"""
Project, ProjectPhase, and ProjectSubphase models.
Maps to the projects, project_phases, and project_subphases tables in PostgreSQL.
"""

import json
from datetime import date, datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.assignment import (
        PhaseStaffAssignment,
        ProjectAssignment,
        SubphaseStaffAssignment,
    )
    from app.models.equipment import EquipmentAssignment
    from app.models.site import Site
    from app.models.user import User


class Project(Base):
    """Project model - represents R&D projects."""

    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    site_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("sites.id", ondelete="SET NULL"),
        nullable=True,
    )
    customer: Mapped[str | None] = mapped_column(String(200), nullable=True)
    pm_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    sales_pm: Mapped[str | None] = mapped_column(String(200), nullable=True)
    confirmed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    volume: Mapped[float | None] = mapped_column(Float, nullable=True)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    archived: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    # Relationships
    site: Mapped[Optional["Site"]] = relationship("Site", back_populates="projects")

    project_manager: Mapped[Optional["User"]] = relationship(
        "User",
        back_populates="managed_projects",
        foreign_keys=[pm_id],
    )

    phases: Mapped[list["ProjectPhase"]] = relationship(
        "ProjectPhase",
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="ProjectPhase.sort_order, ProjectPhase.start_date",
    )

    subphases: Mapped[list["ProjectSubphase"]] = relationship(
        "ProjectSubphase",
        back_populates="project",
        cascade="all, delete-orphan",
    )

    staff_assignments: Mapped[list["ProjectAssignment"]] = relationship(
        "ProjectAssignment",
        back_populates="project",
        cascade="all, delete-orphan",
    )

    equipment_assignments: Mapped[list["EquipmentAssignment"]] = relationship(
        "EquipmentAssignment",
        back_populates="project",
        cascade="all, delete-orphan",
    )

    @property
    def is_confirmed(self) -> bool:
        """Check if project is confirmed."""
        return self.confirmed == 1

    @property
    def is_archived(self) -> bool:
        """Check if project is archived."""
        return self.archived == 1

    @property
    def pm_name(self) -> str | None:
        """Get project manager's full name."""
        if self.project_manager:
            return self.project_manager.full_name
        return None

    @property
    def site_name(self) -> str | None:
        """Get site name."""
        if self.site:
            return self.site.name
        return None

    def __repr__(self) -> str:
        return f"<Project {self.name} (Site: {self.site_id})>"


class ProjectPhase(Base):
    """Project phase model - represents phases within a project."""

    __tablename__ = "project_phases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    type: Mapped[str] = mapped_column(String(100), nullable=False)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    is_milestone: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completion: Mapped[int | None] = mapped_column(Integer, nullable=True)
    dependencies: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationships
    project: Mapped["Project"] = relationship("Project", back_populates="phases")

    staff_assignments: Mapped[list["PhaseStaffAssignment"]] = relationship(
        "PhaseStaffAssignment",
        back_populates="phase",
        cascade="all, delete-orphan",
    )

    @property
    def is_milestone_phase(self) -> bool:
        """Check if this phase is a milestone."""
        return self.is_milestone == 1

    @property
    def parsed_dependencies(self) -> list[dict]:
        """Parse dependencies from JSON string."""
        if self.dependencies:
            try:
                return json.loads(self.dependencies)
            except json.JSONDecodeError:
                return []
        return []

    def set_dependencies(self, deps: list[dict]) -> None:
        """Set dependencies as JSON string."""
        self.dependencies = json.dumps(deps) if deps else None

    def __repr__(self) -> str:
        return f"<ProjectPhase {self.type} (Project: {self.project_id})>"


class ProjectSubphase(Base):
    """Project subphase model - represents nested phases (recursive)."""

    __tablename__ = "project_subphases"
    __table_args__ = (
        CheckConstraint(
            "parent_type IN ('phase', 'subphase')", name="project_subphases_parent_type_check"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    parent_id: Mapped[int] = mapped_column(Integer, nullable=False)
    parent_type: Mapped[str] = mapped_column(String(20), default="phase", nullable=False)
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    is_milestone: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    depth: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    completion: Mapped[int | None] = mapped_column(Integer, nullable=True)
    dependencies: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationships
    project: Mapped["Project"] = relationship("Project", back_populates="subphases")

    staff_assignments: Mapped[list["SubphaseStaffAssignment"]] = relationship(
        "SubphaseStaffAssignment",
        back_populates="subphase",
        cascade="all, delete-orphan",
    )

    @property
    def is_milestone_phase(self) -> bool:
        """Check if this subphase is a milestone."""
        return self.is_milestone == 1

    @property
    def parsed_dependencies(self) -> list[dict]:
        """Parse dependencies from JSON string."""
        if self.dependencies:
            try:
                return json.loads(self.dependencies)
            except json.JSONDecodeError:
                return []
        return []

    def set_dependencies(self, deps: list[dict]) -> None:
        """Set dependencies as JSON string."""
        self.dependencies = json.dumps(deps) if deps else None

    def __repr__(self) -> str:
        return f"<ProjectSubphase {self.name} (Parent: {self.parent_type}/{self.parent_id})>"
