"""
Tenant Resolution Middleware.

Handles /t/{tenant-slug}/ URL prefix routing for multi-tenant mode.
Resolves tenant from URL and attaches tenant context to request state.
"""

import logging
import re
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import selectinload
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.models.tenant import Tenant
from app.services.master_db import master_db
from app.services.tenant_manager import tenant_connection_manager

logger = logging.getLogger(__name__)

# Simple in-memory cache for tenant lookups
# Store primitive values, not ORM objects, to avoid detached session issues
_tenant_cache: dict[str, tuple[dict[str, Any], datetime]] = {}
_cache_ttl = 60  # seconds


async def get_tenant_info_cached(slug: str) -> dict[str, Any] | None:
    """Get tenant info from cache or database. Returns dict, not ORM object."""
    cached = _tenant_cache.get(slug)
    if cached:
        tenant_info, timestamp = cached
        if (datetime.utcnow() - timestamp).total_seconds() < _cache_ttl:
            return tenant_info

    # Query database
    async with master_db.session() as session:
        result = await session.execute(
            select(Tenant).where(Tenant.slug == slug).options(selectinload(Tenant.credentials))
        )
        tenant = result.scalar_one_or_none()

        if tenant:
            # Extract primitive values to avoid detached session issues
            tenant_info = {
                "id": str(tenant.id),
                "name": tenant.name,
                "slug": tenant.slug,
                "status": tenant.status,
                "database_name": tenant.database_name,
                "database_user": tenant.database_user,
                "encrypted_password": tenant.credentials.encrypted_password
                if tenant.credentials
                else None,
            }
            _tenant_cache[slug] = (tenant_info, datetime.utcnow())
            return tenant_info

        return None


def clear_tenant_cache(slug: str | None = None):
    """Clear tenant cache."""
    if slug:
        _tenant_cache.pop(slug, None)
    else:
        _tenant_cache.clear()


def extract_tenant_slug(path: str) -> tuple[str | None, str]:
    """
    Extract tenant slug from URL path.

    /t/acme/api/projects -> ('acme', '/api/projects')
    /api/projects -> (None, '/api/projects')

    Returns: (slug or None, remaining path)
    """
    match = re.match(r"^/t/([a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9])(/.*)?$", path)
    if match:
        slug = match.group(1)
        remaining = match.group(2) or "/"
        return slug, remaining
    return None, path


class TenantMiddleware:
    """
    ASGI Middleware to resolve tenant from /t/{slug}/ URL prefix.

    This properly rewrites the URL path BEFORE FastAPI routing happens.
    Handles both HTTP and WebSocket connections.
    """

    def __init__(self, app: ASGIApp):
        self.app = app
        logger.info("TenantMiddleware initialized - wrapping app")

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        # Debug: log every request type
        logger.debug("TenantMiddleware request: type=%s, path=%s", scope['type'], scope.get('path', 'N/A'))

        # SKIP WebSocket connections - they handle tenant resolution themselves
        # This avoids ASGI scope/state issues with WebSocket connections
        if scope["type"] == "websocket":
            logger.debug("TenantMiddleware skipping WebSocket - handler will resolve tenant")
            await self.app(scope, receive, send)
            return

        # Only handle HTTP requests
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "/")

        # Debug logging for WebSocket
        if scope["type"] == "websocket":
            logger.debug("TenantMiddleware WebSocket request: path=%s", path)

        # Fast path: Skip if not a tenant URL
        if not path.startswith("/t/"):
            # Set empty tenant context
            scope["state"] = scope.get("state", {})
            scope["state"]["tenant"] = None
            scope["state"]["tenant_slug"] = None
            await self.app(scope, receive, send)
            return

        # Extract tenant slug from URL
        slug, remaining_path = extract_tenant_slug(path)

        # Debug logging
        if scope["type"] == "websocket":
            logger.debug(
                "TenantMiddleware WebSocket tenant extraction: slug=%s, remaining=%s", slug, remaining_path
            )

        if not slug:
            await self.app(scope, receive, send)
            return

        try:
            # Look up tenant (returns dict, not ORM object)
            tenant_info = await get_tenant_info_cached(slug)

            if not tenant_info:
                # For WebSocket, we can't send a JSON response easily before accept
                # Just let it through and the handler will reject it
                if scope["type"] == "websocket":
                    await self.app(scope, receive, send)
                    return

                response = JSONResponse(
                    status_code=404,
                    content={
                        "error": "Tenant not found",
                        "message": f"No organization found with identifier: {slug}",
                    },
                )
                await response(scope, receive, send)
                return

            if tenant_info["status"] != "active":
                # For WebSocket, let handler deal with it
                if scope["type"] == "websocket":
                    await self.app(scope, receive, send)
                    return

                status_messages = {
                    "suspended": "This organization has been suspended. Please contact support.",
                    "pending": "This organization is pending activation.",
                    "archived": "This organization has been archived.",
                }
                response = JSONResponse(
                    status_code=403,
                    content={
                        "error": "Tenant not active",
                        "message": status_messages.get(
                            tenant_info["status"], "Organization is not accessible."
                        ),
                    },
                )
                await response(scope, receive, send)
                return

            # Prepare state with tenant info (using dict values)
            state = scope.get("state", {})
            state["tenant"] = tenant_info  # Now a dict, not ORM object
            state["tenant_slug"] = slug

            if tenant_info.get("encrypted_password"):
                try:
                    engine = await tenant_connection_manager.get_pool_from_info(tenant_info)
                    state["tenant_engine"] = engine
                except Exception as e:
                    logger.error("Tenant DB connection error: %s", e)
                    # For WebSocket, let handler deal with it
                    if scope["type"] == "websocket":
                        await self.app(scope, receive, send)
                        return

                    response = JSONResponse(
                        status_code=503,
                        content={
                            "error": "Database unavailable",
                            "message": f"Could not connect to organization database: {str(e)}",
                        },
                    )
                    await response(scope, receive, send)
                    return

            # Create modified scope with rewritten path
            # This is the key - we modify the scope BEFORE passing to the app
            new_scope = scope.copy()
            new_scope["path"] = remaining_path
            new_scope["raw_path"] = remaining_path.encode()
            new_scope["state"] = state

            # Debug logging for WebSocket
            if scope["type"] == "websocket":
                logger.debug("TenantMiddleware WebSocket path rewritten: %s -> %s", path, remaining_path)
                logger.debug("TenantMiddleware WebSocket new_scope path: %s", new_scope.get('path'))
                logger.debug(
                    "TenantMiddleware WebSocket state: tenant_slug=%s, has_engine=%s", state.get('tenant_slug'), state.get('tenant_engine') is not None
                )

            # Also update root_path if needed for URL generation
            # new_scope["root_path"] = f"/t/{slug}"

            await self.app(new_scope, receive, send)

        except Exception as e:
            logger.exception("Tenant middleware error: %s", e)
            # For WebSocket, let it fail naturally
            if scope["type"] == "websocket":
                await self.app(scope, receive, send)
                return

            response = JSONResponse(
                status_code=500,
                content={
                    "error": "Internal error",
                    "message": "Failed to resolve organization context",
                },
            )
            await response(scope, receive, send)
