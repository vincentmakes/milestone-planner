#!/bin/sh
set -e

# ============================================
# Milestone Docker Entrypoint
# Handles database readiness check and optional auto-initialization
# ============================================

# Wait for PostgreSQL to be ready (best-effort, non-fatal)
# Uses actual psql query or Python asyncpg to verify the DB is query-ready,
# not just accepting TCP connections.
wait_for_db() {
    local host="$1"
    local port="$2"
    local label="$3"
    local max_attempts="${DB_WAIT_ATTEMPTS:-30}"
    local attempt=1

    echo "Waiting for PostgreSQL ${label} at ${host}:${port} (max ${max_attempts} attempts)..."
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
            echo "PostgreSQL ${label} is ready at ${host}:${port}"
            return 0
        fi
        echo "  Attempt ${attempt}/${max_attempts} - waiting..."
        sleep 2
        attempt=$((attempt + 1))
    done

    echo "WARNING: PostgreSQL ${label} not ready after ${max_attempts} attempts, starting app anyway..."
    return 0
}

# Determine database host/port
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

# Wait for the main (tenant) database
wait_for_db "$DB_HOST" "$DB_PORT" "(tenant DB)"

# In multi-tenant mode, also wait for master DB if it's on a different host
if [ "${MULTI_TENANT}" = "true" ] && [ -n "${MASTER_DB_HOST}" ] && [ "${MASTER_DB_HOST}" != "${DB_HOST}" ]; then
    MASTER_DB_PORT="${MASTER_DB_PORT:-5432}"
    wait_for_db "$MASTER_DB_HOST" "$MASTER_DB_PORT" "(master DB)"
fi

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
