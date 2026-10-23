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
#    docker-compose.fresh.yml uses host port 8486 (the scripts' default
#    target; point them elsewhere with SCREENSHOT_BASE_URL, see below).
docker compose -f docker-compose.fresh.yml up -d --build

# 3. Seed the canonical demo tenant (Demo Company / slug "demo" with
#    Bioprocess Scale-Up, Catalyst Optimization, Analytical Method Transfer,
#    Quality System Upgrade — admin@demo.local / demo1234). The one seed holds
#    everything the screenshots need: project fields, tags, subphases, dependencies,
#    bookings, blocks, holidays for both sites, a site closure, every absence
#    type, custom columns, Kanban comments and notifications
#    (app/scripts/demo_data.py; dates are relative to the day you run it).
docker exec milestone-fresh python -m app.scripts.seed_demo

# 4. Install Playwright in a venv (avoid polluting system Python).
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

## Capturing without the Docker image (cloud sessions)

A Claude Code cloud session (and any machine where `docker build` cannot trust
the outbound proxy's CA) cannot build the image, so `docker-compose.fresh.yml`
is out. The capture scripts don't care where the app runs: run PostgreSQL in a
container and the backend from a Python venv instead. The steps, in order:

```bash
# 1. PostgreSQL alone (host port 5433 so a local Postgres on 5432 is untouched).
docker run -d --name ms-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5433:5432 postgres:15-alpine

# 2. .env for a multi-tenant backend against that container (same three required
#    keys as above, plus the connection values; INIT_ADMIN_PASSWORD is used by init_db).
cat > .env <<EOF
MULTI_TENANT=true
DB_HOST=127.0.0.1
DB_PORT=5433
DB_NAME=milestone_dev
DB_USER=postgres
DB_PASSWORD=postgres
PG_ADMIN_USER=postgres
PG_ADMIN_PASSWORD=postgres
MASTER_DB_NAME=milestone_master
SESSION_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
TENANT_ENCRYPTION_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
INIT_ADMIN_PASSWORD=<your choice>
EOF

# 3. Backend deps + schema + demo tenant. init_db creates the master DB only; create
#    DB_NAME too so /health stops reporting database: "error".
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m app.scripts.init_db
docker exec ms-pg psql -U postgres -c 'CREATE DATABASE milestone_dev'
.venv/bin/python -m app.scripts.seed_demo

# 4. Build the frontend and deploy it to public/ BEFORE starting the backend:
#    the /assets static mount is registered only if public/assets exists at startup.
(cd frontend && npm ci && npm run build) && bash deploy-react.sh

# 5. Backend on 8485.
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8485 --proxy-headers &

# 6. Capture against it (default target is the compose port 8486).
export SCREENSHOT_BASE_URL=http://localhost:8485
/tmp/pw-venv/bin/python scripts/screenshots/capture.py
/tmp/pw-venv/bin/python scripts/screenshots/capture_collab.py
INIT_ADMIN_PASSWORD=<your choice> /tmp/pw-venv/bin/python scripts/screenshots/capture_admin.py
```

Playwright must match the browser that is already installed. Where Chromium is
preinstalled (`PLAYWRIGHT_BROWSERS_PATH` is set and `playwright install` is
unavailable or forbidden), pin the `playwright` package to the release whose
`browsers.json` names that Chromium build — e.g. build `1194` is
`playwright==1.56.0` — instead of installing a browser. If the frontend is
rebuilt while uvicorn is running, restart uvicorn (step 4's note).

## Capture

Run all three scripts, in this order:

```bash
# 1. Single-user tenant shots (Gantt, views, modals, Settings-hub sections,
#    tags + tag filter, Kanban board, blocks, what-if, dependencies,
#    critical path, filters, archived view, dark theme).
/tmp/pw-venv/bin/python scripts/screenshots/capture.py

# 2. Multi-user collab shots (online users, presence dropdown, activity feed toast).
/tmp/pw-venv/bin/python scripts/screenshots/capture_collab.py

# 3. Admin-portal shots (tenants/orgs/admins/stats tabs, tenant audit log,
#    read-only tenant SSO form). Needs the admin portal password:
INIT_ADMIN_PASSWORD=... /tmp/pw-venv/bin/python scripts/screenshots/capture_admin.py
```

All three scripts target `http://localhost:8486` by default. Set
`SCREENSHOT_BASE_URL` (scheme + host + port, no path; a trailing `/` is
ignored) to capture from another instance, e.g. a second demo stack on 8487:

```bash
SCREENSHOT_BASE_URL=http://localhost:8487 /tmp/pw-venv/bin/python scripts/screenshots/capture.py
```

The tenant scripts append `/t/demo/`, `capture_admin.py` appends `/admin/`.

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

Administration shots (`settings-tags`, `project-fields`, `settings-teams`, `roles`, `approvals`, `sites`, `users`,
`equipment-mgmt`, `phases`, `skills`, `site-modal`) open the sidebar's single **Settings** entry
and switch to a hub section by its label (`open_settings_section(page,
"<label>")`, labels from `SETTINGS_SECTIONS` in
`frontend/src/components/settings/sections.tsx`); `settings` itself stays on
the default General section.

| Key | Output | Shows |
|-----|--------|-------|
| `project-filter` | `project-filter.png` | The project panel's **Filter**, open, on the Gantt chart, scrolled to the end of the *Area* field and the Tags section |
| `project-fields` | `project-fields-settings.png` | Settings → Project fields: the built-in fields and the *Project type* dropdown open on its items |
| `tags` | `project-tags.png` | The Edit Project dialog of Bioprocess Scale-Up with its project fields and the tag picker's list open |
| `settings-tags` | `settings-tags.png` | Settings → Tags (tags only) |
| `team-filter` | `team-filter.png` | The header team filter, open, on the Gantt chart (Winterthur's teams) |
| `settings-teams` | `settings-teams.png` | Settings → Teams for the current site |
| `roles` | `roles-settings.png` | Settings → Roles with the *User* role open on its permission matrix (own bookings in *Needs approval*) |
| `approvals` | `approvals-settings.png` | Settings → Roles → **Approvals**: who approves each own-booking action |
| `my-todos` | `my-todos.png` | My Todos signed in as **Bob**, *To decide* tab with Diana's request to join Analytics |
| `pending` | `pending-assignment.png` | The Gantt chart with Diana's dashed *Pending approval* row on Bioprocess Scale-Up |
| `assignment-overview-row` | `assignment-overview-row.png` | The Gantt chart with Charlie Clark's overview row under Bioprocess Scale-Up's *Analytics* phase (his two own-date bookings as blocks); closes a default panel and scrolls the timeline to the phase |
| `kanban` | `kanban-board.png` | The Kanban board view |
| `grouped` | `gantt-grouped.png` | The Gantt chart grouped by the *Project type* project field (collapsible pill sections) |
| `color-by` | `gantt-color-by.png` | The Gantt chart's *Colour by* dropdown, open, with *Project type* selected |
| `date-picker` | `date-range-picker.png` | The Edit Phase dialog of Bioprocess Scale-Up's *Trial* phase with the two-month date calendar open from *Start Date* |

Project bar colours are a per-user browser preference (*Colour by*), not
seeded data. The `main` shot sets *Colour by* = *Project type*, and since all
`capture.py` shots share one browser context (and so one `localStorage`), the
later Gantt shots keep the coloured bars. `grouped` sets it too (so it works
when captured on its own), and `dark-theme` sets it in its fresh context.

`my-todos` signs in as `bob.brown@demo.local` (password `demo1234`, like every
demo person) in a fresh browser context via `_login_as()`, so the shared
context stays the admin's. The approval shots rely on the demo seed's RBAC
data: the User role books itself with approval, the *Book myself* policy names
the project manager and *Team Lead*, and Diana Davis has a pending request to
join the Analytics phase of Bob's *Bioprocess Scale-Up*. Approving or
rejecting that request during a capture run would remove it — re-seed first
(`seed_demo` on a fresh database) if it is gone.

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
