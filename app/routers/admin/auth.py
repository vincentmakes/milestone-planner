"""
Admin authentication routes and dependencies.

Provides:
- Login / logout / session endpoints
- get_current_admin / require_superadmin dependencies
"""

import json
import logging
import time
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.tenant import AdminSession, AdminUser
from app.schemas.tenant import (
    AdminLoginRequest,
    AdminLoginResponse,
    AdminMeResponse,
    AdminUserInfo,
    ChangeAdminPasswordRequest,
)
from app.services.auth import validate_admin_session
from app.services.encryption import generate_password, hash_password, verify_password
from app.services.master_db import get_master_db

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter()


# ---------------------------------------------------------
# Auth Dependencies (used by tenants.py and users.py too)
# ---------------------------------------------------------


async def get_admin_session_id(request: Request) -> str | None:
    """Extract admin session ID from cookie."""
    cookie = request.cookies.get("admin_session")
    if not cookie:
        return None
    return cookie


async def get_current_admin(
    request: Request,
    db: AsyncSession = Depends(get_master_db),
) -> AdminUser:
    """Get current authenticated admin user.

    Uses the shared validate_admin_session service for session lookup/validation.
    """
    session_id = await get_admin_session_id(request)

    if not session_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Admin authentication required",
        )

    admin = await validate_admin_session(db, session_id)
    if not admin:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session",
        )

    return admin


async def get_current_admin_optional(
    request: Request,
    db: AsyncSession = Depends(get_master_db),
) -> AdminUser | None:
    """Get current admin if authenticated, None otherwise."""
    try:
        return await get_current_admin(request, db)
    except HTTPException:
        return None


async def require_superadmin(
    admin: AdminUser = Depends(get_current_admin),
) -> AdminUser:
    """Require superadmin role."""
    if not admin.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Superadmin access required",
        )
    return admin


# ---------------------------------------------------------
# Auth Routes
# ---------------------------------------------------------


@router.post("/auth/login", response_model=AdminLoginResponse)
async def admin_login(
    data: AdminLoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_master_db),
):
    """Admin login."""
    result = await db.execute(select(AdminUser).where(AdminUser.email == data.email))
    admin = result.scalar_one_or_none()

    if not admin or not verify_password(data.password, admin.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
        )

    if not admin.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Admin account is disabled",
        )

    session_id = generate_password(64)
    expires_ms = int((time.time() + 86400) * 1000)

    sess_data = json.dumps(
        {
            "admin_user_id": admin.id,
            "email": admin.email,
            "role": admin.role,
        }
    )

    session = AdminSession(
        sid=session_id,
        sess=sess_data,
        expired=expires_ms,
    )
    db.add(session)

    admin.last_login = datetime.utcnow()

    await db.commit()

    response.set_cookie(
        key="admin_session",
        value=session_id,
        max_age=86400,
        httponly=True,
        samesite="lax",
        secure=settings.secure_cookies,
        path="/",
    )

    return AdminLoginResponse(
        success=True,
        user=AdminUserInfo(
            id=admin.id,
            email=admin.email,
            name=admin.name,
            role=admin.role,
        ),
        must_change_password=admin.must_change_password == 1,
    )


@router.post("/auth/logout")
async def admin_logout(
    response: Response,
    request: Request,
    db: AsyncSession = Depends(get_master_db),
):
    """Admin logout."""
    session_id = await get_admin_session_id(request)

    if session_id:
        result = await db.execute(select(AdminSession).where(AdminSession.sid == session_id))
        session = result.scalar_one_or_none()
        if session:
            await db.delete(session)
            await db.commit()

    response.delete_cookie(key="admin_session", path="/")

    return {"success": True}


@router.get("/auth/me", response_model=AdminMeResponse)
async def admin_me(
    admin: AdminUser | None = Depends(get_current_admin_optional),
):
    """Get current admin session."""
    if admin:
        return AdminMeResponse(
            user=AdminUserInfo(
                id=admin.id,
                email=admin.email,
                name=admin.name,
                role=admin.role,
            )
        )
    return AdminMeResponse(user=None)


@router.post("/auth/change-password")
async def change_admin_password(
    data: ChangeAdminPasswordRequest,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Change current admin user's password."""
    if not verify_password(data.current_password, admin.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )

    if len(data.new_password) < 8:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password must be at least 8 characters",
        )

    admin.password_hash = hash_password(data.new_password)
    admin.must_change_password = 0
    await db.commit()

    return {"success": True, "message": "Password changed successfully"}
