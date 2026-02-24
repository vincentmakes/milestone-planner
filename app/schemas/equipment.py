"""
Pydantic schemas for Equipment.
"""

from datetime import date

from pydantic import BaseModel, Field

from app.schemas.base import DateAsDateTimeJS, DateTimeJS


class EquipmentResponse(BaseModel):
    """Response model for equipment."""

    id: int
    name: str
    type: str | None = None
    site_id: int | None = None
    site_name: str | None = None
    description: str | None = None
    active: int = 1
    created_at: DateTimeJS

    class Config:
        from_attributes = True


class EquipmentCreate(BaseModel):
    """Request model for creating equipment."""

    name: str = Field(..., min_length=1, max_length=200)
    type: str | None = Field(None, max_length=100)
    site_id: int | None = None
    description: str | None = None


class EquipmentUpdate(BaseModel):
    """Request model for updating equipment."""

    name: str | None = Field(None, min_length=1, max_length=200)
    type: str | None = Field(None, max_length=100)
    site_id: int | None = None
    description: str | None = None
    active: int | None = None


class EquipmentAssignmentResponse(BaseModel):
    """Response model for equipment assignments."""

    id: int
    project_id: int
    project_name: str | None = None
    project_site_id: int | None = None
    equipment_id: int
    start_date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS
    created_at: DateTimeJS

    class Config:
        from_attributes = True


class EquipmentAssignmentCreate(BaseModel):
    """Request model for creating equipment assignment."""

    equipment_id: int
    start_date: date
    end_date: date


class EquipmentAssignmentUpdate(BaseModel):
    """Request model for updating equipment assignment."""

    equipment_id: int | None = None
    start_date: date | None = None
    end_date: date | None = None
