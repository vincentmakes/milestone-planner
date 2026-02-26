"""
Database configuration and session management.
Uses async SQLAlchemy for PostgreSQL connections.
"""

import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import Request
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
            pool_size=settings.db_pool_size,
            max_overflow=settings.db_pool_max_overflow,
            pool_timeout=settings.db_pool_timeout,
            pool_pre_ping=False,  # Disable connection testing for performance
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


async def get_db(request: Request) -> AsyncGenerator[AsyncSession, None]:
    """
    Dependency that provides a database session.

    In multi-tenant mode with /t/{slug}/ URLs:
    - Uses tenant's database if request.state.tenant_slug exists
    - Falls back to default database otherwise

    Used with FastAPI's Depends() for request-scoped sessions.
    """
    # Check for tenant context (set by ASGI middleware)
    state = getattr(request, "state", None)
    if state and hasattr(state, "tenant_slug") and state.tenant_slug:
        # Use tenant's session factory from the connection manager
        from app.services.tenant_manager import tenant_connection_manager

        slug = state.tenant_slug
        session_factory = tenant_connection_manager.get_session_factory(slug)

        if session_factory:
            async with session_factory() as session:
                try:
                    yield session
                    await session.commit()
                except Exception:
                    await session.rollback()
                    raise
            return

    # Use default database
    session_factory = get_session_factory()
    async with session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_db_readonly(request: Request) -> AsyncGenerator[AsyncSession, None]:
    """
    Read-only database session - doesn't commit or rollback.
    Use this for GET endpoints that only read data.
    """
    # Check for tenant context
    state = getattr(request, "state", None)
    if state and hasattr(state, "tenant_slug") and state.tenant_slug:
        from app.services.tenant_manager import tenant_connection_manager

        slug = state.tenant_slug
        session_factory = tenant_connection_manager.get_session_factory(slug)

        if session_factory:
            async with session_factory() as session:
                yield session
            return

    # Use default database
    session_factory = get_session_factory()
    async with session_factory() as session:
        yield session


@asynccontextmanager
async def get_db_context() -> AsyncGenerator[AsyncSession, None]:
    """
    Context manager for database sessions outside of request context.
    Useful for background tasks and startup operations.
    """
    session_factory = get_session_factory()
    async with session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


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


# ---------------------------------------------------------
# Tenant Database Support (for multi-tenant mode)
# ---------------------------------------------------------


class TenantDatabaseManager:
    """
    Manages database connections for multiple tenants.
    Uses connection pooling with lazy initialization.
    """

    def __init__(self):
        self._engines: dict[str, AsyncEngine] = {}
        self._session_factories: dict[str, async_sessionmaker[AsyncSession]] = {}

    async def get_tenant_session(
        self, database_url: str, tenant_slug: str
    ) -> AsyncGenerator[AsyncSession, None]:
        """Get a database session for a specific tenant."""
        if tenant_slug not in self._engines:
            # Create engine for this tenant (lazy initialization)
            self._engines[tenant_slug] = create_async_engine(
                database_url,
                pool_size=5,  # Smaller pool per tenant
                max_overflow=5,
                pool_timeout=30,
                pool_pre_ping=True,
                connect_args={"server_settings": {"timezone": "UTC"}},
            )
            self._session_factories[tenant_slug] = async_sessionmaker(
                bind=self._engines[tenant_slug],
                class_=AsyncSession,
                expire_on_commit=False,
            )

        async with self._session_factories[tenant_slug]() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise
            finally:
                await session.close()

    async def close_all(self) -> None:
        """Close all tenant database connections."""
        for engine in self._engines.values():
            await engine.dispose()
        self._engines.clear()
        self._session_factories.clear()

    async def close_tenant(self, tenant_slug: str) -> None:
        """Close a specific tenant's database connection."""
        if tenant_slug in self._engines:
            await self._engines[tenant_slug].dispose()
            del self._engines[tenant_slug]
            del self._session_factories[tenant_slug]


# Global tenant database manager
tenant_db_manager = TenantDatabaseManager()
