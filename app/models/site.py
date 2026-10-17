"""
Site, BankHoliday and CompanyEvent models.
Maps to the sites, bank_holidays, company_events and company_event_sites tables.
"""

from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.utils import utcnow_naive

if TYPE_CHECKING:
    from app.models.custom_column import CustomColumn
    from app.models.equipment import Equipment
    from app.models.project import Project
    from app.models.user import User


class Site(Base):
    """Site model - represents physical locations/offices."""

    __tablename__ = "sites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    location: Mapped[str | None] = mapped_column(String(100), nullable=True)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    country_code: Mapped[str | None] = mapped_column(String(2), nullable=True)
    region_code: Mapped[str | None] = mapped_column(String(10), nullable=True)
    timezone: Mapped[str] = mapped_column(String(50), default="Europe/Zurich", nullable=False)
    last_holiday_fetch: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    active: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)

    # Relationships
    users: Mapped[list["User"]] = relationship(
        "User",
        secondary="user_sites",
        back_populates="sites",
    )

    projects: Mapped[list["Project"]] = relationship(
        "Project",
        back_populates="site",
        cascade="all, delete-orphan",
    )

    # Equipment can be shared by several sites (equipment_sites), so deleting a
    # site must not delete it: the FK sets equipment.site_id to NULL and the
    # site delete handler removes equipment left without any linked site.
    equipment: Mapped[list["Equipment"]] = relationship(
        "Equipment",
        back_populates="site",
        passive_deletes=True,
    )

    bank_holidays: Mapped[list["BankHoliday"]] = relationship(
        "BankHoliday",
        back_populates="site",
        cascade="all, delete-orphan",
    )

    custom_columns: Mapped[list["CustomColumn"]] = relationship(
        "CustomColumn",
        back_populates="site",
        cascade="all, delete-orphan",
    )

    # Company events link to sites through company_event_sites (an event can
    # span several sites), so there is no direct relationship here. The site
    # delete handler removes events left without any linked site.

    # Note: staff_notes relationship removed - feature not in use

    @property
    def is_active(self) -> bool:
        """Check if site is active."""
        return self.active == 1

    def __repr__(self) -> str:
        return f"<Site {self.name} ({self.city}, {self.country_code})>"


class BankHoliday(Base):
    """Bank holiday model - represents public holidays for sites."""

    __tablename__ = "bank_holidays"
    __table_args__ = (UniqueConstraint("site_id", "date", "name", name="bank_holidays_unique"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    site_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("sites.id", ondelete="CASCADE"),
        nullable=False,
    )
    date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    is_custom: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)

    # Relationships
    site: Mapped["Site"] = relationship("Site", back_populates="bank_holidays")

    @property
    def is_custom_holiday(self) -> bool:
        """Check if this is a custom (user-added) holiday."""
        return self.is_custom == 1

    @property
    def is_multi_day(self) -> bool:
        """Check if this holiday spans multiple days."""
        return self.end_date is not None and self.end_date != self.date

    def __repr__(self) -> str:
        return f"<BankHoliday {self.name} ({self.date})>"


class CompanyEvent(Base):
    """
    Company events (audits, company meetings, etc.)
    Similar to holidays but don't impact working days calculation -- unless
    counts_as_unavailable is set (a site closure), in which case the staff of
    the event's sites are unavailable for its dates.

    An event can apply to several sites; the links live in company_event_sites.
    """

    __tablename__ = "company_events"
    __table_args__ = (Index("ix_company_events_site_date", "site_id", "date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Legacy single-site column, kept for compatibility: set to the first linked
    # site on create. company_event_sites is the source of truth.
    site_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("sites.id", ondelete="SET NULL"),
        nullable=True,
    )
    date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    color: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Site closure: staff of the linked sites are unavailable on the event's dates.
    counts_as_unavailable: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)

    @property
    def is_multi_day(self) -> bool:
        """Check if this event spans multiple days."""
        return self.end_date is not None and self.end_date != self.date

    def __repr__(self) -> str:
        return f"<CompanyEvent {self.name} ({self.date})>"


class CompanyEventSite(Base):
    """Association table for CompanyEvent-Site many-to-many relationship."""

    __tablename__ = "company_event_sites"
    __table_args__ = (Index("idx_company_event_sites_site", "site_id"),)

    event_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("company_events.id", ondelete="CASCADE"),
        primary_key=True,
    )
    site_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("sites.id", ondelete="CASCADE"),
        primary_key=True,
    )
