#!/bin/sh
set -e

# ============================================
# Milestone Docker Entrypoint
# Handles database readiness check and optional auto-initialization
# ============================================

# Wait for PostgreSQL to be ready (best-effort, non-fatal)
wait_for_db() {
    local host="$1"
    local port="$2"
    local max_attempts=15
    local attempt=1

    echo "Waiting for PostgreSQL at ${host}:${port}..."
    while [ $attempt -le $max_attempts ]; do
        if python -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(3)
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

    echo "WARNING: PostgreSQL not ready after ${max_attempts} attempts, starting app anyway..."
    return 0
}

# Determine database host/port
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

# Wait for the database (non-fatal: app starts regardless)
wait_for_db "$DB_HOST" "$DB_PORT"

# Run auto-initialization if AUTO_INIT_DB is set
if [ "${AUTO_INIT_DB}" = "true" ]; then
    echo "Running database auto-initialization..."
    if python -m app.scripts.init_db; then
        echo "Database initialization complete."
    else
        echo "ERROR: Database initialization failed (exit code $?). Starting app anyway..."
    fi
fi

# Execute the main command
exec "$@"
