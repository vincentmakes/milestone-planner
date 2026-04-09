"""
Seed demo data for GitHub Codespaces.

Creates a demo tenant with sample projects, staff, equipment, and
assignments so the app is ready to explore immediately after setup.

Designed to be idempotent — safe to run multiple times.

Usage:
    python -m app.scripts.seed_demo
"""

import asyncio
import os
import sys
from datetime import date, timedelta

import asyncpg

from app.config import get_settings
from app.services.encryption import encrypt, hash_password


DEMO_TENANT_SLUG = "demo"
DEMO_TENANT_NAME = "Demo Company"
DEMO_TENANT_DB = "milestone_demo"
DEMO_TENANT_USER = "milestone_demo"
DEMO_TENANT_PASSWORD = "demo_db_pass_2026"
DEMO_ADMIN_EMAIL = "admin@demo.local"
DEMO_ADMIN_PASSWORD = "demo1234"


async def get_admin_conn(settings) -> asyncpg.Connection:
    host = settings.master_db_host or settings.db_host
    port = settings.master_db_port or settings.db_port
    user = settings.pg_admin_user or settings.db_user
    password = settings.pg_admin_password or settings.db_password
    return await asyncpg.connect(host=host, port=port, user=user, password=password, database="postgres")


async def ensure_tenant_registered(settings) -> bool:
    """Register the demo tenant in the master database. Returns True if newly created."""
    host = settings.master_db_host or settings.db_host
    port = settings.master_db_port or settings.db_port
    user = settings.master_db_user or settings.db_user
    password = settings.master_db_password or settings.db_password
    db_name = settings.master_db_name

    conn = await asyncpg.connect(host=host, port=port, user=user, password=password, database=db_name)
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
            DEMO_TENANT_NAME, DEMO_TENANT_SLUG, DEMO_TENANT_DB, DEMO_TENANT_USER,
            DEMO_ADMIN_EMAIL, DEMO_TENANT_NAME,
        )
        tenant_id = await conn.fetchval("SELECT id FROM tenants WHERE slug = $1", DEMO_TENANT_SLUG)
        await conn.execute(
            "INSERT INTO tenant_credentials (tenant_id, encrypted_password) VALUES ($1, $2)",
            tenant_id, encrypted_pw,
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

        user_exists = await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", DEMO_TENANT_USER)
        if not user_exists:
            safe_pw = DEMO_TENANT_PASSWORD.replace("'", "''")
            await conn.execute(f"CREATE USER \"{DEMO_TENANT_USER}\" WITH PASSWORD '{safe_pw}'")
            print(f"  Created database user '{DEMO_TENANT_USER}'")

        await conn.execute(f'CREATE DATABASE "{DEMO_TENANT_DB}" OWNER "{DEMO_TENANT_USER}"')
        await conn.execute(f'GRANT ALL PRIVILEGES ON DATABASE "{DEMO_TENANT_DB}" TO "{DEMO_TENANT_USER}"')
        print(f"  Created database '{DEMO_TENANT_DB}'")
        return True
    finally:
        await conn.close()


async def apply_schema_and_seed(settings):
    """Apply tenant schema and seed demo data."""
    from app.services.tenant_provisioner import get_tenant_schema_sql

    conn = await asyncpg.connect(
        host=settings.db_host, port=settings.db_port,
        user=DEMO_TENANT_USER, password=DEMO_TENANT_PASSWORD,
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

        # Apply schema
        schema_sql = get_tenant_schema_sql()
        await conn.execute(schema_sql)
        print("  Applied tenant schema")

        # Seed base data
        await conn.execute("""
            INSERT INTO sso_config (id, enabled) VALUES (1, 0) ON CONFLICT (id) DO NOTHING
        """)
        await conn.execute("""
            INSERT INTO settings (key, value) VALUES
                ('instance_title', 'Demo Instance'),
                ('fiscal_year_start', '1')
            ON CONFLICT (key) DO NOTHING
        """)
        await conn.execute("""
            INSERT INTO predefined_phases (name, sort_order, is_active) VALUES
                ('Preparation', 0, 1), ('Analytics', 1, 1), ('Trial', 2, 1),
                ('Cleaning', 3, 1), ('Report', 4, 1)
            ON CONFLICT (name) DO NOTHING
        """)

        # Sites
        await conn.execute("""
            INSERT INTO sites (name, location, city, country_code, region_code, timezone) VALUES
                ('Winterthur', 'Winterthur', 'Winterthur', 'CH', 'ZH', 'Europe/Zurich'),
                ('Frankfurt', 'Frankfurt', 'Frankfurt', 'DE', 'HE', 'Europe/Berlin')
            ON CONFLICT (name) DO NOTHING
        """)
        wt_id = await conn.fetchval("SELECT id FROM sites WHERE name = 'Winterthur'")
        ff_id = await conn.fetchval("SELECT id FROM sites WHERE name = 'Frankfurt'")

        # Skills
        await conn.execute("""
            INSERT INTO skills (name, description, color) VALUES
                ('Project Management', 'Planning and execution', '#3b82f6'),
                ('HPLC', 'High-Performance Liquid Chromatography', '#e74c3c'),
                ('Data Analysis', 'Statistical analysis', '#8b5cf6'),
                ('Cell Culture', 'Mammalian cell culture', '#10b981'),
                ('Technical Writing', 'Documentation and reports', '#f59e0b'),
                ('Quality Control', 'QC procedures', '#ef4444')
            ON CONFLICT (name) DO NOTHING
        """)

        # Admin user (known password: demo1234)
        admin_hash = hash_password(DEMO_ADMIN_PASSWORD)
        await conn.execute(
            """INSERT INTO users (email, password, first_name, last_name, job_title, role, is_system)
               VALUES ($1, $2, 'Admin', 'User', 'System Administrator', 'admin', 1)
               ON CONFLICT (email) DO NOTHING""",
            DEMO_ADMIN_EMAIL, admin_hash,
        )
        admin_id = await conn.fetchval("SELECT id FROM users WHERE email = $1", DEMO_ADMIN_EMAIL)
        await conn.execute(
            "INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            admin_id, wt_id,
        )

        # Staff members
        staff_data = [
            ("alice.anderson@demo.local", "Alice", "Anderson", "Research Scientist", "superuser", wt_id),
            ("bob.brown@demo.local", "Bob", "Brown", "Project Manager", "superuser", wt_id),
            ("charlie.clark@demo.local", "Charlie", "Clark", "Lab Technician", "user", wt_id),
            ("diana.davis@demo.local", "Diana", "Davis", "Data Analyst", "user", wt_id),
            ("edward.evans@demo.local", "Edward", "Evans", "Process Engineer", "user", wt_id),
            ("fiona.fischer@demo.local", "Fiona", "Fischer", "Analytical Chemist", "user", ff_id),
            ("george.garcia@demo.local", "George", "Garcia", "R&D Engineer", "user", ff_id),
            ("hannah.harris@demo.local", "Hannah", "Harris", "Quality Specialist", "user", ff_id),
        ]
        staff_hash = hash_password("demo1234")
        staff_ids = {}
        for email, first, last, title, role, site_id in staff_data:
            await conn.execute(
                """INSERT INTO users (email, password, first_name, last_name, job_title, role)
                   VALUES ($1, $2, $3, $4, $5, $6)
                   ON CONFLICT (email) DO NOTHING""",
                email, staff_hash, first, last, title, role,
            )
            uid = await conn.fetchval("SELECT id FROM users WHERE email = $1", email)
            staff_ids[email] = uid
            await conn.execute(
                "INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                uid, site_id,
            )
        print(f"  Created {len(staff_data)} staff members")

        # Assign some skills
        skill_ids = await conn.fetch("SELECT id, name FROM skills")
        skill_map = {r["name"]: r["id"] for r in skill_ids}
        skill_assignments = [
            ("alice.anderson@demo.local", ["HPLC", "Data Analysis", "Technical Writing"]),
            ("bob.brown@demo.local", ["Project Management", "Technical Writing"]),
            ("charlie.clark@demo.local", ["HPLC", "Cell Culture", "Quality Control"]),
            ("diana.davis@demo.local", ["Data Analysis", "Technical Writing"]),
            ("fiona.fischer@demo.local", ["HPLC", "Quality Control"]),
            ("george.garcia@demo.local", ["Cell Culture", "Data Analysis"]),
        ]
        for email, skills in skill_assignments:
            uid = staff_ids.get(email)
            if not uid:
                continue
            for skill_name in skills:
                sid = skill_map.get(skill_name)
                if sid:
                    await conn.execute(
                        "INSERT INTO user_skills (user_id, skill_id, proficiency) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
                        uid, sid, 4,
                    )

        # Equipment
        equip_data = [
            ("HPLC System 1", "Analytical", wt_id),
            ("Mass Spectrometer", "Analytical", wt_id),
            ("PCR Thermocycler", "Molecular Biology", wt_id),
            ("Biosafety Cabinet", "Cell Culture", wt_id),
            ("Centrifuge", "General Lab", wt_id),
            ("HPLC System 2", "Analytical", ff_id),
            ("Plate Reader", "Analytical", ff_id),
            ("Freeze Dryer", "Processing", ff_id),
        ]
        for name, etype, site_id in equip_data:
            await conn.execute(
                """INSERT INTO equipment (name, type, site_id, active)
                   VALUES ($1, $2, $3, 1)
                   ON CONFLICT DO NOTHING""",
                name, etype, site_id,
            )
        print(f"  Created {len(equip_data)} equipment items")

        # Projects
        today = date.today()
        projects = [
            ("Catalyst Optimization", wt_id, "Novachem AG", True,
             today - timedelta(days=30), today + timedelta(days=150)),
            ("Bioprocess Scale-Up", wt_id, "BioGen Ltd", True,
             today - timedelta(days=15), today + timedelta(days=200)),
            ("Analytical Method Transfer", wt_id, "PharmaCore", False,
             today + timedelta(days=14), today + timedelta(days=120)),
            ("Quality System Upgrade", ff_id, "Internal", True,
             today - timedelta(days=60), today + timedelta(days=90)),
        ]
        for pname, site_id, customer, confirmed, start, end in projects:
            await conn.execute(
                """INSERT INTO projects (name, site_id, customer, confirmed, start_date, end_date)
                   VALUES ($1, $2, $3, $4, $5, $6)""",
                pname, site_id, customer, 1 if confirmed else 0, start, end,
            )
        print(f"  Created {len(projects)} projects")

        # Phases for each project
        project_rows = await conn.fetch("SELECT id, name, start_date, end_date FROM projects ORDER BY id")
        phase_types = ["Preparation", "Analytics", "Trial", "Cleaning", "Report"]
        for proj in project_rows:
            proj_start = proj["start_date"]
            proj_end = proj["end_date"]
            duration = (proj_end - proj_start).days
            phase_len = max(duration // len(phase_types), 7)
            for i, ptype in enumerate(phase_types):
                ps = proj_start + timedelta(days=i * phase_len)
                pe = min(ps + timedelta(days=phase_len - 1), proj_end)
                if ps > proj_end:
                    break
                await conn.execute(
                    """INSERT INTO project_phases (project_id, type, start_date, end_date, sort_order)
                       VALUES ($1, $2, $3, $4, $5)""",
                    proj["id"], ptype, ps, pe, i,
                )

        # Staff assignments to phases
        phases = await conn.fetch(
            "SELECT pp.id, pp.project_id, pp.type, p.site_id "
            "FROM project_phases pp JOIN projects p ON pp.project_id = p.id ORDER BY pp.id"
        )
        wt_staff = [v for k, v in staff_ids.items() if k.split("@")[0] in
                     ("alice.anderson", "bob.brown", "charlie.clark", "diana.davis", "edward.evans")]
        ff_staff = [v for k, v in staff_ids.items() if k.split("@")[0] in
                     ("fiona.fischer", "george.garcia", "hannah.harris")]
        import random
        random.seed(42)  # reproducible
        assignment_count = 0
        for phase in phases:
            pool = wt_staff if phase["site_id"] == wt_id else ff_staff
            n = min(random.randint(1, 3), len(pool))
            chosen = random.sample(pool, n)
            for sid in chosen:
                alloc = random.choice([25, 50, 50, 75, 100])
                await conn.execute(
                    """INSERT INTO phase_staff_assignments (phase_id, project_id, staff_id, allocation)
                       VALUES ($1, $2, $3, $4)""",
                    phase["id"], phase["project_id"], sid, alloc,
                )
                assignment_count += 1
        print(f"  Created {assignment_count} staff assignments")

        # A couple of vacations
        alice_id = staff_ids.get("alice.anderson@demo.local")
        bob_id = staff_ids.get("bob.brown@demo.local")
        if alice_id:
            await conn.execute(
                "INSERT INTO vacations (staff_id, start_date, end_date, description) VALUES ($1, $2, $3, $4)",
                alice_id, today + timedelta(days=30), today + timedelta(days=37), "Summer vacation",
            )
        if bob_id:
            await conn.execute(
                "INSERT INTO vacations (staff_id, start_date, end_date, description) VALUES ($1, $2, $3, $4)",
                bob_id, today + timedelta(days=60), today + timedelta(days=64), "Conference",
            )

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
    print(f"\n  Admin Portal: http://localhost:8485/admin/")
    print(f"  Admin Email:  admin@demo.local")
    print(f"  Admin Pass:   demo1234")
    print("=" * 50 + "\n")


if __name__ == "__main__":
    asyncio.run(main())
