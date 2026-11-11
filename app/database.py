"""
Database configuration and session management.
Uses async SQLAlchemy for PostgreSQL connections.
"""

import logging
from collections.abc import AsyncGenerator
from typing import Any

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    """Base class for all SQLAlchemy models."""

    pass


def resolve_tenant_session_factory(request: Request) -> async_sessionmaker[AsyncSession] | None:
    """
    Return the tenant's session factory when the request carries a tenant slug.

    Returns None when the request has no tenant context (single-tenant mode,
    or a non-tenant URL). When it *does* carry a slug but no pool exists for
    it, raises 503 — never fall through to the default ``DB_*`` database, which
    would serve another database's data under a tenant URL.
    """
    state = getattr(request, "state", None)
    slug = getattr(state, "tenant_slug", None) if state is not None else None
    if not slug:
        return None

    from app.services.tenant_manager import tenant_connection_manager

    session_factory = tenant_connection_manager.get_session_factory(slug)
    if session_factory is None:
        logger.error("No database pool for tenant '%s'; refusing to use the default DB", slug)
        raise HTTPException(
            status_code=503,
            detail="Organization database is unavailable. Please try again later.",
        )
    return session_factory


def pool_arguments(settings: Any) -> dict[str, Any]:
    """
    The pool arguments shared by the default engine and every tenant engine.

    ``DB_POOL_SIZE`` / ``DB_POOL_MAX_OVERFLOW`` / ``DB_POOL_TIMEOUT`` size the
    pool; ``pool_pre_ping`` replaces a connection the server or a proxy closed
    while it sat idle (instead of failing the request that drew it), and
    ``pool_recycle`` (``DB_POOL_RECYCLE`` seconds) retires connections before
    such idle timeouts hit them.
    """
    return {
        "pool_size": settings.db_pool_size,
        "max_overflow": settings.db_pool_max_overflow,
        "pool_timeout": settings.db_pool_timeout,
        # SQLAlchemy's "never" is -1 (0 would recycle on every checkout).
        "pool_recycle": settings.db_pool_recycle if settings.db_pool_recycle > 0 else -1,
        "pool_pre_ping": True,
    }


# Global engine and session factory (initialized on startup)
_engine: AsyncEngine | None = None
_async_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    """Get the database engine, creating it if necessary."""
    global _engine
    if _engine is None:
        settings = get_settings()
        _engine = create_async_engine(
            settings.async_database_url,
            **pool_arguments(settings),
            echo=False,  # Disable SQL logging (too verbose)
            connect_args={
                # Tell asyncpg to not apply timezone conversion
                # Timestamps are stored as UTC in the database
                "server_settings": {"timezone": "UTC"}
            },
        )
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    """Get the session factory, creating it if necessary."""
    global _async_session_factory
    if _async_session_factory is None:
        _async_session_factory = async_sessionmaker(
            bind=get_engine(),
            class_=AsyncSession,
            expire_on_commit=False,
            autocommit=False,
            autoflush=False,
        )
    return _async_session_factory


# Where get_db keeps the request's session (request.state), so the derived
# tiers that open a session of their own can release the request's
# connection first (release_request_connection).
REQUEST_SESSION_STATE_KEY = "db_session"


async def get_db(request: Request) -> AsyncGenerator[AsyncSession, None]:
    """
    Dependency that provides **the** database session of a request.

    In multi-tenant mode with /t/{slug}/ URLs the tenant's own database is
    used; a tenant request without a pool is a 503 (see
    ``resolve_tenant_session_factory``). Requests without tenant context use the
    default database.

    FastAPI caches a dependency per request, so the auth dependencies, the
    handler and ``get_db_readonly`` all share this one session -- one pooled
    connection per request. A second session opened while this one holds a
    connection would draw a second connection from the same pool; under load
    every request then holds one and waits for another, a pool deadlock only
    ``pool_timeout`` breaks (the 2.5.1 fix). The session is also kept on
    ``request.state`` for ``release_request_connection``.
    """
    session_factory = resolve_tenant_session_factory(request) or get_session_factory()
    async with session_factory() as session:
        setattr(request.state, REQUEST_SESSION_STATE_KEY, session)
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_db_readonly(db: AsyncSession = Depends(get_db)) -> AsyncSession:
    """
    The request's session, for routes that only read.

    The same session as ``get_db`` (one connection per request, see there);
    the name marks read-only routes. It used to open a session of its own,
    which made every authenticated read hold two connections at once. The
    commit ``get_db`` runs at the end of a read-only transaction costs one
    round trip and changes nothing.
    """
    return db


async def release_request_connection(request: Any) -> None:
    """
    Hand the request session's connection back to the pool before opening
    another session (the derived tiers: ``audit_log.record_detached``,
    ``change_notifications.deliver``).

    Those run after the route's commit, but a route that re-reads after its
    commit (``db.refresh``, a reload ``select``) has begun a new transaction
    that holds a connection again: a second session would need a second
    connection from the same pool. Committing ends that transaction --
    ``expire_on_commit=False`` keeps the loaded objects usable, which a
    rollback would not (it expires them: lazy loads on an ``AsyncSession``
    raise ``MissingGreenlet``). The route's changes are already committed, so
    this only commits what it read since; anything it writes later begins a
    new transaction that ``get_db`` commits as before. Never raises.
    """
    state = getattr(request, "state", None)
    session = getattr(state, REQUEST_SESSION_STATE_KEY, None) if state is not None else None
    if not isinstance(session, AsyncSession) or not session.in_transaction():
        return
    try:
        await session.commit()
    except Exception as e:  # the caller's own work must still run
        logger.warning("Could not release the request's connection: %s", e)


async def init_db() -> None:
    """Initialize database connection and verify connectivity."""
    engine = get_engine()

    # Test connection
    async with engine.begin() as conn:
        await conn.run_sync(lambda _: None)  # Simple connectivity test

    logger.info("Database connection established successfully")


async def close_db() -> None:
    """Close database connections on shutdown."""
    global _engine, _async_session_factory

    if _engine is not None:
        await _engine.dispose()
        _engine = None
        _async_session_factory = None

    logger.info("Database connections closed")
