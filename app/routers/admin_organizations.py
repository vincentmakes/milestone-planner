"""
Admin Organizations Router.

Handles organization management in multi-tenant admin panel:
- Organization CRUD operations
- Organization SSO configuration
- Tenant-organization association
"""

import logging
import re
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import get_settings
from app.models.organization import Organization, OrganizationSSOConfig
from app.models.tenant import AdminUser, Tenant
from app.routers.admin.auth import get_current_admin
from app.routers.admin.tenants import add_audit_log
from app.schemas.organization import (
    OrganizationCreate,
    OrganizationDetailResponse,
    OrganizationResponse,
    OrganizationSSOConfigCreate,
    OrganizationSSOConfigResponse,
    OrganizationSSOTestCheck,
    OrganizationSSOTestResponse,
    OrganizationUpdate,
    TenantGroupAccessUpdate,
    TenantSummary,
)
from app.services.encryption import decrypt, encrypt
from app.services.master_db import get_master_db
from app.services.sso_errors import parse_entra_token_error
from app.utils import utcnow_naive

router = APIRouter(prefix="/admin/organizations", tags=["Admin Organizations"])

logger = logging.getLogger(__name__)


async def _tenant_has_own_sso_enabled(tenant: Tenant) -> bool:
    """
    Best-effort check of whether a tenant has its own tenant-level SSO enabled.

    Connects to the tenant's own database (its SSO config lives there, not in
    the master DB) and reads the singleton ``sso_config`` row. Any failure —
    missing credentials, unreachable DB, absent table — yields False so the
    caller never fails an organization action over an advisory warning.
    """
    from app.models.settings import SSOConfig
    from app.services.tenant_manager import tenant_connection_manager

    credentials = getattr(tenant, "credentials", None)
    if not credentials or not getattr(credentials, "encrypted_password", None):
        return False

    tenant_info = {
        "slug": tenant.slug,
        "database_name": tenant.database_name,
        "database_user": tenant.database_user,
        "encrypted_password": credentials.encrypted_password,
    }

    try:
        await tenant_connection_manager.get_pool_from_info(tenant_info)
        factory = tenant_connection_manager.get_session_factory(tenant.slug)
        if factory is None:
            return False
        async with factory() as tdb:
            result = await tdb.execute(select(SSOConfig).where(SSOConfig.id == 1))
            config = result.scalar_one_or_none()
        return bool(config and config.enabled == 1)
    except Exception:
        logger.warning("Could not check tenant-level SSO for %s", tenant.slug, exc_info=True)
        return False


# ---------------------------------------------------------
# Organization CRUD
# ---------------------------------------------------------


@router.get("", response_model=list[OrganizationResponse])
async def list_organizations(
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """List all organizations with tenant counts."""
    # Query organizations with tenant count
    result = await db.execute(
        select(Organization, func.count(Tenant.id).label("tenant_count"))
        .outerjoin(Tenant, Tenant.organization_id == Organization.id)
        .options(selectinload(Organization.sso_config))
        .group_by(Organization.id)
        .order_by(Organization.name)
    )
    rows = result.all()

    return [
        OrganizationResponse(
            id=org.id,
            name=org.name,
            slug=org.slug,
            description=org.description,
            created_at=org.created_at,
            updated_at=org.updated_at,
            tenant_count=count,
            sso_enabled=org.sso_config.is_enabled if org.sso_config else False,
        )
        for org, count in rows
    ]


@router.post("", response_model=OrganizationResponse, status_code=201)
async def create_organization(
    data: OrganizationCreate,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Create a new organization."""
    # Check if slug is already used
    existing = await db.execute(select(Organization).where(Organization.slug == data.slug))
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Organization with slug '{data.slug}' already exists",
        )

    # Create organization
    org = Organization(
        id=uuid.uuid4(),
        name=data.name,
        slug=data.slug,
        description=data.description,
    )
    db.add(org)
    await db.commit()
    await db.refresh(org)

    return OrganizationResponse(
        id=org.id,
        name=org.name,
        slug=org.slug,
        description=org.description,
        created_at=org.created_at,
        updated_at=org.updated_at,
        tenant_count=0,
        sso_enabled=False,
    )


@router.get("/{org_id}", response_model=OrganizationDetailResponse)
async def get_organization(
    org_id: str,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Get organization details including SSO config and tenants."""
    result = await db.execute(
        select(Organization)
        .where(Organization.id == org_id)
        .options(
            selectinload(Organization.sso_config),
            selectinload(Organization.tenants),
        )
    )
    org = result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    # Build SSO config response if exists
    sso_config = None
    if org.sso_config:
        sso_config = OrganizationSSOConfigResponse(
            enabled=org.sso_config.is_enabled,
            configured=org.sso_config.is_configured,
            provider=org.sso_config.provider,
            entra_tenant_id=org.sso_config.entra_tenant_id,
            client_id=org.sso_config.client_id,
            redirect_uri=org.sso_config.redirect_uri,
            auto_create_users=org.sso_config.should_auto_create_users,
            default_user_role=org.sso_config.default_user_role,
        )

    return OrganizationDetailResponse(
        id=org.id,
        name=org.name,
        slug=org.slug,
        description=org.description,
        created_at=org.created_at,
        updated_at=org.updated_at,
        sso_config=sso_config,
        tenants=[
            TenantSummary(
                id=t.id,
                name=t.name,
                slug=t.slug,
                status=t.status,
                required_group_ids=t.required_group_ids or [],
                group_membership_mode=t.group_membership_mode or "any",
            )
            for t in org.tenants
        ],
    )


@router.put("/{org_id}", response_model=OrganizationResponse)
async def update_organization(
    org_id: str,
    data: OrganizationUpdate,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Update an organization."""
    result = await db.execute(
        select(Organization)
        .where(Organization.id == org_id)
        .options(selectinload(Organization.sso_config))
    )
    org = result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    if data.name is not None:
        org.name = data.name
    if data.description is not None:
        org.description = data.description

    org.updated_at = utcnow_naive()

    await db.commit()
    await db.refresh(org)

    # Get tenant count
    count_result = await db.execute(
        select(func.count(Tenant.id)).where(Tenant.organization_id == org.id)
    )
    tenant_count = count_result.scalar() or 0

    return OrganizationResponse(
        id=org.id,
        name=org.name,
        slug=org.slug,
        description=org.description,
        created_at=org.created_at,
        updated_at=org.updated_at,
        tenant_count=tenant_count,
        sso_enabled=org.sso_config.is_enabled if org.sso_config else False,
    )


@router.delete("/{org_id}")
async def delete_organization(
    org_id: str,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Delete an organization. Tenants will be disassociated but not deleted."""
    result = await db.execute(
        select(Organization)
        .where(Organization.id == org_id)
        .options(selectinload(Organization.tenants))
    )
    org = result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    # Disassociate tenants (organization_id will be set to NULL by ON DELETE SET NULL)
    # Just need to clear group restrictions
    for tenant in org.tenants:
        tenant.required_group_ids = []
        tenant.group_membership_mode = "any"

    await db.delete(org)
    await db.commit()

    return {"success": True, "message": f"Organization '{org.name}' deleted"}


# ---------------------------------------------------------
# Organization SSO Configuration
# ---------------------------------------------------------


@router.get("/{org_id}/sso", response_model=OrganizationSSOConfigResponse)
async def get_organization_sso_config(
    org_id: str,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Get organization SSO configuration."""
    result = await db.execute(
        select(Organization)
        .where(Organization.id == org_id)
        .options(selectinload(Organization.sso_config))
    )
    org = result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    if not org.sso_config:
        return OrganizationSSOConfigResponse(
            enabled=False,
            configured=False,
            provider="entra",
            entra_tenant_id=None,
            client_id=None,
            redirect_uri=None,
            auto_create_users=False,
            default_user_role="user",
        )

    return OrganizationSSOConfigResponse(
        enabled=org.sso_config.is_enabled,
        configured=org.sso_config.is_configured,
        provider=org.sso_config.provider,
        entra_tenant_id=org.sso_config.entra_tenant_id,
        client_id=org.sso_config.client_id,
        redirect_uri=org.sso_config.redirect_uri,
        auto_create_users=org.sso_config.should_auto_create_users,
        default_user_role=org.sso_config.default_user_role,
    )


@router.put("/{org_id}/sso", response_model=OrganizationSSOConfigResponse)
async def update_organization_sso_config(
    org_id: str,
    data: OrganizationSSOConfigCreate,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Create or update organization SSO configuration."""
    result = await db.execute(
        select(Organization)
        .where(Organization.id == org_id)
        .options(selectinload(Organization.sso_config))
    )
    org = result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    config = org.sso_config

    if not config:
        # Create new SSO config
        config = OrganizationSSOConfig(
            organization_id=org.id,
            enabled=1 if data.enabled else 0,
            provider="entra",
        )
        db.add(config)

    # Update fields if provided
    if data.enabled is not None:
        config.enabled = 1 if data.enabled else 0
    if data.entra_tenant_id is not None:
        config.entra_tenant_id = data.entra_tenant_id
    if data.client_id is not None:
        config.client_id = data.client_id
    if data.client_secret is not None and data.client_secret:
        # Encrypt the client secret
        config.client_secret_encrypted = encrypt(data.client_secret)
    if data.redirect_uri is not None:
        config.redirect_uri = data.redirect_uri
    if data.auto_create_users is not None:
        config.auto_create_users = 1 if data.auto_create_users else 0
    if data.default_user_role is not None:
        config.default_user_role = data.default_user_role

    config.updated_at = utcnow_naive()

    await db.commit()
    await db.refresh(config)

    return OrganizationSSOConfigResponse(
        enabled=config.is_enabled,
        configured=config.is_configured,
        provider=config.provider,
        entra_tenant_id=config.entra_tenant_id,
        client_id=config.client_id,
        redirect_uri=config.redirect_uri,
        auto_create_users=config.should_auto_create_users,
        default_user_role=config.default_user_role,
    )


_GUID_RE = re.compile(r"^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")

_WEB_PLATFORM_CHECK = (
    "Confirm the redirect URI is registered under the 'Web' platform in Entra, not "
    "'Single-page application'. A URI registered as a single-page application authorizes "
    "normally but cannot be redeemed from the server, and this test cannot see the difference."
)


def _check(name: str, status_: str, message: str, code: str | None = None):
    return OrganizationSSOTestCheck(name=name, status=status_, message=message, code=code)


def _local_sso_checks(config: OrganizationSSOConfig, secret: str | None) -> list:
    """Everything that can be judged without asking Microsoft anything."""
    checks = []

    for label, value in (
        ("Directory (tenant) ID", config.entra_tenant_id),
        ("Application (client) ID", config.client_id),
    ):
        if not value:
            checks.append(_check(label, "fail", "Not set."))
        elif not _GUID_RE.match(value):
            checks.append(
                _check(label, "warn", "This does not look like a GUID. Copy it from Entra.")
            )
        else:
            checks.append(_check(label, "pass", "Looks like a valid identifier."))

    if not config.client_secret_encrypted:
        checks.append(_check("Client secret", "fail", "Not set."))
    elif secret is None:
        checks.append(
            _check(
                "Client secret",
                "fail",
                "Stored, but it could not be decrypted. This usually means "
                "TENANT_ENCRYPTION_KEY changed since it was saved — re-enter the secret.",
            )
        )
    elif _GUID_RE.match(secret):
        # Azure shows Value and Secret ID side by side and only the Value works.
        checks.append(
            _check(
                "Client secret",
                "warn",
                "This looks like the Secret ID, not the secret Value. Copy the Value column "
                "from Certificates & secrets in Entra — it is only shown once, so a new "
                "secret may be needed.",
            )
        )
    else:
        checks.append(_check("Client secret", "pass", "Stored and readable."))

    uri = config.redirect_uri or ""
    if not uri:
        checks.append(_check("Redirect URI", "fail", "Not set."))
    elif "/t/" in uri:
        checks.append(
            _check(
                "Redirect URI",
                "fail",
                "Organization SSO uses one shared callback for every workspace, so the URI "
                "must not contain a /t/{slug}/ path.",
            )
        )
    elif not uri.startswith("https://"):
        checks.append(_check("Redirect URI", "warn", "Should be an absolute https:// URL."))
    elif not uri.endswith("/api/auth/sso/callback"):
        checks.append(_check("Redirect URI", "warn", "Should end in /api/auth/sso/callback."))
    else:
        checks.append(_check("Redirect URI", "pass", uri))

    return checks


def _outbound_network_check() -> OrganizationSSOTestCheck:
    """
    Report how this deployment reaches the internet, and what SSO actually uses.

    Two environments running the same version can differ only here, and an
    operator without access to the container has no other way to see it. The
    asymmetry is the point: SSO requests are plain httpx, so they follow
    HTTPS_PROXY/HTTP_PROXY from the environment and nothing else, while
    PROXY_PAC_URL, PROXY_CA_CERT and the proxy credentials apply only to the
    holiday import. A deployment configured the second way believes it has told
    the app about its proxy and has not.

    Never reports the value of PROXY_USERNAME or PROXY_PASSWORD.
    """
    settings = get_settings()

    env_proxy = settings.https_proxy or settings.http_proxy
    unused = [
        name
        for name, value in (
            ("PROXY_PAC_URL", settings.proxy_pac_url),
            ("PROXY_CA_CERT", settings.proxy_ca_cert),
            ("PROXY_USERNAME/PROXY_PASSWORD", settings.proxy_username or settings.proxy_password),
        )
        if value
    ]
    if not settings.proxy_verify_ssl:
        unused.append("PROXY_VERIFY_SSL=false")

    if not env_proxy and not unused:
        return _check(
            "Outbound network",
            "pass",
            "No proxy is configured; sign-in requests connect to Microsoft directly.",
        )

    parts = []
    if env_proxy:
        parts.append(f"Sign-in requests use the configured proxy ({env_proxy}).")
    else:
        parts.append("Sign-in requests connect to Microsoft directly — no HTTPS_PROXY is set.")
    if unused:
        parts.append(
            f"{', '.join(unused)} {'is' if len(unused) == 1 else 'are'} configured but "
            "applies only to the public-holiday import, not to sign-in. If Microsoft is only "
            "reachable through that proxy, sign-in cannot reach it."
        )

    return _check("Outbound network", "warn" if unused else "pass", " ".join(parts))


@router.post("/{org_id}/sso/test", response_model=OrganizationSSOTestResponse)
async def run_organization_sso_test(
    org_id: str,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """
    Check an organization's saved SSO configuration against Microsoft.

    Signs in as the application itself (a client-credentials request), which
    exercises the directory ID, client ID and stored secret without needing
    anyone to sign in — so a configuration can be diagnosed before, or instead
    of, a failed user sign-in.

    It cannot prove that a user sign-in will work: the application sign-in never
    involves a redirect URI, so nothing here can see whether that URI is
    registered under the Web platform. That is reported as a check to make by
    hand, and the response says "credentials" rather than "SSO" throughout.
    """
    result = await db.execute(
        select(Organization)
        .where(Organization.id == org_id)
        .options(selectinload(Organization.sso_config))
    )
    org = result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    config = org.sso_config
    if not config:
        return OrganizationSSOTestResponse(
            credentials_ok=False,
            summary="This organization has no SSO configuration yet.",
            checks=[_check("Configuration", "fail", "Nothing saved.")],
        )

    try:
        secret = decrypt(config.client_secret_encrypted) if config.client_secret_encrypted else None
    except Exception:
        logger.warning("SSO test: could not decrypt secret for organization %s", org.id)
        secret = None

    secret = (secret or "").strip() or None
    checks = _local_sso_checks(config, secret)
    checks.append(_outbound_network_check())

    if any(check.status == "fail" for check in checks):
        checks.append(_check("Microsoft sign-in", "manual", _WEB_PLATFORM_CHECK))
        return OrganizationSSOTestResponse(
            credentials_ok=False,
            summary="Fix the settings marked below, then test again.",
            checks=checks,
        )

    entra_tenant_id = (config.entra_tenant_id or "").strip()
    base = f"https://login.microsoftonline.com/{entra_tenant_id}"
    credentials_ok = False

    try:
        async with httpx.AsyncClient() as client:
            discovery = await client.get(f"{base}/v2.0/.well-known/openid-configuration")
            if discovery.status_code != 200:
                checks.append(
                    _check(
                        "Microsoft directory",
                        "fail",
                        "Microsoft does not recognise this Directory (tenant) ID.",
                    )
                )
            else:
                checks.append(_check("Microsoft directory", "pass", "Found and reachable."))

                token = await client.post(
                    f"{base}/oauth2/v2.0/token",
                    data={
                        "client_id": (config.client_id or "").strip(),
                        "client_secret": secret,
                        "grant_type": "client_credentials",
                        "scope": "https://graph.microsoft.com/.default",
                    },
                )
                if token.status_code == 200:
                    credentials_ok = True
                    checks.append(
                        _check(
                            "Client credentials",
                            "pass",
                            "Microsoft accepted the client ID and secret.",
                        )
                    )
                else:
                    error = parse_entra_token_error(token.status_code, token.text)
                    logger.error(
                        "SSO test for organization %s rejected (%s): %s",
                        org.id,
                        error.code or "no AADSTS code",
                        error.admin_remedy,
                    )
                    checks.append(
                        _check(
                            "Client credentials",
                            "fail",
                            error.admin_remedy,
                            code=error.code,
                        )
                    )
    except Exception:
        # Reaching Microsoft is a separate problem from the credentials being
        # wrong, and reporting it as the latter sends people to fix the wrong
        # thing. Say what actually happened.
        logger.warning(
            "SSO test: could not reach Microsoft for organization %s", org.id, exc_info=True
        )
        checks.append(
            _check(
                "Microsoft directory",
                "warn",
                "Could not reach login.microsoftonline.com from the server. Check outbound "
                "network access and any corporate proxy settings.",
            )
        )

    checks.append(_check("Microsoft sign-in", "manual", _WEB_PLATFORM_CHECK))

    logger.info(
        "SSO test for organization %s run by %s: credentials_ok=%s",
        org.id,
        admin.email,
        credentials_ok,
    )

    if credentials_ok:
        summary = (
            "Microsoft accepted the credentials. Confirm the redirect URI platform below to finish."
        )
    elif any(check.status == "fail" for check in checks):
        summary = "Microsoft rejected the configuration. See below."
    else:
        summary = "The settings look right, but they could not be checked with Microsoft."

    return OrganizationSSOTestResponse(
        credentials_ok=credentials_ok, summary=summary, checks=checks
    )


@router.delete("/{org_id}/sso")
async def delete_organization_sso_config(
    org_id: str,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Delete organization SSO configuration."""
    result = await db.execute(
        select(Organization)
        .where(Organization.id == org_id)
        .options(selectinload(Organization.sso_config))
    )
    org = result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    if not org.sso_config:
        raise HTTPException(status_code=404, detail="SSO config not found")

    await db.delete(org.sso_config)
    await db.commit()

    return {"success": True, "message": "SSO configuration deleted"}


# ---------------------------------------------------------
# Tenant Organization Assignment
# ---------------------------------------------------------


@router.put("/{org_id}/tenants/{tenant_id}")
async def add_tenant_to_organization(
    org_id: str,
    tenant_id: str,
    data: TenantGroupAccessUpdate | None = None,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Add a tenant to an organization with optional group requirements."""
    # Get organization (with its SSO config to know if org SSO would override the tenant's own)
    org_result = await db.execute(
        select(Organization)
        .where(Organization.id == org_id)
        .options(selectinload(Organization.sso_config))
    )
    org = org_result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    # Get tenant (with credentials so we can inspect its own SSO config if needed)
    tenant_result = await db.execute(
        select(Tenant).where(Tenant.id == tenant_id).options(selectinload(Tenant.credentials))
    )
    tenant = tenant_result.scalar_one_or_none()

    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    # If organization SSO is active it will override any SSO this tenant set up
    # for itself. Surface that (best-effort) so the admin can warn the tenant.
    tenant_had_own_sso = False
    if org.sso_config and org.sso_config.is_enabled:
        tenant_had_own_sso = await _tenant_has_own_sso_enabled(tenant)

    # Update tenant
    tenant.organization_id = org.id

    if data:
        if data.required_group_ids is not None:
            tenant.required_group_ids = data.required_group_ids
        if data.group_membership_mode is not None:
            if data.group_membership_mode not in ("any", "all"):
                raise HTTPException(
                    status_code=400, detail="group_membership_mode must be 'any' or 'all'"
                )
            tenant.group_membership_mode = data.group_membership_mode

    # Add audit log
    await add_audit_log(
        db,
        tenant.id,
        "organization_assigned",
        details={"organization_id": str(org.id), "organization_name": org.name},
        actor=admin.email,
    )

    await db.commit()

    return {
        "success": True,
        "message": f"Tenant '{tenant.name}' added to organization '{org.name}'",
        "tenant_had_own_sso": tenant_had_own_sso,
    }


@router.delete("/{org_id}/tenants/{tenant_id}")
async def remove_tenant_from_organization(
    org_id: str,
    tenant_id: str,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Remove a tenant from an organization."""
    # Get tenant
    tenant_result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = tenant_result.scalar_one_or_none()

    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    if str(tenant.organization_id) != org_id:
        raise HTTPException(status_code=400, detail="Tenant is not in this organization")

    # Clear organization and group settings
    old_org_id = tenant.organization_id
    tenant.organization_id = None
    tenant.required_group_ids = []
    tenant.group_membership_mode = "any"

    # Add audit log
    await add_audit_log(
        db,
        tenant.id,
        "organization_removed",
        details={"organization_id": str(old_org_id)},
        actor=admin.email,
    )

    await db.commit()

    return {
        "success": True,
        "message": f"Tenant '{tenant.name}' removed from organization",
    }


@router.patch("/tenants/{tenant_id}/groups")
async def update_tenant_group_access(
    tenant_id: str,
    data: TenantGroupAccessUpdate,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Update tenant's group-based access requirements."""
    # Get tenant
    tenant_result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = tenant_result.scalar_one_or_none()

    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    # Handle organization_id update
    if data.organization_id is not None:
        if data.organization_id:
            # Verify organization exists
            org_result = await db.execute(
                select(Organization).where(Organization.id == data.organization_id)
            )
            if not org_result.scalar_one_or_none():
                raise HTTPException(status_code=404, detail="Organization not found")
        tenant.organization_id = data.organization_id if data.organization_id else None

    if data.required_group_ids is not None:
        tenant.required_group_ids = data.required_group_ids

    if data.group_membership_mode is not None:
        if data.group_membership_mode not in ("any", "all"):
            raise HTTPException(
                status_code=400, detail="group_membership_mode must be 'any' or 'all'"
            )
        tenant.group_membership_mode = data.group_membership_mode

    await db.commit()
    await db.refresh(tenant)

    return {
        "success": True,
        "organization_id": str(tenant.organization_id) if tenant.organization_id else None,
        "required_group_ids": tenant.required_group_ids or [],
        "group_membership_mode": tenant.group_membership_mode,
    }
