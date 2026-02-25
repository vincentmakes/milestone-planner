"""
Database auto-initialization for fresh installs.

Creates the master database (if multi-tenant) or tenant database (if single-tenant)
with full schema and seed data. Idempotent - safe to run multiple times.

Usage:
    python -m app.scripts.init_db

Environment variables:
    AUTO_INIT_DB=true           Enable auto-initialization
    INIT_ADMIN_EMAIL            Admin email (default: admin@milestone.local)
    INIT_ADMIN_PASSWORD         Admin password (default: auto-generated)
"""

import asyncio
import os
import secrets
import sys

import asyncpg

from app.config import get_settings


def generate_password(length: int = 16) -> str:
    """Generate a secure random password."""
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%"
    return "".join(secrets.choice(alphabet) for _ in range(length))


async def get_admin_conn(settings) -> asyncpg.Connection:
    """Connect to the default 'postgres' database with admin credentials."""
    host = settings.db_host
    port = settings.db_port
    user = settings.pg_admin_user or settings.db_user
    password = settings.pg_admin_password or settings.db_password

    return await asyncpg.connect(
        host=host,
        port=port,
        user=user,
        password=password,
        database="postgres",
    )


async def ensure_database_exists(settings, db_name: str, db_user: str, db_password: str):
    """Create database and user if they don't exist."""
    conn = await get_admin_conn(settings)
    try:
        # Check if database exists
        exists = await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", db_name)
        if exists:
            print(f"  Database '{db_name}' already exists")
            return False

        # Create user if needed
        user_exists = await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", db_user)
        if not user_exists:
            safe_pw = db_password.replace("'", "''")
            await conn.execute(f"CREATE USER \"{db_user}\" WITH PASSWORD '{safe_pw}'")
            print(f"  Created user '{db_user}'")

        # Create database
        await conn.execute(f'CREATE DATABASE "{db_name}" OWNER "{db_user}"')
        await conn.execute(f'GRANT ALL PRIVILEGES ON DATABASE "{db_name}" TO "{db_user}"')
        print(f"  Created database '{db_name}'")
        return True

    finally:
        await conn.close()


async def apply_master_schema(settings):
    """Apply the master database schema for multi-tenant mode."""
    host = settings.master_db_host or settings.db_host
    port = settings.master_db_port
    user = settings.master_db_user or settings.db_user
    password = settings.master_db_password or settings.db_password
    db_name = settings.master_db_name

    print(f"\n=== Master Database: {db_name} ===")

    await ensure_database_exists(settings, db_name, user, password)

    # Connect to master DB and apply schema
    conn = await asyncpg.connect(
        host=host, port=port, user=user, password=password, database=db_name
    )
    try:
        await conn.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')

        # Apply schema idempotently
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS organizations (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(63) NOT NULL UNIQUE,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS organization_sso_config (
                organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
                enabled INTEGER DEFAULT 0,
                provider VARCHAR(50) DEFAULT 'entra',
                entra_tenant_id VARCHAR(255),
                client_id VARCHAR(255),
                client_secret_encrypted TEXT,
                redirect_uri VARCHAR(500),
                auto_create_users INTEGER DEFAULT 0,
                default_user_role VARCHAR(20) DEFAULT 'user',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS tenants (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(63) NOT NULL UNIQUE,
                database_name VARCHAR(63) NOT NULL UNIQUE,
                database_user VARCHAR(63) NOT NULL UNIQUE,
                status VARCHAR(20) DEFAULT 'active' NOT NULL,
                plan VARCHAR(50) DEFAULT 'standard',
                max_users INTEGER DEFAULT 50,
                max_projects INTEGER DEFAULT 100,
                admin_email VARCHAR(255) NOT NULL,
                company_name VARCHAR(255),
                settings JSONB DEFAULT '{}',
                organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
                required_group_ids JSONB DEFAULT '[]',
                group_membership_mode VARCHAR(10) DEFAULT 'any',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS tenant_credentials (
                tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
                encrypted_password TEXT NOT NULL,
                password_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS tenant_audit_log (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
                action VARCHAR(50) NOT NULL,
                actor VARCHAR(255),
                details JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS admin_users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                name VARCHAR(255),
                role VARCHAR(20) DEFAULT 'admin',
                active INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS admin_sessions (
                sid TEXT PRIMARY KEY,
                sess TEXT NOT NULL,
                expired BIGINT NOT NULL
            )
        """)

        # Create indexes
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_admin_sessions_expired ON admin_sessions(expired)"
        )
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status)")
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_tenants_organization_id ON tenants(organization_id)"
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug)"
        )

        # Seed default admin user
        admin_email = os.environ.get("INIT_ADMIN_EMAIL", "admin@milestone.local")
        admin_password = os.environ.get("INIT_ADMIN_PASSWORD")
        if not admin_password:
            admin_password = generate_password()
            print("\n  *** Admin password was auto-generated. ***")
            print("  *** Set INIT_ADMIN_PASSWORD env var to control it. ***\n")

        # Hash with bcrypt
        import bcrypt as _bcrypt

        password_hash = _bcrypt.hashpw(
            admin_password.encode("utf-8"), _bcrypt.gensalt(rounds=12)
        ).decode("utf-8")

        result = await conn.execute(
            """
            INSERT INTO admin_users (email, password_hash, name, role, active)
            VALUES ($1, $2, 'System Admin', 'superadmin', 1)
            ON CONFLICT (email) DO NOTHING
            """,
            admin_email,
            password_hash,
        )
        if "INSERT 0 1" in result:
            print(f"  Created admin user: {admin_email}")
        else:
            print(f"  Admin user already exists: {admin_email}")

        print("  Master database schema applied successfully")

    finally:
        await conn.close()


async def apply_tenant_schema(settings):
    """Apply the tenant database schema for single-tenant mode."""
    db_name = settings.db_name
    db_user = settings.db_user
    db_password = settings.db_password

    print(f"\n=== Tenant Database: {db_name} ===")

    await ensure_database_exists(settings, db_name, db_user, db_password)

    # Connect and apply the tenant schema
    conn = await asyncpg.connect(
        host=settings.db_host,
        port=settings.db_port,
        user=db_user,
        password=db_password,
        database=db_name,
    )
    try:
        # Import and run the same schema used by tenant_provisioner
        from app.services.encryption import hash_password
        from app.services.tenant_provisioner import get_tenant_schema_sql, run_seed_data

        schema_sql = get_tenant_schema_sql()
        await conn.execute(schema_sql)

        # Seed data
        admin_email = os.environ.get("INIT_ADMIN_EMAIL", "admin@milestone.local")
        admin_password = os.environ.get("INIT_ADMIN_PASSWORD")
        if not admin_password:
            admin_password = generate_password()
            print("\n  *** Admin password was auto-generated. ***")
            print("  *** Set INIT_ADMIN_PASSWORD env var to control it. ***\n")

        admin_password_hash = hash_password(admin_password)
        await run_seed_data(conn, admin_email, admin_password_hash)

        # Insert default settings
        await conn.execute("""
            INSERT INTO settings (key, value) VALUES
                ('instance_title', 'Milestone'),
                ('fiscal_year_start', '1')
            ON CONFLICT (key) DO NOTHING
        """)

        print("  Tenant database schema applied successfully")

    finally:
        await conn.close()


async def main():
    """Run database initialization."""
    settings = get_settings()

    print("=" * 50)
    print("Milestone Database Auto-Initialization")
    print("=" * 50)
    print(f"Mode: {'Multi-Tenant' if settings.multi_tenant else 'Single-Tenant'}")
    print(f"DB Host: {settings.db_host}:{settings.db_port}")

    try:
        if settings.multi_tenant:
            await apply_master_schema(settings)
        else:
            await apply_tenant_schema(settings)

        print("\n" + "=" * 50)
        print("Database initialization completed successfully!")
        print("=" * 50)

    except Exception as e:
        print(f"\nERROR: Database initialization failed: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
