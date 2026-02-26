"""
SSO Service for organization-level SSO with Microsoft Entra ID.

Provides:
- Effective SSO config resolution (organization or tenant level)
- Microsoft Graph API calls for group membership
- Group membership validation (any/all modes)
- SSO callback URL construction
"""

import logging
from typing import TYPE_CHECKING, Any, Optional
from urllib.parse import urlencode

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.services.encryption import decrypt

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from app.models.tenant import Tenant


class SSOService:
    """Service for SSO operations."""

    def __init__(self, db: AsyncSession):
        self.db = db
        self.settings = get_settings()

    async def get_effective_sso_config(
        self, tenant: Optional["Tenant"] = None
    ) -> tuple[dict[str, Any] | None, str]:
        """
        Get the effective SSO configuration for a tenant.

        Returns:
            Tuple of (config_dict, source) where:
            - config_dict: SSO configuration as dict, or None if SSO not enabled
            - source: 'organization', 'tenant', or 'none'
        """
        # If tenant has an organization with SSO, use that
        if tenant and tenant.organization_id and tenant.organization:
            org = tenant.organization
            if org.sso_config and org.sso_config.is_enabled and org.sso_config.is_configured:
                config = org.sso_config
                return {
                    "enabled": True,
                    "provider": config.provider,
                    "tenant_id": config.entra_tenant_id,
                    "client_id": config.client_id,
                    "client_secret": decrypt(config.client_secret_encrypted)
                    if config.client_secret_encrypted
                    else None,
                    "redirect_uri": config.redirect_uri,
                    "auto_create_users": config.should_auto_create_users,
                    "default_role": config.default_user_role,
                    "required_group_ids": tenant.required_group_ids if tenant else [],
                    "group_membership_mode": tenant.group_membership_mode if tenant else "any",
                }, "organization"

        # Fall back to tenant-level SSO config
        from app.models.settings import SSOConfig

        result = await self.db.execute(select(SSOConfig).where(SSOConfig.id == 1))
        config = result.scalar_one_or_none()

        if config and config.is_enabled and config.is_configured:
            return {
                "enabled": True,
                "provider": "entra",
                "tenant_id": config.tenant_id,
                "client_id": config.client_id,
                "client_secret": config.client_secret,
                "redirect_uri": config.redirect_uri,
                "auto_create_users": config.should_auto_create_users,
                "default_role": config.default_role,
                "required_group_ids": [],
                "group_membership_mode": "any",
            }, "tenant"

        return None, "none"

    async def fetch_user_groups(self, access_token: str, max_groups: int = 500) -> list[str]:
        """
        Fetch user's group memberships from Microsoft Graph API.

        Uses /me/memberOf endpoint with pagination support.

        Args:
            access_token: Valid access token with GroupMember.Read.All scope
            max_groups: Maximum number of groups to fetch (default 500)

        Returns:
            List of group IDs the user is a member of
        """
        group_ids: list[str] = []
        url = "https://graph.microsoft.com/v1.0/me/memberOf?$select=id,displayName"

        async with httpx.AsyncClient() as client:
            while url and len(group_ids) < max_groups:
                response = await client.get(
                    url, headers={"Authorization": f"Bearer {access_token}"}
                )

                if response.status_code != 200:
                    # Log error but don't fail - groups might just not be available
                    logger.warning(
                        "Failed to fetch groups: %s %s", response.status_code, response.text
                    )
                    break

                data = response.json()

                # Extract group IDs from response
                for item in data.get("value", []):
                    # Only include actual groups, not other directory objects
                    if item.get("@odata.type") == "#microsoft.graph.group":
                        group_ids.append(item["id"])

                # Check for pagination
                url = data.get("@odata.nextLink")

        return group_ids

    def validate_group_membership(
        self, user_groups: list[str], required_groups: list[str], mode: str = "any"
    ) -> bool:
        """
        Validate user's group membership against required groups.

        Args:
            user_groups: List of group IDs the user belongs to
            required_groups: List of required group IDs
            mode: 'any' (OR - user must be in at least one) or 'all' (AND - user must be in all)

        Returns:
            True if user meets the group requirements
        """
        if not required_groups:
            # No groups required - access granted
            return True

        if not user_groups:
            # Groups required but user has none - access denied
            return False

        # Convert to sets for efficient comparison
        user_set = set(user_groups)
        required_set = set(required_groups)

        if mode == "all":
            # User must be member of ALL required groups
            return required_set.issubset(user_set)
        else:
            # User must be member of at least ONE required group (default: 'any')
            return bool(user_set.intersection(required_set))

    def build_sso_callback_url(
        self, tenant_slug: str | None = None, base_url: str | None = None
    ) -> str:
        """
        Build the SSO callback URL for a tenant.

        Args:
            tenant_slug: Tenant slug for multi-tenant mode
            base_url: Base URL of the application (optional, uses settings if not provided)

        Returns:
            Full callback URL
        """
        if not base_url:
            # Try to get from settings or construct from host/port
            base_url = getattr(self.settings, "base_url", None)
            if not base_url:
                # Fallback to constructing from port
                port = self.settings.port
                base_url = f"http://localhost:{port}"

        if tenant_slug:
            # Multi-tenant mode
            return f"{base_url}/t/{tenant_slug}/api/auth/sso/callback"
        else:
            # Single-tenant mode
            return f"{base_url}/api/auth/sso/callback"

    def build_authorization_url(
        self, sso_config: dict[str, Any], state: str, include_groups_scope: bool = False
    ) -> str:
        """
        Build the Microsoft authorization URL.

        Args:
            sso_config: Effective SSO configuration dict
            state: State parameter for CSRF protection
            include_groups_scope: Whether to request GroupMember.Read.All scope

        Returns:
            Full authorization URL
        """
        tenant_id = sso_config["tenant_id"]
        auth_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/authorize"

        scopes = ["openid", "profile", "email", "User.Read"]
        if include_groups_scope:
            scopes.append("GroupMember.Read.All")

        params = {
            "client_id": sso_config["client_id"],
            "response_type": "code",
            "redirect_uri": sso_config["redirect_uri"],
            "response_mode": "query",
            "scope": " ".join(scopes),
            "state": state,
        }

        return f"{auth_url}?{urlencode(params)}"


async def get_sso_service(db: AsyncSession) -> SSOService:
    """Dependency for getting SSO service."""
    return SSOService(db)
