"""
Master Database Connection Manager.

Handles connections to the admin/master database that stores:
- Tenant registry
- Tenant credentials (encrypted)
- Admin users
- Audit logs

This is separate from tenant databases.
"""

from typing import Optional, AsyncGenerator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy import text

from app.config import get_settings

# Import tenant models and their separate Base
from app.models.tenant import MasterBase, Tenant, TenantCredentials, TenantAuditLog, AdminUser, AdminSession


class MasterDatabase:
    """Manager for the master/admin database connection."""
    
    def __init__(self):
        self._engine = None
        self._session_factory = None
        self._initialized = False
    
    @property
    def engine(self):
        if self._engine is None:
            settings = get_settings()
            
            # Build master database URL
            if settings.master_async_database_url:
                url = settings.master_async_database_url
            else:
                # Fall back to main database if not in multi-tenant mode
                url = settings.async_database_url
            
            self._engine = create_async_engine(
                url,
                echo=False,  # Disable SQL logging
                pool_size=10,
                max_overflow=5,
                pool_timeout=30,
            )
        return self._engine
    
    @property
    def session_factory(self):
        if self._session_factory is None:
            self._session_factory = async_sessionmaker(
                bind=self.engine,
                class_=AsyncSession,
                expire_on_commit=False,
                autoflush=False,
            )
        return self._session_factory
    
    async def init_db(self):
        """
        Initialize master database connection.
        
        NOTE: We do NOT create tables here. The master database schema
        was created by the Node.js application and already exists.
        This just verifies connectivity.
        """
        if self._initialized:
            return
        
        # Just verify we can connect
        async with self.engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        
        self._initialized = True
    
    async def close(self):
        """Close the database connection."""
        if self._engine:
            await self._engine.dispose()
            self._engine = None
            self._session_factory = None
            self._initialized = False
    
    @asynccontextmanager
    async def session(self) -> AsyncGenerator[AsyncSession, None]:
        """Get a database session."""
        async with self.session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise
    
    async def verify_admin_exists(self):
        """Verify at least one admin user exists."""
        from sqlalchemy import select, func
        
        async with self.session() as session:
            result = await session.execute(
                select(func.count(AdminUser.id))
            )
            count = result.scalar()
            
            if count == 0:
                print("WARNING: No admin users found in master database!")
                print("The Node.js application should have created a default admin.")
            else:
                print(f"Master DB: Found {count} admin user(s)")


# Global instance
master_db = MasterDatabase()


async def get_master_db() -> AsyncGenerator[AsyncSession, None]:
    """Dependency for getting master database session."""
    async with master_db.session() as session:
        yield session
