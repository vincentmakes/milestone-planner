"""
AbsenceType model.
Absence types categorise vacations (Holidays, Home Office, Illness, ...).
They are tenant-wide (shared across all sites) and managed by admins.
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils import utcnow_naive

# Seeded into an empty absence_types table: (name, color, counts_as_unavailable).
# Home Office is the one type that keeps the person available for planning.
DEFAULT_ABSENCE_TYPES: list[tuple[str, str, bool]] = [
    ("Holidays", "#8b5cf6", True),
    ("Home Office", "#0ea5e9", False),
    ("Illness", "#ef4444", True),
    ("Business Trip", "#f59e0b", True),
    ("Training", "#10b981", True),
]


class AbsenceType(Base):
    """Absence type - a category of staff time-off."""

    __tablename__ = "absence_types"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    color: Mapped[str] = mapped_column(String(7), default="#8b5cf6", nullable=False)
    # False means the person is absent from the office but still available
    # for planning (e.g. Home Office), so capacity is not reduced.
    counts_as_unavailable: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False
    )

    def __repr__(self) -> str:
        return f"<AbsenceType {self.name}>"
