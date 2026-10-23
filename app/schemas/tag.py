"""
Pydantic schemas for tags (tag groups became project fields in 2.0.0).
"""

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.base import COLOR_PATTERN, DateTimeJS
from app.schemas.team import TeamIds

# Bounded id lists (a request body cannot ask for an unbounded IN (...)).
SiteIds = Annotated[list[int], Field(max_length=200)]


# ---------------------------------------------------------
# Tags
# ---------------------------------------------------------


class TagBase(BaseModel):
    """Base tag fields."""

    name: str = Field(..., min_length=1, max_length=100)
    color: str = Field(default="#6366f1", pattern=COLOR_PATTERN)


class TagCreate(TagBase):
    """
    Request model for creating a tag.

    ``site_ids`` is only used when the tag is restricted (it is cleared when
    the tag is available at every site). An omitted ``all_sites`` with a
    non-empty ``site_ids`` means ``all_sites = false``. Unknown keys are a 422
    (``group_id`` included: tag groups are project fields since 2.0.0).
    """

    model_config = ConfigDict(extra="forbid")

    all_sites: bool = Field(
        default=True,
        description=(
            "Available at every site. When omitted, a non-empty site_ids restricts the "
            "tag to those sites (all_sites=false); an explicit true clears site_ids."
        ),
    )
    site_ids: SiteIds | None = Field(
        default=None,
        description="Sites the tag is restricted to (ignored when all_sites is true).",
    )
    team_ids: TeamIds | None = Field(
        default=None,
        description=(
            "Teams the tag is limited to. A site with no listed team keeps the whole site; "
            "every team must be at one of the tag's sites unless all_sites is true."
        ),
    )


class TagUpdate(BaseModel):
    """
    Request model for updating a tag (partial).

    An omitted ``all_sites`` with a non-empty ``site_ids`` means
    ``all_sites = false`` (also on a tag that is currently available at every
    site). Unknown keys are a 422 (``group_id`` included).
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(None, min_length=1, max_length=100)
    color: str | None = Field(None, pattern=COLOR_PATTERN)
    all_sites: bool | None = Field(
        default=None,
        description=(
            "Available at every site. When omitted, a non-empty site_ids restricts the "
            "tag to those sites (all_sites=false); an explicit true clears site_ids."
        ),
    )
    site_ids: SiteIds | None = Field(
        default=None,
        description="Sites the tag is restricted to (ignored when all_sites is true).",
    )
    team_ids: TeamIds | None = Field(
        default=None,
        description=(
            "Teams the tag is limited to. A site with no listed team keeps the whole site; "
            "every team must be at one of the tag's sites unless all_sites is true."
        ),
    )


class TagResponse(BaseModel):
    """Response model for a tag."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    color: str
    all_sites: bool = True
    site_ids: list[int] = []
    team_ids: list[int] = []
    sort_order: int = 0
    created_at: DateTimeJS
    updated_at: DateTimeJS


class TagListResponse(BaseModel):
    """Response model for the tag list (no timestamps)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    color: str
    all_sites: bool = True
    site_ids: list[int] = []
    team_ids: list[int] = []
    sort_order: int = 0


class ProjectTagResponse(BaseModel):
    """A tag as embedded in a project response."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    color: str


class TagReorder(BaseModel):
    """Request model for reordering tags: ids in their new order."""

    tag_order: list[int] = Field(..., max_length=500)
