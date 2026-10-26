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
    # 1..100 like every other staff booking (0 would be a booking of nobody).
    allocation: int | None = Field(None, ge=1, le=100)


class AdjustedBooking(BaseModel):
    """A booking of the same person shortened to make room (its new dates)."""

    id: int
    start_date: str | None = None
    end_date: str | None = None
    linked: bool = False


class CardAssigneeResponse(BaseModel):
    success: bool = True
    id: int
    staff_id: int
    staff_name: str | None = None
    allocation: int
    # The new booking's effective dates (own, else the card's) and whether it
    # follows the card; ``adjusted`` = the person's booking shortened by a split.
    start_date: str | None = None
    end_date: str | None = None
    linked: bool = True
    adjusted: list[AdjustedBooking] = []


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
    # Both null once the author's account was deleted (the comment stays).
    author_id: int | None = None
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


class MentionableUserResponse(BaseModel):
    """A person who can be @-mentioned in a card comment."""

    id: int
    name: str
    job_title: str | None = None
