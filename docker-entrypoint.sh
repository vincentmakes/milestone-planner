#!/bin/sh
set -e

# ============================================
# Milestone Docker Entrypoint
# Handles database readiness check and optional auto-initialization
# ============================================

# Wait for PostgreSQL to be ready
wait_for_db() {
    local host="$1"
    local port="$2"
    local max_attempts=30
    local attempt=1

    echo "Waiting for PostgreSQL at ${host}:${port}..."
    while [ $attempt -le $max_attempts ]; do
        if python -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(2)
try:
    s.connect(('${host}', ${port}))
    s.close()
    exit(0)
except:
    exit(1)
" 2>/dev/null; then
            echo "PostgreSQL is ready at ${host}:${port}"
            return 0
        fi
        echo "  Attempt ${attempt}/${max_attempts} - waiting..."
        sleep 2
        attempt=$((attempt + 1))
    done

    echo "ERROR: PostgreSQL not ready after ${max_attempts} attempts"
    return 1
}

# Determine database host/port
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

# Wait for the database
wait_for_db "$DB_HOST" "$DB_PORT"

# Run auto-initialization if AUTO_INIT_DB is set
if [ "${AUTO_INIT_DB}" = "true" ]; then
    echo "Running database auto-initialization..."
    python -m app.scripts.init_db
    echo "Database initialization complete."
fi

# Execute the main command
exec "$@"
