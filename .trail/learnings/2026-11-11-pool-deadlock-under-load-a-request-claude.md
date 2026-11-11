---
title: "Pool deadlock under load: a request must hold one database connection; lists load in one request (2.5.1)"
author: Claude
date: 2026-11-11
branch: claude/affectionate-shannon-anl7dh
cost: { minutes: 70, tokens: 356094 }
id: l-c227a649
scope: repo
status: active
src: agent
touches:
  - app/database.py
  - app/services/audit_log.py
  - app/services/change_notifications.py
  - app/routers/projects.py
  - app/services/approvals.py
  - app/services/tenant_manager.py
  - frontend/src/api/endpoints/projects.ts
  - scripts/loadtest/ci.sh
  - scripts/loadtest/journey.py
  - scripts/loadtest/run.py
---

Symptom in the field: projects missing until a refresh (one failed request among the startup requests fails the whole load; silently before 1.5.0) and saves taking ~30 s, then "Internal server error". The log says `QueuePool limit of size 20 overflow 10 reached, connection timed out`.

Cause: `get_db_readonly` opened its own session while `get_current_user` ran on `get_db`, so every authenticated read held two pooled connections. With more reads in flight than the pool holds, each request held one and waited for a second: a pool deadlock broken only by the 30 s `pool_timeout`. The frontend amplified it with one `GET /api/projects/{id}` per project, in every browser after every `change:*` event.

Reproduced on the 1.1.0 tag as well as main. 1.1.0 survived one browser sending 100 project requests at once, but failed at 300 in flight (33 x 500 after 32 s) and with 10 browsers x 6 connections (267 of 1000 failed). main 2.5.0 already failed with one browser x 100 (46 x 500 after 30 s). So main was more exposed than 1.1.0, plausibly because the live-user check added to every request holds the first connection longer.

## Decided
- One session and one pooled connection per request. `get_db_readonly` returns `get_db`'s session (FastAPI caches a dependency per request). `get_db` keeps the session on `request.state`.
- The detached tiers that open their own session (`audit_log.record_detached`, `change_notifications.deliver`) first call `release_request_connection(request)`. It commits the request session when a post-commit re-read (`db.refresh`, a reload `select`) began a new transaction. It commits rather than rolls back: under `expire_on_commit=False` a commit keeps the loaded objects usable, and a rollback would expire them (MissingGreenlet). Without it, 6 write routes stalled for the pool timeout under a pool of one, and their audit rows and notifications were lost silently.
- Lists load in one request: `GET /api/projects/details` returns a page of the list (same rules, max 200) with each item the exact `GET /api/projects/{id}` body. Both are built by `build_project_details()`, which runs a constant number of queries per page (`approvals.project_approval_indexes` for many projects). `fetchAllProjects()` pages through it. The old routes stay for tabs opened before an upgrade.
- Tenant pools read `DB_POOL_*` (they were hard-coded 20/10/30). Every pool pre-pings and recycles connections (`DB_POOL_RECYCLE`, default 1800 s).
- A load test stays in the repo and runs in CI (`Load test` job).

## Tried and ruled out
- Client-side retries: under overload they multiply the load.
- Wi-Fi as a cause: the 500 is the app's own answer after the pool timeout.
- Staff and equipment handlers as a cause: each is one request with a fixed query count (6 and 5 statements at pilot and at stress size). They failed as collateral, queued behind the project requests.
- Raising the pool size: it only moves the threshold.
- Not verified at the customer: stale idle connections dropped by a firewall. Pre-ping and recycle were added as hygiene, not as the fix.

## Watch out
- `release_request_connection` commits the request session. A route must commit its own writes before it calls `broadcast_change` or `change_notifications.deliver` (the existing contract), or those writes get committed early.
- The pool-of-one journey (`DB_POOL_SIZE=1 DB_POOL_MAX_OVERFLOW=0 DB_POOL_TIMEOUT=5`, `scripts/loadtest/journey.py`) is the deterministic detector for any new second-connection path. A swallowed failure shows up as a ~5 s request, not a 5xx, which is why the journey has a 3 s ceiling and CI greps the log for `QueuePool limit` / `could not be written`.
- With httpx, keep `keepalive_expiry` below uvicorn's 5 s keep-alive, or reused closed connections show up as `RemoteProtocolError` that is not the server's fault.

In the code: `app/database.py` (`get_db`, `get_db_readonly`, `release_request_connection`, `pool_arguments`), `app/services/audit_log.py#record_detached`, `app/services/change_notifications.py#deliver`, `app/routers/projects.py#build_project_details`, `app/services/approvals.py#project_approval_indexes`, `frontend/src/api/endpoints/projects.ts#fetchAllProjects`, `tests/test_db_session_per_request.py`, `tests/test_projects_bulk_details.py`, `scripts/loadtest/` (`bash scripts/loadtest/ci.sh`; `python scripts/loadtest/run.py --projects detail` for the pre-2.5.1 loading).
