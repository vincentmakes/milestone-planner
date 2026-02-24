#!/usr/bin/env python3
"""
Migrate All Tenants Database Script

This script runs Alembic migrations on all active tenant databases.
Run this after deploying code that includes database schema changes.

Usage:
    python scripts/migrate_all_tenants.py [--dry-run] [--tenant SLUG]

Options:
    --dry-run       Show what would be migrated without executing
    --tenant SLUG   Migrate only a specific tenant
    --include-master  Also migrate the master database

Examples:
    # Migrate all tenants
    python scripts/migrate_all_tenants.py

    # Preview what would be migrated
    python scripts/migrate_all_tenants.py --dry-run

    # Migrate specific tenant
    python scripts/migrate_all_tenants.py --tenant acme-corp

    # Migrate everything including master
    python scripts/migrate_all_tenants.py --include-master
"""

import argparse
import asyncio
import sys
import os
from pathlib import Path
from datetime import datetime

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import text, create_engine
from sqlalchemy.ext.asyncio import create_async_engine
from alembic.config import Config
from alembic import command
from alembic.script import ScriptDirectory
from alembic.runtime.migration import MigrationContext


def get_settings():
    """Load settings from environment."""
    from app.config import get_settings
    return get_settings()


def get_master_db_url(settings) -> str:
    """Get master database URL."""
    host = settings.master_db_host or settings.db_host
    user = settings.master_db_user or settings.db_user
    password = settings.master_db_password or settings.db_password
    port = settings.master_db_port
    name = settings.master_db_name
    return f"postgresql://{user}:{password}@{host}:{port}/{name}"


def get_tenant_db_url(settings, database_name: str) -> str:
    """Get tenant database URL."""
    host = settings.db_host
    user = settings.pg_admin_user or settings.db_user
    password = settings.pg_admin_password or settings.db_password
    port = settings.db_port
    return f"postgresql://{user}:{password}@{host}:{port}/{database_name}"


async def get_all_tenants(settings):
    """Fetch all active tenants from master database."""
    url = get_master_db_url(settings).replace("postgresql://", "postgresql+asyncpg://")
    engine = create_async_engine(url)
    
    try:
        async with engine.connect() as conn:
            result = await conn.execute(
                text("SELECT slug, database_name, status FROM tenants ORDER BY slug")
            )
            return result.fetchall()
    finally:
        await engine.dispose()


def get_current_revision(db_url: str) -> str | None:
    """Get the current Alembic revision for a database."""
    try:
        engine = create_engine(db_url)
        with engine.connect() as conn:
            context = MigrationContext.configure(conn)
            return context.get_current_revision()
    except Exception:
        return None


def get_head_revision() -> str:
    """Get the head revision from Alembic scripts."""
    alembic_cfg = Config("alembic.ini")
    script = ScriptDirectory.from_config(alembic_cfg)
    return script.get_current_head()


def run_migrations(db_url: str, revision: str = "head") -> tuple[bool, str]:
    """
    Run Alembic migrations for a specific database.
    Returns (success, message).
    """
    try:
        alembic_cfg = Config("alembic.ini")
        alembic_cfg.set_main_option("sqlalchemy.url", db_url)
        
        command.upgrade(alembic_cfg, revision)
        return True, "Success"
    except Exception as e:
        return False, str(e)


def print_status(slug: str, db_name: str, status: str, current_rev: str | None, 
                 head_rev: str, needs_migration: bool, dry_run: bool = False):
    """Print formatted status for a tenant."""
    if status != 'active':
        status_icon = "⏸️"
        status_text = f"Skipped (status: {status})"
    elif not needs_migration:
        status_icon = "✅"
        status_text = "Up to date"
    elif dry_run:
        status_icon = "🔄"
        status_text = f"Would migrate: {current_rev or 'None'} → {head_rev}"
    else:
        status_icon = "🔄"
        status_text = f"Migrating: {current_rev or 'None'} → {head_rev}"
    
    print(f"  {status_icon} {slug:<20} ({db_name:<30}) - {status_text}")


async def main():
    parser = argparse.ArgumentParser(
        description="Migrate all tenant databases to latest schema version"
    )
    parser.add_argument(
        "--dry-run", 
        action="store_true",
        help="Show what would be migrated without executing"
    )
    parser.add_argument(
        "--tenant",
        type=str,
        help="Migrate only a specific tenant by slug"
    )
    parser.add_argument(
        "--include-master",
        action="store_true",
        help="Also migrate the master database"
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Show detailed output"
    )
    
    args = parser.parse_args()
    
    print("\n" + "=" * 60)
    print("MILESTONE - TENANT DATABASE MIGRATION")
    print("=" * 60)
    print(f"Started at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    if args.dry_run:
        print("Mode: DRY RUN (no changes will be made)")
    print()
    
    # Load settings
    try:
        settings = get_settings()
    except Exception as e:
        print(f"❌ Error loading settings: {e}")
        print("   Make sure you have a valid .env file")
        sys.exit(1)
    
    if not settings.multi_tenant:
        print("⚠️  Multi-tenant mode is not enabled.")
        print("   Set MULTI_TENANT=true in your .env file")
        print()
        print("   For single-tenant mode, run:")
        print("   alembic upgrade head")
        sys.exit(1)
    
    # Get head revision
    try:
        head_rev = get_head_revision()
        print(f"Target revision: {head_rev}")
    except Exception as e:
        print(f"❌ Error reading Alembic scripts: {e}")
        sys.exit(1)
    
    # Migrate master database if requested
    if args.include_master:
        print("\n📦 Master Database:")
        master_url = get_master_db_url(settings)
        current_rev = get_current_revision(master_url)
        needs_migration = current_rev != head_rev
        
        if needs_migration and not args.dry_run:
            success, message = run_migrations(master_url)
            if success:
                print(f"  ✅ milestone_master - Migrated successfully")
            else:
                print(f"  ❌ milestone_master - Failed: {message}")
        else:
            status = "Would migrate" if needs_migration else "Up to date"
            icon = "🔄" if needs_migration else "✅"
            print(f"  {icon} milestone_master - {status}")
    
    # Get all tenants
    print("\n📋 Fetching tenants...")
    try:
        tenants = await get_all_tenants(settings)
    except Exception as e:
        print(f"❌ Error fetching tenants: {e}")
        sys.exit(1)
    
    if not tenants:
        print("   No tenants found in database")
        sys.exit(0)
    
    # Filter by specific tenant if requested
    if args.tenant:
        tenants = [t for t in tenants if t[0] == args.tenant]
        if not tenants:
            print(f"❌ Tenant '{args.tenant}' not found")
            sys.exit(1)
    
    print(f"   Found {len(tenants)} tenant(s)")
    
    # Process tenants
    print("\n🔄 Processing tenants:")
    
    success_count = 0
    skip_count = 0
    fail_count = 0
    uptodate_count = 0
    
    for slug, db_name, status in tenants:
        if status != 'active':
            print_status(slug, db_name, status, None, head_rev, False)
            skip_count += 1
            continue
        
        db_url = get_tenant_db_url(settings, db_name)
        current_rev = get_current_revision(db_url)
        needs_migration = current_rev != head_rev
        
        if not needs_migration:
            print_status(slug, db_name, status, current_rev, head_rev, False)
            uptodate_count += 1
            continue
        
        if args.dry_run:
            print_status(slug, db_name, status, current_rev, head_rev, True, dry_run=True)
            success_count += 1
        else:
            print_status(slug, db_name, status, current_rev, head_rev, True)
            success, message = run_migrations(db_url)
            
            if success:
                success_count += 1
                if args.verbose:
                    print(f"       → Completed successfully")
            else:
                fail_count += 1
                print(f"       ❌ Error: {message}")
    
    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Total tenants:    {len(tenants)}")
    print(f"  Already current:  {uptodate_count}")
    if args.dry_run:
        print(f"  Would migrate:    {success_count}")
    else:
        print(f"  Migrated:         {success_count}")
        print(f"  Failed:           {fail_count}")
    print(f"  Skipped:          {skip_count}")
    print()
    
    if fail_count > 0:
        print("⚠️  Some migrations failed. Check the errors above.")
        sys.exit(1)
    elif args.dry_run and success_count > 0:
        print("ℹ️  Run without --dry-run to apply migrations.")
    else:
        print("✅ All migrations completed successfully!")
    
    print()


if __name__ == "__main__":
    asyncio.run(main())
