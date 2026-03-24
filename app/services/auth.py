"""
Shared authentication utilities.

Centralizes common patterns between tenant auth (middleware/auth.py)
and admin auth (routers/admin/auth.py). Each still handles its own
session format, but this module provides the shared validation logic.
"""

import json
import logging
import time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.tenant import AdminSession, AdminUser

logger = logging.getLogger(__name__)


async def validate_admin_session(
    db: AsyncSession,
    session_id: str,
) -> AdminUser | None:
    """
    Validate an admin session and return the AdminUser, or None.

    Encapsulates the common logic of:
    1. Look up session by ID
    2. Check expiration
    3. Parse session JSON
    4. Load and validate the admin user

    Returns None instead of raising exceptions — callers decide
    how to handle unauthenticated requests.
    """
    now_ms = int(time.time() * 1000)
    result = await db.execute(
        select(AdminSession)
        .where(AdminSession.sid == session_id)
        .where(AdminSession.expired > now_ms)
    )
    session = result.scalar_one_or_none()

    if not session:
        return None

    try:
        sess_data = json.loads(session.sess)
        admin_user_id = sess_data.get("admin_user_id")
        if not admin_user_id:
            return None
    except (json.JSONDecodeError, KeyError):
        logger.warning("Invalid admin session data for sid=%s", session_id[:20])
        return None

    result = await db.execute(select(AdminUser).where(AdminUser.id == admin_user_id))
    admin = result.scalar_one_or_none()

    if not admin or not admin.is_active:
        return None

    return admin
