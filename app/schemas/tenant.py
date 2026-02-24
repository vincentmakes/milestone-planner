"""
Schemas for multi-tenant admin API.
"""

from datetime import datetime
from typing import Optional, List, Any
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field


# ---------------------------------------------------------
# Admin Auth Schemas
# ---------------------------------------------------------

class AdminLoginRequest(BaseModel):
    """Admin login request."""
    email: EmailStr
    password: str


class AdminUserInfo(BaseModel):
    """Admin user info returned in session."""
    id: int
    email: str
    name: Optional[str] = None
    role: str


class AdminLoginResponse(BaseModel):
    """Admin login response."""
    success: bool
    user: AdminUserInfo


class AdminMeResponse(BaseModel):
    """Admin session check response."""
    user: Optional[AdminUserInfo] = None


# ---------------------------------------------------------
# Tenant Schemas
# ---------------------------------------------------------

class TenantBase(BaseModel):
    """Base tenant fields."""
    name: str
    slug: str
    admin_email: EmailStr = Field(alias="adminEmail")
    company_name: Optional[str] = Field(None, alias="companyName")
    plan: Optional[str] = "standard"
    max_users: Optional[int] = Field(50, alias="maxUsers")
    max_projects: Optional[int] = Field(100, alias="maxProjects")
    
    class Config:
        populate_by_name = True


class TenantCreate(TenantBase):
    """Tenant creation request."""
    pass


class TenantUpdate(BaseModel):
    """Tenant update request."""
    name: Optional[str] = None
    company_name: Optional[str] = Field(None, alias="companyName")
    admin_email: Optional[EmailStr] = Field(None, alias="adminEmail")
    status: Optional[str] = None
    plan: Optional[str] = None
    max_users: Optional[int] = Field(None, alias="maxUsers")
    max_projects: Optional[int] = Field(None, alias="maxProjects")
    # Organization fields
    organization_id: Optional[UUID] = Field(None, alias="organizationId")
    required_group_ids: Optional[List[str]] = Field(None, alias="requiredGroupIds")
    group_membership_mode: Optional[str] = Field(None, alias="groupMembershipMode")
    
    class Config:
        populate_by_name = True


class DatabaseStatus(BaseModel):
    """Database status check result."""
    exists: bool
    accessible: bool
    error: Optional[str] = None


class AuditLogEntry(BaseModel):
    """Audit log entry."""
    id: UUID
    action: str
    details: Optional[Any] = None  # JSONB
    actor: Optional[str] = None
    created_at: datetime


class TenantResponse(BaseModel):
    """Tenant response."""
    id: UUID
    name: str
    slug: str
    database_name: str
    database_user: str
    company_name: Optional[str] = None
    admin_email: str
    status: str
    plan: Optional[str] = None
    max_users: Optional[int] = None
    max_projects: Optional[int] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    database_status: Optional[DatabaseStatus] = None
    audit_log: Optional[List[AuditLogEntry]] = None
    # Organization fields
    organization_id: Optional[UUID] = None
    organization_name: Optional[str] = None
    required_group_ids: List[str] = []
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
    admin_email: Optional[EmailStr] = Field(None, alias="adminEmail")
    admin_password: Optional[str] = Field(None, alias="adminPassword")
    
    class Config:
        populate_by_name = True


class TenantProvisionResponse(BaseModel):
    """Response after provisioning tenant database."""
    success: bool
    message: str
    admin_email: Optional[str] = None
    admin_password: Optional[str] = None


class ResetAdminPasswordRequest(BaseModel):
    """Request to reset tenant admin password."""
    email: Optional[EmailStr] = None
    password: Optional[str] = None


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
    name: Optional[str] = None
    role: str = "admin"


class AdminUserUpdate(BaseModel):
    """Update admin user request."""
    name: Optional[str] = None
    role: Optional[str] = None
    active: Optional[bool] = None
    password: Optional[str] = None


class AdminUserResponse(BaseModel):
    """Admin user response."""
    id: int
    email: str
    name: Optional[str] = None
    role: str
    active: int
    created_at: datetime
    last_login: Optional[datetime] = None
