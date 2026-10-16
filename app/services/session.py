"""
Session service for express-session compatible session management.

This service manages sessions in a way that's compatible with the
Node.js express-session PostgreSQL store, enabling hybrid operation.
"""

import json
import logging
import secrets
import time
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.session import Session
from app.models.user import User

logger = logging.getLogger(__name__)


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
        """Get expiry timestamp in milliseconds (express-session format, true Unix epoch)."""
        return int((time.time() + self.settings.session_max_age) * 1000)

    async def create_session(self, user: User) -> str:
        """
        Create a new session for a user.

        Returns the session ID to be set in the cookie.
        """
        session_id = self._generate_session_id()
        expiry_ms = self._get_expiry_timestamp()
        expires_iso = (
            datetime.fromtimestamp(expiry_ms / 1000, UTC).replace(tzinfo=None).isoformat() + "Z"
        )

        # Build session data matching express-session format
        session_data = {
            "cookie": {
                "originalMaxAge": self.settings.session_max_age * 1000,
                "expires": expires_iso,
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
            },
        }

        session = Session(
            sid=session_id,
            sess=json.dumps(session_data),
            expired=expiry_ms,
        )

        self.db.add(session)
        await self.db.commit()

        return session_id

    async def get_session(self, session_id: str) -> Session | None:
        """
        Get a session by ID.

        Returns None if session doesn't exist or is expired.
        """
        result = await self.db.execute(select(Session).where(Session.sid == session_id))
        session = result.scalar_one_or_none()

        if session and session.is_expired:
            # Clean up expired session
            await self.delete_session(session_id)
            return None

        return session

    async def get_user_from_session(self, session_id: str) -> dict | None:
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
        result = await self.db.execute(delete(Session).where(Session.sid == session_id))
        await self.db.commit()
        return result.rowcount > 0

    async def destroy_user_sessions(
        self,
        user_id: int,
        *,
        except_session_id: str | None = None,
        commit: bool = True,
    ) -> int:
        """
        Delete every session belonging to ``user_id``.

        Called when a user's privileges change underneath an existing login
        (deactivation, deletion, role change, password reset) so the old
        cookie stops working immediately instead of at expiry.

        ``sess`` is JSON text (express-session format) with the user under
        ``sess["user"]["id"]``. A ``LIKE`` on the serialised ``"id": <id>``
        token narrows the rows (see :func:`session_user_id_patterns`), then the
        JSON is parsed and the id compared exactly, so ``7`` never matches user
        ``70`` and a malformed row cannot break the delete.

        ``except_session_id`` keeps one session alive (the caller's own, when
        a user changes their own password). Pass ``commit=False`` to make the
        delete part of the caller's transaction.

        Also closes the user's open WebSockets on this process (best effort,
        see :func:`disconnect_user_websockets`), except the one opened with
        ``except_session_id``.

        Returns the number of sessions deleted.
        """
        result = await self.db.execute(
            select(Session.sid, Session.sess).where(
                or_(*(Session.sess.like(p) for p in session_user_id_patterns(user_id)))
            )
        )
        sids = session_ids_for_user(result.all(), user_id, except_session_id=except_session_id)

        if sids:
            await self.db.execute(delete(Session).where(Session.sid.in_(sids)))
        if commit:
            await self.db.commit()

        await disconnect_user_websockets(
            self._tenant_key(), user_id, except_session_id=except_session_id
        )
        return len(sids)

    def _tenant_key(self) -> str | None:
        """The WebSocket room of this session's database ("default" single-tenant)."""
        try:
            from app.services.tenant_manager import tenant_connection_manager

            slug = tenant_connection_manager.slug_for_bind(getattr(self.db, "bind", None))
        except Exception:  # pragma: no cover - best effort
            slug = None
        if slug:
            return slug
        return None if self.settings.multi_tenant else "default"

    async def cleanup_expired_sessions(self) -> int:
        """
        Delete all expired sessions.

        Returns the number of sessions deleted.
        """
        current_time_ms = int(time.time() * 1000)
        result = await self.db.execute(delete(Session).where(Session.expired < current_time_ms))
        await self.db.commit()
        return result.rowcount


def session_user_id_patterns(user_id: int) -> list[str]:
    """
    ``LIKE`` patterns that match the serialised user id in a session row.

    Python writes sessions with ``json.dumps`` default separators, so the user
    object starts ``"user": {"id": 7, "email": ...``; express-session (Node)
    writes compact JSON (``"id":7,``). The id is followed by ``,`` or ``}``,
    so ``7`` does not pre-match ``70``. Every session also carries an ISO
    timestamp and ``originalMaxAge``, which is why a bare ``%7%`` matched
    nearly every row. Used by the raw-asyncpg caller too.
    """
    uid = int(user_id)
    return [
        f'%"id": {uid},%',
        f'%"id": {uid}}}%',
        f'%"id":{uid},%',
        f'%"id":{uid}}}%',
    ]


async def disconnect_user_websockets(
    tenant_key: str | None, user_id: int, *, except_session_id: str | None = None
) -> int:
    """
    Close a revoked user's open WebSockets on this process. Never raises.

    The connection manager is per process, so sockets on other workers stay
    open until they drop; the HTTP API already rejects the revoked session.
    """
    if not tenant_key:
        return 0
    try:
        from app.websocket.manager import manager

        return await manager.disconnect_user(
            tenant_key, int(user_id), except_session_id=except_session_id
        )
    except Exception:
        logger.warning("Could not close WebSockets of user %s", user_id, exc_info=True)
        return 0


def session_ids_for_user(
    rows: Iterable[Any],
    user_id: int,
    *,
    except_session_id: str | None = None,
) -> list[str]:
    """
    Pick the session ids that belong to ``user_id`` from ``(sid, sess)`` rows.

    ``sess`` is the express-session JSON text; the user id lives at
    ``sess["user"]["id"]``. Rows whose JSON is malformed are skipped. Shared by
    ``SessionService.destroy_user_sessions`` and raw-asyncpg callers (the admin
    portal's tenant password reset), which pre-filter with
    :func:`session_user_id_patterns`.
    """
    target = str(user_id)
    sids: list[str] = []
    for sid, sess in rows:
        if except_session_id is not None and sid == except_session_id:
            continue
        try:
            data = json.loads(sess)
        except (TypeError, ValueError):
            continue
        user = data.get("user") if isinstance(data, dict) else None
        if isinstance(user, dict) and str(user.get("id")) == target:
            sids.append(sid)
    return sids


def parse_session_cookie(cookie_value: str) -> str | None:
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
