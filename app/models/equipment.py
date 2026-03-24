"""
Equipment and EquipmentAssignment models.
Maps to the equipment and equipment_assignments tables in PostgreSQL.
"""

from datetime import date, datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.project import Project
    from app.models.site import Site


class Equipment(Base):
    """Equipment model - represents lab equipment and resources."""

    __tablename__ = "equipment"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    site_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("sites.id", ondelete="SET NULL"),
        nullable=True,
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    active: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationships
    site: Mapped[Optional["Site"]] = relationship("Site", back_populates="equipment")

    assignments: Mapped[list["EquipmentAssignment"]] = relationship(
        "EquipmentAssignment",
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

    def __repr__(self) -> str:
        return f"<Equipment {self.name} ({self.type})>"


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
    # Note: 'notes' column not in Node.js schema for equipment_assignments
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

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
