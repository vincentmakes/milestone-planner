"""
Pydantic schemas for Vacations.
"""

from datetime import date

from pydantic import BaseModel, Field

from app.schemas.base import DateAsDateTimeJS, DateTimeJS


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
    description: str | None = Field(default="Vacation", max_length=200)


class VacationUpdate(BaseModel):
    """Request model for updating a vacation."""

    start_date: date | None = None
    end_date: date | None = None
    description: str | None = Field(None, max_length=200)
