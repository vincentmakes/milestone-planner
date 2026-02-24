#!/usr/bin/env python3
"""
Master Database Migration Runner

Runs migrations against the MASTER database only (not tenant databases).
This is used for migrations that modify the master database schema,
such as adding the organizations table for organization-level SSO.

Usage:
    python migrations/run_migration_master.py <migration_name>
    
Example:
    python migrations/run_migration_master.py add_organizations

Environment Variables:
    MASTER_DB_HOST      - Master database host (defaults to DB_HOST)
    MASTER_DB_PORT      - Master database port (defaults to 5432)
    MASTER_DB_NAME      - Master database name (required, defaults to milestone_admin)
    MASTER_DB_USER      - Master database user (defaults to DB_USER)
    MASTER_DB_PASSWORD  - Master database password (defaults to DB_PASSWORD)
    
For single-tenant mode, it will use the main database settings:
    DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
"""

import os
import sys
import asyncio
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

import asyncpg
from dotenv import load_dotenv

# Load environment variables
load_dotenv()


async def get_db_connection(host: str, port: int, database: str, user: str, password: str):
    """Create a database connection."""
    return await asyncpg.connect(
        host=host,
        port=port,
        database=database,
        user=user,
        password=password
    )


async def run_migration_sql(conn, sql: str, db_name: str):
    """Run migration SQL against a database connection."""
    try:
        # Split SQL into statements and execute each
        # This handles multi-statement migrations better
        statements = sql.split(';')
        for stmt in statements:
            stmt = stmt.strip()
            if stmt and not stmt.startswith('--'):
                await conn.execute(stmt + ';')
        print(f"  ✓ Migration successful on {db_name}")
        return True
    except asyncpg.exceptions.DuplicateTableError as e:
        print(f"  ⊘ Table already exists on {db_name}: {e}")
        return True
    except asyncpg.exceptions.DuplicateObjectError as e:
        print(f"  ⊘ Object already exists on {db_name}: {e}")
        return True
    except asyncpg.exceptions.DuplicateColumnError as e:
        print(f"  ⊘ Column already exists on {db_name}: {e}")
        return True
    except Exception as e:
        print(f"  ✗ Migration failed on {db_name}: {e}")
        return False


async def run_migration(migration_name: str):
    """Run a migration against the master database."""
    
    # Load configuration
    db_host = os.getenv('DB_HOST', 'localhost')
    db_port = int(os.getenv('DB_PORT', '5432'))
    db_user = os.getenv('DB_USER', 'milestone_dev_user')
    db_password = os.getenv('DB_PASSWORD', 'devpassword')
    multi_tenant = os.getenv('MULTI_TENANT', 'false').lower() == 'true'
    
    # Master database settings
    master_db_host = os.getenv('MASTER_DB_HOST', db_host)
    master_db_port = int(os.getenv('MASTER_DB_PORT', str(db_port)))
    master_db_name = os.getenv('MASTER_DB_NAME', 'milestone_admin')
    master_db_user = os.getenv('MASTER_DB_USER', db_user)
    master_db_password = os.getenv('MASTER_DB_PASSWORD', db_password)
    
    # Find migration SQL file
    migrations_dir = Path(__file__).parent
    sql_file = migrations_dir / f"{migration_name}.sql"
    
    if not sql_file.exists():
        print(f"Error: Migration file not found: {sql_file}")
        sys.exit(1)
    
    migration_sql = sql_file.read_text()
    print(f"\n{'='*60}")
    print(f"Running MASTER database migration: {migration_name}")
    print(f"{'='*60}\n")
    
    if multi_tenant:
        print("Mode: Multi-tenant")
        print(f"Master database: {master_db_name} @ {master_db_host}:{master_db_port}")
        target_db = master_db_name
        target_host = master_db_host
        target_port = master_db_port
        target_user = master_db_user
        target_password = master_db_password
    else:
        # In single-tenant mode, use the main database
        print("Mode: Single-tenant")
        db_name = os.getenv('DB_NAME', 'milestone_dev')
        print(f"Database: {db_name} @ {db_host}:{db_port}")
        target_db = db_name
        target_host = db_host
        target_port = db_port
        target_user = db_user
        target_password = db_password
    
    print()
    
    try:
        conn = await get_db_connection(
            target_host, target_port, target_db, target_user, target_password
        )
        
        success = await run_migration_sql(conn, migration_sql, target_db)
        await conn.close()
        
    except Exception as e:
        print(f"  ✗ Connection failed: {e}")
        success = False
    
    # Summary
    print(f"\n{'='*60}")
    if success:
        print(f"Migration complete: SUCCESS")
    else:
        print(f"Migration complete: FAILED")
    print(f"{'='*60}\n")
    
    if not success:
        sys.exit(1)


def main():
    if len(sys.argv) < 2:
        print("Usage: python run_migration_master.py <migration_name>")
        print("\nThis runs migrations on the MASTER database only.")
        print("For tenant database migrations, use run_migration.py instead.")
        print("\nAvailable migrations:")
        migrations_dir = Path(__file__).parent
        for sql_file in sorted(migrations_dir.glob("*.sql")):
            print(f"  - {sql_file.stem}")
        sys.exit(1)
    
    migration_name = sys.argv[1]
    
    # Remove .sql extension if provided
    if migration_name.endswith('.sql'):
        migration_name = migration_name[:-4]
    
    asyncio.run(run_migration(migration_name))


if __name__ == "__main__":
    main()
