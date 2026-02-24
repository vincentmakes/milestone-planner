"""
Pydantic schemas for Skills.
"""

from pydantic import BaseModel, Field

from app.schemas.base import DateTimeJS


class SkillBase(BaseModel):
    """Base skill fields."""

    name: str = Field(..., min_length=1, max_length=100)
    description: str | None = None
    color: str = Field(default="#6366f1", pattern="^#[0-9A-Fa-f]{6}$")


class SkillCreate(SkillBase):
    """Request model for creating a skill."""

    pass


class SkillUpdate(BaseModel):
    """Request model for updating a skill."""

    name: str | None = Field(None, min_length=1, max_length=100)
    description: str | None = None
    color: str | None = Field(None, pattern="^#[0-9A-Fa-f]{6}$")


class SkillResponse(BaseModel):
    """Response model for a skill."""

    id: int
    name: str
    description: str | None = None
    color: str
    created_at: DateTimeJS
    updated_at: DateTimeJS

    class Config:
        from_attributes = True


class SkillListResponse(BaseModel):
    """Response model for skill list (simpler, no timestamps)."""

    id: int
    name: str
    color: str

    class Config:
        from_attributes = True


class UserSkillResponse(BaseModel):
    """Response model for a user's skill with proficiency."""

    id: int
    name: str
    color: str
    proficiency: int = 3

    class Config:
        from_attributes = True


class UserSkillAssignment(BaseModel):
    """Request model for assigning skills to a user."""

    skill_ids: list[int] = []


class UserSkillUpdate(BaseModel):
    """Request model for updating a single user skill."""

    skill_id: int
    proficiency: int = Field(default=3, ge=1, le=5)
