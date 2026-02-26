"""
Master Database Connection Manager.

Handles connections to the admin/master database that stores:
- Tenant registry
- Tenant credentials (encrypted)
- Admin users
- Audit logs

This is separate from tenant databases.
"""

import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings

# Import tenant models and their separate Base
from app.models.tenant import AdminUser

logger = logging.getLogger(__name__)


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
                await conn.execute(text('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'))

                # Ensure admin_users table exists (needed for login)
                await conn.execute(
                    text(
                        "CREATE TABLE IF NOT EXISTS admin_users ("
                        "  id SERIAL PRIMARY KEY,"
                        "  email VARCHAR(255) NOT NULL UNIQUE,"
                        "  password_hash TEXT NOT NULL,"
                        "  name VARCHAR(255),"
                        "  role VARCHAR(20) DEFAULT 'admin',"
                        "  active INTEGER DEFAULT 1,"
                        "  must_change_password INTEGER DEFAULT 0,"
                        "  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
                        "  last_login TIMESTAMP"
                        ")"
                    )
                )

                # Ensure admin_sessions table exists (needed for login)
                await conn.execute(
                    text(
                        "CREATE TABLE IF NOT EXISTS admin_sessions ("
                        "  sid TEXT PRIMARY KEY,"
                        "  sess TEXT NOT NULL,"
                        "  expired BIGINT NOT NULL"
                        ")"
                    )
                )
                await conn.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS idx_admin_sessions_expired "
                        "ON admin_sessions(expired)"
                    )
                )

                # Check if organizations table exists
                result = await conn.execute(
                    text(
                        "SELECT EXISTS ("
                        "  SELECT 1 FROM information_schema.tables "
                        "  WHERE table_name = 'organizations'"
                        ")"
                    )
                )
                orgs_table_exists = result.scalar()

                if not orgs_table_exists:
                    logger.info("Master DB: Creating organizations table...")
                    await conn.execute(
                        text(
                            "CREATE TABLE organizations ("
                            "  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),"
                            "  name VARCHAR(255) NOT NULL,"
                            "  slug VARCHAR(63) NOT NULL UNIQUE,"
                            "  description TEXT,"
                            "  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
                            "  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
                            ")"
                        )
                    )
                    await conn.execute(
                        text(
                            "CREATE INDEX IF NOT EXISTS idx_organizations_slug "
                            "ON organizations(slug)"
                        )
                    )
                    logger.info("Master DB: organizations table created")

                # Check if organization_sso_config table exists
                result = await conn.execute(
                    text(
                        "SELECT EXISTS ("
                        "  SELECT 1 FROM information_schema.tables "
                        "  WHERE table_name = 'organization_sso_config'"
                        ")"
                    )
                )
                sso_table_exists = result.scalar()

                if not sso_table_exists:
                    logger.info("Master DB: Creating organization_sso_config table...")
                    await conn.execute(
                        text(
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
                        )
                    )
                    logger.info("Master DB: organization_sso_config table created")

                # Check if tenants.organization_id column exists
                result = await conn.execute(
                    text(
                        "SELECT EXISTS ("
                        "  SELECT 1 FROM information_schema.columns "
                        "  WHERE table_name = 'tenants' AND column_name = 'organization_id'"
                        ")"
                    )
                )
                has_org_id = result.scalar()

                if not has_org_id:
                    logger.info("Master DB: Adding organization_id column to tenants...")
                    await conn.execute(
                        text(
                            "ALTER TABLE tenants ADD COLUMN organization_id UUID "
                            "REFERENCES organizations(id) ON DELETE SET NULL"
                        )
                    )
                    await conn.execute(
                        text(
                            "CREATE INDEX IF NOT EXISTS idx_tenants_organization_id "
                            "ON tenants(organization_id)"
                        )
                    )
                    logger.info("Master DB: organization_id column added")

                # Check if tenants.required_group_ids column exists
                result = await conn.execute(
                    text(
                        "SELECT EXISTS ("
                        "  SELECT 1 FROM information_schema.columns "
                        "  WHERE table_name = 'tenants' AND column_name = 'required_group_ids'"
                        ")"
                    )
                )
                has_group_ids = result.scalar()

                if not has_group_ids:
                    logger.info("Master DB: Adding required_group_ids column to tenants...")
                    await conn.execute(
                        text("ALTER TABLE tenants ADD COLUMN required_group_ids JSONB DEFAULT '[]'")
                    )
                    logger.info("Master DB: required_group_ids column added")

                # Check if tenants.group_membership_mode column exists
                result = await conn.execute(
                    text(
                        "SELECT EXISTS ("
                        "  SELECT 1 FROM information_schema.columns "
                        "  WHERE table_name = 'tenants' AND column_name = 'group_membership_mode'"
                        ")"
                    )
                )
                has_group_mode = result.scalar()

                if not has_group_mode:
                    logger.info("Master DB: Adding group_membership_mode column to tenants...")
                    await conn.execute(
                        text(
                            "ALTER TABLE tenants ADD COLUMN group_membership_mode VARCHAR(10) DEFAULT 'any'"
                        )
                    )
                    logger.info("Master DB: group_membership_mode column added")

                # Check if admin_users.must_change_password column exists
                result = await conn.execute(
                    text(
                        "SELECT EXISTS ("
                        "  SELECT 1 FROM information_schema.columns "
                        "  WHERE table_name = 'admin_users' AND column_name = 'must_change_password'"
                        ")"
                    )
                )
                has_must_change = result.scalar()

                if not has_must_change:
                    logger.info("Master DB: Adding must_change_password column to admin_users...")
                    await conn.execute(
                        text(
                            "ALTER TABLE admin_users ADD COLUMN must_change_password INTEGER DEFAULT 0"
                        )
                    )
                    logger.info("Master DB: must_change_password column added")

        except Exception as e:
            logger.warning("Auto-migration failed: %s", e)
            logger.warning("The app will continue, but organization features may not work.")
            logger.warning(
                "Run manually: python migrations/run_migration_master.py add_organizations"
            )

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
        """Verify at least one admin user exists, create default if none."""
        from sqlalchemy import func, select

        from app.services.encryption import generate_password, hash_password

        async with self.session() as session:
            result = await session.execute(select(func.count(AdminUser.id)))
            count = result.scalar()

            if count == 0:
                password = generate_password(16)
                logger.warning("No admin users found - creating default admin user...")
                admin = AdminUser(
                    email="admin@milestone.local",
                    password_hash=hash_password(password),
                    name="System Admin",
                    role="superadmin",
                    active=1,
                    must_change_password=1,
                )
                session.add(admin)
                logger.warning("=" * 60)
                logger.warning("  DEFAULT ADMIN USER CREATED")
                logger.warning("  Email:    admin@milestone.local")
                logger.warning("  Password: %s", password)
                logger.warning("  You will be required to change this on first login.")
                logger.warning("=" * 60)
            else:
                logger.info("Master DB: Found %d admin user(s)", count)


# Global instance
master_db = MasterDatabase()


async def get_master_db() -> AsyncGenerator[AsyncSession, None]:
    """Dependency for getting master database session."""
    async with master_db.session() as session:
        yield session
