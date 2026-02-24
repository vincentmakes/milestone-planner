"""
Pydantic schemas for Notes.
"""

from datetime import date, datetime

from pydantic import BaseModel, Field


class NoteResponse(BaseModel):
    """Response model for notes."""

    id: int
    site_id: int
    staff_id: int | None = None
    staff_name: str | None = None
    date: date
    text: str
    type: str = "general"
    created_at: datetime

    class Config:
        from_attributes = True


class NoteCreate(BaseModel):
    """Request model for creating a note."""

    site_id: int
    staff_id: int | None = None
    date: date
    text: str = Field(..., min_length=1)
    type: str | None = Field(default="general", max_length=50)


class NoteUpdate(BaseModel):
    """Request model for updating a note."""

    text: str | None = Field(None, min_length=1)
    type: str | None = Field(None, max_length=50)
