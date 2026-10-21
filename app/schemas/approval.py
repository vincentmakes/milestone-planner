"""
Pydantic schemas for approval requests (own bookings awaiting a decision).

The workflow lives in app/services/approvals.py; the routes in
app/routers/approvals.py. ``requested`` / ``previous`` are the booking values
``{allocation, start_date?, end_date?}`` (dates only at project level, as
``YYYY-MM-DD``): what the requester asks for and what the row held when they
asked.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.base import DateTimeJS

ApprovalScope = Literal["mine", "to_decide", "all"]
ApprovalStatus = Literal["pending", "approved", "rejected", "cancelled", "superseded", "expired"]
ApprovalLevel = Literal["project", "phase", "subphase"]


class AssignmentApproval(BaseModel):
    """The open request on a serialised staff assignment (``approval`` field)."""

    request_id: int
    action: str
    requester_id: int
    requested: dict[str, Any] | None = None
    previous: dict[str, Any] | None = None
    created_at: DateTimeJS | None = None
    can_decide: bool = False


class ApprovalDecision(BaseModel):
    """Body of approve / reject / cancel: an optional note for the requester."""

    note: str | None = Field(None, max_length=2000)


class ApprovalRequestResponse(BaseModel):
    """One approval request, with the names a list needs."""

    id: int
    action: str
    status: ApprovalStatus
    close_reason: str | None = None
    requester_id: int
    requester_name: str | None = None
    project_id: int
    project_name: str | None = None
    level: ApprovalLevel
    target_id: int
    target_name: str | None = None
    assignment_id: int | None = None
    requested: dict[str, Any] | None = None
    previous: dict[str, Any] | None = None
    note: str | None = None
    decided_by: int | None = None
    decided_by_name: str | None = None
    decided_at: DateTimeJS | None = None
    decision_note: str | None = None
    superseded_by_id: int | None = None
    created_at: DateTimeJS | None = None
    updated_at: DateTimeJS | None = None
    can_decide: bool = False


class ApprovalDecisionResponse(BaseModel):
    """The outcome of approve / reject / cancel."""

    success: bool = True
    id: int
    status: ApprovalStatus
