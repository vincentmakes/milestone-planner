# Documentation Screenshots

Headless Playwright scripts that capture every screenshot used in the MkDocs
docs (`docs/assets/screenshots/`). Use them whenever you change UI that the
docs reference.

## One-time setup

```bash
# 1. Configure the environment. The screenshot pipeline REQUIRES:
#      MULTI_TENANT=true            (seed_demo exits without it)
#      TENANT_ENCRYPTION_KEY=<64-char hex>   (tenant registration encrypts credentials)
#      INIT_ADMIN_PASSWORD=<your choice>     (deterministic /admin login for capture_admin.py)
#    Generate hex secrets with: python3 -c "import secrets; print(secrets.token_hex(32))"
cp .env.example .env   # then edit the three values above (plus SESSION_SECRET)

# 2. Spin up a self-contained demo instance (PostgreSQL + the app).
#    docker-compose.fresh.yml uses host port 8486.
docker compose -f docker-compose.fresh.yml up -d --build

# 3. Seed the canonical demo tenant (Demo Company / slug "demo" with
#    Bioprocess Scale-Up, Catalyst Optimization, Analytical Method Transfer,
#    Quality System Upgrade — admin@demo.local / demo1234).
docker exec milestone-fresh python -m app.scripts.seed_demo

# 4. Add screenshot extras — vacations, bank holidays, populated custom
#    columns, tags, equipment blocks, a staff note.
docker exec -i milestone-fresh-db psql -U milestone_demo -d milestone_demo \
  < scripts/screenshots/seed_extras.sql

# 5. Install Playwright in a venv (avoid polluting system Python).
python3 -m venv /tmp/pw-venv
/tmp/pw-venv/bin/pip install playwright
/tmp/pw-venv/bin/playwright install chromium
```

!!! note "Existing installs"
    `INIT_ADMIN_PASSWORD` only takes effect on the **first** boot (initial
    master-DB creation). If the master DB already exists with an unknown admin
    password, reset it from inside the container:

    ```bash
    docker exec milestone-fresh python scripts/setup_admin_password.py
    ```

## Capture

Run all three scripts, in this order:

```bash
# 1. Single-user tenant shots (Gantt, views, modals, tags, blocks, what-if).
/tmp/pw-venv/bin/python scripts/screenshots/capture.py

# 2. Multi-user collab shots (online users, presence dropdown, activity feed toast).
/tmp/pw-venv/bin/python scripts/screenshots/capture_collab.py

# 3. Admin-portal shots (tenants/orgs/admins/stats tabs, tenant audit log,
#    read-only tenant SSO form). Needs the admin portal password:
INIT_ADMIN_PASSWORD=... /tmp/pw-venv/bin/python scripts/screenshots/capture_admin.py
```

`capture_admin.py` must run **last**: it temporarily attaches the demo tenant
to an SSO-enabled organization (which adds a "Sign in with Microsoft" button
to the tenant login page) and detaches it again when done — running it before
`capture.py` would contaminate `login.png`.

Output goes to `docs/assets/screenshots/`. Verify with `mkdocs build --strict`
(which fails on broken refs).

`capture.py` accepts shot keys to re-capture a subset (run with an unknown key
to list them), e.g.:

```bash
/tmp/pw-venv/bin/python scripts/screenshots/capture.py main tags block-modal
```

## Conventions

- **Viewport** 1440×900, light theme, `en-US` locale (pinned on the browser
  context so date formatting is host-independent) — matches existing
  screenshots.
- **Gantt zoom** Q (Quarter) so phase bars + the today indicator fit.
- **Demo data** is the canonical "Demo Company / Winterthur" tenant. Don't
  capture against another tenant — the project names and dates are referenced
  in alt text and inline copy.
- Shots must be **idempotent**: don't persist mutations against the demo
  tenant (open modals without saving; `capture_admin.py` cleans up the
  master-DB state it seeds).

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

## How the admin-portal shots work

`capture_admin.py` logs into `/admin` (master DB, `admin_session` cookie) and
seeds demo state **over the admin HTTP API** — an organization ("Demo
Holding") with a dummy Entra SSO config, the demo tenant attached, and one
suspend→activate cycle so the tenant audit log has entries. Seeding through
the API means the SSO secret is encrypted server-side; no raw SQL against the
master DB. A second browser context then logs into the demo tenant to capture
the read-only **SSO Configuration** form ("managed by your organization").
Finally the tenant is detached from the organization again.

## Adding a new shot

1. Add a `shot_<key>` function to `capture.py` (or `capture_collab.py` /
   `capture_admin.py`), following the existing pattern (always end by writing
   to `OUT / "<name>.png"`).
2. For `capture.py`, register it in the `TARGETS` map at the bottom.
3. Reference it from a markdown page under `docs/`.
4. Re-run the capture command and `mkdocs build --strict` to verify.
