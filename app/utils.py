"""
Small shared utilities.
"""

from datetime import UTC, datetime
from typing import Any


def utcnow_naive() -> datetime:
    """Current UTC time as a naive datetime.

    Every datetime column in both the master and tenant databases is
    TIMESTAMP WITHOUT TIME ZONE holding UTC wall-clock time, and asyncpg
    rejects timezone-aware values bound to those columns. This is the
    non-deprecated replacement for ``datetime.utcnow()`` — same value,
    same naive-UTC semantics.
    """
    return datetime.now(UTC).replace(tzinfo=None)


def display_name(user: Any) -> str:
    """``First Last`` of a user (or SessionUser), falling back to the email.

    A leaf helper (approvals, the audit log and the change notifications name
    people the same way); ``approvals.display_name`` re-exports it.
    """
    name = f"{getattr(user, 'first_name', '') or ''} {getattr(user, 'last_name', '') or ''}"
    return name.strip() or getattr(user, "email", None) or "Someone"
