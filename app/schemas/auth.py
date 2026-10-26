"""
Pydantic schemas for Authentication.
"""

from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.services.permissions import ADMIN_ROLE_KEY, ROLE_KEY_PATTERN

# Minimum length for new or changed tenant passwords (login is unaffected, so
# existing shorter passwords keep working until they are changed).
MIN_PASSWORD_LENGTH = 8


class LoginRequest(BaseModel):
    """Request model for login."""

    email: str
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
    role: str  # the role key
    roleName: str | None = None  # the role's display name
    siteIds: list[int] = []  # camelCase
    sites: list[UserSiteInfo] = []  # Full site objects
    # The live role's matrix: the keys allowed outright (the admin: every
    # key), the keys in approval mode, and whether every site is visible.
    permissions: list[str] = []
    approvalRequired: list[str] = []
    canSeeAllSites: bool = False
    # Bookable as a resource (users.is_resource).
    isResource: bool = True

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
    # New passwords only; existing shorter passwords still log in.
    newPassword: str = Field(..., min_length=MIN_PASSWORD_LENGTH)


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
    """Response model for SSO configuration (admin). The secret is only ever masked."""

    enabled: bool
    configured: bool
    tenant_id: str | None = None
    client_id: str | None = None
    client_secret_masked: str | None = None
    redirect_uri: str | None = None
    auto_create_users: bool = False
    default_role: str = "user"


class SSOConfigUpdate(BaseModel):
    """Request model for updating SSO configuration."""

    enabled: bool | None = None
    tenant_id: str | None = None
    client_id: str | None = None
    # Stored encrypted in a VARCHAR(500): 200 characters is far above any
    # Entra secret and keeps the ciphertext within the column.
    client_secret: str | None = Field(None, max_length=200)
    redirect_uri: str | None = None
    auto_create_users: bool | None = None
    # A role key (custom roles included); the route checks it exists (400).
    # Never the admin role: an SSO sign-in never creates an administrator.
    default_role: str | None = Field(None, pattern=ROLE_KEY_PATTERN)

    @field_validator("tenant_id", "client_id", "client_secret", "redirect_uri", mode="before")
    @classmethod
    def _strip_pasted_values(cls, value: Any) -> Any:
        """
        Trim values pasted from the Azure portal (a trailing newline rides along).

        ``None`` keeps the stored value and an exact ``""`` clears it, as
        before. A whitespace-only value becomes ``None`` — keep the stored one —
        so Save agrees with ``POST /auth/sso/test``, which tests the stored
        secret for a blank field: a green test of ``"  "`` must not be followed
        by a save that clears the secret.
        """
        if not isinstance(value, str) or value == "":
            return value
        return value.strip() or None

    @field_validator("default_role")
    @classmethod
    def _not_admin(cls, value: str | None) -> str | None:
        if value == ADMIN_ROLE_KEY:
            raise ValueError("The administrator role cannot be the SSO default role")
        return value
