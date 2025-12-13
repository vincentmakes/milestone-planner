"""
Authentication API router.
Handles login, logout, session management, and SSO.

Matches the Node.js API at /api/auth exactly.
"""

from typing import Optional
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
import httpx
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.models.user import User, UserSite
from app.models.settings import SSOConfig
from app.services.session import SessionService
from app.middleware.auth import (
    get_current_user,
    get_current_user_optional,
    require_admin,
    get_session_id,
)
from app.schemas.auth import (
    LoginRequest,
    LoginResponse,
    UserSessionInfo,
    UserSiteInfo,
    AuthMeResponse,
    ChangePasswordRequest,
    SSOConfigResponse,
    SSOConfigUpdate,
)

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
        select(User)
        .where(User.email == data.email)
        .options(selectinload(User.sites))
    )
    user = result.scalar_one_or_none()
    
    # Verify credentials
    # Note: In production, use proper password hashing (bcrypt)
    if not user or user.password != data.password:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )
    
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
        secure=False,  # Set to True in production with HTTPS
        path="/",
    )
    
    return LoginResponse(
        success=True,
        user=build_user_session_info(user),
    )


@router.post("/auth/logout")
async def logout(
    response: Response,
    session_id: Optional[str] = Depends(get_session_id),
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
    session_id: Optional[str] = Depends(get_session_id),
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
        select(User)
        .where(User.id == user_id)
        .options(selectinload(User.sites))
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
    # Note: In production, use proper password hashing
    if user.password != data.currentPassword:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )
    
    # Update password
    user.password = data.newPassword
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
        config.tenant_id = data.tenant_id or ''
    if data.client_id is not None:
        config.client_id = data.client_id or ''
    
    # If client_secret is not provided or is masked, keep existing
    if data.client_secret is not None:
        if not data.client_secret.startswith('****'):
            config.client_secret = data.client_secret
    
    if data.redirect_uri is not None:
        config.redirect_uri = data.redirect_uri or ''
    if data.auto_create_users is not None:
        config.auto_create_users = 1 if data.auto_create_users else 0
    if data.default_role is not None:
        config.default_role = data.default_role or 'user'
    
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

@router.get("/auth/sso/login")
async def sso_login(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Initiate SSO login flow.
    
    Returns the authorization URL for the frontend to redirect to.
    Matches: GET /api/auth/sso/login
    """
    result = await db.execute(select(SSOConfig).where(SSOConfig.id == 1))
    config = result.scalar_one_or_none()
    
    if not config or config.enabled != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="SSO is not configured or enabled",
        )
    
    if not config.tenant_id or not config.client_id or not config.redirect_uri:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="SSO is not properly configured",
        )
    
    # Build authorization URL
    auth_url = f"https://login.microsoftonline.com/{config.tenant_id}/oauth2/v2.0/authorize"
    
    params = {
        "client_id": config.client_id,
        "response_type": "code",
        "redirect_uri": config.redirect_uri,
        "response_mode": "query",
        "scope": "openid profile email User.Read",
        "state": "sso_login",  # Could be a random token for CSRF protection
    }
    
    redirect_url = f"{auth_url}?{urlencode(params)}"
    
    # Return redirectUrl for frontend to handle the redirect
    return {"redirectUrl": redirect_url}


@router.get("/auth/sso/callback")
async def sso_callback(
    request: Request,
    response: Response,
    code: Optional[str] = None,
    error: Optional[str] = None,
    error_description: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """
    Handle SSO callback from Microsoft Entra.
    
    Exchanges authorization code for tokens and creates session.
    Matches: GET /api/auth/sso/callback
    """
    if error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"SSO Error: {error_description or error}",
        )
    
    if not code:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No authorization code received",
        )
    
    # Get SSO config
    result = await db.execute(select(SSOConfig).where(SSOConfig.id == 1))
    config = result.scalar_one_or_none()
    
    if not config or not config.is_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="SSO is not configured or enabled",
        )
    
    # Exchange code for tokens
    token_url = f"https://login.microsoftonline.com/{config.tenant_id}/oauth2/v2.0/token"
    
    token_data = {
        "client_id": config.client_id,
        "client_secret": config.client_secret,
        "code": code,
        "redirect_uri": config.redirect_uri,
        "grant_type": "authorization_code",
        "scope": "openid profile email User.Read",
    }
    
    async with httpx.AsyncClient() as client:
        token_response = await client.post(token_url, data=token_data)
        
        if token_response.status_code != 200:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Failed to exchange authorization code for tokens",
            )
        
        tokens = token_response.json()
        access_token = tokens.get("access_token")
        
        # Get user info from Microsoft Graph
        graph_response = await client.get(
            "https://graph.microsoft.com/v1.0/me",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        
        if graph_response.status_code != 200:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Failed to fetch user info from Microsoft Graph",
            )
        
        user_info = graph_response.json()
    
    # Find or create user
    email = user_info.get("mail") or user_info.get("userPrincipalName")
    
    if not email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No email found in Microsoft account",
        )
    
    # Look up existing user
    user_result = await db.execute(
        select(User)
        .where(User.email == email)
        .options(selectinload(User.sites))
    )
    user = user_result.scalar_one_or_none()
    
    if not user:
        # Check if auto-create is enabled
        if not config.should_auto_create_users:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="No account found for this email. Contact an administrator.",
            )
        
        # Create new user
        user = User(
            email=email,
            password="",  # No password for SSO users
            first_name=user_info.get("givenName", ""),
            last_name=user_info.get("surname", ""),
            job_title=user_info.get("jobTitle"),
            role=config.default_role,
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
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is disabled",
        )
    
    # Create session
    session_service = SessionService(db)
    session_id = await session_service.create_session(user)
    
    # Set cookie
    response = RedirectResponse(url="/", status_code=302)
    response.set_cookie(
        key="connect.sid",
        value=f"s%3A{session_id}.",
        max_age=settings.session_max_age,
        httponly=True,
        samesite="lax",
        secure=False,
        path="/",
    )
    
    return response
