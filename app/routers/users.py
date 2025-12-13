"""
Users API router.
Handles user management operations (admin functions).

Matches the Node.js API at /api/users exactly.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, delete
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User, UserSite
from app.models.site import Site
from app.middleware.auth import get_current_user, require_admin
from app.schemas.user import (
    UserResponse,
    UserDetailResponse,
    UserSiteResponse,
    StaffCreate,
    StaffUpdate,
)

router = APIRouter()


def build_user_list_response(user: User) -> dict:
    """Build user response for list view (no job_title, has site_names)."""
    sites = user.sites if hasattr(user, 'sites') and user.sites else []
    # Sort by site ID to match Node.js behavior
    sorted_sites = sorted(sites, key=lambda s: s.id)
    
    return {
        "id": user.id,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "role": user.role,
        "active": user.active,
        "created_at": user.created_at,
        "site_ids": [s.id for s in sorted_sites],
        "site_names": [s.name for s in sorted_sites],
    }


def build_user_detail_response(user: User) -> dict:
    """Build user response for detail view (has sites array, no site_names)."""
    sites = user.sites if hasattr(user, 'sites') and user.sites else []
    
    return {
        "id": user.id,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "role": user.role,
        "active": user.active,
        "created_at": user.created_at,
        "site_ids": [s.id for s in sites],
        "sites": [{"id": s.id, "name": s.name} for s in sites],
    }


@router.get("/users", response_model=List[UserResponse])
async def get_users(
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Get all users.
    
    Requires admin authentication.
    Matches: GET /api/users
    """
    result = await db.execute(
        select(User)
        .options(selectinload(User.sites))
        .order_by(User.last_name, User.first_name)
    )
    users = result.scalars().all()
    
    return [build_user_list_response(u) for u in users]


@router.get("/users/{user_id}", response_model=UserDetailResponse)
async def get_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Get a specific user by ID.
    
    Requires admin authentication.
    Matches: GET /api/users/:id
    """
    result = await db.execute(
        select(User)
        .where(User.id == user_id)
        .options(selectinload(User.sites))
    )
    user = result.scalar_one_or_none()
    
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    return build_user_detail_response(user)


@router.post("/users", response_model=UserResponse, status_code=201)
async def create_user(
    data: StaffCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Create a new user.
    
    Requires admin authentication.
    Matches: POST /api/users
    """
    # Check for existing email
    existing = await db.execute(
        select(User).where(User.email == data.email)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=400,
            detail="A user with this email already exists"
        )
    
    # Create user
    user = User(
        email=data.email,
        password=data.password,  # Note: Should hash in production
        first_name=data.first_name,
        last_name=data.last_name,
        job_title=data.job_title,
        role=data.role,
        active=1,
    )
    
    db.add(user)
    await db.flush()  # Get the user ID
    
    # Add site associations
    sites = []
    if data.site_ids:
        for site_id in data.site_ids:
            user_site = UserSite(user_id=user.id, site_id=site_id)
            db.add(user_site)
            
            # Fetch site for response
            site_result = await db.execute(
                select(Site).where(Site.id == site_id)
            )
            site = site_result.scalar_one_or_none()
            if site:
                sites.append(site)
    
    await db.commit()
    await db.refresh(user)
    user.sites = sites
    
    return build_user_list_response(user)


@router.put("/users/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int,
    data: StaffUpdate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Update a user.
    
    Requires admin authentication.
    Matches: PUT /api/users/:id
    """
    result = await db.execute(
        select(User)
        .where(User.id == user_id)
        .options(selectinload(User.sites))
    )
    user = result.scalar_one_or_none()
    
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    # Prevent admin from demoting themselves
    if user.id == admin.id and data.role and data.role != "admin":
        raise HTTPException(
            status_code=400,
            detail="Cannot change your own admin role"
        )
    
    # Prevent admin from deactivating themselves
    if user.id == admin.id and data.active is not None and data.active == 0:
        raise HTTPException(
            status_code=400,
            detail="Cannot deactivate your own account"
        )
    
    # Update fields
    if data.email is not None:
        # Check for duplicate email
        existing = await db.execute(
            select(User).where(User.email == data.email).where(User.id != user_id)
        )
        if existing.scalar_one_or_none():
            raise HTTPException(
                status_code=400,
                detail="A user with this email already exists"
            )
        user.email = data.email
    
    if data.password is not None:
        user.password = data.password  # Note: Should hash in production
    if data.first_name is not None:
        user.first_name = data.first_name
    if data.last_name is not None:
        user.last_name = data.last_name
    if data.job_title is not None:
        user.job_title = data.job_title
    if data.role is not None:
        user.role = data.role
    if data.active is not None:
        user.active = data.active
    
    # Update site associations if provided
    sites = list(user.sites) if user.sites else []
    if data.site_ids is not None:
        # Remove existing associations
        await db.execute(
            delete(UserSite).where(UserSite.user_id == user_id)
        )
        
        # Add new associations
        sites = []
        for site_id in data.site_ids:
            user_site = UserSite(user_id=user_id, site_id=site_id)
            db.add(user_site)
            
            # Fetch site for response
            site_result = await db.execute(
                select(Site).where(Site.id == site_id)
            )
            site = site_result.scalar_one_or_none()
            if site:
                sites.append(site)
    
    await db.commit()
    await db.refresh(user)
    user.sites = sites
    
    return build_user_list_response(user)


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Delete a user.
    
    Requires admin authentication.
    Matches: DELETE /api/users/:id
    """
    if user_id == admin.id:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete your own account"
        )
    
    result = await db.execute(
        select(User).where(User.id == user_id)
    )
    user = result.scalar_one_or_none()
    
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    # Delete site associations first
    await db.execute(
        delete(UserSite).where(UserSite.user_id == user_id)
    )
    
    # Delete user
    await db.delete(user)
    await db.commit()
    
    return {"success": True}


@router.put("/users/{user_id}/toggle-active")
async def toggle_user_active(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Toggle a user's active status.
    
    Requires admin authentication.
    Matches: PUT /api/users/:id/toggle-active
    """
    if user_id == admin.id:
        raise HTTPException(
            status_code=400,
            detail="Cannot deactivate your own account"
        )
    
    result = await db.execute(
        select(User)
        .where(User.id == user_id)
        .options(selectinload(User.sites))
    )
    user = result.scalar_one_or_none()
    
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    # Toggle active status
    user.active = 0 if user.active == 1 else 1
    
    await db.commit()
    await db.refresh(user)
    
    return build_user_list_response(user)
