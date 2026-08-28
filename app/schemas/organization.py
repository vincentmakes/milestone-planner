"""
Schemas for organization management in multi-tenant admin API.
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

# ---------------------------------------------------------
# Organization Schemas
# ---------------------------------------------------------


class OrganizationCreate(BaseModel):
    """Create organization request."""

    name: str
    slug: str = Field(..., pattern=r"^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$")
    description: str | None = None


class OrganizationUpdate(BaseModel):
    """Update organization request."""

    name: str | None = None
    description: str | None = None


class OrganizationResponse(BaseModel):
    """Organization response."""

    id: UUID
    name: str
    slug: str
    description: str | None = None
    created_at: datetime
    updated_at: datetime | None = None
    tenant_count: int = 0
    sso_enabled: bool = False


class TenantSummary(BaseModel):
    """Summary of a tenant for organization detail view."""

    id: UUID
    name: str
    slug: str
    status: str
    required_group_ids: list[str] = []
    group_membership_mode: str = "any"


class OrganizationDetailResponse(BaseModel):
    """Organization detail response with SSO config and tenants."""

    id: UUID
    name: str
    slug: str
    description: str | None = None
    created_at: datetime
    updated_at: datetime | None = None
    sso_config: Optional["OrganizationSSOConfigResponse"] = None
    tenants: list[TenantSummary] = []


# ---------------------------------------------------------
# Organization SSO Config Schemas
# ---------------------------------------------------------


class OrganizationSSOConfigCreate(BaseModel):
    """Create/update organization SSO config request."""

    enabled: bool | None = None
    entra_tenant_id: str | None = Field(None, alias="entraTenantId")
    client_id: str | None = Field(None, alias="clientId")
    client_secret: str | None = Field(None, alias="clientSecret")
    redirect_uri: str | None = Field(None, alias="redirectUri")
    auto_create_users: bool | None = Field(None, alias="autoCreateUsers")
    default_user_role: str | None = Field(None, alias="defaultUserRole")

    class Config:
        populate_by_name = True

    @field_validator("entra_tenant_id", "client_id", "client_secret", "redirect_uri")
    @classmethod
    def strip_whitespace(cls, value: str | None) -> str | None:
        """
        Trim pasted values.

        These are copied out of the Azure portal, and a trailing newline rides
        along invisibly — Entra then rejects the credentials with no hint as to
        why. A field that is only whitespace becomes None, which the update
        handler already reads as "leave the stored value alone".
        """
        if value is None:
            return None
        return value.strip() or None


class OrganizationSSOTestCheck(BaseModel):
    """One check performed by the organization SSO diagnostic."""

    name: str
    status: str
    """``pass`` | ``warn`` | ``fail`` | ``manual``."""
    message: str
    code: str | None = None
    """A Microsoft ``AADSTS…`` code, when Entra supplied one."""


class OrganizationSSOTestResponse(BaseModel):
    """
    Result of testing an organization's SSO configuration.

    ``credentials_ok`` is deliberately not called ``sso_ok``: the probe signs in
    as the application itself, which never involves a redirect URI, so it cannot
    tell whether the redirect URI is registered under the right platform. That
    check is reported as a ``manual`` row for a human to confirm.
    """

    credentials_ok: bool = Field(False, alias="credentialsOk")
    summary: str
    checks: list[OrganizationSSOTestCheck] = []

    class Config:
        populate_by_name = True


class OrganizationSSOConfigResponse(BaseModel):
    """Organization SSO config response."""

    enabled: bool = False
    configured: bool = False
    provider: str = "entra"
    entra_tenant_id: str | None = Field(None, alias="entraTenantId")
    client_id: str | None = Field(None, alias="clientId")
    redirect_uri: str | None = Field(None, alias="redirectUri")
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

    organization_id: UUID | None = Field(None, alias="organizationId")
    required_group_ids: list[str] | None = Field(None, alias="requiredGroupIds")
    group_membership_mode: str | None = Field(None, alias="groupMembershipMode")

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
    source: str | None = None  # 'organization', 'tenant', or None
    provider: str | None = None
    organization: TenantOrganizationInfo | None = None
    required_groups: list[str] = []
    group_membership_mode: str = "any"


# Forward reference for nested model
OrganizationDetailResponse.model_rebuild()
