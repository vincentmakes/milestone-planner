#!/usr/bin/env python3
"""
Milestone Fresh Install Script

Automates the complete setup of a new Milestone installation:
1. Creates master database
2. Creates dev database (optional)
3. Sets up admin user with password
4. Generates .env file if needed
5. Runs initial migrations

Usage:
    python scripts/fresh_install.py [options]

Options:
    --pg-host       PostgreSQL host (default: localhost)
    --pg-port       PostgreSQL port (default: 5432)
    --pg-user       PostgreSQL admin user (default: postgres)
    --pg-password   PostgreSQL admin password (prompted if not provided)
    --admin-email   Admin email (default: admin@milestone.app)
    --admin-pass    Admin password (prompted if not provided)
    --skip-dev      Skip creating development database
    --skip-env      Skip .env file generation
    --force         Drop existing databases without prompting

Example:
    python scripts/fresh_install.py --pg-user postgres --pg-password mypass
"""

import argparse
import getpass
import secrets
import sys
import os
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))


def check_dependencies():
    """Check that required packages are installed."""
    missing = []
    
    try:
        import psycopg2
    except ImportError:
        missing.append("psycopg2-binary")
    
    if missing:
        print("❌ Missing required packages:")
        for pkg in missing:
            print(f"   - {pkg}")
        print(f"\nInstall with: pip install {' '.join(missing)}")
        sys.exit(1)


def connect_postgres(host: str, port: int, user: str, password: str, dbname: str = "postgres"):
    """Connect to PostgreSQL."""
    import psycopg2
    return psycopg2.connect(
        host=host,
        port=port,
        user=user,
        password=password,
        dbname=dbname
    )


def database_exists(conn, dbname: str) -> bool:
    """Check if a database exists."""
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (dbname,))
    exists = cur.fetchone() is not None
    cur.close()
    return exists


def create_database(conn, dbname: str):
    """Create a database."""
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute(f'CREATE DATABASE "{dbname}"')
    cur.close()
    conn.autocommit = False


def drop_database(conn, dbname: str):
    """Drop a database."""
    conn.autocommit = True
    cur = conn.cursor()
    # Terminate existing connections
    cur.execute(f"""
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = %s
        AND pid <> pg_backend_pid()
    """, (dbname,))
    cur.execute(f'DROP DATABASE IF EXISTS "{dbname}"')
    cur.close()
    conn.autocommit = False


def run_sql_file(host: str, port: int, user: str, password: str, dbname: str, sql_content: str):
    """Run SQL statements on a database."""
    import psycopg2
    conn = psycopg2.connect(
        host=host,
        port=port,
        user=user,
        password=password,
        dbname=dbname
    )
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute(sql_content)
    cur.close()
    conn.close()


def get_master_schema() -> str:
    """Get the master database schema SQL."""
    return """
    -- Enable UUID extension
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    
    -- Tenants registry
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    
    -- Tenant credentials
    CREATE TABLE IF NOT EXISTS tenant_credentials (
        tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        encrypted_password TEXT NOT NULL,
        password_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    
    -- Tenant audit log
    CREATE TABLE IF NOT EXISTS tenant_audit_log (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        action VARCHAR(50) NOT NULL,
        actor VARCHAR(255),
        details JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    
    -- Admin users
    CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name VARCHAR(255),
        role VARCHAR(20) DEFAULT 'admin',
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
    );
    
    -- Admin sessions
    CREATE TABLE IF NOT EXISTS admin_sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired BIGINT NOT NULL
    );
    
    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expired ON admin_sessions(expired);
    CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
    CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
    CREATE INDEX IF NOT EXISTS idx_tenant_audit_log_tenant ON tenant_audit_log(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_tenant_audit_log_created ON tenant_audit_log(created_at DESC);
    """


def get_password_hash(password: str) -> str:
    """
    Generate password hash using PBKDF2-SHA512.
    Compatible with app.services.encryption.hash_password()
    """
    import hashlib
    # Generate random salt (16 bytes = 32 hex chars)
    salt = secrets.token_hex(16)
    # Hash with PBKDF2 (10000 iterations, 64 bytes output, SHA-512)
    hash_bytes = hashlib.pbkdf2_hmac(
        'sha512',
        password.encode('utf-8'),
        salt.encode('utf-8'),
        10000,  # Must match app/services/encryption.py
        dklen=64
    )
    return f"{salt}:{hash_bytes.hex()}"


def create_admin_user(host: str, port: int, user: str, password: str, 
                      dbname: str, admin_email: str, admin_password_hash: str):
    """Create admin user in master database."""
    import psycopg2
    conn = psycopg2.connect(
        host=host, port=port, user=user, password=password, dbname=dbname
    )
    cur = conn.cursor()
    
    # Check if user exists
    cur.execute("SELECT id FROM admin_users WHERE email = %s", (admin_email,))
    if cur.fetchone():
        cur.execute(
            "UPDATE admin_users SET password_hash = %s WHERE email = %s",
            (admin_password_hash, admin_email)
        )
    else:
        cur.execute(
            """
            INSERT INTO admin_users (email, password_hash, name, role, active)
            VALUES (%s, %s, 'System Admin', 'superadmin', 1)
            """,
            (admin_email, admin_password_hash)
        )
    
    conn.commit()
    cur.close()
    conn.close()


def generate_env_file(pg_host: str, pg_port: int, pg_user: str) -> str:
    """Generate .env file content.

    Note: Database passwords are not written to the file.
    The user must set them manually or via environment variables.
    """
    session_secret = secrets.token_hex(32)

    return f"""# Milestone Configuration
# Generated by fresh_install.py
# IMPORTANT: Set all password fields below before starting the application.

# Application
DEBUG=false
PORT=8485

# Multi-tenant mode
MULTI_TENANT=true

# Master database (stores tenant registry)
MASTER_DB_HOST={pg_host}
MASTER_DB_PORT={pg_port}
MASTER_DB_NAME=milestone_master
MASTER_DB_USER={pg_user}
MASTER_DB_PASSWORD=<SET_YOUR_PASSWORD_HERE>

# Default database settings (template for tenants)
DB_HOST={pg_host}
DB_PORT={pg_port}
DB_NAME=milestone_dev
DB_USER={pg_user}
DB_PASSWORD=<SET_YOUR_PASSWORD_HERE>

# PostgreSQL admin credentials (for auto-provisioning)
PG_ADMIN_USER={pg_user}
PG_ADMIN_PASSWORD=<SET_YOUR_PASSWORD_HERE>

# Session secret
SESSION_SECRET={session_secret}

# Timezone
TZ=Europe/Zurich
"""


def main():
    parser = argparse.ArgumentParser(
        description="Milestone Fresh Install - Automated Setup"
    )
    parser.add_argument("--pg-host", default="localhost", help="PostgreSQL host")
    parser.add_argument("--pg-port", type=int, default=5432, help="PostgreSQL port")
    parser.add_argument("--pg-user", default="postgres", help="PostgreSQL admin user")
    parser.add_argument("--pg-password", help="PostgreSQL admin password")
    parser.add_argument("--admin-email", default="admin@milestone.app", help="Admin email")
    parser.add_argument("--admin-pass", help="Admin password")
    parser.add_argument("--skip-dev", action="store_true", help="Skip dev database")
    parser.add_argument("--skip-env", action="store_true", help="Skip .env generation")
    parser.add_argument("--force", action="store_true", help="Drop existing without prompting")
    
    args = parser.parse_args()
    
    print("\n" + "=" * 60)
    print("MILESTONE - FRESH INSTALL")
    print("=" * 60 + "\n")
    
    # Check dependencies
    check_dependencies()
    
    # Get PostgreSQL password
    pg_password = args.pg_password
    if not pg_password:
        pg_password = getpass.getpass("PostgreSQL password: ")
    
    # Get admin password
    admin_password = args.admin_pass
    if not admin_password:
        admin_password = getpass.getpass("Admin password for Milestone: ")
        confirm = getpass.getpass("Confirm admin password: ")
        if admin_password != confirm:
            print("❌ Passwords do not match!")
            sys.exit(1)
    
    if len(admin_password) < 8:
        print("❌ Admin password must be at least 8 characters!")
        sys.exit(1)
    
    # Connect to PostgreSQL
    print(f"\n📡 Connecting to PostgreSQL at {args.pg_host}:{args.pg_port}...")
    try:
        conn = connect_postgres(args.pg_host, args.pg_port, args.pg_user, pg_password)
        print("   ✅ Connected successfully")
    except Exception as e:
        print(f"   ❌ Connection failed: {e}")
        sys.exit(1)
    
    # Check for existing databases
    databases = ["milestone_master"]
    if not args.skip_dev:
        databases.append("milestone_dev")
    
    existing = [db for db in databases if database_exists(conn, db)]
    
    if existing and not args.force:
        print(f"\n⚠️  The following databases already exist: {', '.join(existing)}")
        response = input("Drop and recreate? (yes/no): ")
        if response.lower() != 'yes':
            print("Aborted.")
            sys.exit(0)
    
    # Drop existing databases
    for db in existing:
        print(f"\n🗑️  Dropping database: {db}")
        drop_database(conn, db)
        print("   ✅ Dropped")
    
    # Create databases
    for db in databases:
        print(f"\n📦 Creating database: {db}")
        create_database(conn, db)
        print("   ✅ Created")
    
    conn.close()
    
    # Set up master database schema
    print("\n🔧 Setting up master database schema...")
    run_sql_file(
        args.pg_host, args.pg_port, args.pg_user, pg_password,
        "milestone_master",
        get_master_schema()
    )
    print("   ✅ Schema created")
    
    # Create admin user
    print("\n👤 Creating admin user...")
    admin_hash = get_password_hash(admin_password)
    create_admin_user(
        args.pg_host, args.pg_port, args.pg_user, pg_password,
        "milestone_master",
        args.admin_email,
        admin_hash
    )
    print(f"   ✅ Admin user created: {args.admin_email}")
    
    # Generate .env file
    if not args.skip_env:
        env_path = Path(__file__).parent.parent / ".env"
        
        if env_path.exists():
            print(f"\n⚠️  .env file already exists at: {env_path}")
            response = input("Overwrite? (yes/no): ")
            if response.lower() != 'yes':
                print("   Skipping .env generation")
            else:
                env_content = generate_env_file(
                    args.pg_host, args.pg_port, args.pg_user
                )
                env_path.write_text(env_content)
                print(f"   ✅ .env file updated")
                print("   ⚠️  Remember to set the database passwords in .env")
        else:
            print(f"\n📝 Generating .env file...")
            env_content = generate_env_file(
                args.pg_host, args.pg_port, args.pg_user
            )
            env_path.write_text(env_content)
            print(f"   ✅ .env file created at: {env_path}")
            print("   ⚠️  Remember to set the database passwords in .env")
    
    # Summary
    print("\n" + "=" * 60)
    print("INSTALLATION COMPLETE!")
    print("=" * 60)
    print(f"""
Databases created:
  - milestone_master (tenant registry)
  {"- milestone_dev (development)" if not args.skip_dev else ""}

Admin credentials:
  Email:    {args.admin_email}
  Password: {'*' * len(admin_password)}

Next steps:
  1. Start the application:
     uvicorn app.main:app --host 127.0.0.1 --port 8485

  2. Access admin panel:
     http://localhost:8485/admin/

  3. Create your first tenant from the admin panel

  4. Access tenant at:
     http://localhost:8485/t/{{tenant-slug}}/
""")


if __name__ == "__main__":
    main()
