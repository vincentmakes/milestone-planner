"""
Health check endpoints.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app import __version__
from app.config import get_settings
from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.websocket.broadcast import broadcast_change, get_tenant_from_request
from app.websocket.manager import manager

router = APIRouter()


class HealthResponse(BaseModel):
    """Health check response model."""

    status: str
    mode: str
    version: str
    backend: str
    default_tenant: str | None
    timestamp: str
    database: str


@router.get("/health", response_model=HealthResponse)
async def health_check(db: AsyncSession = Depends(get_db)):
    """
    Health check endpoint.
    Returns server status and database connectivity.
    """
    settings = get_settings()

    # Test database connectivity
    db_status = "connected"
    try:
        await db.execute(text("SELECT 1"))
    except Exception as e:
        db_status = f"error: {str(e)}"

    return HealthResponse(
        status="ok",
        mode="multi-tenant" if settings.multi_tenant else "single-tenant",
        version=__version__,
        backend="python-fastapi",
        default_tenant=settings.default_tenant,
        timestamp=datetime.utcnow().isoformat(),
        database=db_status,
    )


@router.get("/api/health")
async def api_health_check(db: AsyncSession = Depends(get_db)):
    """
    API prefixed health check (for consistency with /api/* routes).
    """
    return await health_check(db)


@router.get("/api/ws-debug")
async def ws_debug(
    request: Request,
    user: User = Depends(get_current_user),
):
    """
    Diagnostic endpoint to verify the WebSocket broadcast pipeline.

    Returns the tenant the request resolves to and the count of active
    WebSocket connections (and distinct online users) the broadcast manager
    sees for that tenant. If this returns 0 connections while the user has
    a tab open, the WebSocket and the API are landing on different
    processes/replicas and broadcasts will never reach anyone.
    """
    tenant_id = get_tenant_from_request(request)
    connections = manager._connections.get(tenant_id, {})  # noqa: SLF001
    return {
        "tenant_id": tenant_id,
        "your_user_id": user.id,
        "connection_count": len(connections),
        "online_user_count": manager.get_online_count(tenant_id),
        "online_users": manager.get_online_users(tenant_id),
    }


@router.post("/api/ws-debug/broadcast")
async def ws_debug_broadcast(
    request: Request,
    user: User = Depends(get_current_user),
):
    """
    Diagnostic endpoint that fires a synthetic change broadcast. Use this
    from the editor's browser to confirm that other tabs/users actually
    receive a `change:project` event without needing to coordinate a real
    Gantt edit.
    """
    await broadcast_change(
        request=request,
        user=user,
        entity_type="project",
        entity_id=0,
        project_id=0,
        action="update",
        summary="ws-debug ping",
    )
    tenant_id = get_tenant_from_request(request)
    return {
        "ok": True,
        "tenant_id": tenant_id,
        "connection_count": len(manager._connections.get(tenant_id, {})),  # noqa: SLF001
    }
