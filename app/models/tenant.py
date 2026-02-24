"""
Multi-tenant models for master database.

These models map to the EXISTING Node.js schema in the milestone_admin database.
DO NOT modify these without checking the Node.js masterDb.js schema!

Schema source: lib/masterDb.js initializeMasterDb()
"""

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import declarative_base, relationship

# Separate Base for master database models
# This prevents these tables from being created in tenant databases
MasterBase = declarative_base()

if TYPE_CHECKING:
    pass


class Tenant(MasterBase):  # type: ignore[misc]
    """
    Tenant registry - stores information about each tenant.

    Node.js schema:
    CREATE TABLE IF NOT EXISTS tenants (
        id UUID PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(63) NOT NULL UNIQUE,
        database_name VARCHAR(63) NOT NULL UNIQUE,
        database_user VARCHAR(63) NOT NULL UNIQUE,
        status VARCHAR(20) DEFAULT 'active',
        plan VARCHAR(50) DEFAULT 'standard',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        settings JSONB DEFAULT '{}',
        max_users INTEGER DEFAULT 50,
        max_projects INTEGER DEFAULT 100,
        admin_email VARCHAR(255) NOT NULL,
        company_name VARCHAR(255),
        organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
        required_group_ids JSONB DEFAULT '[]',
        group_membership_mode VARCHAR(10) DEFAULT 'any'
    );
    """

    __tablename__ = "tenants"

    id = Column(UUID(as_uuid=True), primary_key=True)
    name = Column(String(255), nullable=False)
    slug = Column(String(63), unique=True, nullable=False)

    # Database connection info
    database_name = Column(String(63), unique=True, nullable=False)
    database_user = Column(String(63), unique=True, nullable=False)

    # Status: pending, active, suspended, archived
    status = Column(String(20), default="active", nullable=False)

    # Plan/limits
    plan = Column(String(50), default="standard")
    max_users = Column(Integer, default=50)
    max_projects = Column(Integer, default=100)

    # Tenant metadata
    admin_email = Column(String(255), nullable=False)
    company_name = Column(String(255))

    # Settings (JSONB)
    settings = Column(JSONB, default={})

    # Organization reference (nullable for backward compatibility)
    organization_id = Column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True
    )

    # Group-based access control (when using organization SSO)
    # JSONB array of Entra group IDs (UUIDs) required for access
    required_group_ids = Column(JSONB, default=[])
    # 'any' = user must be member of at least one group (OR logic)
    # 'all' = user must be member of all groups (AND logic)
    group_membership_mode = Column(String(10), default="any")

    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    credentials = relationship(
        "TenantCredentials", back_populates="tenant", uselist=False, cascade="all, delete-orphan"
    )
    audit_logs = relationship(
        "TenantAuditLog",
        back_populates="tenant",
        order_by="desc(TenantAuditLog.created_at)",
        cascade="all, delete-orphan",
    )
    organization = relationship(
        "Organization", back_populates="tenants", foreign_keys=[organization_id]
    )

    @property
    def is_active(self) -> bool:
        return self.status == "active"

    @property
    def has_group_restriction(self) -> bool:
        """Check if tenant has group-based access restrictions."""
        return bool(self.required_group_ids and len(self.required_group_ids) > 0)

    def check_group_membership(self, user_group_ids: list[str]) -> bool:
        """
        Check if user's group membership satisfies tenant requirements.

        Args:
            user_group_ids: List of Entra group IDs the user belongs to

        Returns:
            True if user has access, False otherwise
        """
        if not self.has_group_restriction:
            # No group restriction - allow all users
            return True

        required = set(self.required_group_ids)
        user_groups = set(user_group_ids)

        if self.group_membership_mode == "all":
            # User must be member of ALL required groups
            return required.issubset(user_groups)
        else:
            # 'any' mode: User must be member of at least ONE required group
            return bool(required.intersection(user_groups))


class TenantCredentials(MasterBase):  # type: ignore[misc]
    """
    Encrypted database credentials for tenants.

    Node.js schema:
    CREATE TABLE IF NOT EXISTS tenant_credentials (
        tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        encrypted_password TEXT NOT NULL,
        password_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """

    __tablename__ = "tenant_credentials"

    # tenant_id is the PRIMARY KEY (not a separate id column)
    tenant_id = Column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True
    )

    # Encrypted password (AES-256-GCM format: iv:authTag:ciphertext)
    encrypted_password = Column(Text, nullable=False)

    password_updated_at = Column(DateTime, default=datetime.utcnow)

    # Relationship
    tenant = relationship("Tenant", back_populates="credentials")


class TenantAuditLog(MasterBase):  # type: ignore[misc]
    """
    Audit log for tenant actions.

    Node.js schema:
    CREATE TABLE IF NOT EXISTS tenant_audit_log (
        id UUID PRIMARY KEY,
        tenant_id UUID REFERENCES tenants(id),
        action VARCHAR(50) NOT NULL,
        actor VARCHAR(255),
        details JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """

    __tablename__ = "tenant_audit_log"

    id = Column(UUID(as_uuid=True), primary_key=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"))

    action = Column(String(50), nullable=False)  # created, provisioned, suspended, etc.
    actor = Column(String(255))  # Admin email who performed action
    details = Column(JSONB)  # JSON details

    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationship
    tenant = relationship("Tenant", back_populates="audit_logs")


class AdminUser(MasterBase):  # type: ignore[misc]
    """
    Admin users for the multi-tenant admin panel.

    Node.js schema:
    CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name VARCHAR(255),
        role VARCHAR(20) DEFAULT 'admin',
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
    );
    """

    __tablename__ = "admin_users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    email = Column(String(255), unique=True, nullable=False)
    password_hash = Column(Text, nullable=False)
    name = Column(String(255))

    # Role: admin or superadmin
    role = Column(String(20), default="admin")

    active = Column(Integer, default=1)

    created_at = Column(DateTime, default=datetime.utcnow)
    last_login = Column(DateTime)

    @property
    def is_active(self) -> bool:
        return self.active == 1

    @property
    def is_superadmin(self) -> bool:
        return self.role == "superadmin"


class AdminSession(MasterBase):  # type: ignore[misc]
    """
    Admin session storage.

    Node.js schema:
    CREATE TABLE IF NOT EXISTS admin_sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired BIGINT NOT NULL
    );
    """

    __tablename__ = "admin_sessions"

    # sid is the PRIMARY KEY (not a separate id column)
    sid = Column(Text, primary_key=True)
    sess = Column(Text, nullable=False)
    expired = Column(BigInteger, nullable=False)
