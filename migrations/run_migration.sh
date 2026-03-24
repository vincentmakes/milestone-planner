#!/bin/bash
# Run database migrations
# Usage: ./run_migration.sh <migration_name>
#
# Examples:
#   ./run_migration.sh add_company_events
#   
# From Docker:
#   docker exec -it milestone python /app/migrations/run_migration.py add_company_events

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$1" ]; then
    echo "Usage: $0 <migration_name>"
    echo ""
    echo "Available migrations:"
    for f in "$SCRIPT_DIR"/*.sql; do
        [ -f "$f" ] && echo "  - $(basename "${f%.sql}")"
    done
    exit 1
fi

cd "$SCRIPT_DIR/.."
python -m migrations.run_migration "$1"
