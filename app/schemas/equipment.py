"""
Pydantic schemas for Equipment.
"""

from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel, Field

from app.schemas.base import DateTimeJS, DateAsDateTimeJS


class EquipmentResponse(BaseModel):
    """Response model for equipment."""
    id: int
    name: str
    type: Optional[str] = None
    site_id: Optional[int] = None
    site_name: Optional[str] = None
    description: Optional[str] = None
    active: int = 1
    created_at: DateTimeJS

    class Config:
        from_attributes = True


class EquipmentCreate(BaseModel):
    """Request model for creating equipment."""
    name: str = Field(..., min_length=1, max_length=200)
    type: Optional[str] = Field(None, max_length=100)
    site_id: Optional[int] = None
    description: Optional[str] = None


class EquipmentUpdate(BaseModel):
    """Request model for updating equipment."""
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    type: Optional[str] = Field(None, max_length=100)
    site_id: Optional[int] = None
    description: Optional[str] = None
    active: Optional[int] = None


class EquipmentAssignmentResponse(BaseModel):
    """Response model for equipment assignments."""
    id: int
    project_id: int
    project_name: Optional[str] = None
    project_site_id: Optional[int] = None
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
    equipment_id: Optional[int] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
