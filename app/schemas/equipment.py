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


class EquipmentBlockResponse(BaseModel):
    """Response model for equipment blocks (maintenance / defect periods)."""

    id: int
    equipment_id: int
    equipment_name: str = ""
    start_date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS
    reason: str = "maintenance"
    description: str = "Maintenance"
    created_at: DateTimeJS

    class Config:
        from_attributes = True


class EquipmentBlockCreate(BaseModel):
    """Request model for creating an equipment block."""

    equipment_id: int
    start_date: date
    end_date: date
    reason: str | None = Field(default="maintenance", max_length=50)
    description: str | None = Field(default="Maintenance", max_length=200)


class EquipmentBlockUpdate(BaseModel):
    """Request model for updating an equipment block."""

    start_date: date | None = None
    end_date: date | None = None
    reason: str | None = Field(None, max_length=50)
    description: str | None = Field(None, max_length=200)
