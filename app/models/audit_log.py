"""
Audit log (2.4.0): one immutable row per security, administrative or content
action of the tenant -- a sign-in, a failed attempt, a sign-out, an admin
changing a user, a role or a setting, an export, a project or booking change.

Mirrors turbo-ea's "Security & admin log" (``audit_log``). Written only by
``app/services/audit_log.record`` and never updated: no route updates or
deletes a row; only the retention purge removes them. ``actor_user_id``
references the user who acted (``ON DELETE SET NULL``); ``actor_email`` and
``actor_name`` are snapshots, so the row still names the actor after the user
is deleted. ``project_id`` has no foreign key on purpose: the row outlives the
project. ``details`` is JSON **text** (``reason`` / ``changes`` / ``items`` /
``context``, see the service) -- never JSONB on a tenant model: SQLite
``create_all`` cannot render it. Instance-wide: no site column, no site-export
sheet.

The DDL lives in app/services/tenant_provisioner.py
(AUDIT_LOG_SCHEMA_STATEMENTS); tests/test_audit_log_schema.py keeps the two in
step, column for column.
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils import utcnow_naive

# What a row may say. The service (app/services/audit_log.py) validates
# against the same tuples, and the CHECKs of every DDL source spell them.
AUDIT_LOG_CATEGORIES: tuple[str, ...] = ("auth", "admin", "access", "change")
AUDIT_LOG_OUTCOMES: tuple[str, ...] = ("success", "failure")


def _in(column: str, values: tuple[str, ...]) -> str:
    """CHECK text ``column IN ('a', 'b')``, spelled exactly as in the DDL."""
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


class AuditLog(Base):
    """One recorded action: who, what, on what, from where, and how it went."""

    __tablename__ = "audit_log"
    __table_args__ = (
        CheckConstraint(_in("category", AUDIT_LOG_CATEGORIES), name="audit_log_category_check"),
        CheckConstraint(_in("outcome", AUDIT_LOG_OUTCOMES), name="audit_log_outcome_check"),
        Index("ix_audit_log_created_at", "created_at"),
        Index("ix_audit_log_category_created_at", "category", "created_at"),
        Index("ix_audit_log_action", "action"),
        Index("ix_audit_log_actor_user_id", "actor_user_id"),
        Index("ix_audit_log_subject_email", "subject_email"),
        Index("ix_audit_log_ip", "ip"),
        Index("ix_audit_log_project_id", "project_id"),
    )

    # BIGSERIAL on PostgreSQL; INTEGER on SQLite, the only type its
    # autoincrement accepts (the SQLite-backed tests).
    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=utcnow_naive,
        server_default=text("CURRENT_TIMESTAMP"),
        nullable=False,
    )
    category: Mapped[str] = mapped_column(String(16), nullable=False)
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    outcome: Mapped[str] = mapped_column(
        String(16), default="success", server_default=text("'success'"), nullable=False
    )
    actor_user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Snapshots, so the row still names the actor after the user is deleted.
    actor_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    actor_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # The account acted upon: the email a failed login tried, the user edited.
    subject_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # No foreign key: a role key, a setting key, a user id, a phase id.
    target_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    target_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    target_label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # No foreign key: the row outlives the project.
    project_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # ``web`` (a request) or ``system`` (work outside any request).
    origin: Mapped[str] = mapped_column(
        String(20), default="web", server_default=text("'web'"), nullable=False
    )
    # Compact JSON text of reason / changes / items / context; secrets masked
    # at write time. NULL when there is nothing to say.
    details: Mapped[str | None] = mapped_column(Text, nullable=True)

    def __repr__(self) -> str:
        return f"<AuditLog {self.action} ({self.outcome})>"
