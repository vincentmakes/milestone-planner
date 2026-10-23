"""
Pydantic schemas for Equipment.
"""

from datetime import date

from pydantic import BaseModel, Field, model_validator

from app.schemas.base import DateAsDateTimeJS, DateRangeOrdered, DateTimeJS
from app.schemas.team import TeamIds


class EquipmentResponse(BaseModel):
    """
    Response model for equipment.

    Equipment can belong to several sites (``site_ids``). ``site_id`` and
    ``site_name`` are one of them: the row's site in per-site listings
    (GET /equipment returns one row per equipment-site pair), otherwise the
    primary (first) site. ``team_ids`` / ``team_names``: the teams it is
    limited to; a site with none of them keeps the whole site.
    """

    id: int
    name: str
    type: str | None = None
    site_id: int | None = None
    site_name: str | None = None
    site_ids: list[int] = []
    site_names: list[str] = []
    team_ids: list[int] = []
    team_names: list[str] = []
    description: str | None = None
    active: int = 1
    created_at: DateTimeJS

    class Config:
        from_attributes = True


class EquipmentCreate(BaseModel):
    """
    Request model for creating equipment.

    ``site_ids`` lists every site the equipment belongs to. Clients that
    predate multi-site equipment send ``site_id`` instead, which is taken as
    the single site. At least one site is required. ``team_ids`` limits it to
    teams at its sites (a site with no listed team keeps the whole site).
    """

    name: str = Field(..., min_length=1, max_length=200)
    type: str | None = Field(None, max_length=100)
    site_id: int | None = None
    site_ids: list[int] | None = Field(None, min_length=1)
    team_ids: TeamIds | None = None
    description: str | None = None

    @model_validator(mode="after")
    def _resolve_sites(self) -> "EquipmentCreate":
        if self.site_ids is None:
            if self.site_id is None:
                raise ValueError("At least one site is required")
            self.site_ids = [self.site_id]
        return self

    @property
    def resolved_site_ids(self) -> list[int]:
        """Site ids after the legacy ``site_id`` fallback (never empty)."""
        return list(self.site_ids or [])


class EquipmentUpdate(BaseModel):
    """
    Request model for updating equipment.

    ``site_ids``, when given, replaces the equipment's site links (legacy
    ``site_id`` alone is taken as a single-site replacement). ``team_ids``,
    when given, replaces its teams (each at one of its sites); a site change
    alone drops the teams of the removed sites.
    """

    name: str | None = Field(None, min_length=1, max_length=200)
    type: str | None = Field(None, max_length=100)
    site_id: int | None = None
    site_ids: list[int] | None = Field(None, min_length=1)
    team_ids: TeamIds | None = None
    description: str | None = None
    active: int | None = None

    @model_validator(mode="after")
    def _resolve_sites(self) -> "EquipmentUpdate":
        if self.site_ids is None and self.site_id is not None:
            self.site_ids = [self.site_id]
        return self


class EquipmentAssignmentResponse(BaseModel):
    """Response model for equipment assignments."""

    id: int
    project_id: int
    project_name: str | None = None
    project_site_id: int | None = None
    equipment_id: int
    start_date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS
    created_at: DateTimeJS

    class Config:
        from_attributes = True


class EquipmentAssignmentCreate(DateRangeOrdered):
    """Request model for creating equipment assignment."""

    equipment_id: int
    start_date: date
    end_date: date


class EquipmentAssignmentUpdate(DateRangeOrdered):
    """Request model for updating equipment assignment."""

    equipment_id: int | None = None
    start_date: date | None = None
    end_date: date | None = None


class EquipmentBlockResponse(BaseModel):
    """Response model for equipment blocks (maintenance / defect periods)."""

    id: int
    equipment_id: int
    equipment_name: str = ""
    start_date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS
    reason: str = "maintenance"
    description: str = "Maintenance"
    created_at: DateTimeJS

    class Config:
        from_attributes = True


class EquipmentBlockCreate(BaseModel):
    """Request model for creating an equipment block."""

    equipment_id: int
    start_date: date
    end_date: date
    reason: str | None = Field(default="maintenance", max_length=50)
    description: str | None = Field(default="Maintenance", max_length=200)


class EquipmentBlockUpdate(BaseModel):
    """Request model for updating an equipment block."""

    start_date: date | None = None
    end_date: date | None = None
    reason: str | None = Field(None, max_length=50)
    description: str | None = Field(None, max_length=200)
