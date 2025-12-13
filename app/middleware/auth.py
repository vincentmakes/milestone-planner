"""
Authentication middleware and dependencies.

Provides FastAPI dependencies for protecting routes with authentication
and role-based access control.
"""

from typing import Optional

from fastapi import Cookie, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.models.user import User
from app.services.session import SessionService, parse_session_cookie


async def get_session_id(
    request: Request,
    connect_sid: Optional[str] = Cookie(None, alias="connect.sid"),
) -> Optional[str]:
    """
    Extract session ID from cookie.
    
    Handles the express-session cookie format.
    """
    if connect_sid:
        return parse_session_cookie(connect_sid)
    return None


async def get_current_user_optional(
    session_id: Optional[str] = Depends(get_session_id),
    db: AsyncSession = Depends(get_db),
) -> Optional[User]:
    """
    Get current user if authenticated, None otherwise.
    
    Use this for routes that work both authenticated and anonymous.
    """
    if not session_id:
        return None
    
    session_service = SessionService(db)
    user_data = await session_service.get_user_from_session(session_id)
    
    if not user_data:
        return None
    
    # Create a User-like object from session data to avoid extra DB query
    # The session already contains all the user info we need
    user_id = user_data.get("id")
    if not user_id:
        return None
    
    # For most operations, we can use the cached session data
    # Only fetch from DB if we need fresh data or relationships
    class SessionUser:
        """Lightweight user object from session data."""
        def __init__(self, data: dict):
            self.id = data.get("id")
            self.email = data.get("email")
            self.first_name = data.get("first_name")
            self.last_name = data.get("last_name")
            self.job_title = data.get("job_title")
            self.role = data.get("role")
            self._site_ids = data.get("site_ids", [])
            self._site_names = data.get("site_names", [])
            # These are used for auth checks
            self.is_active = True  # If session exists, user was active
        
        @property
        def is_admin(self) -> bool:
            return self.role == "admin"
        
        @property
        def is_superuser(self) -> bool:
            return self.role == "superuser"
        
        @property
        def site_ids(self) -> list:
            return self._site_ids
        
        @property
        def sites(self) -> list:
            # Return lightweight site-like objects
            class SiteRef:
                def __init__(self, id, name):
                    self.id = id
                    self.name = name
            return [SiteRef(id, name) for id, name in zip(self._site_ids, self._site_names)]
    
    return SessionUser(user_data)


async def get_current_user(
    user: Optional[User] = Depends(get_current_user_optional),
) -> User:
    """
    Get current authenticated user.
    
    Raises 401 if not authenticated.
    Use this for routes that require authentication.
    """
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account is disabled",
        )
    
    return user


async def require_admin(
    user: User = Depends(get_current_user),
) -> User:
    """
    Require admin role.
    
    Raises 403 if user is not an admin.
    """
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return user


async def require_superuser(
    user: User = Depends(get_current_user),
) -> User:
    """
    Require superuser or admin role.
    
    Raises 403 if user is not a superuser or admin.
    """
    if not (user.is_admin or user.is_superuser):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Superuser access required",
        )
    return user


def require_site_access(site_id: int):
    """
    Factory for site access check dependency.
    
    Returns a dependency that verifies the user has access to the specified site.
    """
    async def check_site_access(
        user: User = Depends(get_current_user),
    ) -> User:
        if user.is_admin:
            return user
        
        if site_id not in user.site_ids:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied to this site",
            )
        return user
    
    return check_site_access
