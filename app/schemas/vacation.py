"""
Pydantic schemas for Vacations.
"""

from datetime import date

from pydantic import BaseModel, Field

from app.schemas.base import DateAsDateTimeJS, DateRangeOrdered, DateTimeJS

# Upper bound on a single .ics import, so one request cannot insert unbounded rows.
MAX_IMPORT_ITEMS = 1000


class VacationResponse(BaseModel):
    """Response model for vacations."""

    id: int
    staff_id: int
    staff_name: str = ""
    start_date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS
    description: str = "Vacation"
    absence_type_id: int | None = None
    created_at: DateTimeJS
    # Permission flag - set by endpoint based on current user
    canEdit: bool = False

    class Config:
        from_attributes = True


class VacationCreate(DateRangeOrdered):
    """Request model for creating a vacation."""

    staff_id: int
    start_date: date
    end_date: date
    description: str | None = Field(default="Vacation", max_length=200)
    absence_type_id: int | None = None


class VacationUpdate(DateRangeOrdered):
    """Request model for updating a vacation."""

    start_date: date | None = None
    end_date: date | None = None
    description: str | None = Field(None, max_length=200)
    absence_type_id: int | None = None


class VacationImportItem(BaseModel):
    """One absence in a bulk import."""

    start_date: date
    end_date: date
    description: str | None = Field(default="Vacation", max_length=200)
    absence_type_id: int | None = None


class VacationImportRequest(BaseModel):
    """Request model for importing absences (e.g. from an .ics file) for one person."""

    staff_id: int
    items: list[VacationImportItem] = Field(..., max_length=MAX_IMPORT_ITEMS)


class ImportResult(BaseModel):
    """Outcome of a bulk import."""

    created: int
    skipped: int
