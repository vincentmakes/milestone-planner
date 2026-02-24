"""
Schemas for organization management in multi-tenant admin API.
"""

from datetime import datetime
from typing import Optional, List
from uuid import UUID

from pydantic import BaseModel, Field


# ---------------------------------------------------------
# Organization Schemas
# ---------------------------------------------------------

class OrganizationCreate(BaseModel):
    """Create organization request."""
    name: str
    slug: str = Field(..., pattern=r'^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$')
    description: Optional[str] = None


class OrganizationUpdate(BaseModel):
    """Update organization request."""
    name: Optional[str] = None
    description: Optional[str] = None


class OrganizationResponse(BaseModel):
    """Organization response."""
    id: UUID
    name: str
    slug: str
    description: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    tenant_count: int = 0
    sso_enabled: bool = False


class TenantSummary(BaseModel):
    """Summary of a tenant for organization detail view."""
    id: UUID
    name: str
    slug: str
    status: str
    required_group_ids: List[str] = []
    group_membership_mode: str = "any"


class OrganizationDetailResponse(BaseModel):
    """Organization detail response with SSO config and tenants."""
    id: UUID
    name: str
    slug: str
    description: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    sso_config: Optional["OrganizationSSOConfigResponse"] = None
    tenants: List[TenantSummary] = []


# ---------------------------------------------------------
# Organization SSO Config Schemas
# ---------------------------------------------------------

class OrganizationSSOConfigCreate(BaseModel):
    """Create/update organization SSO config request."""
    enabled: Optional[bool] = None
    entra_tenant_id: Optional[str] = Field(None, alias="entraTenantId")
    client_id: Optional[str] = Field(None, alias="clientId")
    client_secret: Optional[str] = Field(None, alias="clientSecret")
    redirect_uri: Optional[str] = Field(None, alias="redirectUri")
    auto_create_users: Optional[bool] = Field(None, alias="autoCreateUsers")
    default_user_role: Optional[str] = Field(None, alias="defaultUserRole")
    
    class Config:
        populate_by_name = True


class OrganizationSSOConfigResponse(BaseModel):
    """Organization SSO config response."""
    enabled: bool = False
    configured: bool = False
    provider: str = "entra"
    entra_tenant_id: Optional[str] = Field(None, alias="entraTenantId")
    client_id: Optional[str] = Field(None, alias="clientId")
    redirect_uri: Optional[str] = Field(None, alias="redirectUri")
    auto_create_users: bool = Field(False, alias="autoCreateUsers")
    default_user_role: str = Field("user", alias="defaultUserRole")
    
    class Config:
        populate_by_name = True
        from_attributes = True


# ---------------------------------------------------------
# Tenant Group Access Schemas
# ---------------------------------------------------------

class TenantGroupAccessUpdate(BaseModel):
    """Update tenant group access requirements."""
    organization_id: Optional[UUID] = Field(None, alias="organizationId")
    required_group_ids: Optional[List[str]] = Field(None, alias="requiredGroupIds")
    group_membership_mode: Optional[str] = Field(None, alias="groupMembershipMode")
    
    class Config:
        populate_by_name = True


# ---------------------------------------------------------
# SSO Status Response Schemas
# ---------------------------------------------------------

class TenantOrganizationInfo(BaseModel):
    """Organization info returned with tenant for SSO status."""
    id: UUID
    name: str
    slug: str
    sso_enabled: bool = False
    sso_provider: str = "entra"


class SSOStatusResponse(BaseModel):
    """
    SSO status response for tenant settings UI.
    
    Indicates whether SSO is configured at organization or tenant level,
    or not configured at all.
    """
    enabled: bool = False
    source: Optional[str] = None  # 'organization', 'tenant', or None
    provider: Optional[str] = None
    organization: Optional[TenantOrganizationInfo] = None
    required_groups: List[str] = []
    group_membership_mode: str = "any"


# Forward reference for nested model
OrganizationDetailResponse.model_rebuild()
