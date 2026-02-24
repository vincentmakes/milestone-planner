"""
Project Presence model for tracking active viewers.
Used to show who is currently viewing/editing a project.
"""

from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.project import Project
    from app.models.user import User


class ProjectPresence(Base):
    """
    Tracks which users are currently viewing/editing a project.
    
    Records are automatically cleaned up after PRESENCE_TIMEOUT_SECONDS of inactivity.
    Frontend should send heartbeats every 30 seconds to maintain presence.
    """
    
    __tablename__ = "project_presence"
    __table_args__ = (
        Index("idx_project_presence_project", "project_id"),
        Index("idx_project_presence_user", "user_id"),
        Index("idx_project_presence_last_seen", "last_seen_at"),
    )
    
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    
    # What the user is doing
    activity: Mapped[str] = mapped_column(
        String(20), 
        default="viewing",  # viewing, editing
        nullable=False
    )
    
    # Last heartbeat timestamp
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime, 
        default=datetime.utcnow, 
        onupdate=datetime.utcnow,
        nullable=False
    )
    
    # When the user started viewing this project
    started_at: Mapped[datetime] = mapped_column(
        DateTime, 
        default=datetime.utcnow, 
        nullable=False
    )
    
    # Relationships
    project: Mapped["Project"] = relationship("Project")
    user: Mapped["User"] = relationship("User")
    
    def __repr__(self) -> str:
        return f"<ProjectPresence user={self.user_id} project={self.project_id} activity={self.activity}>"


# Presence timeout in seconds (users are considered "gone" after this)
PRESENCE_TIMEOUT_SECONDS = 60
