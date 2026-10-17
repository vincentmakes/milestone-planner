#!/bin/bash
# Run one migration file across all active tenant databases (pure psql).
# Usage: ./migrate_all_tenants.sh <migration_file.sql>
#
# The file argument is required. (An older version fell back to an inline
# company_events definition of the wrong shape when no file was given.)
# Prefer `python migrations/run_migration.py <name>`, which also handles
# per-tenant credentials; this loop is for environments where Python is
# impractical.

# Configuration - adjust these for your environment
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-postgres}"
ADMIN_DB="${ADMIN_DB:-${MASTER_DB_NAME:-milestone_master}}"

MIGRATION_FILE="$1"

if [ -z "$MIGRATION_FILE" ]; then
    echo "Usage: $0 <migration_file.sql>" >&2
    echo "Available migrations:" >&2
    ls "$(dirname "$0")"/*.sql >&2
    exit 2
fi

if [ ! -f "$MIGRATION_FILE" ]; then
    echo "Migration file not found: $MIGRATION_FILE" >&2
    exit 2
fi

echo "============================================"
echo "Multi-Tenant Migration Script"
echo "============================================"
echo "Host: $PG_HOST:$PG_PORT"
echo "Admin DB: $ADMIN_DB"
echo "Migration: $MIGRATION_FILE"
echo ""

# Get list of active tenant databases
TENANT_DBS=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$ADMIN_DB" -t -A -c \
    "SELECT database_name FROM tenants WHERE status = 'active' ORDER BY slug;")

if [ -z "$TENANT_DBS" ]; then
    echo "No active tenants found!"
    exit 1
fi

# Count tenants
TENANT_COUNT=$(echo "$TENANT_DBS" | wc -l)
echo "Found $TENANT_COUNT active tenant(s)"
echo ""

# Run migration on each tenant database
SUCCESS=0
FAILED=0

for DB in $TENANT_DBS; do
    echo -n "Migrating $DB... "
    
    if psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DB" -v ON_ERROR_STOP=1 \
        -f "$MIGRATION_FILE" > /dev/null 2>&1; then
        echo "✓ OK"
        ((SUCCESS++))
    else
        echo "✗ FAILED"
        ((FAILED++))
    fi
done

echo ""
echo "============================================"
echo "Migration Complete"
echo "  Success: $SUCCESS"
echo "  Failed:  $FAILED"
echo "============================================"
