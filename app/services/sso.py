"""
SSO Service for organization-level SSO with Microsoft Entra ID.

Provides:
- Effective SSO config resolution (organization or tenant level)
- Microsoft Graph API calls for group membership
- Group membership validation (any/all modes)
- SSO callback URL construction
"""

import logging
from typing import Any
from urllib.parse import urlencode

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.services.encryption import decrypt

logger = logging.getLogger(__name__)


class SSOService:
    """Service for SSO operations."""

    def __init__(self, db: AsyncSession):
        self.db = db
        self.settings = get_settings()

    async def get_effective_sso_config(
        self, tenant: Any = None
    ) -> tuple[dict[str, Any] | None, str]:
        """
        Get the effective SSO configuration for a tenant.

        ``tenant`` may be a ``Tenant`` ORM object, the lightweight tenant-info
        dict that ``TenantMiddleware`` attaches to ``request.state`` (which only
        carries primitive fields, not relationships), or ``None`` in
        single-tenant mode. Organization-level config is resolved against the
        master DB using the tenant id, so it works regardless of which form is
        passed.

        Returns:
            Tuple of (config_dict, source) where:
            - config_dict: SSO configuration as dict, or None if SSO not enabled
            - source: 'organization', 'tenant', or 'none'
        """
        # Resolve the tenant id from either an ORM object or the state dict.
        tenant_id = None
        if tenant is not None:
            tenant_id = (
                tenant.get("id") if isinstance(tenant, dict) else getattr(tenant, "id", None)
            )

        # Organization-level SSO lives in the master DB and is shared across a
        # tenant's organization. Only relevant in multi-tenant mode.
        if tenant_id and self.settings.multi_tenant:
            org_config = await self._get_organization_sso_config(str(tenant_id))
            if org_config is not None:
                return org_config, "organization"

        # Fall back to tenant-level SSO config
        from app.models.settings import SSOConfig

        try:
            result = await self.db.execute(select(SSOConfig).where(SSOConfig.id == 1))
            config = result.scalar_one_or_none()
        except Exception:
            # A missing table or a query against the wrong database must not
            # surface as a 500 (e.g. the SSO callback running without tenant
            # context). Treat it as "no tenant-level SSO configured".
            logger.exception("Tenant-level SSO config lookup failed")
            return None, "none"

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

    async def _get_organization_sso_config(self, tenant_id: str) -> dict[str, Any] | None:
        """
        Resolve organization-level SSO config for a tenant from the master DB.

        The tenant object attached to the request is a detached dict, so the
        organization and its SSO config are loaded fresh (and eagerly) from the
        master database here. Returns the effective config dict when the
        tenant's organization has SSO enabled and configured, otherwise None.
        """
        from sqlalchemy.orm import selectinload

        from app.models.organization import Organization
        from app.models.tenant import Tenant
        from app.services.master_db import master_db

        try:
            async with master_db.session() as session:
                result = await session.execute(
                    select(Tenant)
                    .where(Tenant.id == tenant_id)
                    .options(
                        selectinload(Tenant.organization).selectinload(Organization.sso_config)
                    )
                )
                tenant = result.scalar_one_or_none()
        except Exception:
            logger.exception("Failed to load organization SSO config for tenant %s", tenant_id)
            return None

        if not tenant or not tenant.organization:
            return None

        org = tenant.organization
        config = org.sso_config
        if not config or not config.is_enabled or not config.is_configured:
            return None

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
            "required_group_ids": tenant.required_group_ids or [],
            "group_membership_mode": tenant.group_membership_mode or "any",
            "organization": {
                "id": str(org.id),
                "name": org.name,
                "slug": org.slug,
            },
        }

    async def get_active_organization_sso(self, tenant_id: Any) -> dict[str, Any] | None:
        """
        Return the effective organization-level SSO config for a tenant when its
        organization has SSO enabled and configured, otherwise None.

        Thin public wrapper over ``_get_organization_sso_config`` used by the
        settings UI and write guardrails to detect whether tenant-level SSO is
        overridden by (and therefore redundant with) organization SSO. Only
        meaningful in multi-tenant mode; returns None when the id is missing.
        """
        if not tenant_id:
            return None
        return await self._get_organization_sso_config(str(tenant_id))

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
