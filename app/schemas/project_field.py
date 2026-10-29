"""
Pydantic schemas for project fields and their dropdown items (2.0.0).
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.base import COLOR_PATTERN
from app.schemas.tag import SiteIds
from app.schemas.team import TeamIds

ProjectFieldType = Literal["text", "number", "toggle", "select", "multiselect"]

# A number field's decimals: 0-3, or null = as typed.
FieldDecimals = Annotated[int, Field(ge=0, le=3)]


# ---------------------------------------------------------
# Fields
# ---------------------------------------------------------


class ProjectFieldCreate(BaseModel):
    """Request model for creating a project field (appended at the end)."""

    name: str = Field(..., min_length=1, max_length=100)
    field_type: ProjectFieldType
    decimals: FieldDecimals | None = Field(
        default=None,
        description="Number fields only: new values are rounded to 0-3 decimals; null = as typed.",
    )


class ProjectFieldUpdate(BaseModel):
    """
    Request model for updating a project field (partial).

    ``field_type`` cannot change: a value other than the field's type is a 422
    (the same type is accepted, so a client may send the whole field back).
    ``decimals`` is applied when present, ``null`` included (back to "as
    typed"); a non-null value on a field that is not a number is a 422.
    """

    name: str | None = Field(None, min_length=1, max_length=100)
    field_type: ProjectFieldType | None = None
    decimals: FieldDecimals | None = Field(
        default=None,
        description="Number fields only: 0-3, or null to keep values as typed.",
    )


class ProjectFieldReorder(BaseModel):
    """Request model for reordering fields: ids in their new order."""

    field_order: list[int] = Field(..., max_length=500)


# ---------------------------------------------------------
# Items (options of select / multiselect fields)
# ---------------------------------------------------------


class ProjectFieldOptionCreate(BaseModel):
    """
    Request model for adding an item to a dropdown field (appended at the end).

    Scoped like a tag: ``site_ids`` is only used when the item is restricted;
    an omitted ``all_sites`` with a non-empty ``site_ids`` means
    ``all_sites = false``.
    """

    name: str = Field(..., min_length=1, max_length=100)
    color: str = Field(default="#6366f1", pattern=COLOR_PATTERN)
    all_sites: bool = Field(
        default=True,
        description=(
            "Available at every site. When omitted, a non-empty site_ids restricts the "
            "item to those sites (all_sites=false); an explicit true clears site_ids."
        ),
    )
    site_ids: SiteIds | None = Field(
        default=None,
        description="Sites the item is restricted to (ignored when all_sites is true).",
    )
    team_ids: TeamIds | None = Field(
        default=None,
        description=(
            "Teams the item is limited to. A site with no listed team keeps the whole site; "
            "every team must be at one of the item's sites unless all_sites is true."
        ),
    )


class ProjectFieldOptionUpdate(BaseModel):
    """
    Request model for updating an item (partial).

    An omitted ``all_sites`` with a non-empty ``site_ids`` means
    ``all_sites = false`` (also on an item currently available at every site).
    """

    name: str | None = Field(None, min_length=1, max_length=100)
    color: str | None = Field(None, pattern=COLOR_PATTERN)
    all_sites: bool | None = Field(
        default=None,
        description=(
            "Available at every site. When omitted, a non-empty site_ids restricts the "
            "item to those sites (all_sites=false); an explicit true clears site_ids."
        ),
    )
    site_ids: SiteIds | None = Field(
        default=None,
        description="Sites the item is restricted to (ignored when all_sites is true).",
    )
    team_ids: TeamIds | None = Field(
        default=None,
        description=(
            "Teams the item is limited to. A site with no listed team keeps the whole site; "
            "every team must be at one of the item's sites unless all_sites is true."
        ),
    )


class ProjectFieldOptionReorder(BaseModel):
    """Request model for reordering a field's items: ids in their new order."""

    option_order: list[int] = Field(..., max_length=500)


# ---------------------------------------------------------
# Responses
# ---------------------------------------------------------


class ProjectFieldOptionResponse(BaseModel):
    """An item of a dropdown field."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    color: str
    sort_order: int = 0
    all_sites: bool = True
    site_ids: list[int] = []
    team_ids: list[int] = []


class ProjectFieldResponse(BaseModel):
    """A project field with its items in item order (none for non-dropdown fields)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    field_type: ProjectFieldType
    sort_order: int = 0
    decimals: int | None = None
    options: list[ProjectFieldOptionResponse] = []


class ProjectFieldUsageResponse(BaseModel):
    """How many projects hold a value or an item of a field."""

    projects: int
