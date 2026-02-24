"""
Staff assignment models for projects, phases, and subphases.
Maps to project_assignments, phase_staff_assignments, and subphase_staff_assignments tables.
"""

from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Integer,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.project import Project, ProjectPhase, ProjectSubphase
    from app.models.user import User


class ProjectAssignment(Base):
    """Project-level staff assignment - assigns staff directly to projects."""

    __tablename__ = "project_assignments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    staff_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    allocation: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    # Note: 'notes' column exists in some DBs but not Node.js schema
    # We'll query it dynamically only if needed
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationships
    project: Mapped["Project"] = relationship("Project", back_populates="staff_assignments")
    staff: Mapped["User"] = relationship("User", back_populates="project_assignments")

    @property
    def staff_name(self) -> str:
        """Get staff member's full name."""
        return self.staff.full_name if self.staff else ""

    @property
    def staff_role(self) -> str | None:
        """Get staff member's job title."""
        return self.staff.job_title if self.staff else None

    def __repr__(self) -> str:
        return f"<ProjectAssignment Staff {self.staff_id} -> Project {self.project_id} ({self.allocation}%)>"


class PhaseStaffAssignment(Base):
    """Phase-level staff assignment - assigns staff to specific phases."""

    __tablename__ = "phase_staff_assignments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    phase_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("project_phases.id", ondelete="CASCADE"),
        nullable=False,
    )
    staff_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    allocation: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    # Note: No start_date/end_date - dates come from the phase itself

    # Relationships
    project: Mapped["Project"] = relationship("Project")
    phase: Mapped["ProjectPhase"] = relationship("ProjectPhase", back_populates="staff_assignments")
    staff: Mapped["User"] = relationship("User", back_populates="phase_staff_assignments")

    @property
    def staff_name(self) -> str:
        """Get staff member's full name."""
        return self.staff.full_name if self.staff else ""

    @property
    def staff_role(self) -> str | None:
        """Get staff member's job title."""
        return self.staff.job_title if self.staff else None

    def __repr__(self) -> str:
        return f"<PhaseStaffAssignment Staff {self.staff_id} -> Phase {self.phase_id} ({self.allocation}%)>"


class SubphaseStaffAssignment(Base):
    """Subphase-level staff assignment - assigns staff to specific subphases."""

    __tablename__ = "subphase_staff_assignments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    subphase_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("project_subphases.id", ondelete="CASCADE"),
        nullable=False,
    )
    staff_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    allocation: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    # Note: No start_date/end_date - dates come from the subphase itself

    # Relationships
    project: Mapped["Project"] = relationship("Project")
    subphase: Mapped["ProjectSubphase"] = relationship(
        "ProjectSubphase", back_populates="staff_assignments"
    )
    staff: Mapped["User"] = relationship("User", back_populates="subphase_staff_assignments")

    @property
    def staff_name(self) -> str:
        """Get staff member's full name."""
        return self.staff.full_name if self.staff else ""

    @property
    def staff_role(self) -> str | None:
        """Get staff member's job title."""
        return self.staff.job_title if self.staff else None

    def __repr__(self) -> str:
        return f"<SubphaseStaffAssignment Staff {self.staff_id} -> Subphase {self.subphase_id} ({self.allocation}%)>"
