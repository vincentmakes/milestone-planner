"""
Site and BankHoliday models.
Maps to the sites and bank_holidays tables in PostgreSQL.
"""

from datetime import date, datetime
from typing import TYPE_CHECKING, List, Optional

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.user import User
    from app.models.project import Project
    from app.models.equipment import Equipment
    from app.models.custom_column import CustomColumn


class Site(Base):
    """Site model - represents physical locations/offices."""

    __tablename__ = "sites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    location: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    city: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    country_code: Mapped[Optional[str]] = mapped_column(String(2), nullable=True)
    region_code: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    timezone: Mapped[str] = mapped_column(String(50), default="Europe/Zurich", nullable=False)
    last_holiday_fetch: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    active: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    # Relationships
    users: Mapped[List["User"]] = relationship(
        "User",
        secondary="user_sites",
        back_populates="sites",
    )
    
    projects: Mapped[List["Project"]] = relationship(
        "Project",
        back_populates="site",
        cascade="all, delete-orphan",
    )
    
    equipment: Mapped[List["Equipment"]] = relationship(
        "Equipment",
        back_populates="site",
        cascade="all, delete-orphan",
    )
    
    bank_holidays: Mapped[List["BankHoliday"]] = relationship(
        "BankHoliday",
        back_populates="site",
        cascade="all, delete-orphan",
    )
    
    custom_columns: Mapped[List["CustomColumn"]] = relationship(
        "CustomColumn",
        back_populates="site",
        cascade="all, delete-orphan",
    )
    
    company_events: Mapped[List["CompanyEvent"]] = relationship(
        "CompanyEvent",
        back_populates="site",
        cascade="all, delete-orphan",
    )
    
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
    __table_args__ = (
        UniqueConstraint("site_id", "date", "name", name="bank_holidays_unique"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    site_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("sites.id", ondelete="CASCADE"),
        nullable=False,
    )
    date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    is_custom: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

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
    Similar to holidays but don't impact working days calculation.
    """

    __tablename__ = "company_events"
    __table_args__ = (
        Index("ix_company_events_site_date", "site_id", "date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    site_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("sites.id", ondelete="CASCADE"),
        nullable=False,
    )
    date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    # Relationships
    site: Mapped["Site"] = relationship("Site", back_populates="company_events")

    @property
    def is_multi_day(self) -> bool:
        """Check if this event spans multiple days."""
        return self.end_date is not None and self.end_date != self.date

    def __repr__(self) -> str:
        return f"<CompanyEvent {self.name} ({self.date})>"
