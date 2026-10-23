"""
Role-based access control and approval models.

- ``roles``: the system roles (``admin``, ``superuser``, ``user``; seeded,
  never deletable) and the custom roles an admin creates. ``users.role`` holds
  a role **key** (FK ``users_role_fkey`` -> ``roles.key``, ``ON UPDATE CASCADE
  ON DELETE RESTRICT``). Keys are immutable after creation.
- ``role_permissions``: one row per (role, permission key) with mode
  ``allow`` or ``approval``; no row = deny. The ``admin`` role has no rows:
  code grants it everything (see app/services/permissions.py).
- ``approval_policies`` / ``approval_policy_roles``: per approvable action,
  whether the project manager approves and which roles may approve.
- ``approval_requests``: one request per own-booking change awaiting a
  decision. ``assignment_id`` points into one of the three assignment tables
  (chosen by ``level``), so it has no FK; the pending assignment row points
  back through its ``approval_request_id``.

The DDL lives in app/services/tenant_provisioner.py (RBAC_SCHEMA_STATEMENTS);
tests/test_rbac_schema_sources.py keeps the two in step.
"""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    false,
    text,
    true,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.utils import utcnow_naive

# approval_requests.level: which assignment table assignment_id points into.
REQUEST_LEVELS: tuple[str, ...] = ("project", "phase", "subphase")
REQUEST_STATUSES: tuple[str, ...] = (
    "pending",
    "approved",
    "rejected",
    "cancelled",
    "superseded",
    "expired",
)
# Why a request was closed without a decision (status cancelled / expired).
CLOSE_REASONS: tuple[str, ...] = (
    "target_deleted",
    "requester_inactive",
    "permission_lost",
    "overtaken",
    "duplicate",
)


def _in(column: str, values: tuple[str, ...]) -> str:
    """CHECK text ``column IN ('a', 'b')``, spelled exactly as in the DDL."""
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


class Role(Base):
    """A role: a named set of permission modes held by users (``users.role`` = key)."""

    __tablename__ = "roles"
    __table_args__ = (CheckConstraint("key ~ '^[a-z][a-z0-9_]{1,19}$'", name="roles_key_format"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_system: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false(), nullable=False
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False
    )

    # Loaded with the role (a role is always read with its matrix). Rows go
    # with the role (ON DELETE CASCADE) and with the collection.
    permissions: Mapped[list["RolePermission"]] = relationship(
        "RolePermission",
        back_populates="role",
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
        order_by="RolePermission.permission",
    )

    @property
    def permission_modes(self) -> dict[str, str]:
        """``{permission key: mode}`` of this role's rows (deny = absent)."""
        return {row.permission: row.mode for row in self.permissions}

    def __repr__(self) -> str:
        return f"<Role {self.key}>"


class RolePermission(Base):
    """One granted permission of a role: mode ``allow`` or ``approval``."""

    __tablename__ = "role_permissions"
    __table_args__ = (
        CheckConstraint("mode IN ('allow', 'approval')", name="role_permissions_mode_check"),
    )

    role_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("roles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    permission: Mapped[str] = mapped_column(String(60), primary_key=True)
    mode: Mapped[str] = mapped_column(
        String(10), default="allow", server_default="allow", nullable=False
    )

    role: Mapped["Role"] = relationship("Role", back_populates="permissions")

    def __repr__(self) -> str:
        return f"<RolePermission {self.role_id} {self.permission}={self.mode}>"


class ApprovalPolicy(Base):
    """Who approves an approvable action: the project manager and/or roles."""

    __tablename__ = "approval_policies"

    action: Mapped[str] = mapped_column(String(60), primary_key=True)
    pm_approves: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=true(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False
    )

    roles: Mapped[list["Role"]] = relationship(
        "Role",
        secondary="approval_policy_roles",
        lazy="selectin",
        order_by="Role.id",
        passive_deletes=True,
    )

    @property
    def role_ids(self) -> list[int]:
        """Ids of the roles whose holders may approve, ascending."""
        return sorted(role.id for role in self.roles)

    def __repr__(self) -> str:
        return f"<ApprovalPolicy {self.action} pm={self.pm_approves}>"


class ApprovalPolicyRole(Base):
    """Approval policy <-> approver role link (many-to-many)."""

    __tablename__ = "approval_policy_roles"
    __table_args__ = (Index("idx_approval_policy_roles_role", "role_id"),)

    action: Mapped[str] = mapped_column(
        String(60),
        ForeignKey("approval_policies.action", ondelete="CASCADE"),
        primary_key=True,
    )
    role_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("roles.id", ondelete="CASCADE"),
        primary_key=True,
    )


class ApprovalRequest(Base):
    """A requester's own booking change awaiting (or past) an approver's decision."""

    __tablename__ = "approval_requests"
    __table_args__ = (
        CheckConstraint(_in("level", REQUEST_LEVELS), name="approval_requests_level_check"),
        CheckConstraint(_in("status", REQUEST_STATUSES), name="approval_requests_status_check"),
        CheckConstraint(
            _in("close_reason", CLOSE_REASONS), name="approval_requests_close_reason_check"
        ),
        Index("idx_approval_requests_project_status", "project_id", "status"),
        Index("idx_approval_requests_requester_status", "requester_id", "status"),
        Index(
            "idx_approval_requests_pending",
            "status",
            postgresql_where=text("status = 'pending'"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    requester_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    # An approvable permission key (app.services.permissions.APPROVABLE_KEYS).
    action: Mapped[str] = mapped_column(String(60), nullable=False)
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    level: Mapped[str] = mapped_column(String(10), nullable=False)
    # The project, phase or subphase id (by level).
    target_id: Mapped[int] = mapped_column(Integer, nullable=False)
    # Row in project_assignments / phase_staff_assignments /
    # subphase_staff_assignments (by level); no FK across three tables.
    assignment_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # JSON: the intended {allocation, start_date, end_date} and the values
    # they replace.
    requested: Mapped[str | None] = mapped_column(Text, nullable=True)
    previous: Mapped[str | None] = mapped_column(Text, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(12), default="pending", server_default="pending", nullable=False
    )
    close_reason: Mapped[str | None] = mapped_column(String(20), nullable=True)
    decided_by: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    decision_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    superseded_by_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("approval_requests.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False
    )

    @property
    def is_pending(self) -> bool:
        """Whether the request still awaits a decision."""
        return self.status == "pending"

    def __repr__(self) -> str:
        return f"<ApprovalRequest {self.id} {self.action} {self.status}>"
