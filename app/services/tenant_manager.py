"""
Tenant Connection Manager.

Manages database connection pools for tenant databases.
Each tenant has their own PostgreSQL database with isolated data.
"""

import asyncio
import logging
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import get_settings
from app.models.tenant import Tenant, TenantCredentials
from app.services.encryption import decrypt

logger = logging.getLogger(__name__)


class TenantConnectionManager:
    """
    Manages connection pools for tenant databases.

    Features:
    - Lazy pool creation (pools created on first access)
    - Automatic cleanup of idle pools
    - Connection testing before returning pools
    """

    def __init__(self):
        self._pools: dict[str, AsyncEngine] = {}
        self._pool_timestamps: dict[str, datetime] = {}
        self._session_factories: dict[str, async_sessionmaker] = {}
        self._cleanup_task: asyncio.Task | None = None

        # Configuration
        self.max_idle_time = 15 * 60  # 15 minutes
        self.cleanup_interval = 5 * 60  # 5 minutes

    def start_cleanup_task(self):
        """Start the background cleanup task."""
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def _cleanup_loop(self):
        """Periodically clean up idle connection pools."""
        while True:
            await asyncio.sleep(self.cleanup_interval)
            await self._cleanup_idle_pools()

    async def _cleanup_idle_pools(self):
        """Remove connection pools that have been idle too long."""
        now = datetime.utcnow()
        to_remove = []

        for slug, timestamp in self._pool_timestamps.items():
            idle_seconds = (now - timestamp).total_seconds()
            if idle_seconds > self.max_idle_time:
                to_remove.append(slug)

        for slug in to_remove:
            await self._close_pool(slug)
            logger.info("Closed idle tenant pool: %s", slug)

    async def _close_pool(self, slug: str):
        """Close a specific tenant's connection pool."""
        if slug in self._pools:
            engine = self._pools.pop(slug)
            await engine.dispose()

        self._pool_timestamps.pop(slug, None)
        self._session_factories.pop(slug, None)

    async def _run_auto_migrations(self, conn, slug: str):
        """
        Run automatic migrations for tenant databases.

        This ensures schema changes are applied without manual intervention.
        """
        try:
            # Check if is_system column exists
            result = await conn.execute(
                text("""
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'users' AND column_name = 'is_system'
            """)
            )
            if not result.fetchone():
                logger.info("Auto-migration: Adding is_system column to tenant %s...", slug)
                await conn.execute(text("ALTER TABLE users ADD COLUMN is_system INTEGER DEFAULT 0"))
                # Mark first admin as system user
                await conn.execute(
                    text("""
                    UPDATE users SET is_system = 1
                    WHERE id = (SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1)
                """)
                )
                await conn.commit()
                logger.info("Auto-migration: Added is_system column to tenant %s", slug)
        except Exception as e:
            logger.warning("Auto-migration warning for %s: %s", slug, e)
            # Don't fail if migration has issues - continue with connection

    async def get_pool(self, tenant: Tenant, credentials: TenantCredentials) -> AsyncEngine:
        """
        Get or create a connection pool for a tenant.

        Args:
            tenant: The tenant record
            credentials: The tenant's encrypted credentials

        Returns:
            AsyncEngine for the tenant's database
        """
        slug = tenant.slug

        # Update access timestamp
        self._pool_timestamps[slug] = datetime.utcnow()

        # Return existing pool if available
        if slug in self._pools:
            return self._pools[slug]

        # Decrypt password
        try:
            password = decrypt(credentials.encrypted_password)
        except Exception as e:
            raise ConnectionError(f"Failed to decrypt credentials for tenant {slug}: {e}") from e

        # Build connection URL
        settings = get_settings()
        host = settings.db_host
        port = settings.db_port

        url = (
            f"postgresql+asyncpg://{tenant.database_user}:{password}"
            f"@{host}:{port}/{tenant.database_name}"
        )

        logger.info(
            "Connecting to tenant DB: %s as %s@%s:%s",
            tenant.database_name,
            tenant.database_user,
            host,
            port,
        )

        # Create engine
        engine = create_async_engine(
            url,
            echo=False,  # Disable SQL logging
            pool_size=20,
            max_overflow=10,
            pool_timeout=30,
        )

        # Test connection and run auto-migrations
        try:
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))

                # Auto-migration: Add is_system column if missing
                await self._run_auto_migrations(conn, slug)

            logger.info("Tenant pool created: %s", slug)
        except Exception as e:
            await engine.dispose()
            raise ConnectionError(
                f"Failed to connect to tenant database {slug} ({tenant.database_name}): {e}"
            ) from e

        self._pools[slug] = engine
        return engine

    async def get_pool_from_info(self, tenant_info: dict[str, Any]) -> AsyncEngine:
        """
        Get or create a connection pool for a tenant using dict info.

        This version accepts a dict instead of ORM objects to avoid
        detached session issues when caching tenant data.

        Args:
            tenant_info: Dict with slug, database_name, database_user, encrypted_password

        Returns:
            AsyncEngine for the tenant's database
        """
        slug = tenant_info["slug"]

        # Update access timestamp
        self._pool_timestamps[slug] = datetime.utcnow()

        # Return existing pool if available
        if slug in self._pools:
            return self._pools[slug]

        # Decrypt password
        try:
            password = decrypt(tenant_info["encrypted_password"])
        except Exception as e:
            raise ConnectionError(f"Failed to decrypt credentials for tenant {slug}: {e}") from e

        # Build connection URL
        settings = get_settings()
        host = settings.db_host
        port = settings.db_port

        url = (
            f"postgresql+asyncpg://{tenant_info['database_user']}:{password}"
            f"@{host}:{port}/{tenant_info['database_name']}"
        )

        logger.info(
            "Connecting to tenant DB: %s as %s@%s:%s",
            tenant_info["database_name"],
            tenant_info["database_user"],
            host,
            port,
        )

        # Create engine
        engine = create_async_engine(
            url,
            echo=False,  # Disable SQL logging
            pool_size=20,
            max_overflow=10,
            pool_timeout=30,
        )

        # Test connection and run auto-migrations
        try:
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))

                # Auto-migration: Add is_system column if missing
                await self._run_auto_migrations(conn, slug)

            logger.info("Tenant pool created: %s", slug)
        except Exception as e:
            await engine.dispose()
            raise ConnectionError(
                f"Failed to connect to tenant database {slug} ({tenant_info['database_name']}): {e}"
            ) from e

        self._pools[slug] = engine
        return engine

    def get_session_factory(self, slug: str) -> async_sessionmaker | None:
        """Get session factory for a tenant."""
        if slug not in self._pools:
            return None

        if slug not in self._session_factories:
            self._session_factories[slug] = async_sessionmaker(
                bind=self._pools[slug],
                class_=AsyncSession,
                expire_on_commit=False,
                autoflush=False,
            )

        return self._session_factories[slug]

    def get_stats(self) -> dict[str, Any]:
        """Get connection pool statistics."""
        return {
            "active_pools": len(self._pools),
            "pool_slugs": list(self._pools.keys()),
            "total_connections": sum(
                getattr(engine.pool, "size", 0) for engine in self._pools.values()
            ),
        }

    async def close_all(self):
        """Close all connection pools."""
        for slug in list(self._pools.keys()):
            await self._close_pool(slug)

        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass


# Global instance
tenant_connection_manager = TenantConnectionManager()
