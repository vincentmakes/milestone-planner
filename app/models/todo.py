"""
Todo model - a personal or assigned task (My Todos).

A todo belongs to its assignee; it may be linked to a project and to one of its
cards (a phase or subphase, polymorphic ``entity_type`` / ``entity_id`` like
card comments, so no FK on ``entity_id``). Approval requests a user may decide
are NOT stored here: My Todos merges them in at read time.
"""

from datetime import date, datetime

from sqlalchemy import CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils import utcnow_naive

TODO_STATUSES: tuple[str, ...] = ("open", "done", "cancelled")
TODO_ENTITY_TYPES: tuple[str, ...] = ("phase", "subphase")


class Todo(Base):
    """A task assigned to one user."""

    __tablename__ = "todos"
    __table_args__ = (
        CheckConstraint(
            "status IN (" + ", ".join(f"'{s}'" for s in TODO_STATUSES) + ")",
            name="todos_status_check",
        ),
        CheckConstraint(
            "entity_type IN (" + ", ".join(f"'{t}'" for t in TODO_ENTITY_TYPES) + ")",
            name="todos_entity_type_check",
        ),
        Index("idx_todos_assignee_status", "assignee_id", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    # CASCADE: a deleted user's todos go with them.
    assignee_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    # SET NULL: the todo outlives the person who created it.
    created_by: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    status: Mapped[str] = mapped_column(
        String(10), default="open", server_default="open", nullable=False
    )
    project_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=True,
    )
    entity_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    entity_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False
    )

    @property
    def is_open(self) -> bool:
        """Whether the todo is still to do."""
        return self.status == "open"

    def __repr__(self) -> str:
        return f"<Todo {self.id} -> user {self.assignee_id} ({self.status})>"
