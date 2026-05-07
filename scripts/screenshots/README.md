# Documentation Screenshots

Headless Playwright scripts that capture every screenshot used in the MkDocs
docs (`docs/assets/screenshots/`). Use them whenever you change UI that the
docs reference.

## One-time setup

```bash
# 1. Spin up a self-contained demo instance (PostgreSQL + the app).
#    docker-compose.fresh.yml uses host port 8486.
cp .env.example .env  # edit secrets if needed; defaults work for local
docker compose -f docker-compose.fresh.yml up -d --build

# 2. Seed the canonical demo tenant (Demo Company / slug "demo" with
#    Bioprocess Scale-Up, Catalyst Optimization, Analytical Method Transfer,
#    Quality System Upgrade — admin@demo.local / demo1234).
docker exec milestone-fresh python -m app.scripts.seed_demo

# 3. Add screenshot extras — vacations, bank holidays, populated custom columns.
docker exec -i milestone-fresh-db psql -U milestone_demo -d milestone_demo \
  < scripts/screenshots/seed_extras.sql

# 4. Install Playwright in a venv (avoid polluting system Python).
python3 -m venv /tmp/pw-venv
/tmp/pw-venv/bin/pip install playwright
/tmp/pw-venv/bin/playwright install chromium
```

## Capture

```bash
# Single-user shots (Gantt, panels, vacations, custom columns, what-if).
/tmp/pw-venv/bin/python scripts/screenshots/capture.py

# Multi-user collab shots (online users, presence dropdown, activity feed toast).
/tmp/pw-venv/bin/python scripts/screenshots/capture_collab.py
```

Capture both to refresh every screenshot the docs reference. Output goes to
`docs/assets/screenshots/`. Verify with `mkdocs build --strict` (which fails
on broken refs).

## Conventions

- **Viewport** 1440×900, light theme — matches existing screenshots.
- **Gantt zoom** Q (Quarter) so phase bars + the today indicator fit.
- **Demo data** is the canonical "Demo Company / Winterthur" tenant. Don't
  capture against another tenant — the project names and dates are referenced
  in alt text and inline copy.

## How the multi-user shots work

`capture_collab.py` opens two Playwright **contexts** in one browser. Each
context has its own cookies, so they hold independent sessions:

- Context A logs in as `admin@demo.local`, navigates to the Gantt — this is
  what gets captured.
- Context B logs in as `bob.brown@demo.local`, then drives events:
  - Just being logged in opens a WebSocket → A's `OnlineUsers` indicator
    reacts.
  - `ctx_b.request.put('/api/phases/8', ...)` edits a phase → the backend
    broadcasts the change → A's `ActivityFeed` renders a toast.

This is more reliable than orchestrating two visible browser windows and
produces the same UI A would see in production.

## Adding a new shot

1. Add a `shot_<key>` function to `capture.py` (or `capture_collab.py`),
   following the existing pattern (always end by writing to `OUT / "<name>.png"`).
2. Register it in the `targets` map at the bottom.
3. Reference it from a markdown page under `docs/`.
4. Re-run the capture command and `mkdocs build --strict` to verify.
