"""
Team, TeamMember, ProjectTeam, TagTeam, CompanyEventTeam and EquipmentTeam models.

A team belongs to one site (``site_id``); users are its members
(``team_members``), and projects, tags, company events and equipment can be
linked to teams. Every foreign key cascades, so deleting a site removes its
teams and all their links.
"""

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    true,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.utils import utcnow_naive

if TYPE_CHECKING:
    from app.models.user import User


class Team(Base):
    """A named group of users at one site."""

    __tablename__ = "teams"
    __table_args__ = (
        UniqueConstraint("site_id", "name", name="teams_site_name_unique"),
        Index("idx_teams_site", "site_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    site_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("sites.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    color: Mapped[str | None] = mapped_column(String(7), nullable=True)  # Hex color for UI
    active: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=true(), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False
    )

    # Not eager: callers load members explicitly (selectinload). An eager
    # collection here would chain selectin loads with User.teams.
    members: Mapped[list["User"]] = relationship(
        "User",
        secondary="team_members",
        back_populates="teams",
        order_by="User.id",
        passive_deletes=True,
    )

    @property
    def member_ids(self) -> list[int]:
        """Ids of the team's members, ascending."""
        return sorted(user.id for user in self.members)

    @property
    def is_active(self) -> bool:
        """Check if the team is active."""
        return bool(self.active)

    def __repr__(self) -> str:
        return f"<Team {self.name}>"


class TeamMember(Base):
    """Association table for the Team-User (membership) many-to-many relationship."""

    __tablename__ = "team_members"
    __table_args__ = (Index("idx_team_members_user", "user_id"),)

    team_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("teams.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )


class ProjectTeam(Base):
    """Association table for the Project-Team many-to-many relationship."""

    __tablename__ = "project_teams"
    __table_args__ = (Index("idx_project_teams_team", "team_id"),)

    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    team_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("teams.id", ondelete="CASCADE"),
        primary_key=True,
    )


class TagTeam(Base):
    """Association table for the Tag-Team many-to-many relationship."""

    __tablename__ = "tag_teams"
    __table_args__ = (Index("idx_tag_teams_team", "team_id"),)

    tag_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tags.id", ondelete="CASCADE"),
        primary_key=True,
    )
    team_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("teams.id", ondelete="CASCADE"),
        primary_key=True,
    )


class CompanyEventTeam(Base):
    """Association table for the CompanyEvent-Team many-to-many relationship."""

    __tablename__ = "company_event_teams"
    __table_args__ = (Index("idx_company_event_teams_team", "team_id"),)

    event_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("company_events.id", ondelete="CASCADE"),
        primary_key=True,
    )
    team_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("teams.id", ondelete="CASCADE"),
        primary_key=True,
    )


class EquipmentTeam(Base):
    """Association table for the Equipment-Team many-to-many relationship."""

    __tablename__ = "equipment_teams"
    __table_args__ = (Index("idx_equipment_teams_team", "team_id"),)

    equipment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("equipment.id", ondelete="CASCADE"),
        primary_key=True,
    )
    team_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("teams.id", ondelete="CASCADE"),
        primary_key=True,
    )
