# Load test

Catches, before a release, what took the pilot customer down in 2.5.0: a
request that needs two pooled database connections at once (under load every
request holds one and waits for another -- a pool deadlock that only the
30 s `DB_POOL_TIMEOUT` breaks, as `500 Internal server error`), and loading
that sends one request per item. Real PostgreSQL, a real `uvicorn`, real
HTTP; only `httpx` (already in `requirements.txt`).

| File | What it does |
|------|--------------|
| `seed.py` | Seeds a workspace through the API: `--profile pilot` (5 sites, 33 projects of 6 phases with subphases, 50 equipment, 28 users of three roles, staff and equipment bookings, absences, equipment blocks) or `--profile stress` (15 sites, 100 projects, 150 equipment, 90 users). Users are `lt-user-NNN@loadtest.local`, password `loadtest-1234`. Idempotent. |
| `run.py` | Simulated browsers, each signed in as its own seeded user: the full `loadAllData` startup at once (its `Promise.all`, the site's holidays / events / custom columns, the projects through `GET /api/projects/details`, or `--projects detail` for the pre-2.5.1 one-request-per-project loading), a writer during the startup, then a burst of writes, each followed by every browser's WebSocket refetch. One report line per endpoint; exit 1 on any non-2xx or a ceiling exceeded. |
| `journey.py` | The pool-of-one journey: one user's reads and writes (staff, equipment, equipment blocks and bookings, absences, projects / phases / subphases / bookings, reorder, Kanban, dashboards, notifications, deletes) against a server with **one** connection. Exit 1 on any non-2xx or any request over 3 s. |
| `ci.sh` | All of it, as the `Load test` job of `.github/workflows/backend.yml` runs it. |

## Run it locally

You need PostgreSQL (16) and the backend requirements. From the repository root:

```bash
export DB_HOST=127.0.0.1 DB_PORT=5432 PG_ADMIN_USER=postgres PG_ADMIN_PASSWORD=<postgres password>
export SESSION_SECRET=$(python -c "import secrets; print(secrets.token_hex(32))")
export INIT_ADMIN_PASSWORD=loadtest-admin-1234
bash scripts/loadtest/ci.sh
```

`ci.sh` creates and initialises `milestone_loadtest_pilot` and
`milestone_loadtest_stress` (`LOADTEST_DB_PREFIX` changes the prefix), starts
the server on port 8485 (`LOADTEST_PORT`) three times and leaves the server
logs in `loadtest-logs/` (`LOADTEST_LOG_DIR`). It fails when a server log
contains `QueuePool limit` (a request waited for a connection until the pool
timeout) or `could not be written` / `Change notifications failed` (an audit
row or notification lost, typically for want of a second connection).

Single steps, against a server you started yourself:

```bash
export LOADTEST_BASE_URL=http://127.0.0.1:8485 LOADTEST_ADMIN_PASSWORD=<admin password>
python scripts/loadtest/seed.py --profile pilot
python scripts/loadtest/run.py --browsers 28 --connections 6            # the pilot, everyone online
python scripts/loadtest/run.py --browsers 10 --connections 6 --unlimited-browsers 1
python scripts/loadtest/run.py --projects detail ...                    # the pre-2.5.1 loading (old tabs)

# The journey needs a server with a pool of one:
DB_POOL_SIZE=1 DB_POOL_MAX_OVERFLOW=0 DB_POOL_TIMEOUT=5 uvicorn app.main:app --port 8485
python scripts/loadtest/journey.py
```

Use a local or throwaway database: the seeder creates users, sites and
projects, and the run edits them.

## When to run it

Whenever you touch the session dependencies (`app/database.py`), anything that
opens a session of its own (`audit_log.record_detached`,
`change_notifications.deliver`, the middleware), the pool settings, or how the
frontend loads a list. A new read the frontend makes at startup or on a
refetch belongs in `run.py`; a new write path in `journey.py`.

## Reading the result

- **Any non-2xx is a failure.** Under the 2.5.0 pool deadlock the project
  reads, and as collateral staff, equipment, teams and `/api/auth/me`, answered
  `500` after about 30 s.
- **A request around 5 s in the journey** (or 30 s under load) waited for a
  pooled connection: some code path opened a second session while the
  request's own still held one.
- The ceilings (`--max-seconds 20` under load, 3 s in the journey) are
  generous on purpose: the test is about zero 5xx and no pool-timeout stalls
  on a shared runner, not about a latency budget.
- No retries, on purpose: under overload a retry only multiplies the load.
