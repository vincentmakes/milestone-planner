"""
Small shared utilities.
"""

from datetime import UTC, datetime


def utcnow_naive() -> datetime:
    """Current UTC time as a naive datetime.

    Every datetime column in both the master and tenant databases is
    TIMESTAMP WITHOUT TIME ZONE holding UTC wall-clock time, and asyncpg
    rejects timezone-aware values bound to those columns. This is the
    non-deprecated replacement for ``datetime.utcnow()`` — same value,
    same naive-UTC semantics.
    """
    return datetime.now(UTC).replace(tzinfo=None)
