"""
Pydantic schemas for Authentication.
"""

from pydantic import BaseModel, EmailStr, Field


class LoginRequest(BaseModel):
    """Request model for login."""

    email: EmailStr
    password: str = Field(..., min_length=1)


class UserSiteInfo(BaseModel):
    """Site info for user response - matches Node.js sites array."""

    id: int
    name: str
    location: str | None = None
    city: str | None = None
    country_code: str | None = None
    region_code: str | None = None
    timezone: str = "Europe/Zurich"
    active: int = 1

    class Config:
        from_attributes = True


class UserSessionInfo(BaseModel):
    """
    User info stored in session and returned on login.
    Matches Node.js format with camelCase field names.
    """

    id: int
    email: str
    firstName: str  # camelCase to match Node.js
    lastName: str
    name: str  # computed: firstName + ' ' + lastName
    jobTitle: str | None = None
    role: str
    siteIds: list[int] = []  # camelCase
    sites: list[UserSiteInfo] = []  # Full site objects

    class Config:
        from_attributes = True


class LoginResponse(BaseModel):
    """Response model for successful login."""

    success: bool = True
    user: UserSessionInfo


class AuthMeResponse(BaseModel):
    """
    Response for /api/auth/me endpoint.
    Node.js returns { user: {...} } or { user: null }
    """

    user: UserSessionInfo | None = None


class ChangePasswordRequest(BaseModel):
    """Request model for changing password."""

    currentPassword: str = Field(..., min_length=1)
    newPassword: str = Field(..., min_length=6)


class SSOConfigResponse(BaseModel):
    """Response model for SSO configuration (public info only)."""

    enabled: bool
    configured: bool
    tenant_id: str | None = None
    client_id: str | None = None
    redirect_uri: str | None = None
    auto_create_users: bool = False
    default_role: str = "user"


class SSOConfigFullResponse(BaseModel):
    """Response model for SSO configuration (admin - includes all fields)."""

    enabled: bool
    configured: bool
    tenant_id: str | None = None
    client_id: str | None = None
    client_secret: str | None = None
    redirect_uri: str | None = None
    auto_create_users: bool = False
    default_role: str = "user"


class SSOConfigUpdate(BaseModel):
    """Request model for updating SSO configuration."""

    enabled: bool | None = None
    tenant_id: str | None = None
    client_id: str | None = None
    client_secret: str | None = None
    redirect_uri: str | None = None
    auto_create_users: bool | None = None
    default_role: str | None = Field(None, pattern="^(superuser|user)$")
