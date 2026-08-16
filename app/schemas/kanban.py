"""
Pydantic schemas for the Kanban board API.

Declared here rather than inline in the router (the inline style in
assignments.py is the outlier, and is also the file with essentially no
validation).
"""

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.base import DateTimeJS
from app.services.card_status import CardStatus

CardEntityType = Literal["phase", "subphase"]


class CardStatusUpdate(BaseModel):
    """Move a card to a different status column."""

    status: CardStatus


class CardStatusResponse(BaseModel):
    """Echoes the resulting pair so the client can reconcile without a refetch."""

    success: bool = True
    status: CardStatus
    completion: int | None = None


class CardAssigneeCreate(BaseModel):
    """Assign a staff member to a card (which also books their time)."""

    staff_id: int
    # Resolved server-side from the assignee's max_capacity when omitted.
    allocation: int | None = Field(None, ge=0, le=100)


class CardAssigneeResponse(BaseModel):
    success: bool = True
    id: int
    staff_id: int
    staff_name: str | None = None
    allocation: int


class CardCommentCreate(BaseModel):
    body: str = Field(..., min_length=1, max_length=4000)
    # Accepted for wire compatibility but IGNORED: mentions are parsed from the
    # body's `@[Name](id)` tokens so the rendered text and the notified people
    # can never disagree. See app/services/mentions.py.
    mentioned_user_ids: list[int] = []


class CardCommentUpdate(BaseModel):
    body: str = Field(..., min_length=1, max_length=4000)


class CardCommentResponse(BaseModel):
    id: int
    entity_type: str
    entity_id: int
    project_id: int
    author_id: int
    author_name: str | None = None
    body: str
    mentioned_user_ids: list[int] = []
    edited: bool = False
    created_at: DateTimeJS | None = None
    updated_at: DateTimeJS | None = None

    class Config:
        from_attributes = True


class CommentCountsResponse(BaseModel):
    """Comment counts for one project, keyed by entity type then entity id."""

    phase: dict[str, int] = {}
    subphase: dict[str, int] = {}
