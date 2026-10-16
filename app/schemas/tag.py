"""
Pydantic schemas for tags and tag groups.
"""

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.base import DateTimeJS

COLOR_PATTERN = "^#[0-9A-Fa-f]{6}$"

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
    non-empty ``site_ids`` means ``all_sites = false``.
    """

    group_id: int | None = None
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


class TagUpdate(BaseModel):
    """
    Request model for updating a tag (partial).

    An explicit ``"group_id": null`` moves the tag out of its group; an omitted
    ``group_id`` leaves it unchanged. An omitted ``all_sites`` with a non-empty
    ``site_ids`` means ``all_sites = false`` (also on a tag that is currently
    available at every site).
    """

    name: str | None = Field(None, min_length=1, max_length=100)
    color: str | None = Field(None, pattern=COLOR_PATTERN)
    group_id: int | None = None
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


class TagResponse(BaseModel):
    """Response model for a tag."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    color: str
    group_id: int | None = None
    all_sites: bool = True
    site_ids: list[int] = []
    sort_order: int = 0
    created_at: DateTimeJS
    updated_at: DateTimeJS


class TagListResponse(BaseModel):
    """Response model for the tag list (no timestamps)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    color: str
    group_id: int | None = None
    all_sites: bool = True
    site_ids: list[int] = []
    sort_order: int = 0


class ProjectTagResponse(BaseModel):
    """A tag as embedded in a project response."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    color: str
    group_id: int | None = None


class TagReorder(BaseModel):
    """Request model for reordering tags: ids in their new order."""

    tag_order: list[int] = Field(..., max_length=500)


# ---------------------------------------------------------
# Tag groups
# ---------------------------------------------------------


class TagGroupCreate(BaseModel):
    """Request model for creating a tag group."""

    name: str = Field(..., min_length=1, max_length=100)
    single_select: bool = False
    colors_projects: bool = False


class TagGroupUpdate(BaseModel):
    """Request model for updating a tag group (partial)."""

    name: str | None = Field(None, min_length=1, max_length=100)
    single_select: bool | None = None
    colors_projects: bool | None = None


class TagGroupResponse(BaseModel):
    """Response model for a tag group."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    single_select: bool
    colors_projects: bool
    sort_order: int
    created_at: DateTimeJS
    updated_at: DateTimeJS


class TagGroupReorder(BaseModel):
    """Request model for reordering tag groups: ids in their new order."""

    group_order: list[int] = Field(..., max_length=500)
