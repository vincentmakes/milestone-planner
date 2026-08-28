"""
Authentication API router.
Handles login, logout, session management, and SSO.

Matches the Node.js API at /api/auth exactly.
"""

import hashlib
import logging
from contextlib import asynccontextmanager
from urllib.parse import quote_plus

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import get_settings
from app.database import get_db
from app.middleware.auth import (
    get_current_user,
    get_session_id,
    require_admin,
)
from app.models.settings import SSOConfig
from app.models.user import User
from app.schemas.auth import (
    AuthMeResponse,
    ChangePasswordRequest,
    LoginRequest,
    LoginResponse,
    SSOConfigResponse,
    SSOConfigUpdate,
    UserSessionInfo,
    UserSiteInfo,
)
from app.services.encryption import hash_user_password, password_needs_upgrade, verify_user_password
from app.services.session import SessionService
from app.services.sso_errors import parse_entra_token_error

logger = logging.getLogger(__name__)

router = APIRouter()
settings = get_settings()


def build_user_session_info(user: User) -> UserSessionInfo:
    """Build user session info from User model matching Node.js format."""
    sites = user.sites if user.sites else []

    return UserSessionInfo(
        id=user.id,
        email=user.email,
        firstName=user.first_name,
        lastName=user.last_name,
        name=f"{user.first_name} {user.last_name}".strip(),
        jobTitle=user.job_title,
        role=user.role,
        siteIds=[s.id for s in sites],
        sites=[
            UserSiteInfo(
                id=s.id,
                name=s.name,
                location=s.location,
                city=s.city,
                country_code=s.country_code,
                region_code=s.region_code,
                timezone=s.timezone,
                active=s.active,
            )
            for s in sites
        ],
    )


# ---------------------------------------------------------
# Basic Authentication
# ---------------------------------------------------------


@router.post("/auth/login", response_model=LoginResponse)
async def login(
    data: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """
    Authenticate user with email and password.

    Creates a session and sets the session cookie.
    Matches: POST /api/auth/login
    """
    # In multi-tenant mode, this endpoint requires a tenant context
    if settings.multi_tenant:
        state = getattr(request, "state", None)
        has_tenant = state and hasattr(state, "tenant_slug") and state.tenant_slug
        if not has_tenant:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No tenant context. Use tenant-specific URLs (/t/{slug}/api/auth/login).",
            )

    # Find user by email
    result = await db.execute(
        select(User).where(User.email == data.email).options(selectinload(User.sites))
    )
    user = result.scalar_one_or_none()

    # Verify credentials
    if not user or not verify_user_password(data.password, user.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    # Lazy upgrade: re-hash plain text or PBKDF2 passwords to bcrypt
    if password_needs_upgrade(user.password):
        user.password = hash_user_password(data.password)
        await db.commit()

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account is disabled",
        )

    # Create session
    session_service = SessionService(db)
    session_id = await session_service.create_session(user)

    # Set cookie (matching express-session format)
    response.set_cookie(
        key="connect.sid",
        value=f"s%3A{session_id}.",  # Simplified - no signature
        max_age=settings.session_max_age,
        httponly=True,
        samesite="lax",
        secure=settings.secure_cookies,
        path="/",
    )

    return LoginResponse(
        success=True,
        user=build_user_session_info(user),
    )


@router.post("/auth/logout")
async def logout(
    request: Request,
    response: Response,
    session_id: str | None = Depends(get_session_id),
    db: AsyncSession = Depends(get_db),
):
    """
    Log out the current user.

    Destroys the session and clears the cookie.
    Matches: POST /api/auth/logout
    """
    if settings.multi_tenant:
        state = getattr(request, "state", None)
        has_tenant = state and hasattr(state, "tenant_slug") and state.tenant_slug
        if not has_tenant:
            # Just clear the cookie and return success
            response.delete_cookie(key="connect.sid", path="/")
            return {"success": True}

    if session_id:
        session_service = SessionService(db)
        await session_service.delete_session(session_id)

    # Clear cookie
    response.delete_cookie(
        key="connect.sid",
        path="/",
    )

    return {"success": True}


@router.get("/auth/me", response_model=AuthMeResponse)
async def get_current_session(
    request: Request,
    session_id: str | None = Depends(get_session_id),
    db: AsyncSession = Depends(get_db),
):
    """
    Get current authenticated user.

    Returns { user: {...} } if authenticated, or { user: null }.
    Matches: GET /api/auth/me

    Note: This endpoint fetches the full user from DB (not cached session)
    to ensure all site attributes are available.
    """
    # In multi-tenant mode without tenant context, no user can be authenticated
    if settings.multi_tenant:
        state = getattr(request, "state", None)
        has_tenant = state and hasattr(state, "tenant_slug") and state.tenant_slug
        if not has_tenant:
            return AuthMeResponse(user=None)

    if not session_id:
        return AuthMeResponse(user=None)

    # Get user data from session
    session_service = SessionService(db)
    user_data = await session_service.get_user_from_session(session_id)

    if not user_data:
        return AuthMeResponse(user=None)

    user_id = user_data.get("id")
    if not user_id:
        return AuthMeResponse(user=None)

    # Fetch full user from database with sites relationship
    result = await db.execute(
        select(User).where(User.id == user_id).options(selectinload(User.sites))
    )
    user = result.scalar_one_or_none()

    if not user or not user.is_active:
        return AuthMeResponse(user=None)

    return AuthMeResponse(user=build_user_session_info(user))


@router.post("/auth/change-password")
async def change_password(
    data: ChangePasswordRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Change the current user's password.

    Requires current password verification.
    Matches: POST /api/auth/change-password
    """
    if settings.multi_tenant:
        state = getattr(request, "state", None)
        has_tenant = state and hasattr(state, "tenant_slug") and state.tenant_slug
        if not has_tenant:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No tenant context.",
            )

    # Verify current password
    if not verify_user_password(data.currentPassword, user.password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )

    # Update password (hashed with bcrypt)
    user.password = hash_user_password(data.newPassword)
    await db.commit()

    return {"success": True}


# ---------------------------------------------------------
# SSO Configuration (Admin only)
# ---------------------------------------------------------


async def _active_org_sso(
    request: Request, db: AsyncSession, *, strict: bool = False
) -> dict | None:
    """
    Return the active organization-level SSO config for the request's tenant,
    or None if the organization has no SSO (or in single-tenant mode).

    Used to detect when tenant-level SSO would be overridden by (and is
    therefore redundant with) organization SSO.

    ``strict`` decides what a failed lookup means. Read paths (the settings
    screen) leave it False and degrade to None rather than break. Write paths
    set it True: ``_reject_if_org_sso_active`` is a guardrail, and a guardrail
    that a master-DB blip can silently switch off is not one — those callers
    get a 503 instead.
    """
    if not settings.multi_tenant:
        return None

    tenant = getattr(request.state, "tenant", None) if hasattr(request, "state") else None
    tenant_id = tenant.get("id") if isinstance(tenant, dict) else getattr(tenant, "id", None)
    if not tenant_id:
        return None

    from app.services.sso import SSOService

    try:
        return await SSOService(db).get_active_organization_sso(tenant_id)
    except Exception:
        logger.exception("Organization SSO status lookup failed")
        if strict:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=("Single sign-on configuration could not be read. Please try again later."),
            ) from None
        return None


def _reject_if_org_sso_active(data: "SSOConfigUpdate", org_sso: dict | None) -> None:
    """
    Guardrail: refuse to enable tenant-level SSO while organization-level SSO is
    active for this tenant, since org SSO always takes precedence and the
    tenant-level config would silently never take effect.

    Disabling or clearing tenant-level SSO stays allowed (so admins can tidy up
    dead config). Raises HTTP 409 when the write would enable a redundant config.
    """
    if org_sso is not None and data.enabled:
        org_name = (org_sso.get("organization") or {}).get("name")
        detail = (
            "Organization-level SSO is active for this workspace"
            + (f" (via {org_name})" if org_name else "")
            + ". It overrides tenant-level SSO, so tenant-level SSO cannot be enabled. "
            "Ask an administrator to change SSO at the organization level."
        )
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


@router.get("/sso/config")
async def get_sso_config_public(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Get SSO configuration (public info only, no client_secret).

    Public endpoint - needed for login page to show SSO button.
    Matches: GET /api/sso/config
    """
    if settings.multi_tenant:
        state = getattr(request, "state", None)
        has_tenant = state and hasattr(state, "tenant_slug") and state.tenant_slug
        if not has_tenant:
            return {"enabled": 0}

    try:
        result = await db.execute(select(SSOConfig).where(SSOConfig.id == 1))
        config = result.scalar_one_or_none()
    except Exception as e:
        logger.error("SSO config query failed: %s", e)
        return {"enabled": 0}

    if not config:
        return {"enabled": 0}

    # Return snake_case to match Node.js
    return {
        "enabled": config.enabled,
        "tenant_id": config.tenant_id,
        "client_id": config.client_id,
        "redirect_uri": config.redirect_uri,
        "auto_create_users": config.auto_create_users,
        "default_role": config.default_role,
    }


@router.get("/sso/config/full")
async def get_sso_config_full(
    request: Request,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Get full SSO configuration including client_secret.

    Requires admin authentication.
    Matches: GET /api/sso/config/full

    Also reports whether organization-level SSO is active for this tenant
    (``org_sso_active`` + ``organization``); when it is, tenant-level SSO is
    overridden and the settings UI disables the form.
    """
    try:
        result = await db.execute(select(SSOConfig).where(SSOConfig.id == 1))
        config = result.scalar_one_or_none()
    except Exception as e:
        logger.exception("SSO config query failed: %s", e)
        config = None

    if not config:
        response: dict = {"id": 1, "enabled": 0}
    else:
        # Return snake_case to match Node.js, include client_secret_masked
        response = {
            "id": config.id,
            "enabled": config.enabled,
            "tenant_id": config.tenant_id,
            "client_id": config.client_id,
            "client_secret": config.client_secret,
            "redirect_uri": config.redirect_uri,
            "auto_create_users": config.auto_create_users,
            "default_role": config.default_role,
        }

        # Mask client_secret for display (show only last 4 chars)
        if config.client_secret:
            response["client_secret_masked"] = "****" + config.client_secret[-4:]

    # Surface organization-level SSO precedence so the settings UI can explain
    # and disable the tenant-level form.
    org_sso = await _active_org_sso(request, db)
    response["org_sso_active"] = org_sso is not None
    if org_sso:
        if org_sso.get("organization"):
            response["organization"] = {"name": org_sso["organization"].get("name")}

        # Organization SSO overrides the tenant-level row, so report what is
        # actually in effect. Without this the settings screen renders the
        # dormant tenant config — normally absent entirely — as a blank form,
        # even though SSO is configured and working at the organization level.
        # The secret is only ever returned masked.
        org_secret = org_sso.get("client_secret") or ""
        response.update(
            {
                "enabled": 1 if org_sso.get("enabled") else 0,
                "tenant_id": org_sso.get("tenant_id"),
                "client_id": org_sso.get("client_id"),
                "redirect_uri": org_sso.get("redirect_uri"),
                "auto_create_users": 1 if org_sso.get("auto_create_users") else 0,
                "default_role": org_sso.get("default_role") or "user",
            }
        )
        response.pop("client_secret", None)
        response["client_secret_masked"] = ("****" + org_secret[-4:]) if org_secret else "****"

    return response


@router.put("/sso/config")
async def update_sso_config_new(
    data: SSOConfigUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Update SSO configuration.

    Requires admin authentication.
    Matches: PUT /api/sso/config
    """
    logger.info("SSO Update received: %s", data)

    _reject_if_org_sso_active(data, await _active_org_sso(request, db, strict=True))

    result = await db.execute(select(SSOConfig).where(SSOConfig.id == 1))
    config = result.scalar_one_or_none()

    if not config:
        logger.info("Creating new SSO config record")
        config = SSOConfig(id=1)
        db.add(config)

    if data.enabled is not None:
        config.enabled = 1 if data.enabled else 0
    if data.tenant_id is not None:
        config.tenant_id = data.tenant_id or ""
    if data.client_id is not None:
        config.client_id = data.client_id or ""

    # If client_secret is not provided or is masked, keep existing
    if data.client_secret is not None:
        if not data.client_secret.startswith("****"):
            config.client_secret = data.client_secret

    if data.redirect_uri is not None:
        config.redirect_uri = data.redirect_uri or ""
    if data.auto_create_users is not None:
        config.auto_create_users = 1 if data.auto_create_users else 0
    if data.default_role is not None:
        config.default_role = data.default_role or "user"

    await db.commit()

    logger.info("SSO config saved: enabled=%s, tenant_id=%s", config.enabled, config.tenant_id)

    # Return { success: true } to match Node.js
    return {"success": True}


@router.get("/auth/sso/config", response_model=SSOConfigResponse)
async def get_sso_config(
    request: Request,
    db: AsyncSession = Depends(get_db),
    # Public endpoint - needed for login page
):
    """
    Get SSO configuration (public info only).

    Does not return client_secret.
    Matches: GET /api/auth/sso/config
    """
    if settings.multi_tenant:
        state = getattr(request, "state", None)
        has_tenant = state and hasattr(state, "tenant_slug") and state.tenant_slug
        if not has_tenant:
            return SSOConfigResponse(enabled=False, configured=False)

    result = await db.execute(select(SSOConfig).where(SSOConfig.id == 1))
    config = result.scalar_one_or_none()

    if not config:
        return SSOConfigResponse(
            enabled=False,
            configured=False,
        )

    return SSOConfigResponse(
        enabled=config.is_enabled,
        configured=config.is_configured,
        tenant_id=config.tenant_id,
        client_id=config.client_id,
        redirect_uri=config.redirect_uri,
        auto_create_users=config.should_auto_create_users,
        default_role=config.default_role,
    )


@router.put("/auth/sso/config", response_model=SSOConfigResponse)
async def update_sso_config(
    data: SSOConfigUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Update SSO configuration.

    Requires admin authentication.
    Matches: PUT /api/auth/sso/config
    """
    _reject_if_org_sso_active(data, await _active_org_sso(request, db, strict=True))

    result = await db.execute(select(SSOConfig).where(SSOConfig.id == 1))
    config = result.scalar_one_or_none()

    if not config:
        # Create new config
        config = SSOConfig(id=1)
        db.add(config)

    # Update fields
    if data.enabled is not None:
        config.enabled = 1 if data.enabled else 0
    if data.tenant_id is not None:
        config.tenant_id = data.tenant_id
    if data.client_id is not None:
        config.client_id = data.client_id
    if data.client_secret is not None:
        config.client_secret = data.client_secret
    if data.redirect_uri is not None:
        config.redirect_uri = data.redirect_uri
    if data.auto_create_users is not None:
        config.auto_create_users = 1 if data.auto_create_users else 0
    if data.default_role is not None:
        config.default_role = data.default_role

    await db.commit()
    await db.refresh(config)

    return SSOConfigResponse(
        enabled=config.is_enabled,
        configured=config.is_configured,
        tenant_id=config.tenant_id,
        client_id=config.client_id,
        redirect_uri=config.redirect_uri,
        auto_create_users=config.should_auto_create_users,
        default_role=config.default_role,
    )


# ---------------------------------------------------------
# Microsoft Entra SSO Flow
# ---------------------------------------------------------


def _sso_state_sig(payload: str) -> str:
    """HMAC-SHA256 signature (truncated) over the state payload."""
    import hashlib
    import hmac

    return hmac.new(
        settings.session_secret.encode(),
        payload.encode(),
        hashlib.sha256,
    ).hexdigest()[:16]


def _sign_sso_state(slug: str | None) -> str:
    """
    Build an HMAC-signed OAuth ``state`` that also carries the tenant slug.

    Organization SSO uses a single shared callback URL with no ``/t/{slug}/``
    prefix, so the tenant identity must survive the round-trip inside the state.
    Format: ``{slug}:{nonce}:{sig}`` where ``sig`` signs ``f"{slug}:{nonce}"``.
    ``slug`` is empty in single-tenant mode.
    """
    import secrets

    slug = slug or ""
    nonce = secrets.token_urlsafe(32)
    payload = f"{slug}:{nonce}"
    return f"{payload}:{_sso_state_sig(payload)}"


def _parse_sso_state(state: str | None) -> tuple[str | None, bool]:
    """
    Verify an OAuth ``state`` and extract the tenant slug.

    Returns ``(tenant_slug_or_None, valid)``. Accepts the new three-part
    ``{slug}:{nonce}:{sig}`` form and the legacy two-part ``{nonce}:{sig}`` form
    (slug ``None``) so logins already in flight during a deploy still validate.
    """
    import hmac

    if not state or ":" not in state:
        return None, False

    parts = state.split(":")
    if len(parts) == 3:
        slug, nonce, sig = parts
        payload = f"{slug}:{nonce}"
        if hmac.compare_digest(sig, _sso_state_sig(payload)):
            return (slug or None), True
        return None, False
    if len(parts) == 2:
        nonce, sig = parts
        if hmac.compare_digest(sig, _sso_state_sig(nonce)):
            return None, True
        return None, False
    return None, False


def _sso_error_redirect(tenant_slug: str | None, message: str) -> RedirectResponse:
    """
    Redirect a failed SSO login back to the sign-in screen it started from.

    Organization SSO shares one callback URL with no ``/t/{slug}/`` prefix, so a
    root-absolute redirect lands on ``/``, which multi-tenant mode bounces to the
    admin portal (``serve_root``) and drops the query string with it. Once the
    signed state has given us the slug we send the user back to their own tenant
    login screen instead, with the reason attached.
    """
    base = f"/t/{tenant_slug}/" if tenant_slug else "/"
    return RedirectResponse(url=f"{base}?sso_error={quote_plus(message)}", status_code=302)


def _config_fingerprint(config: dict, source: str) -> str:
    """
    Describe an effective SSO config for the log without leaking the secret.

    The authorization request and the code redemption resolve the config
    independently, and a redemption that quietly used a *different* config than
    the sign-in is the hardest SSO failure to see from the outside — Entra just
    reports a redirect-URI mismatch. Logging this on both hops makes the two
    directly comparable. The secret is reduced to a short digest, which proves
    both hops used the same credential without disclosing it.
    """
    secret = config.get("client_secret") or ""
    secret_fp = hashlib.sha256(secret.encode()).hexdigest()[:8] if secret else "none"
    return (
        f"source={source} client_id={config.get('client_id')} "
        f"entra_tenant={config.get('tenant_id')} redirect_uri={config.get('redirect_uri')} "
        f"secret_fp={secret_fp}"
    )


@asynccontextmanager
async def _resolve_sso_tenant_session(request: Request, default_db: AsyncSession, tenant_slug):
    """
    Yield ``(db_session, tenant_ctx)`` for the SSO callback.

    Organization SSO shares one callback URL with no ``/t/{slug}/`` prefix, so
    when the request carries no tenant context we recover the tenant from the
    (already-verified) state slug and open a session against that tenant's own
    database — mirroring what ``TenantMiddleware`` does for prefixed routes.
    Otherwise the request's default session is yielded unchanged.

    On an unknown/inactive tenant or a connection failure, yields
    ``(None, None)`` so the caller can redirect with a friendly error instead of
    surfacing a 500.
    """
    tenant = getattr(request.state, "tenant", None) if hasattr(request, "state") else None
    if tenant or not tenant_slug:
        yield default_db, tenant
        return

    from app.middleware.tenant import get_tenant_info_cached
    from app.services.tenant_manager import tenant_connection_manager

    try:
        tenant_info = await get_tenant_info_cached(tenant_slug)
        if not tenant_info or tenant_info.get("status") != "active":
            yield None, None
            return
        await tenant_connection_manager.get_pool_from_info(tenant_info)
        factory = tenant_connection_manager.get_session_factory(tenant_slug)
    except Exception:
        logger.exception("SSO callback: failed to resolve tenant '%s'", tenant_slug)
        yield None, None
        return

    if factory is None:
        yield None, None
        return

    async with factory() as tenant_db:
        yield tenant_db, tenant_info


@router.get("/auth/sso/status")
async def sso_status(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Check SSO status for this tenant.

    Returns information about whether SSO is configured at
    organization or tenant level, including group requirements.

    Public endpoint - used by login page to show/hide SSO button.
    Matches: GET /api/auth/sso/status
    """
    from app.services.sso import OrgSSOLookupError, SSOService

    _sso_disabled = {
        "enabled": False,
        "source": None,
        "provider": None,
        "organization": None,
        "required_groups": [],
        "group_membership_mode": "any",
    }

    # Get tenant from request state (set by tenant middleware in multi-tenant mode)
    tenant = getattr(request.state, "tenant", None) if hasattr(request, "state") else None

    # In multi-tenant mode without a tenant context, there's no tenant DB to query
    settings = get_settings()
    if settings.multi_tenant and not tenant:
        state = getattr(request, "state", None)
        has_tenant_slug = state and hasattr(state, "tenant_slug") and state.tenant_slug
        if not has_tenant_slug:
            return _sso_disabled

    sso_service = SSOService(db)

    try:
        config, source = await sso_service.get_effective_sso_config(tenant)
    except OrgSSOLookupError:
        # The login page degrades to "no SSO" either way, but this one is a
        # broken deployment rather than an unconfigured one — say so loudly.
        logger.error(
            "SSO status: organization SSO lookup failed for tenant '%s'; the sign-in button "
            "will be hidden until it recovers",
            getattr(getattr(request, "state", None), "tenant_slug", None),
            exc_info=True,
        )
        return _sso_disabled
    except Exception:
        return _sso_disabled

    if not config or not config.get("enabled"):
        return _sso_disabled

    result = {
        "enabled": True,
        "source": source,
        "provider": "microsoft",
        "required_groups": config.get("required_group_ids", []),
        "group_membership_mode": config.get("group_membership_mode", "any"),
    }

    # Include organization info if SSO is from organization. The org details
    # are carried on the effective config (resolved from the master DB) since
    # request.state.tenant is a primitive dict without relationships.
    org_info = config.get("organization") if source == "organization" else None
    if org_info:
        result["organization"] = {
            "id": org_info["id"],
            "name": org_info["name"],
            "slug": org_info["slug"],
            "sso_enabled": True,
        }

    return result


@router.get("/auth/sso/login")
async def sso_login(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Initiate SSO login flow.

    Uses organization-level or tenant-level SSO configuration.
    Returns the authorization URL for the frontend to redirect to.

    Matches: GET /api/auth/sso/login
    """
    from app.services.sso import OrgSSOLookupError, SSOService

    sso_service = SSOService(db)

    # Get tenant from request state (set by tenant middleware in multi-tenant mode)
    tenant = getattr(request.state, "tenant", None) if hasattr(request, "state") else None

    # Get effective SSO config. A failed organization lookup must not fall
    # through to the tenant-level config: the callback resolves the config
    # again, and starting a sign-in against one app registration only to redeem
    # the code against another is the failure this fails closed to avoid.
    try:
        config, source = await sso_service.get_effective_sso_config(tenant)
    except OrgSSOLookupError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Single sign-on is temporarily unavailable. Please try again later.",
        ) from None

    if not config or not config.get("enabled"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="SSO is not configured or enabled",
        )

    if not config.get("tenant_id") or not config.get("client_id") or not config.get("redirect_uri"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="SSO is not properly configured",
        )

    # Generate an HMAC-signed state carrying the tenant slug. Organization SSO
    # shares one callback URL with no tenant prefix, so the callback recovers the
    # tenant from the state (see _parse_sso_state / sso_callback).
    tenant_slug = getattr(request.state, "tenant_slug", None) if hasattr(request, "state") else None
    if not tenant_slug and isinstance(tenant, dict):
        tenant_slug = tenant.get("slug")
    state = _sign_sso_state(tenant_slug)

    # Determine if we need groups scope
    has_group_requirements = bool(config.get("required_group_ids"))

    logger.info("SSO login for tenant '%s': %s", tenant_slug, _config_fingerprint(config, source))

    # Build authorization URL
    redirect_url = sso_service.build_authorization_url(
        config, state, include_groups_scope=has_group_requirements
    )

    # Return url for frontend to handle the redirect
    return {"url": redirect_url}


@router.get("/auth/sso/callback")
async def sso_callback(
    request: Request,
    response: Response,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    """
    Handle SSO callback from Microsoft Entra.

    Supports organization-level SSO with group-based access control.
    Exchanges authorization code for tokens, validates group membership,
    and creates session.

    Matches: GET /api/auth/sso/callback
    """
    from app.services.sso import OrgSSOLookupError, SSOService

    # Verify the HMAC-signed state and recover the tenant slug it carries. The
    # slug is only ever used to pick a redirect target, so recovering it up front
    # lets even the earliest failures land back on the right sign-in screen.
    tenant_slug, state_valid = _parse_sso_state(state)

    # Handle error from Entra
    if error:
        # Use a generic error message to avoid reflecting remote input in the redirect URL
        return _sso_error_redirect(
            tenant_slug if state_valid else None, "SSO authentication failed"
        )

    if not code:
        return _sso_error_redirect(
            tenant_slug if state_valid else None, "No authorization code received"
        )

    if not state_valid:
        return _sso_error_redirect(None, "Invalid SSO state")

    # Organization SSO shares one callback URL with no /t/{slug}/ prefix, so the
    # request has no tenant context here — recover it from the (verified) state
    # slug and run the rest of the flow against that tenant's own database.
    async with _resolve_sso_tenant_session(request, db, tenant_slug) as (active_db, tenant_ctx):
        if active_db is None:
            return _sso_error_redirect(tenant_slug, "Unknown or inactive tenant")

        sso_service = SSOService(active_db)

        # Get effective SSO config (organization-level is resolved from the
        # tenant). This is a second, independent resolution — the sign-in leg
        # did its own — so a failed organization lookup must fail the sign-in
        # rather than fall through to the tenant-level config, which would
        # redeem the code against a different client and redirect URI than the
        # one it was issued for.
        try:
            config, source = await sso_service.get_effective_sso_config(tenant_ctx)
        except OrgSSOLookupError:
            return _sso_error_redirect(
                tenant_slug, "Single sign-on is temporarily unavailable. Please try again."
            )

        if not config or not config.get("enabled"):
            return _sso_error_redirect(tenant_slug, "SSO not configured")

        fingerprint = _config_fingerprint(config, source)
        logger.info("SSO callback for tenant '%s': %s", tenant_slug, fingerprint)

        # Exchange code for tokens
        entra_tenant_id = config["tenant_id"]
        token_url = f"https://login.microsoftonline.com/{entra_tenant_id}/oauth2/v2.0/token"

        # Determine scopes (need GroupMember.Read.All if groups are required).
        # These must match the scopes the authorization URL asked for; see
        # SSOService.build_authorization_url for why the list is what it is.
        has_group_requirements = bool(config.get("required_group_ids"))
        scopes = ["openid", "profile", "email", "User.Read"]
        if has_group_requirements:
            scopes.append("GroupMember.Read.All")

        # Posting an empty secret gets an "invalid client" back, which reads as
        # a wrong secret rather than a missing one. Say what is actually wrong.
        if not (config.get("client_secret") or "").strip():
            logger.error("SSO: no client secret in the effective config (%s)", fingerprint)
            return _sso_error_redirect(
                tenant_slug, "SSO client secret is not configured. Contact administrator."
            )

        token_data = {
            "client_id": config["client_id"],
            "client_secret": config["client_secret"],
            "code": code,
            "redirect_uri": config["redirect_uri"],
            "grant_type": "authorization_code",
            "scope": " ".join(scopes),
        }

        # A refused connection, proxy error or timeout would otherwise reach
        # the global handler as an opaque 500, telling the user nothing and
        # leaving no trace of which hop failed.
        try:
            async with httpx.AsyncClient() as client:
                token_response = await client.post(token_url, data=token_data)

                if token_response.status_code != 200:
                    logger.error(
                        "Token exchange failed: %s %s",
                        token_response.status_code,
                        token_response.text,
                    )
                    # Entra names the cause in an AADSTS code. Surfacing it is the
                    # whole point: an operator who cannot read this log otherwise
                    # sees eleven different failures as one sentence.
                    token_error = parse_entra_token_error(
                        token_response.status_code, token_response.text
                    )
                    logger.error(
                        "SSO token exchange rejected (%s, %s) [%s]: %s",
                        token_error.code or "no AADSTS code",
                        token_error.category,
                        fingerprint,
                        token_error.admin_remedy,
                    )
                    return _sso_error_redirect(tenant_slug, token_error.user_message)

                tokens = token_response.json()
                access_token = tokens.get("access_token")

                # Get user info from Microsoft Graph
                graph_response = await client.get(
                    "https://graph.microsoft.com/v1.0/me",
                    headers={"Authorization": f"Bearer {access_token}"},
                )

                if graph_response.status_code != 200:
                    logger.error(
                        "Graph API failed: %s %s", graph_response.status_code, graph_response.text
                    )
                    graph_error = parse_entra_token_error(
                        graph_response.status_code, graph_response.text
                    )
                    if graph_error.code:
                        logger.error(
                            "SSO profile lookup rejected (%s) [%s]: %s",
                            graph_error.code,
                            fingerprint,
                            graph_error.admin_remedy,
                        )
                        return _sso_error_redirect(tenant_slug, graph_error.user_message)
                    return _sso_error_redirect(tenant_slug, "Failed to fetch user info")

                user_info = graph_response.json()
        except httpx.HTTPError:
            logger.exception("SSO: could not reach the identity provider [%s]", fingerprint)
            return _sso_error_redirect(
                tenant_slug, "Could not reach the identity provider. Contact administrator."
            )

        # Validate group membership if required
        if has_group_requirements:
            user_groups = await sso_service.fetch_user_groups(access_token)

            if user_groups is None:
                # The directory lookup itself failed (most often the app
                # registration is missing consented GroupMember.Read.All), which
                # is a configuration problem — not a decision about this user.
                logger.error(
                    "SSO: group membership lookup failed for tenant '%s'; "
                    "check that the app registration has GroupMember.Read.All consented",
                    tenant_slug,
                )
                return _sso_error_redirect(
                    tenant_slug,
                    "Could not verify group membership. Contact administrator.",
                )

            is_allowed = sso_service.validate_group_membership(
                user_groups,
                config["required_group_ids"],
                config.get("group_membership_mode", "any"),
            )

            if not is_allowed:
                return _sso_error_redirect(
                    tenant_slug, "You do not have access to this tenant. Contact administrator."
                )

        # Find or create user
        email = user_info.get("mail") or user_info.get("userPrincipalName")

        if not email:
            return _sso_error_redirect(tenant_slug, "No email found in Microsoft account")

        # Look up existing user
        user_result = await active_db.execute(
            select(User).where(User.email == email).options(selectinload(User.sites))
        )
        user = user_result.scalar_one_or_none()

        if not user:
            # Check if auto-create is enabled
            if not config.get("auto_create_users"):
                return _sso_error_redirect(tenant_slug, "No account found. Contact administrator.")

            # Create new user
            user = User(
                email=email,
                password="",  # No password for SSO users
                first_name=user_info.get("givenName", ""),
                last_name=user_info.get("surname", ""),
                job_title=user_info.get("jobTitle"),
                role=config.get("default_role", "user"),
                sso_provider="microsoft",
                sso_id=user_info.get("id"),
                active=1,
            )

            active_db.add(user)
            await active_db.commit()
            await active_db.refresh(user)

            # Load sites relationship
            user.sites = []

        else:
            # Update SSO info if needed
            if not user.sso_provider:
                user.sso_provider = "microsoft"
                user.sso_id = user_info.get("id")
                await active_db.commit()

        if not user.is_active:
            return _sso_error_redirect(tenant_slug, "User account is disabled")

        # Create session
        session_service = SessionService(active_db)
        session_id = await session_service.create_session(user)

        # Determine redirect URL - land back inside the tenant workspace.
        if tenant_slug:
            redirect_url = f"/t/{tenant_slug}/"
        else:
            # Single-tenant / legacy state: derive from the callback path as before.
            redirect_url = "/"
            if config.get("redirect_uri"):
                from urllib.parse import urlparse

                parsed = urlparse(config["redirect_uri"])
                path = parsed.path
                if "/api/auth/sso/callback" in path:
                    tenant_path = path.replace("/api/auth/sso/callback", "")
                    if tenant_path:
                        redirect_url = (
                            tenant_path if tenant_path.endswith("/") else tenant_path + "/"
                        )

        # Set cookie
        response = RedirectResponse(url=redirect_url, status_code=302)
        response.set_cookie(
            key="connect.sid",
            value=f"s%3A{session_id}.",
            max_age=settings.session_max_age,
            httponly=True,
            samesite="lax",
            secure=settings.secure_cookies,
            path="/",
        )

        return response
