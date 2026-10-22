"""
User and UserSite models.
Maps to the users and user_sites tables in PostgreSQL.
"""

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    select,
)
from sqlalchemy.orm import Mapped, column_property, mapped_column, relationship

from app.database import Base
from app.models.rbac import Role
from app.services.permissions import PermissionSet
from app.utils import utcnow_naive

if TYPE_CHECKING:
    from app.models.assignment import (
        PhaseStaffAssignment,
        ProjectAssignment,
        SubphaseStaffAssignment,
    )
    from app.models.project import Project
    from app.models.site import Site
    from app.models.skill import Skill
    from app.models.team import Team
    from app.models.vacation import Vacation


class User(Base):
    """User model - represents application users who can also be staff resources."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    password: Mapped[str] = mapped_column(String(255), nullable=False)
    first_name: Mapped[str] = mapped_column(String(100), nullable=False)
    last_name: Mapped[str] = mapped_column(String(100), nullable=False)
    job_title: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # A role key (roles.key). The admin role is the one key "admin"; every
    # other role's rights come from its role_permissions rows.
    role: Mapped[str] = mapped_column(
        String(20),
        ForeignKey("roles.key", name="users_role_fkey", onupdate="CASCADE", ondelete="RESTRICT"),
        default="user",
        nullable=False,
    )
    # The role's display name, read in the same SELECT as the user (a
    # correlated scalar subquery on the unique roles.key, no extra round trip).
    # None on a user not loaded from the database.
    role_name: Mapped[str | None] = column_property(
        select(Role.name).where(Role.key == role).correlate_except(Role).scalar_subquery()
    )
    max_capacity: Mapped[int] = mapped_column(
        Integer, default=100, nullable=False
    )  # Max work capacity % (e.g., 80 for part-time)
    sso_provider: Mapped[str | None] = mapped_column(String(50), nullable=True)
    sso_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    active: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    # Bookable as a resource: may be booked on projects and appears in the Staff panel
    is_resource: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_system: Mapped[int | None] = mapped_column(
        Integer, default=0, nullable=True
    )  # Protected admin created by master panel
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False
    )

    # Relationships
    sites: Mapped[list["Site"]] = relationship(
        "Site",
        secondary="user_sites",
        back_populates="users",
        lazy="selectin",
    )

    managed_projects: Mapped[list["Project"]] = relationship(
        "Project",
        back_populates="project_manager",
        foreign_keys="Project.pm_id",
    )

    project_assignments: Mapped[list["ProjectAssignment"]] = relationship(
        "ProjectAssignment",
        back_populates="staff",
        cascade="all, delete-orphan",
    )

    phase_staff_assignments: Mapped[list["PhaseStaffAssignment"]] = relationship(
        "PhaseStaffAssignment",
        back_populates="staff",
        cascade="all, delete-orphan",
    )

    subphase_staff_assignments: Mapped[list["SubphaseStaffAssignment"]] = relationship(
        "SubphaseStaffAssignment",
        back_populates="staff",
        cascade="all, delete-orphan",
    )

    vacations: Mapped[list["Vacation"]] = relationship(
        "Vacation",
        back_populates="staff",
        cascade="all, delete-orphan",
    )

    skills: Mapped[list["Skill"]] = relationship(
        "Skill",
        secondary="user_skills",
        back_populates="users",
        lazy="selectin",
    )

    # Teams the user is a member of, loaded with the user (selectin) so
    # responses never trigger a lazy load. Rows go with the team / user (ON DELETE CASCADE).
    teams: Mapped[list["Team"]] = relationship(
        "Team",
        secondary="team_members",
        back_populates="members",
        lazy="selectin",
        order_by="Team.id",
        passive_deletes=True,
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
    def permissions(self) -> PermissionSet:
        """
        The user's permission set (not mapped).

        ``get_current_user`` sets the live one; until then it is the set of
        ``role`` without rows (the admin holds everything, anyone else only
        the locked view), so an unresolved user is denied rather than trusted.
        """
        resolved: PermissionSet | None = getattr(self, "_permission_set", None)
        if resolved is None or resolved.role_key != self.role:
            return PermissionSet(self.role or "", {})
        return resolved

    @permissions.setter
    def permissions(self, value: PermissionSet) -> None:
        self._permission_set = value

    @property
    def site_ids(self) -> list[int]:
        """Get list of site IDs user has access to."""
        return [site.id for site in self.sites]

    @property
    def team_ids(self) -> list[int]:
        """Ids of the teams the user is a member of, ascending."""
        return sorted(team.id for team in self.teams)

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
