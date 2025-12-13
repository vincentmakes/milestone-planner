"""
Pydantic schemas for Vacations.
"""

from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel, Field

from app.schemas.base import DateTimeJS, DateAsDateTimeJS


class VacationResponse(BaseModel):
    """Response model for vacations."""
    id: int
    staff_id: int
    staff_name: str = ""
    start_date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS
    description: str = "Vacation"
    created_at: DateTimeJS
    # Permission flag - set by endpoint based on current user
    canEdit: bool = False

    class Config:
        from_attributes = True


class VacationCreate(BaseModel):
    """Request model for creating a vacation."""
    staff_id: int
    start_date: date
    end_date: date
    description: Optional[str] = Field(default="Vacation", max_length=200)


class VacationUpdate(BaseModel):
    """Request model for updating a vacation."""
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    description: Optional[str] = Field(None, max_length=200)
