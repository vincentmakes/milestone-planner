"""
CardComment model - comments on Kanban cards (leaf phases/subphases).

The (entity_type, entity_id) pair mirrors custom_column_values: a card is a
phase or a subphase, and there is no FK on entity_id because it is polymorphic.
Deleting a phase/subphase must therefore delete its comments explicitly -
see delete_phase / delete_subphase in app/routers/projects.py.
"""

import json
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.utils import utcnow_naive

if TYPE_CHECKING:
    from app.models.user import User


class CardComment(Base):
    """A comment posted on a Kanban card."""

    __tablename__ = "card_comments"
    __table_args__ = (
        CheckConstraint(
            "entity_type IN ('phase', 'subphase')",
            name="card_comments_entity_type_check",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(String(20), nullable=False)
    entity_id: Mapped[int] = mapped_column(Integer, nullable=False)
    # Denormalised so per-project comment counts are a single indexed scan,
    # and so a project delete cascades to its comments.
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    author_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # JSON array of user ids, following ProjectPhase.dependencies.
    mentioned_user_ids: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False
    )

    # Async sessions blow up on implicit lazy loads; routers join and select
    # author_name explicitly (same reasoning as Note.staff).
    author: Mapped[Optional["User"]] = relationship("User", foreign_keys=[author_id], lazy="noload")

    @property
    def parsed_mentions(self) -> list[int]:
        """Parse mentioned user ids from the JSON string."""
        if self.mentioned_user_ids:
            try:
                parsed = json.loads(self.mentioned_user_ids)
                return [int(uid) for uid in parsed] if isinstance(parsed, list) else []
            except (json.JSONDecodeError, TypeError, ValueError):
                return []
        return []

    def set_mentions(self, user_ids: list[int]) -> None:
        """Store mentioned user ids as a JSON string."""
        self.mentioned_user_ids = json.dumps(user_ids) if user_ids else None

    @property
    def is_edited(self) -> bool:
        """Whether the comment has been edited since it was posted."""
        return self.updated_at > self.created_at

    def __repr__(self) -> str:
        return f"<CardComment {self.id} on {self.entity_type}/{self.entity_id}>"
