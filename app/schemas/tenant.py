"""
Schemas for multi-tenant admin API.
"""

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field

# ---------------------------------------------------------
# Admin Auth Schemas
# ---------------------------------------------------------


class AdminLoginRequest(BaseModel):
    """Admin login request."""

    email: str
    password: str


class AdminUserInfo(BaseModel):
    """Admin user info returned in session."""

    id: int
    email: str
    name: str | None = None
    role: str


class AdminLoginResponse(BaseModel):
    """Admin login response."""

    success: bool
    user: AdminUserInfo
    must_change_password: bool = False


class AdminMeResponse(BaseModel):
    """Admin session check response."""

    user: AdminUserInfo | None = None


class ChangeAdminPasswordRequest(BaseModel):
    """Request to change admin's own password."""

    current_password: str
    new_password: str


# ---------------------------------------------------------
# Tenant Schemas
# ---------------------------------------------------------


class TenantBase(BaseModel):
    """Base tenant fields."""

    name: str
    slug: str
    admin_email: EmailStr = Field(alias="adminEmail")
    company_name: str | None = Field(None, alias="companyName")
    plan: str | None = "standard"
    max_users: int | None = Field(50, alias="maxUsers")
    max_projects: int | None = Field(100, alias="maxProjects")

    class Config:
        populate_by_name = True


class TenantCreate(TenantBase):
    """Tenant creation request."""

    pass


class TenantUpdate(BaseModel):
    """Tenant update request."""

    name: str | None = None
    company_name: str | None = Field(None, alias="companyName")
    admin_email: EmailStr | None = Field(None, alias="adminEmail")
    status: str | None = None
    plan: str | None = None
    max_users: int | None = Field(None, alias="maxUsers")
    max_projects: int | None = Field(None, alias="maxProjects")
    # Organization fields
    organization_id: UUID | None = Field(None, alias="organizationId")
    required_group_ids: list[str] | None = Field(None, alias="requiredGroupIds")
    group_membership_mode: str | None = Field(None, alias="groupMembershipMode")

    class Config:
        populate_by_name = True


class DatabaseStatus(BaseModel):
    """Database status check result."""

    exists: bool
    accessible: bool
    error: str | None = None


class AuditLogEntry(BaseModel):
    """Audit log entry."""

    id: UUID
    action: str
    details: Any | None = None  # JSONB
    actor: str | None = None
    created_at: datetime


class TenantResponse(BaseModel):
    """Tenant response."""

    id: UUID
    name: str
    slug: str
    database_name: str
    database_user: str
    company_name: str | None = None
    admin_email: str
    status: str
    plan: str | None = None
    max_users: int | None = None
    max_projects: int | None = None
    created_at: datetime
    updated_at: datetime | None = None
    database_status: DatabaseStatus | None = None
    audit_log: list[AuditLogEntry] | None = None
    # Organization fields
    organization_id: UUID | None = None
    organization_name: str | None = None
    required_group_ids: list[str] = []
    group_membership_mode: str = "any"


class TenantCredentialsResponse(BaseModel):
    """Tenant credentials (only shown on creation)."""

    database_name: str
    database_user: str
    database_password: str


class TenantCreateResponse(BaseModel):
    """Response after creating a tenant."""

    success: bool
    tenant: TenantResponse
    credentials: TenantCredentialsResponse
    message: str


class TenantProvisionRequest(BaseModel):
    """Request to provision tenant database."""

    admin_email: EmailStr | None = Field(None, alias="adminEmail")
    admin_password: str | None = Field(None, alias="adminPassword")

    class Config:
        populate_by_name = True


class TenantProvisionResponse(BaseModel):
    """Response after provisioning tenant database."""

    success: bool
    message: str
    admin_email: str | None = None
    admin_password: str | None = None


class ResetAdminPasswordRequest(BaseModel):
    """Request to reset tenant admin password."""

    email: EmailStr | None = None
    password: str | None = None


class ResetAdminPasswordResponse(BaseModel):
    """Response after resetting admin password."""

    success: bool
    email: str
    password: str
    message: str


# ---------------------------------------------------------
# System Stats Schemas
# ---------------------------------------------------------


class TenantStats(BaseModel):
    """Tenant statistics."""

    total: int
    active: int
    suspended: int
    pending: int
    archived: int


class ConnectionStats(BaseModel):
    """Connection pool statistics."""

    active_pools: int
    total_connections: int


class SystemInfo(BaseModel):
    """System information."""

    uptime: float
    memory_mb: float
    python_version: str


class SystemStatsResponse(BaseModel):
    """System statistics response."""

    tenants: TenantStats
    connections: ConnectionStats
    system: SystemInfo


# ---------------------------------------------------------
# Admin User Management Schemas
# ---------------------------------------------------------


class AdminUserCreate(BaseModel):
    """Create admin user request."""

    email: EmailStr
    password: str
    name: str | None = None
    role: str = "admin"


class AdminUserUpdate(BaseModel):
    """Update admin user request."""

    name: str | None = None
    role: str | None = None
    active: bool | None = None
    password: str | None = None


class AdminUserResponse(BaseModel):
    """Admin user response."""

    id: int
    email: str
    name: str | None = None
    role: str
    active: int
    created_at: datetime
    last_login: datetime | None = None
