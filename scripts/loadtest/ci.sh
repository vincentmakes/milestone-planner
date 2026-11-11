#!/usr/bin/env bash
# The load-test suite the CI job runs (.github/workflows/backend.yml, job
# "Load test"), runnable locally the same way -- see scripts/loadtest/README.md.
#
# Needs: a PostgreSQL reachable with the DB_* / PG_ADMIN_* variables, the
# backend requirements installed, SESSION_SECRET, INIT_ADMIN_PASSWORD (also
# used as LOADTEST_ADMIN_PASSWORD). Creates and initialises two databases,
# ${LOADTEST_DB_PREFIX}_pilot and ${LOADTEST_DB_PREFIX}_stress (app.scripts.init_db).
#
#   1. pool of one: a server with DB_POOL_SIZE=1 DB_POOL_MAX_OVERFLOW=0
#      DB_POOL_TIMEOUT=5; the pilot workspace is seeded through it (every
#      seeding write runs on one connection) and the journey runs
#      (journey.py: no non-2xx, no request over 3 s);
#   2. pilot: the default pool, 28 browsers (each signed in as its own user)
#      x 6 connections, full startup at once, then a write burst with every
#      browser's refetch;
#   3. stress: the stress workspace, 10 browsers x 6 connections + 1 browser
#      with unlimited connections.
#
# Each server's log must not contain "QueuePool limit" (a request waited for
# a pooled connection until DB_POOL_TIMEOUT) nor "could not be written" /
# "Change notifications failed" (a derived write lost, e.g. for want of a
# second connection). Any failure exits non-zero; logs stay in $LOADTEST_LOG_DIR.
set -euo pipefail

cd "$(dirname "$0")/../.."
PYTHON=${PYTHON:-python}
PORT=${LOADTEST_PORT:-8485}
PREFIX=${LOADTEST_DB_PREFIX:-milestone_loadtest}
LOG_DIR=${LOADTEST_LOG_DIR:-loadtest-logs}
export LOADTEST_BASE_URL="http://127.0.0.1:${PORT}"
export LOADTEST_ADMIN_PASSWORD=${LOADTEST_ADMIN_PASSWORD:-${INIT_ADMIN_PASSWORD:?set INIT_ADMIN_PASSWORD}}
export MULTI_TENANT=false AUTO_INIT_DB=true
mkdir -p "$LOG_DIR"
SERVER_PID=""

use_database() {
  export DB_NAME="${PREFIX}_$1" DB_USER="${PREFIX}_$1"
  export DB_PASSWORD=${LOADTEST_DB_PASSWORD:-loadtest-db-password}
  "$PYTHON" -m app.scripts.init_db >"$LOG_DIR/init_$1.log" 2>&1 || {
    cat "$LOG_DIR/init_$1.log"
    exit 1
  }
}

start_server() { # <log name> [VAR=value ...]
  local log="$LOG_DIR/$1.log"
  shift
  env "$@" "$PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT" >"$log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    if curl -sf --noproxy '*' "$LOADTEST_BASE_URL/health" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "server did not start"
  cat "$log"
  exit 1
}

stop_server() { # <log name>
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
  if grep -E "QueuePool limit|could not be written|Change notifications failed" "$LOG_DIR/$1.log"; then
    echo "FAIL: the server log of '$1' shows a pool timeout or a lost derived write"
    exit 1
  fi
}

trap 'if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi' EXIT

echo "=== 1. pool of one: seed the pilot workspace, then the journey"
use_database pilot
start_server pool-of-one DB_POOL_SIZE=1 DB_POOL_MAX_OVERFLOW=0 DB_POOL_TIMEOUT=5
"$PYTHON" scripts/loadtest/seed.py --profile pilot
"$PYTHON" scripts/loadtest/journey.py --max-seconds "${LOADTEST_JOURNEY_MAX_SECONDS:-3}"
stop_server pool-of-one

echo "=== 2. pilot: 28 browsers x 6 connections, startup + write burst"
start_server pilot
"$PYTHON" scripts/loadtest/run.py --browsers 28 --connections 6 \
  --max-seconds "${LOADTEST_MAX_SECONDS:-20}"
stop_server pilot

echo "=== 3. stress: 10 browsers x 6 connections + 1 unlimited"
use_database stress
start_server stress-seed
"$PYTHON" scripts/loadtest/seed.py --profile stress
stop_server stress-seed
start_server stress
"$PYTHON" scripts/loadtest/run.py --browsers 10 --connections 6 --unlimited-browsers 1 \
  --max-seconds "${LOADTEST_MAX_SECONDS:-20}"
stop_server stress

echo "=== load test passed"
