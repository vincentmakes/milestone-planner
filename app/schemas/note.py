"""
Pydantic schemas for Notes.
"""

from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel, Field


class NoteResponse(BaseModel):
    """Response model for notes."""
    id: int
    site_id: int
    staff_id: Optional[int] = None
    staff_name: Optional[str] = None
    date: date
    text: str
    type: str = "general"
    created_at: datetime

    class Config:
        from_attributes = True


class NoteCreate(BaseModel):
    """Request model for creating a note."""
    site_id: int
    staff_id: Optional[int] = None
    date: date
    text: str = Field(..., min_length=1)
    type: Optional[str] = Field(default="general", max_length=50)


class NoteUpdate(BaseModel):
    """Request model for updating a note."""
    text: Optional[str] = Field(None, min_length=1)
    type: Optional[str] = Field(None, max_length=50)
