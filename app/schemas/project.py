"""
Pydantic schemas for Projects, Phases, and Subphases.
"""

from datetime import date
from typing import Annotated, Any

from pydantic import BaseModel, Field

from app.schemas.approval import AssignmentApproval
from app.schemas.base import DateAsDateTimeJS, DateRangeOrdered, DateTimeJS
from app.schemas.tag import ProjectTagResponse
from app.schemas.team import TeamIds
from app.services.card_status import CardStatus

# A project's custom field values, {field_id: value} (2.0.0): text a string,
# number a finite number, toggle a boolean, select an item id (or null),
# multiselect a list of item ids. Checked by
# app/services/project_field_rules.validate_field_values.
ProjectFieldValues = Annotated[dict[int, Any], Field(max_length=500)]

# ---------------------------------------------------------
# Staff Assignment Schemas (for nested responses)
# ---------------------------------------------------------


class StaffAssignmentInPhase(BaseModel):
    """Staff assignment within a phase/subphase response."""

    id: int
    phase_id: int | None = None
    subphase_id: int | None = None
    project_id: int
    staff_id: int
    allocation: int
    # Effective dates: the row's own dates (an unlinked segment inside the
    # card), else the card's; linked = no own dates, the booking follows it.
    start_date: DateAsDateTimeJS | None = None
    end_date: DateAsDateTimeJS | None = None
    linked: bool = True
    staff_name: str | None = None
    staff_role: str | None = None
    # "pending" = a self-booking awaiting approval (not counted in capacity).
    approval_status: str = "approved"
    # The open approval request on the row (pending create, change or removal).
    approval: AssignmentApproval | None = None

    class Config:
        from_attributes = True


class ProjectStaffAssignmentResponse(BaseModel):
    """Staff assignment at project level."""

    id: int
    project_id: int
    staff_id: int
    allocation: int
    start_date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS
    # Project-level bookings always carry their own dates (a uniform client type).
    linked: bool = False
    staff_name: str | None = None
    staff_role: str | None = None
    approval_status: str = "approved"
    approval: AssignmentApproval | None = None

    class Config:
        from_attributes = True


class EquipmentAssignmentInProject(BaseModel):
    """Equipment assignment within a project response."""

    id: int
    equipment_id: int
    project_id: int
    start_date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS
    note: str | None = None
    created_at: DateTimeJS
    equipment_name: str | None = None
    equipment_type: str | None = None

    class Config:
        from_attributes = True


# ---------------------------------------------------------
# Subphase Schemas
# ---------------------------------------------------------


class SubphaseResponse(BaseModel):
    """Response model for subphases (recursive structure)."""

    id: int
    parent_id: int
    parent_type: str
    project_id: int
    name: str
    start_date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS
    is_milestone: bool
    sort_order: int
    depth: int
    completion: int | None = None
    status: CardStatus = "todo"
    dependencies: list[Any] = []
    created_at: DateTimeJS | None = None
    staffAssignments: list[StaffAssignmentInPhase] = []
    children: list["SubphaseResponse"] = []

    class Config:
        from_attributes = True


class SubphaseCreate(DateRangeOrdered):
    """Request model for creating a subphase."""

    name: str = Field(..., min_length=1, max_length=200)
    start_date: date
    end_date: date
    project_id: int
    is_milestone: bool = False
    dependencies: list[Any] | None = None
    order_index: int | None = None


class SubphaseUpdate(DateRangeOrdered):
    """Request model for updating a subphase."""

    name: str | None = Field(None, min_length=1, max_length=200)
    start_date: date | None = None
    end_date: date | None = None
    is_milestone: bool | None = None
    dependencies: list[Any] | None = None
    completion: int | None = Field(None, ge=0, le=100)
    status: CardStatus | None = None


# ---------------------------------------------------------
# Phase Schemas
# ---------------------------------------------------------


class PhaseResponse(BaseModel):
    """Response model for project phases."""

    id: int
    project_id: int
    type: str
    start_date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS
    is_milestone: bool
    sort_order: int
    completion: int | None = None
    status: CardStatus = "todo"
    dependencies: list[Any] = []
    created_at: DateTimeJS | None = None
    staffAssignments: list[StaffAssignmentInPhase] = []
    children: list[SubphaseResponse] = []

    class Config:
        from_attributes = True


class PhaseCreate(DateRangeOrdered):
    """Request model for creating a phase."""

    type: str = Field(..., min_length=1, max_length=100)
    start_date: date
    end_date: date
    is_milestone: bool = False
    dependencies: list[Any] | None = None
    order_index: int | None = None


class PhaseUpdate(DateRangeOrdered):
    """Request model for updating a phase."""

    type: str | None = Field(None, min_length=1, max_length=100)
    start_date: date | None = None
    end_date: date | None = None
    is_milestone: bool | None = None
    dependencies: list[Any] | None = None
    completion: int | None = Field(None, ge=0, le=100)
    status: CardStatus | None = None


class PhaseReorderRequest(BaseModel):
    """Request model for reordering phases."""

    phase_order: list[int]


# ---------------------------------------------------------
# Project Schemas
# ---------------------------------------------------------


class ProjectListResponse(BaseModel):
    """Response model for project list (without nested data)."""

    id: int
    name: str
    site_id: int | None = None
    site_name: str | None = None
    customer: str | None = None
    pm_id: int | None = None
    pm_name: str | None = None
    sales_pm: str | None = None
    confirmed: int
    volume: float | None = None
    start_date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS
    notes: str | None = None
    archived: int = 0
    created_at: DateTimeJS
    updated_at: DateTimeJS | None = None
    tags: list[ProjectTagResponse] = []
    team_ids: list[int] = []
    # {field_id: value}: see ProjectFieldValues (fields without a value left out).
    field_values: dict[int, Any] = {}

    class Config:
        from_attributes = True


class ProjectDetailResponse(BaseModel):
    """Response model for single project with all nested data."""

    id: int
    name: str
    site_id: int | None = None
    site_name: str | None = None
    customer: str | None = None
    pm_id: int | None = None
    pm_name: str | None = None
    sales_pm: str | None = None
    confirmed: int
    volume: float | None = None
    start_date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS
    notes: str | None = None
    archived: int = 0
    created_at: DateTimeJS
    updated_at: DateTimeJS | None = None
    phases: list[PhaseResponse] = []
    staffAssignments: list[ProjectStaffAssignmentResponse] = []
    equipmentAssignments: list[EquipmentAssignmentInProject] = []
    tags: list[ProjectTagResponse] = []
    team_ids: list[int] = []
    # {field_id: value}: see ProjectFieldValues (fields without a value left out).
    field_values: dict[int, Any] = {}

    class Config:
        from_attributes = True


class ProjectCreate(DateRangeOrdered):
    """Request model for creating a project."""

    name: str = Field(..., min_length=1, max_length=200)
    site_id: int | None = None
    customer: str | None = Field(None, max_length=200)
    pm_id: int | None = None
    sales_pm: str | None = Field(None, max_length=200)
    confirmed: bool = False
    volume: float | None = None
    start_date: date
    end_date: date
    notes: str | None = None
    phases: list[PhaseCreate] | None = None
    tag_ids: list[int] | None = None
    team_ids: TeamIds | None = None
    field_values: ProjectFieldValues | None = None


class ProjectUpdate(DateRangeOrdered):
    """Request model for updating a project."""

    name: str | None = Field(None, min_length=1, max_length=200)
    customer: str | None = Field(None, max_length=200)
    pm_id: int | None = None
    sales_pm: str | None = Field(None, max_length=200)
    confirmed: bool | None = None
    volume: float | None = None
    start_date: date | None = None
    end_date: date | None = None
    notes: str | None = None
    archived: bool | None = None
    tag_ids: list[int] | None = None
    team_ids: TeamIds | None = None
    # Only the fields given change; a value of null, "" or [] clears one.
    field_values: ProjectFieldValues | None = None


class SubphaseReorderRequest(BaseModel):
    """Request model for reordering subphases."""

    subphase_order: list[int]
    parent_type: str = "phase"


# Enable forward references for recursive SubphaseResponse
SubphaseResponse.model_rebuild()
