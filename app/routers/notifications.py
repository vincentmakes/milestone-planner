"""
In-app notification routes.

Every query here is pinned to the session user's own id. There is deliberately
no `user_id` query parameter -- one would be a straightforward IDOR, letting any
authenticated user read or clear someone else's inbox.

Due-soon/overdue reminders never reach this table: they are derived in the
browser from project data the client already holds, because the application has
no scheduler to produce them server-side. For the same reason, read rows older
than ``READ_RETENTION_DAYS`` are purged when the inbox is listed.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, get_db_readonly
from app.middleware.auth import get_current_user
from app.models.notification import Notification
from app.models.user import User
from app.schemas.notification import (
    NotificationResponse,
    UnreadCountResponse,
)
from app.services.notifications import purge_read_notifications
from app.utils import utcnow_naive

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/notifications")


@router.get("", response_model=list[NotificationResponse])
async def list_notifications(
    unread_only: bool = Query(False),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    The current user's notifications, newest first.

    Purges the user's read rows past the retention first (hence ``get_db``
    and the commit: the read-only session never commits).
    """
    await purge_read_notifications(db, user.id)
    await db.commit()

    query = select(Notification, User.first_name, User.last_name).outerjoin(
        User, Notification.actor_id == User.id
    )

    query = query.where(Notification.user_id == user.id)
    if unread_only:
        query = query.where(Notification.read_at.is_(None))

    query = query.order_by(Notification.created_at.desc()).limit(limit)
    result = await db.execute(query)

    items = []
    for row, first_name, last_name in result.all():
        actor_name = f"{first_name or ''} {last_name or ''}".strip() or None
        items.append(
            {
                "id": row.id,
                "type": row.type,
                "actor_id": row.actor_id,
                "actor_name": actor_name,
                "entity_type": row.entity_type,
                "entity_id": row.entity_id,
                "project_id": row.project_id,
                "title": row.title,
                "body": row.body,
                "read_at": row.read_at,
                "created_at": row.created_at,
            }
        )
    return items


@router.get("/unread-count", response_model=UnreadCountResponse)
async def get_unread_count(
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(get_current_user),
):
    """Unread count for the bell badge (served by the partial index)."""
    result = await db.execute(
        select(func.count(Notification.id)).where(
            Notification.user_id == user.id,
            Notification.read_at.is_(None),
        )
    )
    return {"count": result.scalar() or 0}


@router.put("/read-all")
async def mark_all_read(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Mark every unread notification of the current user as read."""
    await db.execute(
        update(Notification)
        .where(Notification.user_id == user.id, Notification.read_at.is_(None))
        .values(read_at=utcnow_naive())
    )
    await db.commit()
    return {"success": True}


@router.put("/{notification_id}/read")
async def mark_read(
    notification_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Mark one notification as read.

    Scoped to (id, user_id) so another user's id is indistinguishable from a
    non-existent one -- you cannot probe for other people's notifications.
    """
    result = await db.execute(
        select(Notification).where(
            Notification.id == notification_id,
            Notification.user_id == user.id,
        )
    )
    notification = result.scalar_one_or_none()
    if not notification:
        raise HTTPException(status_code=404, detail="Notification not found")

    if notification.read_at is None:
        notification.read_at = utcnow_naive()
        await db.commit()

    return {"success": True}


@router.delete("", response_model=None)
async def clear_notifications(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Delete every notification of the current user, read or not."""
    result = await db.execute(delete(Notification).where(Notification.user_id == user.id))
    await db.commit()
    return {"deleted": result.rowcount}


@router.delete("/{notification_id}", status_code=204, response_class=Response)
async def delete_notification(
    notification_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Delete one notification of the current user.

    Scoped to (id, user_id) like ``mark_read``: someone else's id is a 404,
    indistinguishable from a non-existent one.
    """
    result = await db.execute(
        delete(Notification).where(
            Notification.id == notification_id,
            Notification.user_id == user.id,
        )
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Notification not found")
    await db.commit()
    return Response(status_code=204)
