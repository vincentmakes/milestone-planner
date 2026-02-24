"""
Pydantic schemas for Predefined Phases.
"""

from pydantic import BaseModel, Field

from app.schemas.base import DateTimeJS


class PredefinedPhaseResponse(BaseModel):
    """Response model for predefined phases."""

    id: int
    name: str
    sort_order: int
    is_active: int
    created_at: DateTimeJS

    class Config:
        from_attributes = True


class PredefinedPhaseCreate(BaseModel):
    """Request model for creating a predefined phase."""

    name: str = Field(..., min_length=1, max_length=100)


class PredefinedPhaseUpdate(BaseModel):
    """Request model for updating a predefined phase."""

    name: str | None = Field(None, min_length=1, max_length=100)
    is_active: bool | None = None


class PhaseReorderRequest(BaseModel):
    """Request model for reordering phases."""

    phaseOrder: list[int] = Field(..., description="List of phase IDs in desired order")
