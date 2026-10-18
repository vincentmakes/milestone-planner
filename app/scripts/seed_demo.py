"""
Seed the demo tenant (GitHub Codespaces, the screenshot pipeline).

Provisions the `demo` tenant database, registers it in the master DB and
inserts the demo data from `app/scripts/demo_data.py`: two sites, nine
people, projects with phases, nested subphases and dependencies, staff and
equipment bookings, blocks, bank holidays, company events incl. a site
closure, every absence type, tag groups, custom columns, Kanban comments with
mentions and notifications.

Idempotent — safe to run again; a partially seeded database is completed.

Usage:
    python -m app.scripts.seed_demo
"""

import asyncio
import sys
from datetime import date

import asyncpg

from app.config import get_settings
from app.scripts.demo_data import DEMO_PASSWORD, build_demo
from app.services.demo_seed import insert_demo_data
from app.services.encryption import encrypt

DEMO_TENANT_SLUG = "demo"
DEMO_TENANT_NAME = "Demo Company"
DEMO_TENANT_DB = "milestone_demo"
DEMO_TENANT_USER = "milestone_demo"
DEMO_TENANT_PASSWORD = "demo_db_pass_2026"
DEMO_ADMIN_EMAIL = "admin@demo.local"
DEMO_ADMIN_PASSWORD = DEMO_PASSWORD


async def get_admin_conn(settings) -> asyncpg.Connection:
    host = settings.master_db_host or settings.db_host
    port = settings.master_db_port or settings.db_port
    user = settings.pg_admin_user or settings.db_user
    password = settings.pg_admin_password or settings.db_password
    return await asyncpg.connect(
        host=host, port=port, user=user, password=password, database="postgres"
    )


async def ensure_tenant_registered(settings) -> bool:
    """Register the demo tenant in the master database. Returns True if newly created."""
    host = settings.master_db_host or settings.db_host
    port = settings.master_db_port or settings.db_port
    user = settings.master_db_user or settings.db_user
    password = settings.master_db_password or settings.db_password
    db_name = settings.master_db_name

    conn = await asyncpg.connect(
        host=host, port=port, user=user, password=password, database=db_name
    )
    try:
        exists = await conn.fetchval("SELECT 1 FROM tenants WHERE slug = $1", DEMO_TENANT_SLUG)
        if exists:
            print(f"  Tenant '{DEMO_TENANT_SLUG}' already registered in master DB")
            return False

        encrypted_pw = encrypt(DEMO_TENANT_PASSWORD)
        await conn.execute(
            """
            INSERT INTO tenants (name, slug, database_name, database_user, status, admin_email, company_name)
            VALUES ($1, $2, $3, $4, 'active', $5, $6)
            """,
            DEMO_TENANT_NAME,
            DEMO_TENANT_SLUG,
            DEMO_TENANT_DB,
            DEMO_TENANT_USER,
            DEMO_ADMIN_EMAIL,
            DEMO_TENANT_NAME,
        )
        tenant_id = await conn.fetchval("SELECT id FROM tenants WHERE slug = $1", DEMO_TENANT_SLUG)
        await conn.execute(
            "INSERT INTO tenant_credentials (tenant_id, encrypted_password) VALUES ($1, $2)",
            tenant_id,
            encrypted_pw,
        )
        print(f"  Registered tenant '{DEMO_TENANT_SLUG}' in master DB")
        return True
    finally:
        await conn.close()


async def provision_demo_db(settings) -> bool:
    """Create the demo tenant database and user. Returns True if newly created."""
    conn = await get_admin_conn(settings)
    try:
        exists = await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", DEMO_TENANT_DB)
        if exists:
            print(f"  Database '{DEMO_TENANT_DB}' already exists")
            return False

        user_exists = await conn.fetchval(
            "SELECT 1 FROM pg_roles WHERE rolname = $1", DEMO_TENANT_USER
        )
        if not user_exists:
            safe_pw = DEMO_TENANT_PASSWORD.replace("'", "''")
            await conn.execute(f"CREATE USER \"{DEMO_TENANT_USER}\" WITH PASSWORD '{safe_pw}'")
            print(f"  Created database user '{DEMO_TENANT_USER}'")

        # Grant the role to the current admin so a non-superuser (managed
        # Postgres: Azure / RDS / Cloud SQL) can create a database OWNED by it.
        # Without membership, "CREATE DATABASE ... OWNER <role>" fails with
        # 'must be able to SET ROLE "<role>"'.
        try:
            await conn.execute(f'GRANT "{DEMO_TENANT_USER}" TO CURRENT_USER')
        except Exception as e:
            print(f"  Warning: could not grant role to admin (continuing): {e}")

        await conn.execute(f'CREATE DATABASE "{DEMO_TENANT_DB}" OWNER "{DEMO_TENANT_USER}"')
        await conn.execute(
            f'GRANT ALL PRIVILEGES ON DATABASE "{DEMO_TENANT_DB}" TO "{DEMO_TENANT_USER}"'
        )
        print(f"  Created database '{DEMO_TENANT_DB}'")
        return True
    finally:
        await conn.close()


async def apply_schema_and_seed(settings):
    """Apply the tenant schema and insert the demo data (see demo_data.py)."""
    from app.services.tenant_provisioner import get_tenant_schema_sql

    conn = await asyncpg.connect(
        host=settings.db_host,
        port=settings.db_port,
        user=DEMO_TENANT_USER,
        password=DEMO_TENANT_PASSWORD,
        database=DEMO_TENANT_DB,
    )
    try:
        # Check if already seeded
        has_users = await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users')"
        )
        if has_users:
            user_count = await conn.fetchval("SELECT COUNT(*) FROM users")
            if user_count > 1:
                print("  Demo data already seeded — skipping")
                return

        await conn.execute(get_tenant_schema_sql())
        print("  Applied tenant schema")

        counts = await insert_demo_data(conn, build_demo(date.today()))
        for table, n_rows in counts.items():
            print(f"  {table}: {n_rows}")
        print("  Demo data seeded successfully")
    finally:
        await conn.close()


async def main():
    settings = get_settings()

    if not settings.multi_tenant:
        print("ERROR: seed_demo requires MULTI_TENANT=true")
        sys.exit(1)

    print("\n=== Seeding Demo Tenant ===")

    # 1. Provision the database
    print("\n1. Provisioning database...")
    await provision_demo_db(settings)

    # 2. Register tenant in master DB
    print("\n2. Registering tenant...")
    await ensure_tenant_registered(settings)

    # 3. Apply schema and seed data
    print("\n3. Applying schema and seeding data...")
    await apply_schema_and_seed(settings)

    print("\n" + "=" * 50)
    print("  DEMO TENANT READY")
    print("=" * 50)
    print(f"  URL:      http://localhost:8485/t/{DEMO_TENANT_SLUG}/")
    print(f"  Email:    {DEMO_ADMIN_EMAIL}")
    print(f"  Password: {DEMO_ADMIN_PASSWORD}")
    print("=" * 50)
    print("\n  Admin Portal: http://localhost:8485/admin/")
    print("  Admin Email:  admin@demo.local")
    print("  Admin Pass:   demo1234")
    print("=" * 50 + "\n")


if __name__ == "__main__":
    asyncio.run(main())
