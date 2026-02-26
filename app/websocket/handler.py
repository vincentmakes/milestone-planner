"""
WebSocket Endpoint Handler

Handles WebSocket connections with session-based authentication.
"""

import json
import logging
from datetime import datetime

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session_factory
from app.models.session import Session
from app.models.user import User
from app.websocket.manager import manager

logger = logging.getLogger(__name__)

router = APIRouter()


async def get_user_from_session(session_id: str, db: AsyncSession) -> User | None:
    """
    Validate session and return the associated user.

    Args:
        session_id: The session ID from cookie (without 's:' prefix)
        db: Database session

    Returns:
        User if session is valid, None otherwise
    """
    try:
        logger.debug("Looking up session: %s...", session_id[:20])

        # Query the session
        result = await db.execute(select(Session).where(Session.sid == session_id))
        session = result.scalar_one_or_none()

        if not session:
            logger.debug("Session not found in database")
            return None

        logger.debug("Session found, checking expiry...")

        # Check if session is expired
        now_ms = int(datetime.utcnow().timestamp() * 1000)
        if session.expired < now_ms:
            logger.debug("Session expired: %s < %s", session.expired, now_ms)
            return None

        logger.debug("Session valid, parsing data...")

        # Parse session data to get user ID
        sess_data = json.loads(session.sess)
        user_data = sess_data.get("user", {})
        user_id = user_data.get("id")

        logger.debug("User ID from session: %s", user_id)

        if not user_id:
            logger.debug("No user ID in session data")
            return None

        # Get the user
        result = await db.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()

        if user:
            logger.debug("User found: %s %s", user.first_name, user.last_name)
        else:
            logger.debug("User %s not found in database", user_id)

        return user

    except Exception as e:
        logger.error("Error validating session: %s", e)
        return None


def extract_session_id(cookie_value: str) -> str | None:
    """
    Extract session ID from cookie value.

    Cookie format: s:SESSION_ID.SIGNATURE
    or URL-encoded: s%3ASESSION_ID.SIGNATURE
    or just: SESSION_ID
    """
    if not cookie_value:
        return None

    # URL-decode the cookie value first (handles %3A -> :)
    from urllib.parse import unquote

    cookie_value = unquote(cookie_value)

    # Remove 's:' prefix if present
    if cookie_value.startswith("s:"):
        cookie_value = cookie_value[2:]

    # Remove signature if present (after the dot)
    if "." in cookie_value:
        cookie_value = cookie_value.split(".")[0]

    return cookie_value


def get_tenant_from_scope(websocket: WebSocket) -> str:
    """
    Extract tenant slug from WebSocket scope.

    In multi-tenant mode, the TenantMiddleware sets tenant_slug in scope state.
    Returns "default" for single-tenant mode or when no tenant is set.
    """
    state = websocket.scope.get("state", {})
    tenant_slug = state.get("tenant_slug")
    path = websocket.scope.get("path", "/ws")

    logger.debug(
        "get_tenant_from_scope: path=%s, state keys=%s, tenant_slug=%s", path, list(state.keys()), tenant_slug
    )

    if tenant_slug:
        return tenant_slug

    # Fallback: try to extract from path (in case middleware didn't run)
    import re

    match = re.match(r"^/t/([a-z0-9][a-z0-9-]*)/ws", path)
    if match:
        logger.debug("get_tenant_from_scope: Using fallback path extraction: %s", match.group(1))
        return match.group(1)

    return "default"


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    WebSocket endpoint for single-tenant mode.
    Handles connections at /ws.
    """
    logger.debug("websocket_endpoint (/ws) called")
    await handle_websocket_connection(websocket, tenant_slug=None)


@router.websocket("/t/{tenant_slug}/ws")
async def websocket_tenant_endpoint(websocket: WebSocket, tenant_slug: str):
    """
    WebSocket endpoint for multi-tenant mode.
    Handles connections at /t/{tenant}/ws.
    """
    logger.debug("websocket_tenant_endpoint (/t/%s/ws) called", tenant_slug)
    await handle_websocket_connection(websocket, tenant_slug=tenant_slug)


async def handle_websocket_connection(websocket: WebSocket, tenant_slug: str | None = None):
    """
    Handle WebSocket connection with authentication and tenant resolution.

    Args:
        websocket: The WebSocket connection
        tenant_slug: Tenant slug from URL path (None for single-tenant)
    """
    logger.info("WebSocket connection attempt from %s", websocket.client)

    # Get session cookie
    cookies = websocket.cookies
    session_cookie = cookies.get("connect.sid", "")
    session_id = extract_session_id(session_cookie)

    if not session_id:
        await websocket.accept()
        await websocket.close(code=4001, reason="No session cookie")
        return

    # Determine tenant - use URL slug or "default" for single-tenant
    tenant_id = tenant_slug if tenant_slug else "default"
    logger.debug("Tenant: %s, Session: %s...", tenant_id, session_id[:20])

    # Validate session and get user
    try:
        user = None

        if tenant_slug:
            # Multi-tenant mode - get tenant's database engine
            from app.middleware.tenant import get_tenant_info_cached
            from app.services.tenant_manager import tenant_connection_manager

            tenant_info = await get_tenant_info_cached(tenant_slug)
            if not tenant_info:
                await websocket.accept()
                await websocket.close(code=4004, reason="Tenant not found")
                return

            if tenant_info["status"] != "active":
                await websocket.accept()
                await websocket.close(code=4005, reason="Tenant not active")
                return

            if not tenant_info.get("encrypted_password"):
                await websocket.accept()
                await websocket.close(code=4006, reason="Tenant database not configured")
                return

            tenant_engine = await tenant_connection_manager.get_pool_from_info(tenant_info)

            from sqlalchemy.ext.asyncio import AsyncSession
            from sqlalchemy.orm import sessionmaker

            tenant_session_factory = sessionmaker(
                tenant_engine, class_=AsyncSession, expire_on_commit=False
            )
            async with tenant_session_factory() as db:
                user = await get_user_from_session(session_id, db)
        else:
            # Single-tenant mode - use default database
            session_factory = get_session_factory()
            async with session_factory() as db:
                user = await get_user_from_session(session_id, db)

        if not user:
            await websocket.accept()
            await websocket.close(code=4001, reason="Invalid or expired session")
            return

        if not user.active:
            await websocket.accept()
            await websocket.close(code=4003, reason="User account is disabled")
            return

        user_id = user.id
        first_name = user.first_name
        last_name = user.last_name
        logger.info("Authenticated: user %s (%s %s)", user_id, first_name, last_name)

    except Exception as e:
        logger.exception("Database error during WebSocket auth: %s", e)
        await websocket.accept()
        await websocket.close(code=4002, reason="Authentication error")
        return

    # Accept connection and register with manager
    await manager.connect(
        websocket=websocket,
        tenant_id=tenant_id,
        user_id=user_id,
        first_name=first_name,
        last_name=last_name,
    )

    logger.debug("Starting receive loop for user %s", user_id)

    try:
        while True:
            data = await websocket.receive_text()

            try:
                message = json.loads(data)
                msg_type = message.get("type", "")

                if msg_type == "ping":
                    await websocket.send_text(
                        json.dumps(
                            {
                                "type": "pong",
                                "timestamp": datetime.utcnow().isoformat() + "Z",
                            }
                        )
                    )

            except json.JSONDecodeError:
                logger.warning("Invalid JSON from user %s", user_id)

    except WebSocketDisconnect as e:
        logger.info("Disconnected: user %s, code=%s", user_id, getattr(e, 'code', 'N/A'))
        await manager.disconnect(tenant_id, user_id)
    except Exception as e:
        logger.error("Error for user %s: %s", user_id, e)
        await manager.disconnect(tenant_id, user_id)
