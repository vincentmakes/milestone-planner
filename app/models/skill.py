"""
Skill model and UserSkill association.
Skills are shared across all sites and can be assigned to users.
"""

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
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
    from app.models.user import User


class Skill(Base):
    """Skill model - represents a skill that can be assigned to staff members."""

    __tablename__ = "skills"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    color: Mapped[str] = mapped_column(
        String(7), default="#6366f1", nullable=False
    )  # Hex color for UI
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    # Relationships
    users: Mapped[list["User"]] = relationship(
        "User",
        secondary="user_skills",
        back_populates="skills",
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return f"<Skill {self.name}>"


class UserSkill(Base):
    """Association table for User-Skill many-to-many relationship."""

    __tablename__ = "user_skills"
    __table_args__ = (
        CheckConstraint(
            "proficiency >= 1 AND proficiency <= 5", name="user_skills_proficiency_check"
        ),
    )

    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    skill_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("skills.id", ondelete="CASCADE"),
        primary_key=True,
    )
    proficiency: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    assigned_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
