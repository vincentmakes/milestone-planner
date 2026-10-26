"""
Equipment, EquipmentSite, EquipmentAssignment and EquipmentBlock models.
Maps to the equipment, equipment_sites, equipment_assignments and
equipment_blocks tables in PostgreSQL.
"""

from datetime import date, datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.utils import utcnow_naive

if TYPE_CHECKING:
    from app.models.project import Project
    from app.models.site import Site
    from app.models.team import Team


class Equipment(Base):
    """
    Equipment model - represents lab equipment and resources.

    Equipment can be shared by several sites; the links live in equipment_sites.
    """

    __tablename__ = "equipment"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # Legacy single-site column, kept for compatibility: always the first
    # linked site. equipment_sites is the source of truth.
    site_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("sites.id", ondelete="SET NULL"),
        nullable=True,
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    active: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)

    # Relationships
    site: Mapped[Optional["Site"]] = relationship("Site", back_populates="equipment")

    # Every site the equipment belongs to, loaded with the equipment (selectin)
    # so responses never trigger a lazy load. Ordered by id: site_id is the first.
    sites: Mapped[list["Site"]] = relationship(
        "Site",
        secondary="equipment_sites",
        lazy="selectin",
        order_by="Site.id",
    )

    # Teams the equipment is linked to, loaded with it (selectin) so responses
    # never trigger a lazy load. Rows go with the team / equipment (ON DELETE CASCADE).
    teams: Mapped[list["Team"]] = relationship(
        "Team",
        secondary="equipment_teams",
        lazy="selectin",
        order_by="Team.id",
        passive_deletes=True,
    )

    assignments: Mapped[list["EquipmentAssignment"]] = relationship(
        "EquipmentAssignment",
        back_populates="equipment",
        cascade="all, delete-orphan",
    )

    blocks: Mapped[list["EquipmentBlock"]] = relationship(
        "EquipmentBlock",
        back_populates="equipment",
        cascade="all, delete-orphan",
    )

    @property
    def is_active(self) -> bool:
        """Check if equipment is active."""
        return self.active == 1

    @property
    def site_name(self) -> str | None:
        """Get site name."""
        if self.site:
            return self.site.name
        return None

    @property
    def site_ids(self) -> list[int]:
        """Ids of every linked site, ascending (the first one is site_id)."""
        return [site.id for site in self.sites]

    @property
    def team_ids(self) -> list[int]:
        """Ids of the teams the equipment is linked to, ascending."""
        return sorted(team.id for team in self.teams)

    def __repr__(self) -> str:
        return f"<Equipment {self.name} ({self.type})>"


class EquipmentSite(Base):
    """Association table for Equipment-Site many-to-many relationship."""

    __tablename__ = "equipment_sites"
    __table_args__ = (Index("idx_equipment_sites_site", "site_id"),)

    equipment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("equipment.id", ondelete="CASCADE"),
        primary_key=True,
    )
    site_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("sites.id", ondelete="CASCADE"),
        primary_key=True,
    )


class EquipmentAssignment(Base):
    """Equipment assignment model - represents equipment bookings for projects."""

    __tablename__ = "equipment_assignments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    equipment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("equipment.id", ondelete="CASCADE"),
        nullable=False,
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    # Optional free text written with the booking (2.0.0): shown in the
    # booking dialog, the PM's notification and the site export.
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)

    # Relationships
    project: Mapped["Project"] = relationship("Project", back_populates="equipment_assignments")
    equipment: Mapped["Equipment"] = relationship("Equipment", back_populates="assignments")

    @property
    def equipment_name(self) -> str:
        """Get equipment name."""
        return self.equipment.name if self.equipment else ""

    @property
    def equipment_type(self) -> str | None:
        """Get equipment type."""
        return self.equipment.type if self.equipment else None

    def __repr__(self) -> str:
        return f"<EquipmentAssignment {self.equipment_id} -> Project {self.project_id}>"


class EquipmentBlock(Base):
    """
    Equipment block - represents periods when equipment is unavailable
    due to maintenance, defects, calibration, etc. Equivalent to staff vacations.
    """

    __tablename__ = "equipment_blocks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    equipment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("equipment.id", ondelete="CASCADE"),
        nullable=False,
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    reason: Mapped[str] = mapped_column(String(50), default="maintenance", nullable=False)
    description: Mapped[str] = mapped_column(String(200), default="Maintenance", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)

    equipment: Mapped["Equipment"] = relationship("Equipment", back_populates="blocks")

    @property
    def equipment_name(self) -> str:
        return self.equipment.name if self.equipment else ""

    @property
    def duration_days(self) -> int:
        return (self.end_date - self.start_date).days + 1

    def __repr__(self) -> str:
        return f"<EquipmentBlock {self.equipment_id} ({self.start_date} to {self.end_date})>"
