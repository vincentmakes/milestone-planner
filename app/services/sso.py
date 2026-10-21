"""
SSO Service for organization-level SSO with Microsoft Entra ID.

Provides:
- Effective SSO config resolution (organization or tenant level)
- Microsoft Graph API calls for group membership
- Group membership validation (any/all modes)
- SSO callback URL construction
"""

import logging
import re
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.services.encryption import decrypt, encrypt
from app.services.permissions import ADMIN_ROLE_KEY, ROLE_KEY_PATTERN, SYSTEM_ROLE_KEYS

logger = logging.getLogger(__name__)


class OrgSSOLookupError(RuntimeError):
    """
    The organization-level SSO lookup itself failed.

    Distinct from "this tenant has no organization SSO", which is a plain
    ``None``. The distinction matters: a caller that reads a failed lookup as
    "no organization SSO" falls through to the tenant-level config and, on the
    SSO callback, redeems the authorization code against a *different* client
    and redirect URI than the one ``/authorize`` was called with — which Entra
    rejects with an error that looks nothing like the real cause.
    """


_SSO_FALLBACK_ROLE = "user"


async def resolve_sso_default_role(db: AsyncSession, role: Any) -> str:
    """
    Return the role to give an SSO auto-created user, resolved in the tenant DB.

    The stored default (tenant ``sso_config.default_role`` or the
    organization's ``default_user_role``) is used when it is a role key that
    exists in this tenant's ``roles`` and is not ``admin``; anything else
    falls back to ``user``. So a bad stored default (e.g. an organization
    config saved before the role was validated, with ``viewer``, or a custom
    role since deleted) cannot make every first SSO sign-in fail on the
    ``users.role`` foreign key to ``roles.key``, and an automatically created
    account is never an administrator. The system roles always exist (no query).
    """
    if not isinstance(role, str):
        return _SSO_FALLBACK_ROLE
    key = role.strip().lower()
    if key == ADMIN_ROLE_KEY or not re.match(ROLE_KEY_PATTERN, key):
        return _SSO_FALLBACK_ROLE
    if key in SYSTEM_ROLE_KEYS:
        return key

    from app.models.rbac import Role

    found = await db.execute(select(Role.key).where(Role.key == key))
    return found.scalar_one_or_none() or _SSO_FALLBACK_ROLE


SSO_DEFAULT_ROLE_DETAIL = "Unknown role, or a role SSO cannot assign: {role}"


async def ensure_sso_default_role(db: AsyncSession, role: str) -> str:
    """
    A tenant SSO default role being saved: the key itself when
    ``resolve_sso_default_role`` keeps it (an existing, non-admin role),
    else 400 -- never silently stored as something sign-in would replace.
    """
    resolved = await resolve_sso_default_role(db, role)
    if resolved != role:
        raise HTTPException(status_code=400, detail=SSO_DEFAULT_ROLE_DETAIL.format(role=role))
    return resolved


def _stored_role(role: Any) -> str | None:
    """A stored default role as configured (trimmed); resolved at sign-in."""
    return role.strip() if isinstance(role, str) else None


# ---------------------------------------------------------
# Tenant-level client secret at rest
# ---------------------------------------------------------

# ``encrypt()`` output: 12-byte IV, 16-byte GCM tag, ciphertext — all hex.
_ENCRYPTED_SECRET_RE = re.compile(r"^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*$")

# Prefix the settings UI echoes back for "keep the stored secret".
MASKED_SECRET_PREFIX = "****"

_decrypt_failure_logged = False


def is_encrypted_secret(value: Any) -> bool:
    """True when ``value`` has the ``iv:tag:ciphertext`` shape ``encrypt()`` writes."""
    return isinstance(value, str) and bool(_ENCRYPTED_SECRET_RE.match(value))


def read_tenant_client_secret(config: Any) -> str | None:
    """
    Return the plaintext client secret of a tenant ``SSOConfig`` row.

    Encrypted values are decrypted; a legacy plaintext value (written before
    secrets were encrypted at rest) is returned as is — callers upgrade it with
    :func:`store_tenant_client_secret`. When decryption fails (the encryption
    key changed — in single-tenant mode it is derived from ``SESSION_SECRET``)
    the failure is logged once and ``None`` is returned, so SSO reports "not
    configured" instead of failing with a 500.
    """
    global _decrypt_failure_logged
    stored = getattr(config, "client_secret", None)
    if not stored:
        return None
    if not is_encrypted_secret(stored):
        return stored
    try:
        return decrypt(stored)
    except Exception:
        if not _decrypt_failure_logged:
            _decrypt_failure_logged = True
            logger.error(
                "Could not decrypt the tenant SSO client secret; the encryption key "
                "(TENANT_ENCRYPTION_KEY, or SESSION_SECRET in single-tenant mode) has "
                "probably changed. Re-enter the client secret in Settings > SSO."
            )
        return None


def store_tenant_client_secret(config: Any, secret: str | None) -> None:
    """Write ``secret`` to a tenant ``SSOConfig`` row, encrypted at rest."""
    if secret:
        config.client_secret = encrypt(secret)
    else:
        config.client_secret = None if secret is None else ""


def apply_secret_update(config: Any, submitted: str | None) -> bool:
    """
    Apply a client secret submitted to one of the SSO write routes.

    ``None`` (field omitted) and the masked form the settings UI displays
    (``****abcd``) keep the stored secret; anything else replaces it (an empty
    string clears it). Returns True when the stored secret changed.
    """
    if submitted is None or submitted.startswith(MASKED_SECRET_PREFIX):
        return False
    store_tenant_client_secret(config, submitted)
    return True


def mask_secret(secret: str | None) -> str | None:
    """``****`` plus the last four characters, or None for no secret."""
    if not secret:
        return None
    return MASKED_SECRET_PREFIX + secret[-4:]


def tenant_sso_is_configured(config: Any) -> bool:
    """Like ``SSOConfig.is_configured``, but requires a *readable* client secret."""
    return bool(
        config is not None
        and config.tenant_id
        and config.client_id
        and config.redirect_uri
        and read_tenant_client_secret(config)
    )


def _clean(value: Any) -> Any:
    """Strip whitespace off a config string, leaving non-strings untouched."""
    return value.strip() if isinstance(value, str) else value


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

        Raises:
            OrgSSOLookupError: the organization-level lookup failed. Never
                falls back to the tenant-level config in that case — see the
                exception's docstring for why that fallback is dangerous.
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
            client_secret = read_tenant_client_secret(config)
            if not client_secret:
                # Stored encrypted under a key we no longer have.
                return None, "none"
            effective = {
                "enabled": True,
                "provider": "entra",
                "tenant_id": _clean(config.tenant_id),
                "client_id": _clean(config.client_id),
                "client_secret": _clean(client_secret),
                "redirect_uri": _clean(config.redirect_uri),
                "auto_create_users": config.should_auto_create_users,
                "default_role": _stored_role(config.default_role),
                "required_group_ids": [],
                "group_membership_mode": "any",
            }
            if not is_encrypted_secret(config.client_secret):
                # Lazy upgrade of a secret saved before encryption at rest. Runs
                # after the dict is built: a failed commit rolls back and
                # expires the row.
                await self._upgrade_plaintext_secret(config, client_secret)
            return effective, "tenant"

        return None, "none"

    async def _upgrade_plaintext_secret(self, config: Any, plaintext: str) -> None:
        """Re-store a legacy plaintext secret encrypted. Best effort, never raises."""
        try:
            store_tenant_client_secret(config, plaintext)
            await self.db.commit()
            logger.info("Encrypted the tenant SSO client secret at rest (lazy upgrade)")
        except Exception:
            logger.warning("Could not encrypt the legacy tenant SSO client secret", exc_info=True)
            try:
                await self.db.rollback()
            except Exception:  # pragma: no cover - best effort
                pass

    async def _get_organization_sso_config(self, tenant_id: str) -> dict[str, Any] | None:
        """
        Resolve organization-level SSO config for a tenant from the master DB.

        The tenant object attached to the request is a detached dict, so the
        organization and its SSO config are loaded fresh (and eagerly) from the
        master database here. Returns the effective config dict when the
        tenant's organization has SSO enabled and configured, otherwise None.

        Raises ``OrgSSOLookupError`` when the lookup cannot be completed, so a
        caller can tell "no organization SSO" apart from "we do not know".
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
        except Exception as exc:
            logger.exception("Failed to load organization SSO config for tenant %s", tenant_id)
            raise OrgSSOLookupError(
                f"organization SSO lookup failed for tenant {tenant_id}"
            ) from exc

        if not tenant or not tenant.organization:
            return None

        org = tenant.organization
        config = org.sso_config
        if not config or not config.is_enabled or not config.is_configured:
            return None

        try:
            client_secret = (
                decrypt(config.client_secret_encrypted) if config.client_secret_encrypted else None
            )
        except Exception as exc:
            # A wrong/rotated TENANT_ENCRYPTION_KEY would otherwise surface as an
            # opaque 500 from the login and callback routes.
            logger.exception("Failed to decrypt SSO client secret for organization %s", org.id)
            raise OrgSSOLookupError(
                f"could not decrypt SSO client secret for organization {org.id}"
            ) from exc

        return {
            "enabled": True,
            "provider": config.provider,
            # Stripped on read, not just on write: configurations saved before
            # the write-side validators existed can carry a trailing newline
            # from a copy-paste, which Entra rejects as an invalid secret.
            "tenant_id": _clean(config.entra_tenant_id),
            "client_id": _clean(config.client_id),
            "client_secret": _clean(client_secret),
            "redirect_uri": _clean(config.redirect_uri),
            "auto_create_users": config.should_auto_create_users,
            "default_role": _stored_role(config.default_user_role),
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

    async def fetch_user_groups(self, access_token: str, max_groups: int = 500) -> list[str] | None:
        """
        Fetch user's group memberships from Microsoft Graph API.

        Uses /me/memberOf endpoint with pagination support.

        Args:
            access_token: Valid access token with GroupMember.Read.All scope
            max_groups: Maximum number of groups to fetch (default 500)

        Returns:
            List of group IDs the user is a member of, or ``None`` if the lookup
            itself failed. Callers gating access on groups must treat ``None``
            as "unknown" rather than "member of nothing" — a missing
            GroupMember.Read.All consent would otherwise deny every user.
        """
        group_ids: list[str] = []
        url = "https://graph.microsoft.com/v1.0/me/memberOf?$select=id,displayName"

        async with httpx.AsyncClient() as client:
            while url and len(group_ids) < max_groups:
                response = await client.get(
                    url, headers={"Authorization": f"Bearer {access_token}"}
                )

                if response.status_code != 200:
                    logger.warning(
                        "Failed to fetch groups: %s %s", response.status_code, response.text
                    )
                    return None

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

        # Every value here resolves to a single resource (Microsoft Graph;
        # openid/profile/email are OIDC scopes), which is what the v2.0
        # endpoints require. Adding a scope on a second API would make Entra
        # reject the request with AADSTS28000 — this list is correct as it is.
        # The callback's redemption must keep using the same scopes.
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
