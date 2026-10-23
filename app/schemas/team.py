"""
Pydantic schemas for teams.
"""

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.base import COLOR_PATTERN, DateTimeJS

# Bounded id lists (a request body cannot ask for an unbounded IN (...)).
TeamIds = Annotated[list[int], Field(max_length=200)]
MemberIds = Annotated[list[int], Field(max_length=500)]


class TeamCreate(BaseModel):
    """Request model for creating a team at a site, optionally with its members."""

    site_id: int
    name: str = Field(..., min_length=1, max_length=100)
    description: str | None = None
    color: str | None = Field(None, pattern=COLOR_PATTERN)
    active: bool = True
    member_ids: MemberIds = []


class TeamUpdate(BaseModel):
    """
    Request model for updating a team (partial; the site cannot change).

    An omitted or null field is left unchanged, except ``description`` and
    ``color``: an explicit null clears them. ``member_ids`` replaces the
    member list.
    """

    name: str | None = Field(None, min_length=1, max_length=100)
    description: str | None = None
    color: str | None = Field(None, pattern=COLOR_PATTERN)
    active: bool | None = None
    member_ids: MemberIds | None = None


class TeamResponse(BaseModel):
    """Response model for a team."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    site_id: int
    name: str
    description: str | None = None
    color: str | None = None
    active: bool
    member_ids: list[int] = []
    created_at: DateTimeJS
    updated_at: DateTimeJS
