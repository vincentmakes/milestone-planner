"""
Tag, TagSite and ProjectTag models.

Tags are tenant-wide labels assignable to projects. A tag is available at
every site (``all_sites``) or only at the sites linked in ``tag_sites``, and
may be limited to teams (``tag_teams``). The tag groups of earlier releases
became dropdown project fields in 2.0.0 (``app/models/project_field.py``).
"""

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.utils import utcnow_naive

if TYPE_CHECKING:
    from app.models.project import Project
    from app.models.site import Site
    from app.models.team import Team


class Tag(Base):
    """Tag model - represents a label that can be assigned to projects."""

    __tablename__ = "tags"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    color: Mapped[str] = mapped_column(
        String(7), default="#6366f1", nullable=False
    )  # Hex color for UI
    # True = available at every site; False = only at the sites in tag_sites.
    all_sites: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False
    )

    # Relationships
    # Sites the tag is restricted to (only consulted when all_sites is false),
    # loaded with the tag (selectin) so responses never trigger a lazy load.
    sites: Mapped[list["Site"]] = relationship(
        "Site",
        secondary="tag_sites",
        lazy="selectin",
        order_by="Site.id",
    )

    # Teams the tag is linked to, loaded with it (selectin) so responses
    # never trigger a lazy load. Rows go with the team / tag (ON DELETE CASCADE).
    teams: Mapped[list["Team"]] = relationship(
        "Team",
        secondary="tag_teams",
        lazy="selectin",
        order_by="Team.id",
        passive_deletes=True,
    )

    projects: Mapped[list["Project"]] = relationship(
        "Project",
        secondary="project_tags",
        back_populates="tags",
    )

    @property
    def site_ids(self) -> list[int]:
        """Ids of the sites the tag is restricted to, ascending."""
        return [site.id for site in self.sites]

    @property
    def team_ids(self) -> list[int]:
        """Ids of the teams the tag is linked to, ascending."""
        return sorted(team.id for team in self.teams)

    def __repr__(self) -> str:
        return f"<Tag {self.name}>"


class TagSite(Base):
    """Association table for the Tag-Site many-to-many relationship."""

    __tablename__ = "tag_sites"
    __table_args__ = (Index("idx_tag_sites_site", "site_id"),)

    tag_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tags.id", ondelete="CASCADE"),
        primary_key=True,
    )
    site_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("sites.id", ondelete="CASCADE"),
        primary_key=True,
    )


class ProjectTag(Base):
    """Association table for Project-Tag many-to-many relationship."""

    __tablename__ = "project_tags"

    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    tag_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tags.id", ondelete="CASCADE"),
        primary_key=True,
    )
    assigned_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)
