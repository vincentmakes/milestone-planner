#!/bin/bash
# Run migration across all tenant databases
# Usage: ./migrate_all_tenants.sh [migration_file.sql]

# Configuration - adjust these for your environment
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-postgres}"
ADMIN_DB="${ADMIN_DB:-milestone_admin}"

# Migration SQL file (default to company_events migration)
MIGRATION_FILE="${1:-add_company_events.sql}"

# If no file provided, use inline SQL
if [ ! -f "$MIGRATION_FILE" ]; then
    echo "Using inline company_events migration..."
    MIGRATION_SQL="
        CREATE TABLE IF NOT EXISTS company_events (
            id SERIAL PRIMARY KEY,
            site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
            name VARCHAR(255) NOT NULL,
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            description TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_company_events_site_id ON company_events(site_id);
        CREATE INDEX IF NOT EXISTS idx_company_events_dates ON company_events(start_date, end_date);
    "
else
    MIGRATION_SQL=$(cat "$MIGRATION_FILE")
fi

echo "============================================"
echo "Multi-Tenant Migration Script"
echo "============================================"
echo "Host: $PG_HOST:$PG_PORT"
echo "Admin DB: $ADMIN_DB"
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
    
    if psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DB" -c "$MIGRATION_SQL" > /dev/null 2>&1; then
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
