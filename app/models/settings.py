"""
Settings, PredefinedPhase, and SSOConfig models.
Maps to the settings, predefined_phases, and sso_config tables in PostgreSQL.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Settings(Base):
    """Key-value settings storage."""

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    def __repr__(self) -> str:
        return f"<Settings {self.key}={self.value}>"


class PredefinedPhase(Base):
    """Predefined phase types for project creation."""

    __tablename__ = "predefined_phases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    @property
    def active(self) -> bool:
        """Check if phase is active."""
        return self.is_active == 1

    def __repr__(self) -> str:
        return f"<PredefinedPhase {self.name}>"


class SSOConfig(Base):
    """SSO configuration (Microsoft Entra / Azure AD)."""

    __tablename__ = "sso_config"
    __table_args__ = (
        CheckConstraint("id = 1", name="sso_config_singleton"),
        CheckConstraint(
            "default_role IN ('superuser', 'user')",
            name="sso_config_default_role_check"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    enabled: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    tenant_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    client_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    client_secret: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    redirect_uri: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    auto_create_users: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    default_role: Mapped[str] = mapped_column(String(20), default="user", nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    @property
    def is_enabled(self) -> bool:
        """Check if SSO is enabled."""
        return self.enabled == 1

    @property
    def is_configured(self) -> bool:
        """Check if SSO is properly configured."""
        return bool(self.tenant_id and self.client_id and self.redirect_uri)

    @property
    def should_auto_create_users(self) -> bool:
        """Check if auto user creation is enabled."""
        return self.auto_create_users == 1

    def __repr__(self) -> str:
        return f"<SSOConfig enabled={self.is_enabled}>"
