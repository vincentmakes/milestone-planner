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
                pool_pre_ping=True,  # Test connections before use, replace stale ones
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
        Initialize master database connection and apply pending migrations.

        Verifies connectivity and ensures the schema is up to date
        (e.g., organizations table and related tenant columns).
        """
        if self._initialized:
            return

        # Verify we can connect
        async with self.engine.connect() as conn:
            await conn.execute(text("SELECT 1"))

        # Apply any missing schema migrations
        await self._apply_pending_migrations()

        self._initialized = True

    async def _apply_pending_migrations(self):
        """
        Check for and apply missing schema elements.

        This handles the case where the master database was created before
        the organizations feature was added. It checks for missing tables
        and columns and applies them idempotently.

        Errors are caught and logged so the app can still start even if
        migrations fail (e.g., due to insufficient DB permissions).
        """
        try:
            async with self.engine.begin() as conn:
                # Ensure uuid-ossp extension exists
                await conn.execute(text(
                    'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'
                ))

                # Check if organizations table exists
                result = await conn.execute(text(
                    "SELECT EXISTS ("
                    "  SELECT 1 FROM information_schema.tables "
                    "  WHERE table_name = 'organizations'"
                    ")"
                ))
                orgs_table_exists = result.scalar()

                if not orgs_table_exists:
                    print("Master DB: Creating organizations table...")
                    await conn.execute(text(
                        "CREATE TABLE organizations ("
                        "  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),"
                        "  name VARCHAR(255) NOT NULL,"
                        "  slug VARCHAR(63) NOT NULL UNIQUE,"
                        "  description TEXT,"
                        "  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
                        "  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
                        ")"
                    ))
                    await conn.execute(text(
                        "CREATE INDEX IF NOT EXISTS idx_organizations_slug "
                        "ON organizations(slug)"
                    ))
                    print("Master DB: organizations table created")

                # Check if organization_sso_config table exists
                result = await conn.execute(text(
                    "SELECT EXISTS ("
                    "  SELECT 1 FROM information_schema.tables "
                    "  WHERE table_name = 'organization_sso_config'"
                    ")"
                ))
                sso_table_exists = result.scalar()

                if not sso_table_exists:
                    print("Master DB: Creating organization_sso_config table...")
                    await conn.execute(text(
                        "CREATE TABLE organization_sso_config ("
                        "  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,"
                        "  enabled INTEGER DEFAULT 0,"
                        "  provider VARCHAR(50) DEFAULT 'entra',"
                        "  entra_tenant_id VARCHAR(255),"
                        "  client_id VARCHAR(255),"
                        "  client_secret_encrypted TEXT,"
                        "  redirect_uri VARCHAR(500),"
                        "  auto_create_users INTEGER DEFAULT 0,"
                        "  default_user_role VARCHAR(20) DEFAULT 'user',"
                        "  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
                        "  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
                        ")"
                    ))
                    print("Master DB: organization_sso_config table created")

                # Check if tenants.organization_id column exists
                result = await conn.execute(text(
                    "SELECT EXISTS ("
                    "  SELECT 1 FROM information_schema.columns "
                    "  WHERE table_name = 'tenants' AND column_name = 'organization_id'"
                    ")"
                ))
                has_org_id = result.scalar()

                if not has_org_id:
                    print("Master DB: Adding organization_id column to tenants...")
                    await conn.execute(text(
                        "ALTER TABLE tenants ADD COLUMN organization_id UUID "
                        "REFERENCES organizations(id) ON DELETE SET NULL"
                    ))
                    await conn.execute(text(
                        "CREATE INDEX IF NOT EXISTS idx_tenants_organization_id "
                        "ON tenants(organization_id)"
                    ))
                    print("Master DB: organization_id column added")

                # Check if tenants.required_group_ids column exists
                result = await conn.execute(text(
                    "SELECT EXISTS ("
                    "  SELECT 1 FROM information_schema.columns "
                    "  WHERE table_name = 'tenants' AND column_name = 'required_group_ids'"
                    ")"
                ))
                has_group_ids = result.scalar()

                if not has_group_ids:
                    print("Master DB: Adding required_group_ids column to tenants...")
                    await conn.execute(text(
                        "ALTER TABLE tenants ADD COLUMN required_group_ids JSONB DEFAULT '[]'"
                    ))
                    print("Master DB: required_group_ids column added")

                # Check if tenants.group_membership_mode column exists
                result = await conn.execute(text(
                    "SELECT EXISTS ("
                    "  SELECT 1 FROM information_schema.columns "
                    "  WHERE table_name = 'tenants' AND column_name = 'group_membership_mode'"
                    ")"
                ))
                has_group_mode = result.scalar()

                if not has_group_mode:
                    print("Master DB: Adding group_membership_mode column to tenants...")
                    await conn.execute(text(
                        "ALTER TABLE tenants ADD COLUMN group_membership_mode VARCHAR(10) DEFAULT 'any'"
                    ))
                    print("Master DB: group_membership_mode column added")

        except Exception as e:
            print(f"WARNING: Auto-migration failed: {e}")
            print("The app will continue, but organization features may not work.")
            print("Run manually: python migrations/run_migration_master.py add_organizations")
    
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
