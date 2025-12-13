"""
Vacation model for staff time-off tracking.
Maps to the vacations table in PostgreSQL.
"""

from datetime import date, datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.user import User


class Vacation(Base):
    """Vacation model - represents staff time-off periods."""

    __tablename__ = "vacations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    staff_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    description: Mapped[str] = mapped_column(
        String(200), default="Vacation", nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    # Relationships
    staff: Mapped["User"] = relationship("User", back_populates="vacations")

    @property
    def staff_name(self) -> str:
        """Get staff member's full name."""
        return self.staff.full_name if self.staff else ""

    @property
    def duration_days(self) -> int:
        """Calculate duration in days."""
        return (self.end_date - self.start_date).days + 1

    def __repr__(self) -> str:
        return f"<Vacation {self.staff_id} ({self.start_date} to {self.end_date})>"
