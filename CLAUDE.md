# CLAUDE.md - Milestone Planner

## Project Overview

Multi-tenant SaaS platform for R&D project management with Gantt charts, staff allocation, equipment booking, and Microsoft Entra SSO. FastAPI backend + React/TypeScript frontend.

## Tech Stack

- **Backend**: Python 3.11+, FastAPI, SQLAlchemy 2.0 (async), asyncpg
- **Frontend**: React 18, TypeScript, Vite, Zustand, React Router, TanStack Query
- **Database**: PostgreSQL 15+ (multi-tenant: one master DB + one DB per tenant)
- **Deployment**: Docker, docker-compose, port 8485
- **CI/CD**: GitHub Actions (backend lint/test/typecheck, frontend lint/test/build, Docker build)
- **Documentation**: MkDocs Material, deployed to Cloudflare Pages

## Architecture

### Dual-database model

- **Master database** (`milestone_admin`): stores tenant registry, admin users, organizations, SSO config. Models use `MasterBase` from `app/models/tenant.py`.
- **Tenant databases** (`milestone_<slug>`): per-tenant isolated data (projects, users, sites, etc). Models use `Base` from `app/database.py`.

### Key directories

```
app/
  main.py              # FastAPI app with lifespan, SPA fallback routing
  config.py            # Pydantic settings (env vars)
  database.py          # Tenant DB engine/session (Base)
  models/              # SQLAlchemy ORM models
    tenant.py          # MasterBase + Tenant, AdminUser
    organization.py    # Organization, OrganizationSSOConfig
    project.py         # Project, Phase, Subphase
    user.py            # User (with full_name property)
    assignment.py      # ProjectAssignment, PhaseStaffAssignment, SubphaseStaffAssignment
    equipment.py       # Equipment, EquipmentAssignment, EquipmentBlock (maintenance/unavailability)
    site.py            # Site, BankHoliday, CompanyEvent
    skill.py           # Skill, UserSkill
    vacation.py        # Vacation, RecurringAbsence
    custom_column.py   # CustomColumn, CustomColumnValue
    tag.py             # Tag, ProjectTag (global project tags, shared across sites)
    note.py            # Note
    settings.py        # Settings, PredefinedPhase, SSOConfig
    session.py         # Session
    presence.py        # Presence
  routers/             # FastAPI route handlers
    admin/             # Multi-tenant admin sub-routes
    admin_organizations.py  # Organization CRUD
    assignments.py     # Staff/equipment assignments
    auth.py            # Authentication (login, SSO, sessions)
    custom_columns.py  # Custom column CRUD
    equipment.py       # Equipment CRUD and bookings
    export.py          # CSV/XML project export + full site export to Excel (.xlsx)
    health.py          # Health check endpoint
    mpp_import.py      # Microsoft Project file import (requires Java)
    notes.py           # Project/phase notes
    predefined_phases.py # Phase template management
    presence.py        # Real-time presence (WebSocket)
    projects.py        # Project CRUD
    settings.py        # Instance settings
    sites.py           # Site management
    skills.py          # Skills management
    staff.py           # Staff management
    tags.py            # Project tag CRUD (superuser/admin only)
    users.py           # User management
    vacations.py       # Vacation/time-off management
  schemas/             # Pydantic request/response schemas
  services/
    auth.py            # Authentication logic
    encryption.py      # AES-256-GCM credential encryption
    master_db.py       # Master DB connection + auto-migrations
    proxy.py           # Proxy service
    response_builders.py # Shared response formatting
    session.py         # Session management
    sso.py             # Microsoft Entra SSO
    tenant_manager.py  # Per-tenant connection pool management
    tenant_provisioner.py  # DB/user creation for new tenants
  middleware/
    auth.py            # Session-based authentication
    tenant.py          # URL-based tenant resolution (/t/{slug}/*)
    broadcast.py       # Auto-broadcasts change:<entity> WS events on successful writes
  websocket/
    manager.py         # Connection manager (tenant isolation, presence, multi-tab)
    handler.py         # WebSocket endpoint + session auth
    broadcast.py       # broadcast_change() helper for routers (rich attribution)
frontend/
  src/
    App.tsx            # Root component with routing
    main.tsx           # React entry point
    api/               # API client and per-resource endpoint functions
      client.ts        # Base HTTP client
      endpoints/       # admin, auth, customColumns, equipment, presence, projects,
                       # settings, sites, skills, staff, tags, users, vacations
    components/
      admin/           # AdminApp, AdminDashboard, AdminLoginScreen, TenantList,
                       # OrganizationList, AdminUserList, SystemStatsPanel
      gantt/           # Gantt chart components
      views/           # ArchivedView, CrossSiteView, EquipmentView, StaffView
      screens/         # LoginScreen, LoadingScreen
      modals/          # Modal dialogs
      common/          # Shared UI components
      layout/          # Layout components
    stores/            # Zustand state stores
      appStore.ts      # Main app state
      adminStore.ts    # Admin portal state
      uiStore.ts       # UI state (sidebar, modals)
      viewStore.ts     # Current view state
      whatIfStore.ts   # What-If mode state
      customColumnStore.ts  # Custom columns state
      undoStore.ts     # Undo/redo state
    types/             # TypeScript type definitions (models.ts)
    hooks/             # Custom React hooks
    styles/            # CSS files
    utils/             # Utility functions
docs/                  # MkDocs documentation source
  index.md             # Docs landing page
  user-guide/          # End-user documentation
  admin-guide/         # Admin & multi-tenant management docs
  developer-guide/     # Architecture, API reference, contributing
migrations/            # Raw SQL migration files
scripts/               # Utility scripts (fresh_install, seed_tenant_data, etc.)
.devcontainer/         # GitHub Codespaces configuration
.github/workflows/     # CI: backend.yml, frontend.yml, docker.yml, docs.yml
setup_databases.sql    # Full schema for fresh installs
```

## Common Commands

```bash
# Build frontend (Docker, no local Node.js needed)
docker run --rm -v $(pwd)/frontend:/app -w /app node:20-alpine sh -c "npm install && npm run build"

# Deploy frontend to public/
./deploy-react.sh

# Start production
docker-compose up -d

# Fresh install (includes PostgreSQL)
docker compose -f docker-compose.fresh.yml up -d

# Rebuild after backend changes
docker-compose up -d --build

# View logs
docker logs -f milestone

# Run backend tests
docker exec milestone pytest
# Or locally:
pytest --cov=app --cov-report=term-missing

# Frontend dev server (hot reload, port 3333)
cd frontend && npm install && npm run dev

# Frontend tests
cd frontend && npm test

# Linting
ruff check app/ && ruff format --check app/
cd frontend && npm run lint

# Type checking
mypy app/
cd frontend && npm run build   # TypeScript compilation included

# Run master DB migration
python migrations/run_migration_master.py add_organizations

# Run tenant DB migration across all tenants
python migrations/run_migration.py <migration_name>

# Build documentation locally
pip install -r docs/requirements.txt
mkdocs serve   # Preview at http://localhost:8000
mkdocs build   # Output to site/
```

## Database Migrations

- Migrations are raw SQL files in `migrations/` (no Alembic).
- Master DB migrations: `python migrations/run_migration_master.py <name>`
- Tenant DB migrations: `python migrations/run_migration.py <name>`
- `master_db.init_db()` auto-applies missing schema (organizations table, new tenant columns) on startup.
- `setup_databases.sql` is the canonical fresh-install schema.
- Available migrations: `add_organizations`, `add_skills_tables`, `add_custom_columns`, `add_company_events`, `add_company_event_color`, `add_project_presence`, `add_is_system_column`, `add_equipment_blocks`, `add_tags_tables`, `upgrade_to_v90`

## Environment Variables

Required:
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` - tenant DB
- `SECRET_KEY` - session signing

Multi-tenant mode:
- `MULTI_TENANT=true`
- `MASTER_DB_HOST`, `MASTER_DB_PORT`, `MASTER_DB_NAME`, `MASTER_DB_USER`, `MASTER_DB_PASSWORD`
- `TENANT_ENCRYPTION_KEY` - 64-char hex for AES-256-GCM
- `PG_ADMIN_USER`, `PG_ADMIN_PASSWORD` - for provisioning new tenant DBs

Auto-initialization (fresh install):
- `AUTO_INIT_DB=true` - runs `app.scripts.init_db` on startup
- `INIT_ADMIN_EMAIL` - initial admin email
- `INIT_ADMIN_PASSWORD` - initial admin password (auto-generated if empty)

## Site Export to Excel

- Endpoint: `GET /t/{slug}/api/export/site/{site_id}/excel` (admin / superuser only; superusers limited to sites they belong to).
- Implemented in `app/routers/export.py` — `build_site_export_workbook()` generates a multi-sheet `.xlsx` via `openpyxl`.
- Current sheets: Site, Projects (hierarchy with phases/subphases), Users, Equipment, Skills, User skills, Tags, Project tags, Vacations, Project assignments, Phase assignments, Subphase assignments, Equipment assignments, Custom columns, Custom column values, Bank holidays, Company events, Equipment blocks.
- **IMPORTANT**: any new data added at the site level through future enhancements (e.g. equipment maintenance/blocks, new event types, additional site-scoped settings, new assignment kinds, etc.) **must** be added as a new sheet (or a new column on the existing sheet) in `build_site_export_workbook()`. The site export is the canonical "everything for this site" snapshot — do not let it drift behind the model.

## Documentation Screenshots

When asked to **add, update, or refresh screenshots in the MkDocs docs** (`docs/`), use the canonical capture pipeline in [scripts/screenshots/](scripts/screenshots/) — do not capture by hand.

**Pipeline:**
1. **Spin up the demo instance** (self-contained Postgres + app on port 8486):
   ```bash
   cp .env.example .env  # if missing — generate SECRET_KEY/SESSION_SECRET/TENANT_ENCRYPTION_KEY (64-char hex each)
   docker compose -f docker-compose.fresh.yml up -d --build
   docker exec milestone-fresh python -m app.scripts.seed_demo
   docker exec -i milestone-fresh-db psql -U milestone_demo -d milestone_demo \
     < scripts/screenshots/seed_extras.sql
   ```
   This produces tenant `demo` (Demo Company) with the canonical projects (Bioprocess Scale-Up, Catalyst Optimization, Analytical Method Transfer, Quality System Upgrade), Swiss bank holidays, demo vacations, and 3 populated custom columns. Login: `admin@demo.local` / `demo1234` (and `bob.brown@demo.local` for multi-user collab shots).
2. **Install Playwright** once:
   ```bash
   python3 -m venv /tmp/pw-venv
   /tmp/pw-venv/bin/pip install playwright
   /tmp/pw-venv/bin/playwright install chromium
   ```
3. **Capture** — both scripts are idempotent and headless, output to `docs/assets/screenshots/`:
   ```bash
   /tmp/pw-venv/bin/python scripts/screenshots/capture.py          # single-user shots
   /tmp/pw-venv/bin/python scripts/screenshots/capture_collab.py   # multi-user collab shots
   ```
4. **Verify** with `mkdocs build --strict` (catches broken image refs).

**Conventions** the scripts enforce:
- Viewport **1440×900**, **light theme**, Gantt **Q (Quarter)** zoom — matches the existing screenshots' visual style.
- Capture against the **demo tenant only** — project names and dates are referenced in alt text and prose.
- Multi-user shots use **two Playwright `BrowserContext`s in one browser** (independent cookies, real WebSockets); User B drives events through `ctx_b.request.*` API calls so the WS broadcast fires naturally.

**Adding a new shot:** add a `shot_<key>` function to `capture.py` or `capture_collab.py`, register it in the `targets` map, reference the new PNG from a markdown page, then re-run capture + `mkdocs build --strict`. See [scripts/screenshots/README.md](scripts/screenshots/README.md) for full details.

The `scripts/screenshots/` Python scripts run their own Chromium and are always headless — they do **not** depend on the Claude Code Playwright MCP plugin. (If the user asks to make that plugin headless-by-default, edit both copies of `.mcp.json` under `~/.claude/plugins/.../playwright/` to add `"--headless"` to the `args` list and reload Claude Code.)

## Important Patterns

- Admin routes are at `/api/admin/*` and use `get_master_db` dependency for master DB sessions.
- Tenant routes are prefixed `/t/{slug}/api/*` and resolved by `TenantMiddleware`.
- The frontend is a React SPA served from `public/` by FastAPI's catch-all route.
- `CustomJSONResponse` formats datetimes to match Node.js `toISOString()` output.
- Organization SSO (Microsoft Entra ID) is configured per-organization and shared across its tenants.
- WebSocket connections (`app/websocket/`) provide real-time collaboration (presence tracking, live updates). Routers can call `broadcast_change(...)` (`app/websocket/broadcast.py`) for rich, attributed updates; `BroadcastMiddleware` (`app/middleware/broadcast.py`) auto-fires a coarse `change:<entity>` event on any other successful write so clients refresh the affected slice.
- The Dockerfile is a multi-stage build: Python deps, Node.js frontend build, slim runtime.

## Gotchas

- The master and tenant databases use **separate SQLAlchemy Base classes** (`MasterBase` vs `Base`). Don't mix them.
- `setup_databases.sql` must stay in sync with SQLAlchemy models. When adding columns to master DB models, also update this file and add a migration in `migrations/`.
- Tenant routes don't work on the Vite dev server (port 3333). Use port 8485 for tenant features.
- The `run_migration_master.py` splits SQL on `;` which can break `DO $$ ... END $$;` blocks. Use `run_migration.py` or apply those manually via `psql`.
- MPP file import requires Java (JRE 11+), included in the Docker image but not in dev environments by default.
- The User model has a `full_name` property at `user.py` — use it instead of manual `first_name + last_name` concatenation.

## Versioning & Changelog (MANDATORY)

This project uses [Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). **Single source of truth for the version is `/VERSION`** (one line, e.g. `1.2.3`, no `v` prefix).

### When to bump

You MUST bump `VERSION` and add a `CHANGELOG.md` entry — in the same PR — for any change to:

- `app/**` — backend code
- `frontend/src/**`, `frontend/package.json`, `frontend/package-lock.json`, `frontend/vite.config.ts`, `frontend/tsconfig*.json`, `frontend/index.html` — frontend code/build
- `migrations/**`, `setup_databases.sql` — DB schema
- `Dockerfile`, `docker-compose*.yml` — runtime/deployment
- `scripts/**` — operational scripts that ship with the app
- `requirements*.txt`, `pyproject.toml` — backend deps

**No bump needed** for changes confined to:

- `README.md`, `CLAUDE.md`, `CHANGELOG.md` itself
- `docs/**`, `mkdocs.yml`, `docs/requirements.txt` — MkDocs end-user / admin / developer docs
- `LICENSE`, `.gitignore`, `.dockerignore`, `.editorconfig`
- `.github/ISSUE_TEMPLATE/**`, `.github/PULL_REQUEST_TEMPLATE.md`
- `.devcontainer/**` — Codespaces config

CI enforces this via `.github/workflows/version-check.yml` — PRs touching the first list FAIL unless `VERSION` is bumped AND `CHANGELOG.md` has a matching `## [<new-version>]` heading.

### How to bump (SemVer)

- **PATCH** (`1.0.0` → `1.0.1`) — bug fix, no API/UX change.
- **MINOR** (`1.0.0` → `1.1.0`) — new feature, backwards-compatible.
- **MAJOR** (`1.0.0` → `2.0.0`) — breaking change to API, DB schema in a non-additive way, env-var rename, etc.

One bump per PR — not per commit. All commits in a feature branch share one version.

### CHANGELOG entry format

Add the new version as a new `## [<version>] - YYYY-MM-DD` heading at the top, under the preamble. Use only the categories that apply, in this order:

- **Added** — new features
- **Changed** — changes to existing behaviour
- **Deprecated** — features marked for removal
- **Removed** — features removed in this release
- **Fixed** — bug fixes
- **Security** — security-relevant fixes

Each entry is a single, human-readable line written from the user's perspective — not implementation detail.

Do **not** use an `[Unreleased]` section — every change belongs to a concrete numbered release.

### Static placeholders

`frontend/package.json`'s `"version"` field is a **static placeholder** — do not edit it on each bump. Only `/VERSION` is the source of truth. The backend reads `/VERSION` at import in `app/__init__.py` and exposes it via `/health`.

## Commit & PR conventions

- **Never include the `🤖 Generated with Claude Code` line, the "Generated with Claude Code" badge, or any equivalent attribution string** in commit messages or PR descriptions. Keep `Co-Authored-By: Claude Opus … <noreply@anthropic.com>` (this repo's existing convention) — that's the only AI-attribution footer this project uses.
- PR titles: short imperative summary (under ~70 chars). Body explains *why*, not *what* — the diff covers the what.
- Don't add an "AI was used" disclaimer or footer to PR bodies.
