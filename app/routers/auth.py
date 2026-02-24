"""
Authentication API router.
Handles login, logout, session management, and SSO.

Matches the Node.js API at /api/auth exactly.
"""

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
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """
    Authenticate user with email and password.

    Creates a session and sets the session cookie.
    Matches: POST /api/auth/login
    """
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
    response: Response,
    session_id: str | None = Depends(get_session_id),
    db: AsyncSession = Depends(get_db),
):
    """
    Log out the current user.

    Destroys the session and clears the cookie.
    Matches: POST /api/auth/logout
    """
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
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Change the current user's password.

    Requires current password verification.
    Matches: POST /api/auth/change-password
    """
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


@router.get("/sso/config")
async def get_sso_config_public(
    db: AsyncSession = Depends(get_db),
):
    """
    Get SSO configuration (public info only, no client_secret).

    Public endpoint - needed for login page to show SSO button.
    Matches: GET /api/sso/config
    """
    try:
        result = await db.execute(select(SSOConfig).where(SSOConfig.id == 1))
        config = result.scalar_one_or_none()
    except Exception as e:
        print(f"SSO config query failed: {e}")
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
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Get full SSO configuration including client_secret.

    Requires admin authentication.
    Matches: GET /api/sso/config/full
    """
    try:
        result = await db.execute(select(SSOConfig).where(SSOConfig.id == 1))
        config = result.scalar_one_or_none()
    except Exception as e:
        print(f"SSO config query failed: {e}")
        import traceback

        traceback.print_exc()
        return {"id": 1, "enabled": 0}

    if not config:
        return {"id": 1, "enabled": 0}

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

    return response


@router.put("/sso/config")
async def update_sso_config_new(
    data: SSOConfigUpdate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Update SSO configuration.

    Requires admin authentication.
    Matches: PUT /api/sso/config
    """
    print(f"SSO Update received: {data}")

    result = await db.execute(select(SSOConfig).where(SSOConfig.id == 1))
    config = result.scalar_one_or_none()

    if not config:
        print("Creating new SSO config record")
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

    print(f"SSO config saved: enabled={config.enabled}, tenant_id={config.tenant_id}")

    # Return { success: true } to match Node.js
    return {"success": True}


@router.get("/auth/sso/config", response_model=SSOConfigResponse)
async def get_sso_config(
    db: AsyncSession = Depends(get_db),
    # Public endpoint - needed for login page
):
    """
    Get SSO configuration (public info only).

    Does not return client_secret.
    Matches: GET /api/auth/sso/config
    """
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
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Update SSO configuration.

    Requires admin authentication.
    Matches: PUT /api/auth/sso/config
    """
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
    from app.services.sso import SSOService

    sso_service = SSOService(db)

    # Get tenant from request state (set by tenant middleware in multi-tenant mode)
    tenant = getattr(request.state, "tenant", None) if hasattr(request, "state") else None

    # Get effective SSO config
    config, source = await sso_service.get_effective_sso_config(tenant)

    if not config or not config.get("enabled"):
        return {
            "enabled": False,
            "source": None,
            "provider": None,
            "organization": None,
            "required_groups": [],
            "group_membership_mode": "any",
        }

    result = {
        "enabled": True,
        "source": source,
        "provider": "microsoft",
        "required_groups": config.get("required_group_ids", []),
        "group_membership_mode": config.get("group_membership_mode", "any"),
    }

    # Include organization info if SSO is from organization
    if source == "organization" and tenant and tenant.organization:
        result["organization"] = {
            "id": str(tenant.organization_id),
            "name": tenant.organization.name,
            "slug": tenant.organization.slug,
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
    import secrets

    from app.services.sso import SSOService

    sso_service = SSOService(db)

    # Get tenant from request state (set by tenant middleware in multi-tenant mode)
    tenant = getattr(request.state, "tenant", None) if hasattr(request, "state") else None

    # Get effective SSO config
    config, source = await sso_service.get_effective_sso_config(tenant)

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

    # Generate HMAC-signed state for OAuth CSRF protection
    # Format: {nonce}:{hmac_signature}
    import hashlib as _hashlib
    import hmac as _hmac

    nonce = secrets.token_urlsafe(32)
    sig = _hmac.new(
        settings.session_secret.encode(),
        nonce.encode(),
        _hashlib.sha256,
    ).hexdigest()[:16]
    state = f"{nonce}:{sig}"

    # Determine if we need groups scope
    has_group_requirements = bool(config.get("required_group_ids"))

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
    from app.services.sso import SSOService

    # Handle error from Entra
    if error:
        from urllib.parse import quote

        # Use a generic error message to avoid reflecting remote input in the redirect URL
        error_msg = "SSO+authentication+failed"
        redirect_url = f"/?sso_error={error_msg}"
        return RedirectResponse(url=redirect_url, status_code=302)

    if not code:
        return RedirectResponse(url="/?sso_error=No+authorization+code+received", status_code=302)

    # Verify HMAC-signed state to prevent OAuth CSRF
    import hashlib as _hashlib
    import hmac as _hmac

    if not state or ":" not in state:
        return RedirectResponse(url="/?sso_error=Invalid+SSO+state", status_code=302)
    nonce, sig = state.rsplit(":", 1)
    expected_sig = _hmac.new(
        settings.session_secret.encode(),
        nonce.encode(),
        _hashlib.sha256,
    ).hexdigest()[:16]
    if not _hmac.compare_digest(sig, expected_sig):
        return RedirectResponse(url="/?sso_error=Invalid+SSO+state", status_code=302)

    sso_service = SSOService(db)

    # Get tenant from request state (set by tenant middleware in multi-tenant mode)
    tenant = getattr(request.state, "tenant", None) if hasattr(request, "state") else None

    # Get effective SSO config
    config, source = await sso_service.get_effective_sso_config(tenant)

    if not config or not config.get("enabled"):
        return RedirectResponse(url="/?sso_error=SSO+not+configured", status_code=302)

    # Exchange code for tokens
    entra_tenant_id = config["tenant_id"]
    token_url = f"https://login.microsoftonline.com/{entra_tenant_id}/oauth2/v2.0/token"

    # Determine scopes (need GroupMember.Read.All if groups are required)
    has_group_requirements = bool(config.get("required_group_ids"))
    scopes = ["openid", "profile", "email", "User.Read"]
    if has_group_requirements:
        scopes.append("GroupMember.Read.All")

    token_data = {
        "client_id": config["client_id"],
        "client_secret": config["client_secret"],
        "code": code,
        "redirect_uri": config["redirect_uri"],
        "grant_type": "authorization_code",
        "scope": " ".join(scopes),
    }

    async with httpx.AsyncClient() as client:
        token_response = await client.post(token_url, data=token_data)

        if token_response.status_code != 200:
            print(f"Token exchange failed: {token_response.status_code} {token_response.text}")
            return RedirectResponse(
                url="/?sso_error=Failed+to+exchange+authorization+code", status_code=302
            )

        tokens = token_response.json()
        access_token = tokens.get("access_token")

        # Get user info from Microsoft Graph
        graph_response = await client.get(
            "https://graph.microsoft.com/v1.0/me",
            headers={"Authorization": f"Bearer {access_token}"},
        )

        if graph_response.status_code != 200:
            print(f"Graph API failed: {graph_response.status_code} {graph_response.text}")
            return RedirectResponse(url="/?sso_error=Failed+to+fetch+user+info", status_code=302)

        user_info = graph_response.json()

    # Validate group membership if required
    if has_group_requirements:
        user_groups = await sso_service.fetch_user_groups(access_token)

        is_allowed = sso_service.validate_group_membership(
            user_groups, config["required_group_ids"], config.get("group_membership_mode", "any")
        )

        if not is_allowed:
            return RedirectResponse(
                url="/?sso_error=You+do+not+have+access+to+this+tenant.+Contact+administrator.",
                status_code=302,
            )

    # Find or create user
    email = user_info.get("mail") or user_info.get("userPrincipalName")

    if not email:
        return RedirectResponse(
            url="/?sso_error=No+email+found+in+Microsoft+account", status_code=302
        )

    # Look up existing user
    user_result = await db.execute(
        select(User).where(User.email == email).options(selectinload(User.sites))
    )
    user = user_result.scalar_one_or_none()

    if not user:
        # Check if auto-create is enabled
        if not config.get("auto_create_users"):
            return RedirectResponse(
                url="/?sso_error=No+account+found.+Contact+administrator.", status_code=302
            )

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

        db.add(user)
        await db.commit()
        await db.refresh(user)

        # Load sites relationship
        user.sites = []

    else:
        # Update SSO info if needed
        if not user.sso_provider:
            user.sso_provider = "microsoft"
            user.sso_id = user_info.get("id")
            await db.commit()

    if not user.is_active:
        return RedirectResponse(url="/?sso_error=User+account+is+disabled", status_code=302)

    # Create session
    session_service = SessionService(db)
    session_id = await session_service.create_session(user)

    # Determine redirect URL - for multi-tenant, redirect to tenant base URL
    redirect_url = "/"
    if config.get("redirect_uri"):
        from urllib.parse import urlparse

        parsed = urlparse(config["redirect_uri"])
        path = parsed.path
        # Extract tenant prefix from callback path (remove /api/auth/sso/callback)
        if "/api/auth/sso/callback" in path:
            tenant_path = path.replace("/api/auth/sso/callback", "")
            if tenant_path:
                redirect_url = tenant_path if tenant_path.endswith("/") else tenant_path + "/"

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
