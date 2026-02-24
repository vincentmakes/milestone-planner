#!/usr/bin/env python3
"""
Automated Migration Runner

Runs migrations against:
- Single-tenant: The main database
- Multi-tenant: All active tenant databases

Usage:
    python migrations/run_migration.py <migration_name>
    
Example:
    python migrations/run_migration.py add_company_events
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
        await conn.execute(sql)
        print(f"  ✓ Migration successful on {db_name}")
        return True
    except asyncpg.exceptions.DuplicateTableError:
        print(f"  ⊘ Table already exists on {db_name} (skipped)")
        return True
    except asyncpg.exceptions.DuplicateObjectError:
        print(f"  ⊘ Object already exists on {db_name} (skipped)")
        return True
    except Exception as e:
        print(f"  ✗ Migration failed on {db_name}: {e}")
        return False


async def get_tenant_databases(master_conn) -> list[dict]:
    """Get all active tenant databases from master database."""
    try:
        rows = await master_conn.fetch("""
            SELECT t.id, t.slug, t.database_name, t.database_user, tc.encrypted_password
            FROM tenants t
            LEFT JOIN tenant_credentials tc ON t.id = tc.tenant_id
            WHERE t.status = 'active'
            ORDER BY t.slug
        """)
        return [dict(row) for row in rows]
    except asyncpg.exceptions.UndefinedTableError:
        # Not a multi-tenant setup or master DB doesn't have tenants table
        return []


def decrypt_password(encrypted_str: str, key: bytes) -> str:
    """Decrypt tenant database password.
    
    Format: iv:authTag:ciphertext (all hex encoded)
    """
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    
    parts = encrypted_str.split(':')
    if len(parts) != 3:
        raise ValueError(f"Invalid encrypted password format: expected 3 parts, got {len(parts)}")
    
    iv = bytes.fromhex(parts[0])
    auth_tag = bytes.fromhex(parts[1])
    ciphertext = bytes.fromhex(parts[2])
    
    aesgcm = AESGCM(key)
    # GCM expects ciphertext + tag concatenated
    plaintext = aesgcm.decrypt(iv, ciphertext + auth_tag, None)
    return plaintext.decode()


async def run_migration(migration_name: str):
    """Run a migration against all relevant databases."""
    
    # Load configuration
    db_host = os.getenv('DB_HOST', 'localhost')
    db_port = int(os.getenv('DB_PORT', '5432'))
    db_name = os.getenv('DB_NAME', 'milestone_dev')
    db_user = os.getenv('DB_USER', 'milestone_dev_user')
    db_password = os.getenv('DB_PASSWORD', 'devpassword')
    multi_tenant = os.getenv('MULTI_TENANT', 'false').lower() == 'true'
    
    # Master database settings (for multi-tenant mode)
    master_db_name = os.getenv('MASTER_DB_NAME', 'milestone_admin')
    master_db_host = os.getenv('MASTER_DB_HOST', db_host)
    master_db_port = int(os.getenv('MASTER_DB_PORT', db_port))
    master_db_user = os.getenv('MASTER_DB_USER', db_user)
    master_db_password = os.getenv('MASTER_DB_PASSWORD', db_password)
    
    # PostgreSQL admin credentials (for running migrations on all databases)
    # This user needs access to all tenant databases
    pg_admin_user = os.getenv('PG_ADMIN_USER')
    pg_admin_password = os.getenv('PG_ADMIN_PASSWORD')
    
    encryption_key_hex = os.getenv('TENANT_ENCRYPTION_KEY', '')
    
    # Find migration SQL file
    migrations_dir = Path(__file__).parent
    sql_file = migrations_dir / f"{migration_name}.sql"
    
    if not sql_file.exists():
        print(f"Error: Migration file not found: {sql_file}")
        sys.exit(1)
    
    migration_sql = sql_file.read_text()
    print(f"\n{'='*60}")
    print(f"Running migration: {migration_name}")
    print(f"{'='*60}\n")
    
    success_count = 0
    fail_count = 0
    
    if multi_tenant:
        print("Mode: Multi-tenant")
        print(f"Master database: {master_db_name} @ {master_db_host}")
        print()
        
        # Connect to master database to get tenant list
        try:
            master_conn = await get_db_connection(
                master_db_host, master_db_port, master_db_name, master_db_user, master_db_password
            )
        except Exception as e:
            print(f"Error connecting to master database: {e}")
            sys.exit(1)
        
        tenants = await get_tenant_databases(master_conn)
        await master_conn.close()
        
        if not tenants:
            print("No active tenants found.")
            return
        
        print(f"Found {len(tenants)} active tenant(s)\n")
        
        # Determine which credentials to use for tenant databases
        # Priority: PG_ADMIN > decrypted tenant password > fallback
        use_pg_admin = pg_admin_user and pg_admin_password
        
        if use_pg_admin:
            print(f"Using PG admin credentials ({pg_admin_user}) for all tenant databases\n")
        else:
            # Try to decrypt tenant passwords
            encryption_key = None
            if encryption_key_hex:
                try:
                    encryption_key = bytes.fromhex(encryption_key_hex)
                    print("TENANT_ENCRYPTION_KEY loaded for password decryption\n")
                except ValueError:
                    print("Warning: Invalid TENANT_ENCRYPTION_KEY format\n")
            else:
                print("Warning: No TENANT_ENCRYPTION_KEY set - will use fallback credentials\n")
        
        # Run migration on each tenant database
        for tenant in tenants:
            print(f"Tenant: {tenant['slug']} ({tenant['database_name']})")
            
            # Determine credentials to use
            if use_pg_admin:
                # Use PostgreSQL admin credentials (has access to all databases)
                connect_user = pg_admin_user
                connect_password = pg_admin_password
            else:
                # Try to use tenant-specific credentials
                connect_user = tenant.get('database_user') or db_user
                connect_password = db_password  # Default fallback
                
                if tenant.get('encrypted_password') and encryption_key:
                    try:
                        # Format is iv:authTag:ciphertext (hex encoded)
                        connect_password = decrypt_password(
                            tenant['encrypted_password'],
                            encryption_key
                        )
                        print(f"  (using decrypted password)")
                    except Exception as e:
                        print(f"  Warning: Could not decrypt password: {e}")
                        print(f"  (using fallback password)")
                elif not tenant.get('encrypted_password'):
                    print(f"  (no encrypted password stored, using fallback)")
            
            try:
                conn = await get_db_connection(
                    db_host, db_port,
                    tenant['database_name'],
                    connect_user,
                    connect_password
                )
                
                if await run_migration_sql(conn, migration_sql, tenant['database_name']):
                    success_count += 1
                else:
                    fail_count += 1
                
                await conn.close()
                
            except Exception as e:
                print(f"  ✗ Connection failed: {e}")
                fail_count += 1
    
    else:
        print("Mode: Single-tenant")
        print(f"Database: {db_name}")
        print()
        
        try:
            conn = await get_db_connection(db_host, db_port, db_name, db_user, db_password)
            
            if await run_migration_sql(conn, migration_sql, db_name):
                success_count += 1
            else:
                fail_count += 1
            
            await conn.close()
            
        except Exception as e:
            print(f"  ✗ Connection failed: {e}")
            fail_count += 1
    
    # Summary
    print(f"\n{'='*60}")
    print(f"Migration complete: {success_count} succeeded, {fail_count} failed")
    print(f"{'='*60}\n")
    
    if fail_count > 0:
        sys.exit(1)


def main():
    if len(sys.argv) < 2:
        print("Usage: python run_migration.py <migration_name>")
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
