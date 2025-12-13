"""
Multi-tenant models for master database.

These models map to the EXISTING Node.js schema in the milestone_admin database.
DO NOT modify these without checking the Node.js masterDb.js schema!

Schema source: lib/masterDb.js initializeMasterDb()
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Column, Integer, String, Text, DateTime, ForeignKey, BigInteger
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship, declarative_base

# Separate Base for master database models
# This prevents these tables from being created in tenant databases
MasterBase = declarative_base()


class Tenant(MasterBase):
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
        company_name VARCHAR(255)
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
    
    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Relationships
    credentials = relationship("TenantCredentials", back_populates="tenant", uselist=False, cascade="all, delete-orphan")
    audit_logs = relationship("TenantAuditLog", back_populates="tenant", order_by="desc(TenantAuditLog.created_at)", cascade="all, delete-orphan")
    
    @property
    def is_active(self) -> bool:
        return self.status == "active"


class TenantCredentials(MasterBase):
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
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True)
    
    # Encrypted password (AES-256-GCM format: iv:authTag:ciphertext)
    encrypted_password = Column(Text, nullable=False)
    
    password_updated_at = Column(DateTime, default=datetime.utcnow)
    
    # Relationship
    tenant = relationship("Tenant", back_populates="credentials")


class TenantAuditLog(MasterBase):
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


class AdminUser(MasterBase):
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


class AdminSession(MasterBase):
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
