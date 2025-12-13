"""
Pydantic schemas for Projects, Phases, and Subphases.
"""

from datetime import date, datetime
from typing import List, Optional, Any

from pydantic import BaseModel, Field

from app.schemas.base import DateTimeJS, DateAsDateTimeJS


# ---------------------------------------------------------
# Staff Assignment Schemas (for nested responses)
# ---------------------------------------------------------

class StaffAssignmentInPhase(BaseModel):
    """Staff assignment within a phase/subphase response."""
    id: int
    phase_id: Optional[int] = None
    subphase_id: Optional[int] = None
    project_id: int
    staff_id: int
    allocation: int
    staff_name: Optional[str] = None
    staff_role: Optional[str] = None

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
    staff_name: Optional[str] = None
    staff_role: Optional[str] = None

    class Config:
        from_attributes = True


class EquipmentAssignmentInProject(BaseModel):
    """Equipment assignment within a project response."""
    id: int
    equipment_id: int
    project_id: int
    start_date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS
    notes: Optional[str] = None
    created_at: DateTimeJS
    equipment_name: Optional[str] = None
    equipment_type: Optional[str] = None

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
    completion: Optional[int] = None
    dependencies: List[Any] = []
    created_at: Optional[DateTimeJS] = None
    staffAssignments: List[StaffAssignmentInPhase] = []
    children: List["SubphaseResponse"] = []

    class Config:
        from_attributes = True


class SubphaseCreate(BaseModel):
    """Request model for creating a subphase."""
    name: str = Field(..., min_length=1, max_length=200)
    start_date: date
    end_date: date
    project_id: int
    is_milestone: bool = False
    dependencies: Optional[List[Any]] = None
    order_index: Optional[int] = None


class SubphaseUpdate(BaseModel):
    """Request model for updating a subphase."""
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    is_milestone: Optional[bool] = None
    dependencies: Optional[List[Any]] = None
    completion: Optional[int] = None


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
    completion: Optional[int] = None
    dependencies: List[Any] = []
    created_at: Optional[DateTimeJS] = None
    staffAssignments: List[StaffAssignmentInPhase] = []
    children: List[SubphaseResponse] = []

    class Config:
        from_attributes = True


class PhaseCreate(BaseModel):
    """Request model for creating a phase."""
    type: str = Field(..., min_length=1, max_length=100)
    start_date: date
    end_date: date
    is_milestone: bool = False
    dependencies: Optional[List[Any]] = None
    order_index: Optional[int] = None


class PhaseUpdate(BaseModel):
    """Request model for updating a phase."""
    type: Optional[str] = Field(None, min_length=1, max_length=100)
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    is_milestone: Optional[bool] = None
    dependencies: Optional[List[Any]] = None
    completion: Optional[int] = None


class PhaseReorderRequest(BaseModel):
    """Request model for reordering phases."""
    phase_order: List[int]


# ---------------------------------------------------------
# Project Schemas
# ---------------------------------------------------------

class ProjectListResponse(BaseModel):
    """Response model for project list (without nested data)."""
    id: int
    name: str
    site_id: Optional[int] = None
    site_name: Optional[str] = None
    customer: Optional[str] = None
    pm_id: Optional[int] = None
    pm_name: Optional[str] = None
    sales_pm: Optional[str] = None
    confirmed: int
    volume: Optional[float] = None
    start_date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS
    notes: Optional[str] = None
    archived: int = 0
    created_at: DateTimeJS
    updated_at: Optional[DateTimeJS] = None

    class Config:
        from_attributes = True


class ProjectDetailResponse(BaseModel):
    """Response model for single project with all nested data."""
    id: int
    name: str
    site_id: Optional[int] = None
    site_name: Optional[str] = None
    customer: Optional[str] = None
    pm_id: Optional[int] = None
    pm_name: Optional[str] = None
    sales_pm: Optional[str] = None
    confirmed: int
    volume: Optional[float] = None
    start_date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS
    notes: Optional[str] = None
    archived: int = 0
    created_at: DateTimeJS
    updated_at: Optional[DateTimeJS] = None
    phases: List[PhaseResponse] = []
    staffAssignments: List[ProjectStaffAssignmentResponse] = []
    equipmentAssignments: List[EquipmentAssignmentInProject] = []

    class Config:
        from_attributes = True


class ProjectCreate(BaseModel):
    """Request model for creating a project."""
    name: str = Field(..., min_length=1, max_length=200)
    site_id: Optional[int] = None
    customer: Optional[str] = Field(None, max_length=200)
    pm_id: Optional[int] = None
    sales_pm: Optional[str] = Field(None, max_length=200)
    confirmed: bool = False
    volume: Optional[float] = None
    start_date: date
    end_date: date
    notes: Optional[str] = None
    phases: Optional[List[PhaseCreate]] = None


class ProjectUpdate(BaseModel):
    """Request model for updating a project."""
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    customer: Optional[str] = Field(None, max_length=200)
    pm_id: Optional[int] = None
    sales_pm: Optional[str] = Field(None, max_length=200)
    confirmed: Optional[bool] = None
    volume: Optional[float] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    notes: Optional[str] = None
    archived: Optional[bool] = None


class SubphaseReorderRequest(BaseModel):
    """Request model for reordering subphases."""
    subphase_order: List[int]
    parent_type: str = "phase"


# Enable forward references for recursive SubphaseResponse
SubphaseResponse.model_rebuild()
