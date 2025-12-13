"""
Session service for express-session compatible session management.

This service manages sessions in a way that's compatible with the
Node.js express-session PostgreSQL store, enabling hybrid operation.
"""

import json
import secrets
import time
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.session import Session
from app.models.user import User


class SessionService:
    """
    Manages sessions compatible with express-session.
    
    Session ID format: s%3A{session_id}.{signature}
    The 's:' prefix and signature are handled by express-session's cookie parser.
    We store just the session_id in the database.
    """
    
    def __init__(self, db: AsyncSession):
        self.db = db
        self.settings = get_settings()
    
    def _generate_session_id(self) -> str:
        """Generate a secure random session ID."""
        return secrets.token_urlsafe(32)
    
    def _get_expiry_timestamp(self) -> int:
        """Get expiry timestamp in milliseconds (express-session format)."""
        expiry = datetime.utcnow() + timedelta(seconds=self.settings.session_max_age)
        return int(expiry.timestamp() * 1000)
    
    async def create_session(self, user: User) -> str:
        """
        Create a new session for a user.
        
        Returns the session ID to be set in the cookie.
        """
        session_id = self._generate_session_id()
        
        # Build session data matching express-session format
        session_data = {
            "cookie": {
                "originalMaxAge": self.settings.session_max_age * 1000,
                "expires": datetime.utcnow().isoformat() + "Z",
                "httpOnly": True,
                "path": "/",
                "sameSite": "lax",
            },
            "user": {
                "id": user.id,
                "email": user.email,
                "first_name": user.first_name,
                "last_name": user.last_name,
                "job_title": user.job_title,
                "role": user.role,
                "site_ids": [s.id for s in user.sites] if user.sites else [],
                "site_names": [s.name for s in user.sites] if user.sites else [],
            }
        }
        
        session = Session(
            sid=session_id,
            sess=json.dumps(session_data),
            expired=self._get_expiry_timestamp(),
        )
        
        self.db.add(session)
        await self.db.commit()
        
        return session_id
    
    async def get_session(self, session_id: str) -> Optional[Session]:
        """
        Get a session by ID.
        
        Returns None if session doesn't exist or is expired.
        """
        result = await self.db.execute(
            select(Session).where(Session.sid == session_id)
        )
        session = result.scalar_one_or_none()
        
        if session and session.is_expired:
            # Clean up expired session
            await self.delete_session(session_id)
            return None
        
        return session
    
    async def get_user_from_session(self, session_id: str) -> Optional[dict]:
        """
        Get user data from session.
        
        Returns the user dict stored in the session, or None.
        """
        session = await self.get_session(session_id)
        if session:
            return session.user
        return None
    
    async def update_session(self, session_id: str, user: User) -> bool:
        """
        Update session with new user data.
        
        Useful when user info changes (e.g., role update).
        """
        session = await self.get_session(session_id)
        if not session:
            return False
        
        session_data = session.session_data
        session_data["user"] = {
            "id": user.id,
            "email": user.email,
            "first_name": user.first_name,
            "last_name": user.last_name,
            "job_title": user.job_title,
            "role": user.role,
            "site_ids": [s.id for s in user.sites] if user.sites else [],
            "site_names": [s.name for s in user.sites] if user.sites else [],
        }
        
        session.session_data = session_data
        session.expired = self._get_expiry_timestamp()
        
        await self.db.commit()
        return True
    
    async def delete_session(self, session_id: str) -> bool:
        """Delete a session."""
        result = await self.db.execute(
            delete(Session).where(Session.sid == session_id)
        )
        await self.db.commit()
        return result.rowcount > 0
    
    async def cleanup_expired_sessions(self) -> int:
        """
        Delete all expired sessions.
        
        Returns the number of sessions deleted.
        """
        current_time_ms = int(datetime.utcnow().timestamp() * 1000)
        result = await self.db.execute(
            delete(Session).where(Session.expired < current_time_ms)
        )
        await self.db.commit()
        return result.rowcount


def parse_session_cookie(cookie_value: str) -> Optional[str]:
    """
    Parse express-session cookie to extract session ID.
    
    Express-session cookies are formatted as: s%3A{session_id}.{signature}
    After URL decoding: s:{session_id}.{signature}
    
    We need to extract just the session_id part.
    """
    if not cookie_value:
        return None
    
    # URL decode if needed
    from urllib.parse import unquote
    decoded = unquote(cookie_value)
    
    # Check for signed cookie format (s:{id}.{sig})
    if decoded.startswith("s:"):
        # Remove 's:' prefix
        rest = decoded[2:]
        # Split on '.' to separate id from signature
        parts = rest.split(".", 1)
        if parts:
            return parts[0]
    
    # If not in signed format, return as-is (might be plain session ID)
    return cookie_value
