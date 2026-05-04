"""
Pydantic schemas for Tags.
"""

from pydantic import BaseModel, Field

from app.schemas.base import DateTimeJS


class TagBase(BaseModel):
    """Base tag fields."""

    name: str = Field(..., min_length=1, max_length=100)
    color: str = Field(default="#6366f1", pattern="^#[0-9A-Fa-f]{6}$")


class TagCreate(TagBase):
    """Request model for creating a tag."""

    pass


class TagUpdate(BaseModel):
    """Request model for updating a tag."""

    name: str | None = Field(None, min_length=1, max_length=100)
    color: str | None = Field(None, pattern="^#[0-9A-Fa-f]{6}$")


class TagResponse(BaseModel):
    """Response model for a tag."""

    id: int
    name: str
    color: str
    created_at: DateTimeJS
    updated_at: DateTimeJS

    class Config:
        from_attributes = True


class TagListResponse(BaseModel):
    """Response model for tag list (simpler, no timestamps)."""

    id: int
    name: str
    color: str

    class Config:
        from_attributes = True
