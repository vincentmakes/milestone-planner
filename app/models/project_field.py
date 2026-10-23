"""
Project fields: instance-wide custom fields on projects (2.0.0).

A ``ProjectField`` is ``text``, ``number``, ``toggle``, ``select`` or
``multiselect``. Dropdown fields (select / multiselect) carry items
(``ProjectFieldOption``), each available at every site (``all_sites``) or only
at the sites in ``project_field_option_sites``, and optionally limited to
teams (``project_field_option_teams``; per site, no team row = the whole
site) -- the rules of tags. A project's text / number / toggle value is one
``ProjectFieldValue`` row (absent = empty); its chosen items are rows of
``project_field_selections`` (the ``project_tags`` shape).

Tag groups were converted into dropdown fields by the 2.0.0 data migration
(``tenant_provisioner.PROJECT_FIELDS_MIGRATION_SQL``). Every foreign key
cascades.
"""

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Double,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.utils import utcnow_naive

if TYPE_CHECKING:
    from app.models.site import Site
    from app.models.team import Team

PROJECT_FIELD_TYPES: tuple[str, ...] = ("text", "number", "toggle", "select", "multiselect")
# The types whose values are items (project_field_selections).
DROPDOWN_FIELD_TYPES: frozenset[str] = frozenset({"select", "multiselect"})


class ProjectField(Base):
    """A custom field on projects (e.g. "Project type", "Budget")."""

    __tablename__ = "project_fields"
    __table_args__ = (
        CheckConstraint(
            "field_type IN ('text', 'number', 'toggle', 'select', 'multiselect')",
            name="project_fields_type_check",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    field_type: Mapped[str] = mapped_column(String(20), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False
    )

    # The items of a dropdown field in display order, loaded with the field
    # (selectin) so responses never trigger a lazy load. Rows go with the
    # field (ON DELETE CASCADE).
    options: Mapped[list["ProjectFieldOption"]] = relationship(
        "ProjectFieldOption",
        lazy="selectin",
        order_by="ProjectFieldOption.sort_order, ProjectFieldOption.id",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    @property
    def is_dropdown(self) -> bool:
        """Whether the field's values are items (select / multiselect)."""
        return self.field_type in DROPDOWN_FIELD_TYPES

    def __repr__(self) -> str:
        return f"<ProjectField {self.name} ({self.field_type})>"


class ProjectFieldOption(Base):
    """An item of a dropdown field (select / multiselect)."""

    __tablename__ = "project_field_options"
    __table_args__ = (
        UniqueConstraint("field_id", "name", name="project_field_options_field_name_unique"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    field_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("project_fields.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    color: Mapped[str] = mapped_column(String(7), default="#6366f1", nullable=False)
    # True = available at every site; False = only at the sites linked in
    # project_field_option_sites.
    all_sites: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False
    )

    # Sites the item is restricted to (only consulted when all_sites is false)
    # and the teams it is limited to, loaded with it (selectin) so responses
    # never trigger a lazy load. Rows go with the site / team / item.
    sites: Mapped[list["Site"]] = relationship(
        "Site",
        secondary="project_field_option_sites",
        lazy="selectin",
        order_by="Site.id",
        passive_deletes=True,
    )
    teams: Mapped[list["Team"]] = relationship(
        "Team",
        secondary="project_field_option_teams",
        lazy="selectin",
        order_by="Team.id",
        passive_deletes=True,
    )

    @property
    def site_ids(self) -> list[int]:
        """Ids of the sites the item is restricted to, ascending."""
        return sorted(site.id for site in self.sites)

    @property
    def team_ids(self) -> list[int]:
        """Ids of the teams the item is limited to, ascending."""
        return sorted(team.id for team in self.teams)

    def __repr__(self) -> str:
        return f"<ProjectFieldOption {self.name}>"


class ProjectFieldOptionSite(Base):
    """Association table for the ProjectFieldOption-Site many-to-many relationship."""

    __tablename__ = "project_field_option_sites"
    __table_args__ = (Index("idx_project_field_option_sites_site", "site_id"),)

    option_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("project_field_options.id", ondelete="CASCADE"),
        primary_key=True,
    )
    site_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("sites.id", ondelete="CASCADE"),
        primary_key=True,
    )


class ProjectFieldOptionTeam(Base):
    """Association table for the ProjectFieldOption-Team many-to-many relationship."""

    __tablename__ = "project_field_option_teams"
    __table_args__ = (Index("idx_project_field_option_teams_team", "team_id"),)

    option_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("project_field_options.id", ondelete="CASCADE"),
        primary_key=True,
    )
    team_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("teams.id", ondelete="CASCADE"),
        primary_key=True,
    )


class ProjectFieldValue(Base):
    """A project's value of a text, number or toggle field (absent = empty)."""

    __tablename__ = "project_field_values"
    __table_args__ = (
        UniqueConstraint(
            "field_id", "project_id", name="project_field_values_field_project_unique"
        ),
        Index("idx_project_field_values_project", "project_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    field_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("project_fields.id", ondelete="CASCADE"),
        nullable=False,
    )
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    value_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    value_number: Mapped[float | None] = mapped_column(Double, nullable=True)
    value_bool: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False
    )

    def __repr__(self) -> str:
        return f"<ProjectFieldValue field={self.field_id} project={self.project_id}>"


class ProjectFieldSelection(Base):
    """Association table: the items a project holds for its dropdown fields."""

    __tablename__ = "project_field_selections"
    __table_args__ = (Index("idx_project_field_selections_option", "option_id"),)

    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    option_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("project_field_options.id", ondelete="CASCADE"),
        primary_key=True,
    )
    assigned_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)
