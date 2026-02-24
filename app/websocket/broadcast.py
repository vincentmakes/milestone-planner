"""
Broadcast helper for sending WebSocket updates from API endpoints.

Usage in routers:
    from app.websocket.broadcast import broadcast_change
    
    # After updating a phase:
    await broadcast_change(
        request=request,
        user=user,
        entity_type="phase",
        entity_id=phase.id,
        project_id=phase.project_id,
        action="update",
        summary="moved to Jan 15",
    )
"""

import logging
from typing import Optional
from fastapi import Request

from app.models.user import User
from app.websocket.manager import manager

logger = logging.getLogger(__name__)


def get_tenant_from_request(request: Request) -> str:
    """Extract tenant ID from request path."""
    import re
    path = request.url.path
    match = re.match(r'^/t/([a-z0-9][a-z0-9-]*)/', path)
    if match:
        return match.group(1)
    return "default"


def format_user_name(user: User) -> str:
    """Format user name for display (e.g., 'Vincent D.')"""
    last_initial = user.last_name[0] + "." if user.last_name else ""
    return f"{user.first_name} {last_initial}".strip()


async def broadcast_change(
    request: Request,
    user: User,
    entity_type: str,
    entity_id: int,
    project_id: int,
    action: str,
    summary: Optional[str] = None,
) -> None:
    """
    Broadcast a change event to all connected users in the tenant.
    
    Args:
        request: FastAPI request (used to determine tenant)
        user: The user who made the change
        entity_type: Type of entity (phase, subphase, project, assignment)
        entity_id: ID of the changed entity
        project_id: Parent project ID
        action: Action type (create, update, delete, move)
        summary: Optional human-readable summary
    """
    tenant_id = get_tenant_from_request(request)
    user_name = format_user_name(user)
    
    # Debug logging
    online_count = manager.get_online_count(tenant_id)
    logger.info(f"Broadcasting {entity_type}:{action} to tenant '{tenant_id}' ({online_count} users online)")
    
    await manager.broadcast_change(
        tenant_id=tenant_id,
        user_id=user.id,
        user_name=user_name,
        entity_type=entity_type,
        entity_id=entity_id,
        project_id=project_id,
        action=action,
        summary=summary,
    )
