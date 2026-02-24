"""
User and UserSite models.
Maps to the users and user_sites tables in PostgreSQL.
"""

from datetime import datetime
from typing import TYPE_CHECKING, List, Optional

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.site import Site
    from app.models.project import Project
    from app.models.assignment import ProjectAssignment, PhaseStaffAssignment, SubphaseStaffAssignment
    from app.models.vacation import Vacation
    from app.models.skill import Skill


class User(Base):
    """User model - represents application users who can also be staff resources."""

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(
            "role IN ('admin', 'superuser', 'user')",
            name="users_role_check"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    password: Mapped[str] = mapped_column(String(255), nullable=False)
    first_name: Mapped[str] = mapped_column(String(100), nullable=False)
    last_name: Mapped[str] = mapped_column(String(100), nullable=False)
    job_title: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    role: Mapped[str] = mapped_column(String(20), default="user", nullable=False)
    max_capacity: Mapped[int] = mapped_column(Integer, default=100, nullable=False)  # Max work capacity % (e.g., 80 for part-time)
    sso_provider: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    sso_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    active: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    is_system: Mapped[Optional[int]] = mapped_column(Integer, default=0, nullable=True)  # Protected admin created by master panel
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    # Relationships
    sites: Mapped[List["Site"]] = relationship(
        "Site",
        secondary="user_sites",
        back_populates="users",
        lazy="selectin",
    )
    
    managed_projects: Mapped[List["Project"]] = relationship(
        "Project",
        back_populates="project_manager",
        foreign_keys="Project.pm_id",
    )
    
    project_assignments: Mapped[List["ProjectAssignment"]] = relationship(
        "ProjectAssignment",
        back_populates="staff",
        cascade="all, delete-orphan",
    )
    
    phase_staff_assignments: Mapped[List["PhaseStaffAssignment"]] = relationship(
        "PhaseStaffAssignment",
        back_populates="staff",
        cascade="all, delete-orphan",
    )
    
    subphase_staff_assignments: Mapped[List["SubphaseStaffAssignment"]] = relationship(
        "SubphaseStaffAssignment",
        back_populates="staff",
        cascade="all, delete-orphan",
    )
    
    vacations: Mapped[List["Vacation"]] = relationship(
        "Vacation",
        back_populates="staff",
        cascade="all, delete-orphan",
    )
    
    skills: Mapped[List["Skill"]] = relationship(
        "Skill",
        secondary="user_skills",
        back_populates="users",
        lazy="selectin",
    )

    @property
    def full_name(self) -> str:
        """Return full name combining first and last name."""
        return f"{self.first_name} {self.last_name}".strip()

    @property
    def is_active(self) -> bool:
        """Check if user is active."""
        return self.active == 1

    @property
    def is_system_user(self) -> bool:
        """Check if user is a system-created admin (protected from deletion)."""
        return self.is_system == 1 if self.is_system is not None else False

    @property
    def is_admin(self) -> bool:
        """Check if user has admin role."""
        return self.role == "admin"

    @property
    def is_superuser(self) -> bool:
        """Check if user has superuser role."""
        return self.role == "superuser"

    @property
    def site_ids(self) -> List[int]:
        """Get list of site IDs user has access to."""
        return [site.id for site in self.sites]

    def can_modify_site(self, site_id: int) -> bool:
        """Check if user can modify data for a specific site."""
        if self.is_admin:
            return True
        if self.is_superuser:
            return site_id in self.site_ids
        return False

    def __repr__(self) -> str:
        return f"<User {self.email} ({self.role})>"


class UserSite(Base):
    """Association table for User-Site many-to-many relationship."""

    __tablename__ = "user_sites"

    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    site_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("sites.id", ondelete="CASCADE"),
        primary_key=True,
    )
