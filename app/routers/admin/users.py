"""
Admin user management routes (superadmin only).
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.tenant import AdminUser
from app.routers.admin.auth import require_superadmin
from app.schemas.tenant import AdminUserCreate, AdminUserUpdate
from app.services.encryption import hash_password
from app.services.master_db import get_master_db

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/users")
async def list_admin_users(
    admin: AdminUser = Depends(require_superadmin),
    db: AsyncSession = Depends(get_master_db),
):
    """List all admin users."""
    result = await db.execute(select(AdminUser).order_by(AdminUser.email))
    users = result.scalars().all()

    return [
        {
            "id": u.id,
            "email": u.email,
            "name": u.name,
            "role": u.role,
            "active": u.active,
            "created_at": u.created_at,
            "last_login": u.last_login,
        }
        for u in users
    ]


@router.post("/users", status_code=201)
async def create_admin_user(
    data: AdminUserCreate,
    admin: AdminUser = Depends(require_superadmin),
    db: AsyncSession = Depends(get_master_db),
):
    """Create an admin user."""
    existing = await db.execute(select(AdminUser).where(AdminUser.email == data.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Email already exists")

    user = AdminUser(
        email=data.email,
        password_hash=hash_password(data.password),
        name=data.name,
        role=data.role,
        active=1,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "active": user.active,
        "created_at": user.created_at,
    }


@router.put("/users/{user_id}")
async def update_admin_user(
    user_id: int,
    data: AdminUserUpdate,
    admin: AdminUser = Depends(require_superadmin),
    db: AsyncSession = Depends(get_master_db),
):
    """Update an admin user."""
    result = await db.execute(select(AdminUser).where(AdminUser.id == user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if data.name is not None:
        user.name = data.name
    if data.role is not None:
        user.role = data.role
    if data.active is not None:
        user.active = 1 if data.active else 0
    if data.password is not None:
        user.password_hash = hash_password(data.password)

    await db.commit()
    await db.refresh(user)

    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "active": user.active,
        "created_at": user.created_at,
        "last_login": user.last_login,
    }


@router.delete("/users/{user_id}")
async def delete_admin_user(
    user_id: int,
    admin: AdminUser = Depends(require_superadmin),
    db: AsyncSession = Depends(get_master_db),
):
    """Delete an admin user."""
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")

    result = await db.execute(select(AdminUser).where(AdminUser.id == user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    await db.delete(user)
    await db.commit()

    return {"success": True}
