"""
Pydantic schemas for Projects, Phases, and Subphases.
"""

from datetime import date
from typing import Any

from pydantic import BaseModel, Field

from app.schemas.base import DateAsDateTimeJS, DateTimeJS

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
    staff_name: str | None = None
    staff_role: str | None = None

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
    staff_name: str | None = None
    staff_role: str | None = None

    class Config:
        from_attributes = True


class EquipmentAssignmentInProject(BaseModel):
    """Equipment assignment within a project response."""

    id: int
    equipment_id: int
    project_id: int
    start_date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS
    notes: str | None = None
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
    dependencies: list[Any] = []
    created_at: DateTimeJS | None = None
    staffAssignments: list[StaffAssignmentInPhase] = []
    children: list["SubphaseResponse"] = []

    class Config:
        from_attributes = True


class SubphaseCreate(BaseModel):
    """Request model for creating a subphase."""

    name: str = Field(..., min_length=1, max_length=200)
    start_date: date
    end_date: date
    project_id: int
    is_milestone: bool = False
    dependencies: list[Any] | None = None
    order_index: int | None = None


class SubphaseUpdate(BaseModel):
    """Request model for updating a subphase."""

    name: str | None = Field(None, min_length=1, max_length=200)
    start_date: date | None = None
    end_date: date | None = None
    is_milestone: bool | None = None
    dependencies: list[Any] | None = None
    completion: int | None = None


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
    dependencies: list[Any] = []
    created_at: DateTimeJS | None = None
    staffAssignments: list[StaffAssignmentInPhase] = []
    children: list[SubphaseResponse] = []

    class Config:
        from_attributes = True


class PhaseCreate(BaseModel):
    """Request model for creating a phase."""

    type: str = Field(..., min_length=1, max_length=100)
    start_date: date
    end_date: date
    is_milestone: bool = False
    dependencies: list[Any] | None = None
    order_index: int | None = None


class PhaseUpdate(BaseModel):
    """Request model for updating a phase."""

    type: str | None = Field(None, min_length=1, max_length=100)
    start_date: date | None = None
    end_date: date | None = None
    is_milestone: bool | None = None
    dependencies: list[Any] | None = None
    completion: int | None = None


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

    class Config:
        from_attributes = True


class ProjectCreate(BaseModel):
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


class ProjectUpdate(BaseModel):
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


class SubphaseReorderRequest(BaseModel):
    """Request model for reordering subphases."""

    subphase_order: list[int]
    parent_type: str = "phase"


# Enable forward references for recursive SubphaseResponse
SubphaseResponse.model_rebuild()
