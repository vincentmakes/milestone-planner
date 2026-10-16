"""
Tag, TagGroup, TagSite and ProjectTag models.

Tags are tenant-wide labels assignable to projects. A tag may belong to a
group (``tag_groups``): a single-select group allows at most one of its tags
per project. A tag is available at every site (``all_sites``) or only at the
sites linked in ``tag_sites``.
"""

from datetime import datetime
from typing import TYPE_CHECKING, Optional

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


class TagGroup(Base):
    """A named group of tags (e.g. "Project type")."""

    __tablename__ = "tag_groups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    single_select: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False
    )

    def __repr__(self) -> str:
        return f"<TagGroup {self.name}>"


class Tag(Base):
    """Tag model - represents a label that can be assigned to projects."""

    __tablename__ = "tags"
    __table_args__ = (Index("idx_tags_group", "group_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    color: Mapped[str] = mapped_column(
        String(7), default="#6366f1", nullable=False
    )  # Hex color for UI
    group_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("tag_groups.id", ondelete="SET NULL"),
        nullable=True,
    )
    # True = available at every site; False = only at the sites in tag_sites.
    all_sites: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False
    )

    # Relationships
    # Many-to-one, joined so the group's rules (single_select) are always at
    # hand without a lazy load (which an AsyncSession cannot do).
    group: Mapped[Optional["TagGroup"]] = relationship("TagGroup", lazy="joined")

    # Sites the tag is restricted to (only consulted when all_sites is false),
    # loaded with the tag (selectin) so responses never trigger a lazy load.
    sites: Mapped[list["Site"]] = relationship(
        "Site",
        secondary="tag_sites",
        lazy="selectin",
        order_by="Site.id",
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
