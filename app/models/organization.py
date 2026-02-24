"""
Organization models for master database.

Organizations allow multiple tenants to share SSO configuration
and enable group-based access control via Microsoft Entra ID.
"""

from datetime import datetime
from typing import Optional, List, TYPE_CHECKING

from sqlalchemy import (
    Column, Integer, String, Text, DateTime, ForeignKey
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.models.tenant import MasterBase

if TYPE_CHECKING:
    from app.models.tenant import Tenant


class Organization(MasterBase):
    """
    Organization - groups multiple tenants with shared SSO.
    
    Schema:
    CREATE TABLE organizations (
        id UUID PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(63) NOT NULL UNIQUE,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """
    
    __tablename__ = "organizations"
    
    id = Column(UUID(as_uuid=True), primary_key=True)
    name = Column(String(255), nullable=False)
    slug = Column(String(63), unique=True, nullable=False)
    description = Column(Text)
    
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Relationships
    sso_config = relationship(
        "OrganizationSSOConfig", 
        back_populates="organization", 
        uselist=False,
        cascade="all, delete-orphan"
    )
    tenants = relationship(
        "Tenant", 
        back_populates="organization",
        foreign_keys="Tenant.organization_id"
    )
    
    @property
    def has_sso_configured(self) -> bool:
        """Check if organization has SSO configured and enabled."""
        return (
            self.sso_config is not None and 
            self.sso_config.enabled == 1 and
            self.sso_config.is_configured
        )


class OrganizationSSOConfig(MasterBase):
    """
    SSO configuration for an organization.
    
    Schema:
    CREATE TABLE organization_sso_config (
        organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        enabled INTEGER DEFAULT 0,
        provider VARCHAR(50) DEFAULT 'entra',
        entra_tenant_id VARCHAR(255),
        client_id VARCHAR(255),
        client_secret_encrypted TEXT,
        redirect_uri VARCHAR(500),
        auto_create_users INTEGER DEFAULT 0,
        default_user_role VARCHAR(20) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """
    
    __tablename__ = "organization_sso_config"
    
    organization_id = Column(
        UUID(as_uuid=True), 
        ForeignKey("organizations.id", ondelete="CASCADE"), 
        primary_key=True
    )
    
    enabled = Column(Integer, default=0)
    provider = Column(String(50), default="entra")  # Currently only 'entra' supported
    
    # Microsoft Entra ID settings
    entra_tenant_id = Column(String(255))
    client_id = Column(String(255))
    client_secret_encrypted = Column(Text)  # AES-256-GCM encrypted
    redirect_uri = Column(String(500))
    
    # User provisioning settings
    auto_create_users = Column(Integer, default=0)
    default_user_role = Column(String(20), default="user")
    
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Relationship
    organization = relationship("Organization", back_populates="sso_config")
    
    @property
    def is_enabled(self) -> bool:
        """Check if SSO is enabled."""
        return self.enabled == 1
    
    @property
    def is_configured(self) -> bool:
        """Check if SSO is properly configured."""
        return bool(
            self.entra_tenant_id and 
            self.client_id and 
            self.client_secret_encrypted
        )
    
    @property
    def should_auto_create_users(self) -> bool:
        """Check if auto user creation is enabled."""
        return self.auto_create_users == 1
