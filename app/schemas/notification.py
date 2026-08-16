"""
Pydantic schemas for in-app notifications.
"""

from pydantic import BaseModel

from app.schemas.base import DateTimeJS


class NotificationResponse(BaseModel):
    """One notification in the bell panel."""

    id: int
    type: str
    actor_id: int | None = None
    actor_name: str | None = None
    entity_type: str | None = None
    entity_id: int | None = None
    project_id: int | None = None
    title: str
    body: str | None = None
    read_at: DateTimeJS | None = None
    created_at: DateTimeJS | None = None

    class Config:
        from_attributes = True


class UnreadCountResponse(BaseModel):
    """Badge count for the notification bell."""

    count: int
