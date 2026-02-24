"""
Tenant Database Provisioner.

Handles creating and managing tenant PostgreSQL databases.
Schema matches Node.js application exactly.
"""

import re
from typing import Any

import asyncpg

from app.config import get_settings
from app.services.encryption import generate_password, hash_password


def _validate_identifier(name: str) -> str:
    """Validate a SQL identifier (database name, username) to prevent injection."""
    if not re.match(r"^[a-zA-Z0-9_-]+$", name):
        raise ValueError(f"Invalid SQL identifier: {name!r}")
    if len(name) > 63:
        raise ValueError(f"SQL identifier too long (max 63): {name!r}")
    return name


def _escape_literal(value: str) -> str:
    """Escape a string for use as a SQL literal (single-quoted value)."""
    return value.replace("'", "''")


async def get_admin_connection() -> asyncpg.Connection:
    """
    Get a connection using PostgreSQL admin credentials.

    Uses pg_admin_user/pg_admin_password or falls back to main DB credentials.
    """
    settings = get_settings()

    host = settings.db_host
    port = settings.db_port
    user = settings.pg_admin_user or settings.db_user
    password = settings.pg_admin_password or settings.db_password
    database = "postgres"  # Connect to default database for admin operations

    print(f"Admin connection: user={user}, host={host}:{port}, database={database}")

    return await asyncpg.connect(
        host=host,
        port=port,
        user=user,
        password=password,
        database=database,
    )


def get_tenant_schema_sql() -> str:
    """
    Get the SQL schema for tenant databases.

    This matches the Node.js schema exactly for compatibility.
    """
    return """
    -- Settings table (key-value store for app settings)
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Predefined phases for project creation
    CREATE TABLE IF NOT EXISTS predefined_phases (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Sites table
    CREATE TABLE IF NOT EXISTS sites (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      location TEXT,
      city TEXT,
      country_code TEXT,
      region_code TEXT,
      timezone TEXT DEFAULT 'Europe/Zurich',
      last_holiday_fetch TIMESTAMP,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Bank holidays table
    CREATE TABLE IF NOT EXISTS bank_holidays (
      id SERIAL PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      end_date DATE,
      name TEXT NOT NULL,
      is_custom INTEGER DEFAULT 0,
      year INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(site_id, date, name)
    );

    -- Company events table (similar to holidays but don't affect working days)
    CREATE TABLE IF NOT EXISTS company_events (
      id SERIAL PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      end_date DATE,
      name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      job_title TEXT,
      role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'superuser', 'user')),
      max_capacity INTEGER DEFAULT 100,
      sso_provider TEXT,
      sso_id TEXT,
      active INTEGER DEFAULT 1,
      is_system INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- User-Site junction table
    CREATE TABLE IF NOT EXISTS user_sites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, site_id)
    );

    -- Equipment table
    CREATE TABLE IF NOT EXISTS equipment (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT,
      site_id INTEGER REFERENCES sites(id),
      description TEXT,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Projects table
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      site_id INTEGER REFERENCES sites(id),
      customer TEXT,
      pm_id INTEGER REFERENCES users(id),
      sales_pm TEXT,
      confirmed INTEGER DEFAULT 0,
      volume REAL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      notes TEXT,
      archived INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Project phases table
    CREATE TABLE IF NOT EXISTS project_phases (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      is_milestone INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      completion INTEGER,
      dependencies TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Project subphases table
    CREATE TABLE IF NOT EXISTS project_subphases (
      id SERIAL PRIMARY KEY,
      parent_id INTEGER NOT NULL,
      parent_type TEXT NOT NULL DEFAULT 'phase' CHECK(parent_type IN ('phase', 'subphase')),
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      is_milestone INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      depth INTEGER DEFAULT 1,
      completion INTEGER,
      dependencies TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Project staff assignments (project-level)
    CREATE TABLE IF NOT EXISTS project_assignments (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      allocation INTEGER DEFAULT 100,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Phase staff assignments
    CREATE TABLE IF NOT EXISTS phase_staff_assignments (
      id SERIAL PRIMARY KEY,
      phase_id INTEGER NOT NULL REFERENCES project_phases(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      allocation INTEGER DEFAULT 100,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Subphase staff assignments
    CREATE TABLE IF NOT EXISTS subphase_staff_assignments (
      id SERIAL PRIMARY KEY,
      subphase_id INTEGER NOT NULL REFERENCES project_subphases(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      allocation INTEGER DEFAULT 100,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Equipment assignments
    CREATE TABLE IF NOT EXISTS equipment_assignments (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      phase_id INTEGER REFERENCES project_phases(id) ON DELETE CASCADE,
      subphase_id INTEGER REFERENCES project_subphases(id) ON DELETE CASCADE,
      equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Notes
    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      site_id INTEGER REFERENCES sites(id),
      staff_id INTEGER REFERENCES users(id),
      date DATE NOT NULL,
      text TEXT NOT NULL,
      type TEXT DEFAULT 'general',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Vacations/time off
    CREATE TABLE IF NOT EXISTS vacations (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      description TEXT DEFAULT 'Vacation',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Session storage for express-session (Node.js format)
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expired BIGINT NOT NULL
    );

    -- SSO Configuration
    CREATE TABLE IF NOT EXISTS sso_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER DEFAULT 0,
      tenant_id TEXT,
      client_id TEXT,
      client_secret TEXT,
      redirect_uri TEXT,
      auto_create_users INTEGER DEFAULT 0,
      default_role TEXT DEFAULT 'user' CHECK(default_role IN ('superuser', 'user')),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Custom columns (user-defined properties for projects/phases/subphases)
    CREATE TABLE IF NOT EXISTS custom_columns (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      column_type VARCHAR(20) NOT NULL DEFAULT 'text' CHECK(column_type IN ('text', 'boolean', 'list')),
      list_options TEXT,
      site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
      display_order INTEGER NOT NULL DEFAULT 0,
      width INTEGER NOT NULL DEFAULT 120,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Custom column values
    CREATE TABLE IF NOT EXISTS custom_column_values (
      id SERIAL PRIMARY KEY,
      custom_column_id INTEGER NOT NULL REFERENCES custom_columns(id) ON DELETE CASCADE,
      entity_type VARCHAR(20) NOT NULL CHECK(entity_type IN ('project', 'phase', 'subphase')),
      entity_id INTEGER NOT NULL,
      value TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(custom_column_id, entity_type, entity_id)
    );

    -- Skills (global, shared across all sites)
    CREATE TABLE IF NOT EXISTS skills (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      description TEXT,
      color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- User skills (many-to-many)
    CREATE TABLE IF NOT EXISTS user_skills (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      proficiency INTEGER NOT NULL DEFAULT 3 CHECK(proficiency >= 1 AND proficiency <= 5),
      assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, skill_id)
    );

    -- Project presence (tracking active viewers for realtime collaboration)
    CREATE TABLE IF NOT EXISTS project_presence (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      activity TEXT DEFAULT 'viewing' NOT NULL,
      last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_presence_unique ON project_presence(project_id, user_id);

    -- Create indexes
    CREATE INDEX IF NOT EXISTS idx_bank_holidays_site ON bank_holidays(site_id);
    CREATE INDEX IF NOT EXISTS idx_bank_holidays_date ON bank_holidays(date);
    CREATE INDEX IF NOT EXISTS idx_bank_holidays_year ON bank_holidays(site_id, year);
    CREATE INDEX IF NOT EXISTS idx_company_events_site_date ON company_events(site_id, date);
    CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
    CREATE INDEX IF NOT EXISTS idx_projects_site ON projects(site_id);
    CREATE INDEX IF NOT EXISTS idx_project_phases_project ON project_phases(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_subphases_project ON project_subphases(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_subphases_parent ON project_subphases(parent_id, parent_type);
    CREATE INDEX IF NOT EXISTS idx_project_assignments_project ON project_assignments(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_assignments_staff ON project_assignments(staff_id);
    CREATE INDEX IF NOT EXISTS idx_phase_staff_assignments_phase ON phase_staff_assignments(phase_id);
    CREATE INDEX IF NOT EXISTS idx_phase_staff_assignments_project ON phase_staff_assignments(project_id);
    CREATE INDEX IF NOT EXISTS idx_phase_staff_assignments_staff ON phase_staff_assignments(staff_id);
    CREATE INDEX IF NOT EXISTS idx_subphase_staff_assignments_subphase ON subphase_staff_assignments(subphase_id);
    CREATE INDEX IF NOT EXISTS idx_subphase_staff_assignments_project ON subphase_staff_assignments(project_id);
    CREATE INDEX IF NOT EXISTS idx_subphase_staff_assignments_staff ON subphase_staff_assignments(staff_id);
    CREATE INDEX IF NOT EXISTS idx_equipment_assignments_project ON equipment_assignments(project_id);
    CREATE INDEX IF NOT EXISTS idx_equipment_assignments_equip ON equipment_assignments(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_vacations_staff ON vacations(staff_id);
    CREATE INDEX IF NOT EXISTS idx_vacations_dates ON vacations(start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_custom_columns_site ON custom_columns(site_id);
    CREATE INDEX IF NOT EXISTS idx_custom_column_values_column ON custom_column_values(custom_column_id);
    CREATE INDEX IF NOT EXISTS idx_custom_column_values_entity ON custom_column_values(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_user_skills_user ON user_skills(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_skills_skill ON user_skills(skill_id);
    CREATE INDEX IF NOT EXISTS idx_project_presence_project ON project_presence(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_presence_user ON project_presence(user_id);
    CREATE INDEX IF NOT EXISTS idx_project_presence_last_seen ON project_presence(last_seen_at);
    """


async def run_seed_data(conn: asyncpg.Connection, admin_email: str, admin_password_hash: str):
    """Seed initial data for a new tenant using parameterized queries."""
    # Static seed data (no user input)
    await conn.execute("""
    INSERT INTO sso_config (id, enabled) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
    """)
    await conn.execute("""
    INSERT INTO predefined_phases (name, sort_order, is_active) VALUES
      ('Preparation', 0, 1),
      ('Analytics', 1, 1),
      ('Trial', 2, 1),
      ('Cleaning', 3, 1),
      ('Report', 4, 1)
    ON CONFLICT (name) DO NOTHING;
    """)
    await conn.execute("""
    INSERT INTO skills (name, description, color) VALUES
      ('Project Management', 'Experience in managing projects and teams', '#3b82f6'),
      ('Data Analysis', 'Statistical analysis and data interpretation', '#8b5cf6'),
      ('Laboratory Work', 'Hands-on laboratory experience', '#10b981'),
      ('Technical Writing', 'Documentation and report writing', '#f59e0b'),
      ('Quality Control', 'QC procedures and compliance', '#ef4444'),
      ('R&D', 'Research and development experience', '#06b6d4')
    ON CONFLICT (name) DO NOTHING;
    """)
    await conn.execute("""
    INSERT INTO sites (name, location, city, country_code, region_code)
    VALUES ('Main Site', 'Default', 'Default', 'US', 'US')
    ON CONFLICT (name) DO NOTHING;
    """)
    # User input - use parameterized queries
    await conn.execute(
        "INSERT INTO users (email, password, first_name, last_name, job_title, role, is_system) "
        "VALUES ($1, $2, 'Admin', 'User', 'Administrator', 'admin', 1) "
        "ON CONFLICT (email) DO NOTHING",
        admin_email,
        admin_password_hash,
    )
    await conn.execute(
        "INSERT INTO user_sites (user_id, site_id) "
        "SELECT u.id, s.id FROM users u, sites s "
        "WHERE u.email = $1 AND s.name = 'Main Site' "
        "ON CONFLICT DO NOTHING",
        admin_email,
    )


async def provision_tenant_database(
    tenant_id: str,
    database_name: str,
    database_user: str,
    database_password: str,
    admin_email: str,
    admin_password: str | None = None,
) -> dict[str, Any]:
    """
    Provision a new tenant database.

    Creates:
    1. PostgreSQL user
    2. PostgreSQL database
    3. Schema tables
    4. Seed data (predefined phases, default site, admin user)

    Returns dict with admin credentials.
    """
    import traceback

    conn = None
    tenant_conn = None

    try:
        conn = await get_admin_connection()

        # Generate admin password if not provided
        if not admin_password:
            admin_password = generate_password(16)

        admin_password_hash = hash_password(admin_password)

        print(f"Provisioning tenant database: {database_name}")

        # Validate identifiers to prevent SQL injection
        _validate_identifier(database_user)
        _validate_identifier(database_name)
        safe_password = _escape_literal(database_password)

        # Create database user
        try:
            await conn.execute(f"CREATE USER \"{database_user}\" WITH PASSWORD '{safe_password}'")
            print(f"  Created user: {database_user}")
        except asyncpg.DuplicateObjectError:
            # User exists, update password
            await conn.execute(f"ALTER USER \"{database_user}\" WITH PASSWORD '{safe_password}'")
            print(f"  Updated password for existing user: {database_user}")
        except Exception as e:
            print(f"  Error creating user: {e}")
            traceback.print_exc()
            raise

        # Create database
        try:
            await conn.execute(f'CREATE DATABASE "{database_name}" OWNER "{database_user}"')
            print(f"  Created database: {database_name}")
        except asyncpg.DuplicateDatabaseError:
            print(f"  Database already exists: {database_name}")
        except Exception as e:
            print(f"  Error creating database: {e}")
            traceback.print_exc()
            raise

        # Grant privileges
        try:
            await conn.execute(
                f'GRANT ALL PRIVILEGES ON DATABASE "{database_name}" TO "{database_user}"'
            )
        except Exception as e:
            print(f"  Error granting privileges: {e}")
            traceback.print_exc()
            raise

        await conn.close()
        conn = None

        # Connect to the new database to create schema
        settings = get_settings()
        print(f"  Connecting to new database as {database_user}...")
        tenant_conn = await asyncpg.connect(
            host=settings.db_host,
            port=settings.db_port,
            user=database_user,
            password=database_password,
            database=database_name,
        )

        # Create schema
        print("  Creating schema tables...")
        schema_sql = get_tenant_schema_sql()
        await tenant_conn.execute(schema_sql)
        print("  Created schema tables")

        # Seed data
        print("  Seeding initial data...")
        await run_seed_data(tenant_conn, admin_email, admin_password_hash)
        print("  Seeded initial data")

        await tenant_conn.close()
        tenant_conn = None

        print(f"Tenant database provisioned successfully: {database_name}")

        return {
            "database_name": database_name,
            "database_user": database_user,
            "admin_email": admin_email,
            "admin_password": admin_password,
        }

    except Exception as e:
        print(f"PROVISIONING ERROR: {e}")
        traceback.print_exc()
        raise
    finally:
        if conn:
            await conn.close()
        if tenant_conn:
            await tenant_conn.close()


async def drop_tenant_database(
    database_name: str,
    database_user: str,
) -> bool:
    """
    Drop a tenant database and user.

    WARNING: This permanently deletes all tenant data!
    """
    conn = await get_admin_connection()

    try:
        _validate_identifier(database_name)
        _validate_identifier(database_user)

        # Terminate any active connections (parameterized)
        await conn.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
            database_name,
        )

        # Drop database
        await conn.execute(f'DROP DATABASE IF EXISTS "{database_name}"')
        print(f"Dropped database: {database_name}")

        # Drop user
        await conn.execute(f'DROP USER IF EXISTS "{database_user}"')
        print(f"Dropped user: {database_user}")

        return True

    finally:
        await conn.close()


async def reset_tenant_admin_password(
    database_name: str,
    database_user: str,
    database_password: str,
    admin_email: str,
    new_password: str | None = None,
) -> dict[str, str]:
    """
    Reset a tenant admin user's password.

    Returns dict with the new password.
    """
    settings = get_settings()

    # Generate new password if not provided
    if not new_password:
        new_password = generate_password(16)

    password_hash = hash_password(new_password)

    # Connect to tenant database
    conn = await asyncpg.connect(
        host=settings.db_host,
        port=settings.db_port,
        user=database_user,
        password=database_password,
        database=database_name,
    )

    try:
        # Update password (parameterized)
        result = await conn.execute(
            "UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE email = $2",
            password_hash,
            admin_email,
        )

        if result == "UPDATE 0":
            raise ValueError(f"Admin user not found: {admin_email}")

        print(f"Reset password for {admin_email} in {database_name}")

    finally:
        await conn.close()

    return {
        "admin_email": admin_email,
        "admin_password": new_password,
    }


async def test_tenant_connection(
    database_name: str,
    database_user: str,
    database_password: str,
) -> bool:
    """
    Test if we can connect to a tenant database.

    Returns True if connection succeeds.
    """
    settings = get_settings()

    try:
        conn = await asyncpg.connect(
            host=settings.db_host,
            port=settings.db_port,
            user=database_user,
            password=database_password,
            database=database_name,
        )
        await conn.execute("SELECT 1")
        await conn.close()
        return True
    except Exception as e:
        print(f"Connection test failed: {e}")
        return False


async def check_tenant_database(
    database_name: str,
    database_user: str,
    database_password: str,
) -> dict[str, Any]:
    """
    Check tenant database status and health.

    Returns dict with:
    - exists: bool - database exists
    - accessible: bool - can connect with credentials
    - tables: list - list of tables in database
    - user_count: int - number of users
    - project_count: int - number of projects
    """
    settings = get_settings()
    admin_conn = None
    tenant_conn = None

    result = {
        "exists": False,
        "accessible": False,
        "tables": [],
        "user_count": 0,
        "project_count": 0,
        "error": None,
    }

    try:
        # Check if database exists using admin connection
        admin_conn = await get_admin_connection()
        db_check = await admin_conn.fetchval(
            "SELECT 1 FROM pg_database WHERE datname = $1", database_name
        )
        result["exists"] = db_check is not None

        if not result["exists"]:
            result["error"] = "Database does not exist"
            return result

    except Exception as e:
        result["error"] = f"Admin connection failed: {e}"
        return result
    finally:
        if admin_conn:
            await admin_conn.close()

    try:
        # Try to connect with tenant credentials
        tenant_conn = await asyncpg.connect(
            host=settings.db_host,
            port=settings.db_port,
            user=database_user,
            password=database_password,
            database=database_name,
        )
        result["accessible"] = True

        # Get table list
        tables = await tenant_conn.fetch("""
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name
        """)
        table_list: list[str] = [t["table_name"] for t in tables]
        result["tables"] = table_list

        # Get counts if tables exist
        if "users" in table_list:
            result["user_count"] = await tenant_conn.fetchval("SELECT COUNT(*) FROM users")

        if "projects" in table_list:
            result["project_count"] = await tenant_conn.fetchval("SELECT COUNT(*) FROM projects")

    except Exception as e:
        result["error"] = f"Tenant connection failed: {e}"
    finally:
        if tenant_conn:
            await tenant_conn.close()

    return result
