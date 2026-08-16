"""
Notification model - the in-app notification inbox.

Notifications are persisted per recipient. The WebSocket push (see
ConnectionManager.send_to_user) is only a live hint: the connection manager is
per-process and in-memory, so under more than one worker a user connected to
another process will not receive the live push. The DB row is the source of
truth and the bell reloads on mount / focus.

Due-soon and overdue reminders are NOT stored here - they are derived
client-side from already-loaded project data, which is why `type` has no
`due_soon` value. See frontend/src/hooks/useDerivedDueNotifications.ts.
"""

from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.utils import utcnow_naive

if TYPE_CHECKING:
    from app.models.user import User


class Notification(Base):
    """An in-app notification addressed to one user."""

    __tablename__ = "notifications"
    __table_args__ = (
        CheckConstraint(
            "type IN ('assigned', 'comment', 'mention', 'status_change')",
            name="notifications_type_check",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Recipient. CASCADE: a deleted user's inbox goes with them.
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    type: Mapped[str] = mapped_column(String(30), nullable=False)
    # Who caused it. SET NULL, not CASCADE: deleting the actor must never
    # delete other people's notifications.
    actor_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Nullable so a future non-card notification fits without a schema change.
    entity_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    entity_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    project_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=True,
    )
    # Rendered text, stored. A notification is a historical record - it must not
    # silently rewrite itself when the card it refers to is renamed.
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Nullable timestamp rather than a boolean: gives "when" for free and backs
    # the partial index used by the unread badge.
    read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)

    actor: Mapped[Optional["User"]] = relationship("User", foreign_keys=[actor_id], lazy="noload")

    @property
    def is_read(self) -> bool:
        """Whether the recipient has read this notification."""
        return self.read_at is not None

    def __repr__(self) -> str:
        return f"<Notification {self.type} -> user {self.user_id}>"
