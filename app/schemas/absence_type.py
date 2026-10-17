"""
Pydantic schemas for Absence Types.
"""

from pydantic import BaseModel, Field

from app.schemas.base import DateTimeJS

HEX_COLOR_PATTERN = "^#[0-9A-Fa-f]{6}$"


class AbsenceTypeResponse(BaseModel):
    """Response model for an absence type."""

    id: int
    name: str
    color: str
    counts_as_unavailable: bool
    sort_order: int
    is_active: bool
    created_at: DateTimeJS
    updated_at: DateTimeJS

    class Config:
        from_attributes = True


class AbsenceTypeCreate(BaseModel):
    """Request model for creating an absence type."""

    name: str = Field(..., min_length=1, max_length=100)
    color: str = Field(..., pattern=HEX_COLOR_PATTERN)
    counts_as_unavailable: bool = True
    is_active: bool = True


class AbsenceTypeUpdate(BaseModel):
    """Request model for updating an absence type (all fields optional)."""

    name: str | None = Field(None, min_length=1, max_length=100)
    color: str | None = Field(None, pattern=HEX_COLOR_PATTERN)
    counts_as_unavailable: bool | None = None
    is_active: bool | None = None


class AbsenceTypeReorderRequest(BaseModel):
    """Request model for reordering absence types."""

    type_order: list[int] = Field(..., description="List of absence type IDs in desired order")
