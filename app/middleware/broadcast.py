"""
Auto-broadcast middleware.

Watches every state-changing API request and, on a successful response,
fires a tenant-wide WebSocket `change:<entity>` broadcast so other users'
clients can refresh the affected slice of data.

This complements the explicit `broadcast_change(...)` calls inside the
projects/assignments routers (which carry richer attribution like the
phase/subphase id and a human-readable summary). For all the other
write endpoints (staff/equipment/vacations/sites/skills/...) we don't
need that level of detail - clients just need to know "someone changed
something of this kind, refresh."

Implemented as pure ASGI middleware so it doesn't touch the WebSocket
upgrade path (BaseHTTPMiddleware would).
"""

import logging
import re
from datetime import datetime

from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.middleware.auth import get_current_user_from_session
from app.websocket.manager import manager

logger = logging.getLogger(__name__)

WRITE_METHODS = {"POST", "PUT", "DELETE", "PATCH"}

# Paths whose routers already call broadcast_change() with rich attribution.
# We skip them here to avoid double broadcasts.
SKIP_PATTERNS = [
    re.compile(r"^/api/projects(?:/|$)"),
    re.compile(r"^/api/phases(?:/|$)"),
    re.compile(r"^/api/subphases(?:/|$)"),
    re.compile(r"^/api/assignments(?:/|$)"),
    re.compile(r"^/api/phase-staff(?:/|$)"),
    re.compile(r"^/api/subphase-staff(?:/|$)"),
    re.compile(r"^/api/equipment-assignments(?:/|$)"),
    re.compile(r"^/api/auth(?:/|$)"),
    re.compile(r"^/api/admin(?:/|$)"),
    re.compile(r"^/api/ws-debug(?:/|$)"),
    re.compile(r"^/api/health$"),
]

# (regex, entity_type). First match wins. Only used when no SKIP_PATTERN matches.
ENTITY_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"^/api/users(?:/|$)"), "user"),
    (re.compile(r"^/api/staff(?:/|$)"), "staff"),
    (re.compile(r"^/api/equipment-blocks(?:/|$)"), "equipment_block"),
    (re.compile(r"^/api/equipment-types(?:/|$)"), "equipment"),
    (re.compile(r"^/api/equipment(?:/|$)"), "equipment"),
    (re.compile(r"^/api/vacations(?:/|$)"), "vacation"),
    (re.compile(r"^/api/sites/\d+/holidays(?:/|$)"), "bank_holiday"),
    (re.compile(r"^/api/sites/\d+/events(?:/|$)"), "company_event"),
    (re.compile(r"^/api/sites(?:/|$)"), "site"),
    (re.compile(r"^/api/skills(?:/|$)"), "skill"),
    (re.compile(r"^/api/tags(?:/|$)"), "tag"),
    (re.compile(r"^/api/custom-columns(?:/|$)"), "custom_column"),
    (re.compile(r"^/api/notes(?:/|$)"), "note"),
    (re.compile(r"^/api/predefined-phases(?:/|$)"), "predefined_phase"),
    (re.compile(r"^/api/settings(?:/|$)"), "settings"),
]


def _resolve_entity_type(path: str) -> str | None:
    for pat in SKIP_PATTERNS:
        if pat.match(path):
            return None
    for pat, entity in ENTITY_PATTERNS:
        if pat.match(path):
            return entity
    return None


def _action_for_method(method: str) -> str:
    if method == "POST":
        return "create"
    if method == "DELETE":
        return "delete"
    return "update"  # PUT, PATCH


class BroadcastMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        method = scope.get("method", "GET")
        if method not in WRITE_METHODS:
            return await self.app(scope, receive, send)

        path = scope.get("path", "")
        entity_type = _resolve_entity_type(path)
        if entity_type is None:
            return await self.app(scope, receive, send)

        status_code = {"value": 0}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_code["value"] = int(message.get("status", 0))
            await send(message)

        await self.app(scope, receive, send_wrapper)

        if not (200 <= status_code["value"] < 300):
            return

        # Resolve tenant + user. Tenant slug is set by TenantMiddleware in
        # scope["state"] (and the path will have been rewritten to drop the
        # /t/{slug}/ prefix already, which is why our regex patterns above
        # match against the rewritten /api/* path).
        scope_state_raw = scope.get("state")
        state = scope_state_raw if isinstance(scope_state_raw, dict) else None
        tenant_id = (state or {}).get("tenant_slug") or "default"

        # Prefer the user that the request's auth dependency stashed in
        # scope state - that lookup already used the tenant-aware DB. Fall
        # back to a session lookup only for endpoints that don't go through
        # get_current_user (uncommon for /api writes).
        user_data: dict | None = (state or {}).get("current_user") if state else None
        if user_data is None:
            try:
                request = Request(scope=scope, receive=receive)
                user_data = await get_current_user_from_session(request)
            except Exception as e:
                logger.debug("BroadcastMiddleware: session lookup failed: %s", e)
                user_data = None

        if not user_data:
            return

        user_id = user_data.get("id")
        first_name = user_data.get("firstName") or user_data.get("first_name") or ""
        last_name = user_data.get("lastName") or user_data.get("last_name") or ""
        last_initial = (last_name[:1] + ".") if last_name else ""
        user_name = f"{first_name} {last_initial}".strip()

        try:
            await manager.broadcast_to_tenant(
                tenant_id,
                {
                    "type": f"change:{entity_type}",
                    "payload": {
                        "user_id": user_id,
                        "user_name": user_name,
                        "entity_type": entity_type,
                        "entity_id": 0,
                        "project_id": 0,
                        "action": _action_for_method(method),
                    },
                    "timestamp": datetime.utcnow().isoformat() + "Z",
                },
                exclude_user=user_id,
            )
        except Exception as e:
            logger.warning("BroadcastMiddleware: broadcast failed: %s", e)
