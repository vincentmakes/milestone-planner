# CLAUDE.md - Milestone Planner

Multi-tenant SaaS platform for R&D project management: interactive Gantt charts with phase/subphase hierarchies and dependencies, staff allocation with workload heatmaps, equipment booking with conflict detection, vacation/holiday tracking, real-time multi-user collaboration over WebSockets, What-If planning, Microsoft Entra SSO, and MS Project import/export. FastAPI backend + React/TypeScript frontend.

**Current version**: see `/VERSION` (single source of truth, one line, no `v` prefix). The backend reads it at import in `app/__init__.py` and exposes it via `/health`. Note: `app/config.py`'s `app_version = "2.0.0"` default is stale and **unused** — never treat it as the version.

## Quick Start

```bash
# Self-contained fresh install (bundled PostgreSQL, app on port 8486, DB on 5433)
docker compose -f docker-compose.fresh.yml up -d
# AUTO_INIT_DB=true creates the schema and seeds an admin
# (admin@milestone.local — password printed in the container logs)

# Production (external PostgreSQL configured via .env, port 8485)
cp .env.example .env   # fill in DB credentials + secrets
docker-compose up -d
```

GitHub Codespaces / devcontainer: `.devcontainer/` boots a full **multi-tenant** dev environment (postgres sidecar, `AUTO_INIT_DB=true`, demo login `admin@demo.local` / `demo1234`, uvicorn auto-started on 8485).

---

## AI Assistant Guidelines

When working on this codebase, follow these conventions:

### General Principles

- **Two SQLAlchemy declarative bases — never mix them.** Tenant-database models use `Base` (`app/database.py`); master-database models use `MasterBase` (`app/models/tenant.py`). A model on the wrong base silently lands in the wrong `metadata` and breaks provisioning/init.
- **Node.js compatibility is a contract, not an accident.** This app replaced a Node/Express implementation and keeps wire-level compatibility: `CustomJSONResponse` formats datetimes like `toISOString()` and coerces whole floats to ints; sessions are express-session-compatible (`connect.sid` cookie, `s%3A<id>.` value format, `sessions` table shape); credential encryption uses the Node `iv:authTag:ciphertext` hex format. Changing any of these serialization behaviours is a breaking change.
- **Optimistic frontend + WebSocket refetch.** The frontend mutates Zustand state immediately and persists after; other clients converge via `change:<entity>` WebSocket events that trigger debounced slice refetches. On a failed persist the frontend reloads everything from the server and clears undo history. Keep new features inside this model — don't invent per-feature sync mechanisms.
- **Site export is a canonical snapshot.** Any new site-scoped data must be added to `build_site_export_workbook()` — see the Site Export contract under Import & Export below.
- **There is no client-side router.** `react-router-dom` was removed from `package.json` (it was never imported) — don't re-add it. `App.tsx` branches on `window.location.pathname` (`/admin*` → admin portal, everything else → main app), and in-app views (gantt/staff/equipment/crosssite/archived) are `viewStore` state, not URLs. Don't add routes; add views to `viewStore` + `MainLayout.renderView()`.
- **Raw SQL migrations only — never introduce Alembic.** Migrations are idempotent `.sql` files in `migrations/` executed by `run_migration.py` (tenant DBs) / `run_migration_master.py` (master DB).

### Backend Conventions

- Route handlers live in `app/routers/`, one file per resource domain, and **must be registered in `create_app()` in `app/main.py`** (`app.include_router(...)`). Cautionary tale: a `presence.py` router was once written but never registered — its HTTP endpoints sat dead for a long time before being deleted (presence works over WebSocket). Verify registration when adding a router.
- Use `async def` and `AsyncSession` for all handlers and DB access.
- Role gating via dependencies from `app/middleware/auth.py`: `get_current_user` (any authenticated user), `require_superuser` (**admin OR superuser**), `require_admin` (admin only). Admin-portal routes use `get_current_admin` / `require_superadmin` from `app/routers/admin/auth.py` against the master DB. The `is_system` flag on users protects the provisioned admin from deletion.
- **Real-time broadcast is two-tier.** For user-facing mutations on projects/phases/subphases/assignments, call `broadcast_change(...)` (`app/websocket/broadcast.py`) with rich attribution (entity, action, summary). Everything else is covered automatically: `BroadcastMiddleware` (`app/middleware/broadcast.py`) fires a coarse `change:<entity>` on any successful 2xx write, and its `SKIP_PATTERNS` list suppresses the paths that already do rich broadcasts. When you add rich broadcasting to a new path, add it to `SKIP_PATTERNS` too — otherwise clients receive double events.
- **Schema-change checklist** — when you add/alter a tenant table or column, update ALL of:
  1. The SQLAlchemy model (`app/models/`)
  2. `setup_databases.sql` (canonical fresh-install schema)
  3. A new idempotent migration in `migrations/` (for existing installs)
  4. `app/services/tenant_provisioner.py`'s `get_tenant_schema_sql()` (schema for newly provisioned tenants)
  5. `scripts/sql/tenant_schema_template.sql` (manual-setup reference)
  6. `build_site_export_workbook()` in `app/routers/export.py` if the data is site-scoped
  Master-DB changes: model + `setup_databases.sql` + a migration run by `run_migration_master.py` + the idempotent auto-migration in `app/services/master_db.py` if it must apply automatically on upgrade.
- Secrets at rest (tenant DB passwords, SSO client secrets) go through `app/services/encryption.py` (AES-256-GCM, `iv:tag:ciphertext` hex). Never store plaintext credentials.
- **Before every commit**: `ruff check app/ && ruff format --check app/ && mypy app/`. CI fails on any of these.

### Frontend Conventions

- **Store ownership**: domain data (sites/projects/staff/equipment/vacations/holidays/skills/tags/settings) → `appStore`; view state (mode, zoom, expansion, scroll, current view) → `viewStore`; transient UI (modals, drag/resize, dependency linking, context menus) → `uiStore`; What-If sandbox → `whatIfStore`; undo/redo snapshots → `undoStore`; custom-column data/filters/visibility → `customColumnStore`; admin portal → `adminStore`. Don't put domain data in `uiStore` or UI state in `appStore`.
- **All snake_case↔camelCase transforms live in the API layer**, chiefly `src/api/endpoints/projects.ts` (`transformProject/Phase/Subphase/...` — including `type`↔`name` for phases and `sort_order`↔`order_index`). Components consume the frontend model from `src/types/models.ts` only; never transform field names in components.
- **New write endpoints are What-If-intercepted by default.** The API client queues every PUT/POST/DELETE while What-If mode is active, except URLs under `/api/auth/` and `/api/settings/`. If a new endpoint must bypass What-If (rare), extend the exemption list in `src/api/client.ts` deliberately — and if it must be queued, ensure the local optimistic update is complete since the server won't respond for real.
- **Optimistic-write failure protocol**: on persist failure, reload the affected data from the server and call `undoStore.clear()` — a stale undo stack against fresh server state corrupts data. `useDragAndDrop` and `useUndoRedo` are the reference implementations.
- **Modals close only via explicit buttons or the Escape key — never on backdrop/outside click.** Clicking outside a modal must NOT close it (it discards in-progress input, e.g. when a text-selection drag ends on the backdrop). The shared `Modal` component (`src/components/common/Modal/`) enforces this and has no overlay-click prop; new dialogs must use it. Standalone dialogs that can't (like the admin-portal modals in `src/components/admin/modals/`) must not attach close handlers to their overlay and should use the `useEscapeKey` hook for Escape support. This rule is for modals/dialogs only — dropdowns, context menus, and popovers keep their click-outside-to-close behavior.
- New localStorage keys go through `STORAGE_KEYS` in `src/utils/storage.ts` (typed wrappers, legacy migration support). Zustand persistence serializes `Set`s as arrays with custom `merge` — follow the existing pattern in `viewStore`.
- ESLint is configured with most rules at **warn** level (including `rules-of-hooks`) — CI's lint job will not catch everything. Treat warnings as errors when writing new code.
- Frontend model types live in `src/types/models.ts`; dates are `YYYY-MM-DD` strings throughout the frontend.

### Security Requirements

- **Two independent auth systems — never cross them.** Tenant app: `connect.sid` cookie → `sessions` table in the tenant DB. Admin portal: `admin_session` cookie → `admin_sessions` table in the master DB. A tenant session must never grant admin-portal access or vice versa.
- Every tenant route needs an auth dependency (`get_current_user` at minimum). Every admin route needs `get_current_admin` or `require_superadmin`.
- Tenant user passwords: bcrypt (rounds=12) with lazy upgrade from legacy PBKDF2/plaintext on login. Admin-portal passwords: PBKDF2-SHA512. Both in `app/services/encryption.py`.
- SSO `state` parameters are HMAC-signed (carrying the tenant slug through the shared organization callback) — never accept an unsigned or unvalidated state.
- Organization-level SSO **takes precedence** over tenant-level SSO; enabling tenant SSO while org SSO is active is rejected with 409 (`_reject_if_org_sso_active`). Preserve this guardrail.
- API docs (`/api/docs`, `/api/redoc`, `/api/openapi.json`) are gated to `role == "admin"` — keep them gated.

### Testing Conventions

- Backend tests live in `tests/` (pytest, `asyncio_mode=auto`, config in `pyproject.toml`). Style is **unit tests with mocks, no live DB**: `mock_db_session` (AsyncMock) and `app_client` (httpx `AsyncClient` + `ASGITransport` with dependency overrides) from `tests/conftest.py`.
- `tests/test_lint.py` shells out to ruff — lint failures fail the test suite too.
- `tests/test_migration_parser.py` covers `run_migration_master.py`'s `split_sql_statements()` (including `DO $$ ... END $$;` handling). Extend it when the migration runner must support new SQL constructs.
- Frontend uses Vitest + Testing Library (`frontend/vitest.config.ts`, jsdom, setup in `src/test/setup.ts`). Coverage is currently minimal (a smoke test) — add tests alongside new features rather than retrofitting.
- Run locally: `pytest --cov=app --cov-report=term-missing` and `cd frontend && npm run test -- --run`.

### Documentation (MkDocs)

- The user/admin/developer manual lives in `docs/`, built with **MkDocs Material** (`mkdocs.yml`; nav: User Guide / Admin Guide / Developer Guide).
- **Deployment is Cloudflare Pages, not GitHub Actions** — there is no `docs.yml` workflow. Cloudflare runs `docs/build.sh` (`pip install -r docs/requirements.txt && mkdocs build --strict`) with output dir `site/`.
- `docs/release-notes.md` embeds the root `CHANGELOG.md` via a pymdownx snippet — don't duplicate release notes in docs.
- Validate any docs change with `mkdocs build --strict` (catches broken links/images).
- User-facing feature changes should update the relevant `docs/user-guide/` or `docs/admin-guide/` page.

### Documentation Screenshots

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
   This produces tenant `demo` (Demo Company) with the canonical projects (Bioprocess Scale-Up, Catalyst Optimization, Analytical Method Transfer, Quality System Upgrade), Swiss bank holidays, demo vacations, tags, equipment blocks, and 3 populated custom columns. Login: `admin@demo.local` / `demo1234` (and `bob.brown@demo.local` for multi-user collab shots). **`.env` must set `MULTI_TENANT=true`, a `TENANT_ENCRYPTION_KEY`, and `INIT_ADMIN_PASSWORD`** (deterministic admin-portal login for `capture_admin.py`) — see `scripts/screenshots/README.md`.
2. **Install Playwright** once:
   ```bash
   python3 -m venv /tmp/pw-venv
   /tmp/pw-venv/bin/pip install playwright
   /tmp/pw-venv/bin/playwright install chromium
   ```
3. **Capture** — all scripts are idempotent and headless, output to `docs/assets/screenshots/`, and must run in this order (`capture_admin.py` temporarily attaches the demo tenant to an SSO org and cleans up after itself):
   ```bash
   /tmp/pw-venv/bin/python scripts/screenshots/capture.py          # single-user shots
   /tmp/pw-venv/bin/python scripts/screenshots/capture_collab.py   # multi-user collab shots
   INIT_ADMIN_PASSWORD=... /tmp/pw-venv/bin/python scripts/screenshots/capture_admin.py  # admin portal
   ```
4. **Verify** with `mkdocs build --strict` (catches broken image refs).

**Conventions** the scripts enforce:
- Viewport **1440×900**, **light theme**, **en-US locale** (pinned on the browser context), Gantt **Q (Quarter)** zoom — matches the existing screenshots' visual style.
- Capture against the **demo tenant only** — project names and dates are referenced in alt text and prose.
- Multi-user shots use **two Playwright `BrowserContext`s in one browser** (independent cookies, real WebSockets); User B drives events through `ctx_b.request.*` API calls so the WS broadcast fires naturally.

**Adding a new shot:** add a `shot_<key>` function to `capture.py` or `capture_collab.py`, register it in the `targets` map, reference the new PNG from a markdown page, then re-run capture + `mkdocs build --strict`. See [scripts/screenshots/README.md](scripts/screenshots/README.md) for full details.

The `scripts/screenshots/` Python scripts run their own Chromium and are always headless — they do **not** depend on the Claude Code Playwright MCP plugin. (If the user asks to make that plugin headless-by-default, edit both copies of `.mcp.json` under `~/.claude/plugins/.../playwright/` to add `"--headless"` to the `args` list and reload Claude Code.)

### Versioning & Changelog (MANDATORY)

This project uses [Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). **Single source of truth for the version is `/VERSION`** (one line, e.g. `1.2.3`, no `v` prefix).

#### When to bump

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
- `.github/**` — workflows and repo metadata
- `.devcontainer/**` — Codespaces config

CI enforces this via `.github/workflows/version-check.yml` — PRs touching the first list FAIL unless `VERSION` is bumped AND `CHANGELOG.md` has a matching `## [<new-version>]` heading. Note the path filters are directory-wide: even a README inside `scripts/` or `migrations/` triggers the gate.

#### How to bump (SemVer)

- **PATCH** (`1.0.0` → `1.0.1`) — bug fix, no API/UX change.
- **MINOR** (`1.0.0` → `1.1.0`) — new feature, backwards-compatible.
- **MAJOR** (`1.0.0` → `2.0.0`) — breaking change to API, DB schema in a non-additive way, env-var rename, etc.

One bump per PR — not per commit. All commits in a feature branch share one version.

#### CHANGELOG entry format

Add the new version as a new `## [<version>] - YYYY-MM-DD` heading at the top, under the preamble. Use only the categories that apply, in this order:

- **Added** — new features
- **Changed** — changes to existing behaviour
- **Deprecated** — features marked for removal
- **Removed** — features removed in this release
- **Fixed** — bug fixes
- **Security** — security-relevant fixes

Each entry is a single, human-readable line written from the user's perspective — not implementation detail.

Do **not** use an `[Unreleased]` section — every change belongs to a concrete numbered release.

#### Static placeholders

`frontend/package.json`'s `"version"` field is a **static placeholder** — do not edit it on each bump. Only `/VERSION` is the source of truth. The backend reads `/VERSION` at import in `app/__init__.py` and exposes it via `/health`.

### Commit & PR conventions

- **Never include the `🤖 Generated with Claude Code` line, the "Generated with Claude Code" badge, or any equivalent attribution string** in commit messages or PR descriptions. Keep `Co-Authored-By: Claude Opus … <noreply@anthropic.com>` (this repo's existing convention) — that's the only AI-attribution footer this project uses.
- PR titles: short imperative summary (under ~70 chars). Body explains *why*, not *what* — the diff covers the what.
- Don't add an "AI was used" disclaimer or footer to PR bodies.

---

## Architecture Overview

```
┌───────────────────────────────────────────────────────────────┐
│  Browser                                                      │
│  React 18 + TypeScript + Zustand (SPA, no client router)      │
│  Vite dev server (port 3333) — API calls go direct to :8485   │
└───────────────┬──────────────────────────┬────────────────────┘
                │ HTTP /t/{slug}/api/*     │ WS /t/{slug}/ws
                │ (or /api/* single-tenant)│ (or /ws)
┌───────────────▼──────────────────────────▼────────────────────┐
│  FastAPI (uvicorn, port 8485)                                 │
│                                                               │
│  TenantMiddleware (pure ASGI, multi-tenant only)              │
│    resolves /t/{slug}/*, rewrites path, 60s tenant cache,     │
│    puts tenant info in scope["state"] (plain dict)            │
│    └─ BroadcastMiddleware (pure ASGI)                         │
│         fires coarse change:<entity> WS event on 2xx writes   │
│         └─ Routers (/api/*) + WebSocket handler + SPA serving │
│                                                               │
│  Session auth: connect.sid cookie (tenant) /                  │
│                admin_session cookie (admin portal)            │
│  CustomJSONResponse: Node-compatible datetime/float output    │
│  Lifespan: master_db.init_db() ALWAYS runs (both modes),      │
│            + tenant pool idle-cleanup task (multi-tenant)     │
└───────┬──────────────────────────────┬────────────────────────┘
        │                              │
┌───────▼───────────┐   ┌──────────────▼───────────────────────┐
│  Master DB        │   │  Tenant DBs (one per tenant)         │
│  milestone_admin  │   │  milestone_<slug>                    │
│  MasterBase models│   │  Base models                         │
│  tenants, admins, │   │  lazy per-tenant asyncpg pools       │
│  orgs, org SSO    │   │  (tenant_manager, 15-min idle close) │
└───────────────────┘   └──────────────────────────────────────┘
```

- **Single-tenant mode** (`MULTI_TENANT=false`): no `TenantMiddleware`; routes are `/api/*` and `/ws`; one tenant DB from `DB_*` env vars. The master DB is still initialized so the admin portal (`/admin`) works in both modes.
- The SPA is served by FastAPI from `public/` (static mounts for `/css /js /images /img /fonts /assets` + catch-all returning `index.html`; `api/` paths get 404, `/ws` paths get 426 from the catch-all).
- Docs endpoints (`/api/docs`, `/api/redoc`, `/api/openapi.json`) require an authenticated tenant `admin`.
- A global exception handler returns an opaque 500 (no stack traces to clients).

## Terminology

- **Tenant** — an isolated customer workspace with its own PostgreSQL database (`milestone_<slug>`), reached at `/t/{slug}/`. Managed from the admin portal.
- **Site** — a physical location *within* a tenant (labs/offices). Most data (projects, equipment, holidays, events) is site-scoped; users belong to one or more sites via `user_sites`.
- **Organization** — a master-DB grouping of tenants that share one Microsoft Entra SSO configuration.
- **Tenant roles** (`users.role`): `admin` > `superuser` > `user`. Superusers manage projects/staff/equipment within their sites; admins additionally manage sites, users, and settings.
- **Admin-portal roles** (`admin_users.role`): `superadmin` > `admin`. These are master-DB accounts for the `/admin` portal, completely separate from tenant users. Don't confuse tenant `admin` with portal `admin`.
- **Phase / Subphase** — projects contain phases; subphases nest recursively under phases or other subphases (`parent_type` = `phase`|`subphase`, with `depth`).
- **Equipment block** — maintenance/unavailability window on equipment (the equipment analogue of a vacation).
- **What-If mode** — a client-side sandbox: edits are queued locally instead of sent to the server, then applied or discarded.

## Project Structure

```
app/
  __init__.py          # Reads /VERSION → __version__
  main.py              # create_app()/create_wrapped_app(), lifespan, router registration,
                       #   CustomJSONResponse, CORS, static mounts + SPA catch-all
  config.py            # Pydantic settings (env vars); get_settings() lru_cached
  database.py          # Tenant DB engine/session + declarative Base
  models/              # SQLAlchemy ORM models
    tenant.py          # MasterBase + Tenant, TenantCredentials, TenantAuditLog,
                       #   AdminUser, AdminSession (master DB)
    organization.py    # Organization, OrganizationSSOConfig (master DB)
    project.py         # Project, ProjectPhase, ProjectSubphase (recursive)
    user.py            # User (full_name property, role, max_capacity, is_system), UserSite
    assignment.py      # ProjectAssignment, PhaseStaffAssignment, SubphaseStaffAssignment
    equipment.py       # Equipment, EquipmentAssignment, EquipmentBlock
    site.py            # Site, BankHoliday, CompanyEvent
    skill.py           # Skill, UserSkill
    vacation.py        # Vacation (recurring pattern encoded in description)
    custom_column.py   # CustomColumn, CustomColumnValue (EAV)
    tag.py             # Tag, ProjectTag (global project tags, shared across sites)
    note.py            # Note — tablename is staff_notes
    settings.py        # Settings (KV), PredefinedPhase, SSOConfig (singleton)
    session.py         # Session (express-session compatible)
    presence.py        # ProjectPresence
  routers/             # FastAPI route handlers (registered in main.py)
    admin/             # Admin portal: auth.py, tenants.py, users.py → /api/admin/*
    admin_organizations.py  # Organization CRUD + org SSO + tenant attach → /api/admin/organizations
    assignments.py     # Staff assignments (3 levels) + equipment assignments
    auth.py            # Login/logout/me, password change, SSO config/login/callback
    custom_columns.py  # Custom column + value CRUD
    equipment.py       # Equipment, equipment types, bookings, blocks
    export.py          # MPP/CSV project export + full site export to Excel (.xlsx)
    health.py          # /health + /api/health + WS debug endpoints
    mpp_import.py      # Microsoft Project file import (requires Java)
    notes.py           # Staff notes
    predefined_phases.py # Phase template management
    projects.py        # Project/phase/subphase CRUD + reorder
    settings.py        # Instance settings (KV) + tenant SSO settings
    sites.py           # Sites, bank holidays (incl. Nager refresh), company events
    skills.py          # Skills + user-skill assignment
    staff.py           # Staff read endpoints (staff are users; created via /users)
    tags.py            # Project tag CRUD
    users.py           # User management
    vacations.py       # Vacation/time-off management
  schemas/             # Pydantic request/response schemas (one file per domain;
                       #   base.py holds Node-compatible serializers)
  services/
    auth.py            # Shared admin-session validation
    encryption.py      # AES-256-GCM credentials + bcrypt/PBKDF2 password hashing
    master_db.py       # Master DB singleton: init, idempotent auto-migrations,
                       #   verify_admin_exists() (auto-creates admin@milestone.local)
    proxy.py           # Corporate proxy resolution (env vars or PAC file)
    response_builders.py # Shared ORM→dict response helpers
    session.py         # SessionService (express-session compatible)
    sso.py             # SSOService: effective config (org > tenant), Graph groups,
                       #   authorization URL + HMAC-signed state
    tenant_manager.py  # Lazy per-tenant connection pools + idle cleanup + auto-migrations
    tenant_provisioner.py # Tenant DB/user creation, schema, seed; managed-PG support
  middleware/
    auth.py            # Session auth dependencies (get_current_user, require_*)
    tenant.py          # Pure-ASGI tenant resolution (/t/{slug}/* rewrite, 60s cache)
    broadcast.py       # Pure-ASGI coarse change:<entity> broadcast on 2xx writes
  websocket/
    manager.py         # ConnectionManager: per-tenant rooms, multi-tab, presence
    handler.py         # /ws and /t/{slug}/ws endpoints, cookie auth, close codes
    broadcast.py       # broadcast_change() helper for routers (rich attribution)
frontend/
  src/
    main.tsx           # Entry: QueryClientProvider, initTheme, configureApiClient (What-If wiring)
    App.tsx            # Top-level branching (pathname /admin* vs main app), no router
    api/
      client.ts        # Fetch wrapper: cookie auth, tenant prefix, What-If interception
      endpoints/       # admin, auth, customColumns, equipment, projects (transform
                       #   layer), settings, sites, skills, staff, tags, users, vacations
    components/
      admin/           # AdminApp, AdminDashboard, TenantList, OrganizationList,
                       #   AdminUserList, SystemStatsPanel + admin modals
      gantt/           # GanttContainer, ProjectPanel/ (tree rows), Timeline/ (bars,
                       #   dependencies, phantom overlays), CustomColumns/, hooks/, utils/
      views/           # StaffView (workload heatmap), EquipmentView, CrossSiteView, ArchivedView
      screens/         # LoginScreen, LoadingScreen
      modals/          # ModalContainer (lazy) + all dialogs
      common/          # Button, Modal, Tooltip, ContextMenu, OnlineUsers, ActivityFeed, …
      layout/          # MainLayout, Header/ (controls), Sidebar/, ResourcePanel/
    contexts/          # WebSocketContext (WS → debounced refetch), TimelineScrollContext
    stores/            # 7 Zustand stores (see Frontend Architecture)
    types/models.ts    # All frontend entity types (snake_case, YYYY-MM-DD dates)
    hooks/             # useAuth, useDataLoader, useWebSocket, useDragAndDrop, … (see catalog)
    utils/             # date, storage (STORAGE_KEYS, themes), criticalPath, csvExport,
                       #   xmlExport, recurringVacation, equipmentOverlap, …
  vite.config.ts       # tenantSpaPlugin (/t/* SPA fallback in dev), @ → src alias, port 3333
  vitest.config.ts     # Vitest (jsdom) config
docs/                  # MkDocs Material source (user-guide/, admin-guide/, developer-guide/)
  build.sh             # Cloudflare Pages build command (mkdocs build --strict)
migrations/            # Raw SQL migrations + run_migration.py / run_migration_master.py
scripts/
  fresh_install.py     # Automated master-DB installer (+ .env generation)
  seed_tenant_data.py  # Seed a tenant with sample data
  setup_admin_password.py
  sql/                 # milestone_master_fresh_install.sql, tenant_schema_template.sql,
                       #   migrations/001_add_max_capacity.sql
  screenshots/         # Playwright screenshot pipeline (capture.py, capture_collab.py)
tests/                 # Backend pytest suite (mock-based, no live DB)
public/                # Built frontend served by FastAPI (deploy-react.sh copies dist/ here)
.devcontainer/         # Codespaces: multi-tenant dev env, demo seed, uvicorn autostart
.github/workflows/     # CI: backend.yml, frontend.yml, docker.yml, version-check.yml
setup_databases.sql    # Canonical full schema for fresh installs
deploy-react.sh        # Copies frontend/dist → public/ atomically
docker-entrypoint.sh   # DB wait + optional AUTO_INIT_DB, then uvicorn
```

## Common Commands

```bash
# Build frontend (Docker, no local Node.js needed)
docker run --rm -v $(pwd)/frontend:/app -w /app node:24-alpine sh -c "npm install && npm run build"

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

**Dev-server nuance**: the Vite dev server (:3333) serves `/t/{slug}/…` SPA paths via the custom `tenantSpaPlugin` in `vite.config.ts`, but there is **no API proxy** — `src/api/client.ts` detects port 3333 and sends API/WS traffic directly to `:8485`, so the backend must be running (e.g. via `docker-compose.dev.yml`, which runs both). For full tenant/WebSocket behaviour, test against `:8485` serving the built frontend from `public/`.

## Environment Variables

Settings are loaded by `app/config.py` (pydantic-settings, `.env`, case-insensitive) unless marked *env-only*.

| Variable | Default | Description |
|----------|---------|-------------|
| `DEBUG` | `false` | Debug mode (enables localhost CORS defaults) |
| `PORT` | `8485` | Backend HTTP port |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | `localhost`/`5432`/`milestone_dev`/`milestone_dev_user`/`""` | Tenant DB (single-tenant mode) |
| `DATABASE_URL` | *(unset)* | Overrides individual `DB_*` vars (`postgres://` auto-rewritten to `postgresql+asyncpg://`) |
| `DB_SSL` | `false` | Require SSL to the tenant DB |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` / `DB_POOL_TIMEOUT` | `20`/`10`/`30` | Connection pool tuning |
| `SESSION_SECRET` | insecure default | Session signing secret — **must change in production** |
| `SESSION_COOKIE_NAME` | `connect.sid` | Tenant session cookie (express-session compatible) |
| `SESSION_MAX_AGE` | `86400` | Session lifetime (seconds) |
| `SECURE_COOKIES` | `false` | Set `Secure` on cookies (enable behind HTTPS) |
| `CORS_ORIGINS` | *(unset)* | Comma-separated allowed origins (localhost defaults in debug; same-origin otherwise) |
| `MULTI_TENANT` | `false` | Enable multi-tenant mode (TenantMiddleware + master-driven tenant pools) |
| `DEFAULT_TENANT` | *(unset)* | Optional default tenant slug |
| `MASTER_DB_HOST` / `MASTER_DB_PORT` / `MASTER_DB_NAME` / `MASTER_DB_USER` / `MASTER_DB_PASSWORD` | `-`/`5432`/`milestone_master`/`-`/`-` | Master DB connection (multi-tenant) |
| `PG_ADMIN_USER` / `PG_ADMIN_PASSWORD` | *(unset)* | PostgreSQL admin (CREATEROLE+CREATEDB) for tenant provisioning and cross-tenant migrations |
| `TENANT_ENCRYPTION_KEY` | *(env-only)* | 64-char hex AES-256-GCM key for tenant credentials — **required** in multi-tenant mode |
| `SSO_ENABLED` / `SSO_CLIENT_ID` / `SSO_CLIENT_SECRET` / `SSO_TENANT_ID` / `SSO_REDIRECT_URI` | `false`/unset | Env-level SSO bootstrap (normally configured in-app instead) |
| `NAGER_API_URL` | `https://date.nager.at/api/v3` | Public-holiday API for bank-holiday refresh |
| `HTTP_PROXY` / `HTTPS_PROXY` / `PROXY_USERNAME` / `PROXY_PASSWORD` / `PROXY_PAC_URL` / `PROXY_VERIFY_SSL` / `PROXY_CA_CERT` | *(unset)* | Corporate proxy for outbound HTTP (Nager, Microsoft Graph); PAC files supported |
| `AUTO_INIT_DB` | *(env-only)* `false` | Run `app.scripts.init_db` on container start (fresh installs) |
| `INIT_ADMIN_EMAIL` / `INIT_ADMIN_PASSWORD` | *(env-only)* | Initial admin credentials for auto-init (password auto-generated if empty) |
| `TZ` | `Europe/Zurich` | Container timezone |

Fresh-compose overrides: `FRESH_APP_PORT` (default 8486), `FRESH_DB_PORT` (5433), `FRESH_APP_NAME`, `FRESH_DB_NAME`.

## Database Schema

Two declarative bases: **`Base`** (tenant databases, `app/database.py`) and **`MasterBase`** (master database, `app/models/tenant.py`). Never mix them.

### Tenant database tables (one DB per tenant: `milestone_<slug>`)

**Users & access**

| Table | Model | Purpose |
|-------|-------|---------|
| `users` | `User` | App users *and* staff resources. email (unique), password, names, job_title, role CHECK(`admin`/`superuser`/`user`), `max_capacity` % (part-time), SSO fields, `active`, `is_system` (protects provisioned admin). Props: `full_name`, `is_admin`, `site_ids`, `can_modify_site()` |
| `user_sites` | `UserSite` | M:N user ↔ site (composite PK) |
| `sessions` | `Session` | express-session-compatible session store: `sid` PK, `sess` JSON text, `expired` (ms epoch) |
| `sso_config` | `SSOConfig` | Tenant-level SSO singleton (CHECK `id = 1`): enabled, Entra tenant/client/secret, redirect URI, auto_create_users, default_role |

**Sites & calendar**

| Table | Model | Purpose |
|-------|-------|---------|
| `sites` | `Site` | Physical locations: name (unique), location, country/region codes, timezone, `last_holiday_fetch` |
| `bank_holidays` | `BankHoliday` | Public holidays per site (affect working-day calc); `is_custom` for manual entries; refreshable from the Nager API |
| `company_events` | `CompanyEvent` | Audits/meetings per site with color — displayed but do **not** affect working-day calc |

**Projects**

| Table | Model | Purpose |
|-------|-------|---------|
| `projects` | `Project` | R&D projects: name, site_id, customer, pm_id, confirmed, volume, dates, notes, archived; `tags` M:N |
| `project_phases` | `ProjectPhase` | Phases: project_id (CASCADE), `type` (name), dates, `is_milestone`, `sort_order`, `completion`, `dependencies` (JSON text) |
| `project_subphases` | `ProjectSubphase` | **Recursive** subphases: `parent_id` + `parent_type` CHECK(`phase`/`subphase`), `depth`, dates, milestone/completion/dependencies |
| `tags` / `project_tags` | `Tag` / `ProjectTag` | Global project tags (shared across sites) + M:N join |
| `custom_columns` | `CustomColumn` | User-defined Gantt columns: `column_type` CHECK(`text`/`boolean`/`list`), `list_options` JSON, site_id (NULL = global), display_order, width |
| `custom_column_values` | `CustomColumnValue` | EAV values: `entity_type` CHECK(`project`/`phase`/`subphase`) + entity_id, unique per (column, entity) |

**Assignments** (three staff levels + equipment)

| Table | Model | Purpose |
|-------|-------|---------|
| `project_assignments` | `ProjectAssignment` | Project-level staff: allocation %, own start/end dates |
| `phase_staff_assignments` | `PhaseStaffAssignment` | Phase-level staff: allocation only (dates come from the phase) |
| `subphase_staff_assignments` | `SubphaseStaffAssignment` | Subphase-level staff: allocation only |
| `equipment_assignments` | `EquipmentAssignment` | Equipment bookings: project + equipment + dates (project-level only; tenants provisioned before 1.0.15 may carry unused legacy phase/subphase columns) |

**Resources & time-off**

| Table | Model | Purpose |
|-------|-------|---------|
| `equipment` | `Equipment` | Lab equipment: name, type (free-form string, managed via `/equipment-types`), site_id |
| `equipment_blocks` | `EquipmentBlock` | Maintenance/unavailability windows (the vacation analogue for equipment) |
| `vacations` | `Vacation` | Staff time-off. Recurring absences are encoded in `description` as `[R:0,2,4]` (days of week, 0=Sun) — parsed by `frontend/src/utils/recurringVacation.ts` |
| `skills` / `user_skills` | `Skill` / `UserSkill` | Global skills + M:N with proficiency CHECK(1–5) |

**Misc**

| Table | Model | Purpose |
|-------|-------|---------|
| `staff_notes` | `Note` | Notes pinned to a site/date. Class is `Note` but tablename is **`staff_notes`**. All schema sources now create `staff_notes`; a legacy `notes` table on old installs is migrated and dropped by `migrations/add_staff_notes.sql` / the tenant auto-migration |
| `settings` | `Settings` | Instance key-value settings (e.g. `instance_title`, `show_weekends`) |
| `predefined_phases` | `PredefinedPhase` | Phase name templates offered in the UI |
| `project_presence` | `ProjectPresence` | Active-viewer rows (60s timeout). Written by the WS layer; presence has no HTTP API |

### Master database tables (`milestone_admin`)

| Table | Model | Purpose |
|-------|-------|---------|
| `tenants` | `Tenant` | Tenant registry: UUID id, name, slug (unique), database_name/user, status (`active`/`suspended`/`pending`/`archived`), plan/limits, `organization_id`, `required_group_ids` (JSONB) + `group_membership_mode` (`any`/`all`) for SSO group gating |
| `tenant_credentials` | `TenantCredentials` | Per-tenant DB password, AES-256-GCM encrypted (`iv:tag:ciphertext` hex) |
| `tenant_audit_log` | `TenantAuditLog` | Admin actions on tenants (actor, action, JSONB details) |
| `admin_users` | `AdminUser` | Portal admins: email, PBKDF2 password hash, role (`admin`/`superadmin`), `must_change_password` |
| `admin_sessions` | `AdminSession` | Admin-portal session store (same shape as tenant `sessions`) |
| `organizations` | `Organization` | Groups tenants for shared SSO |
| `organization_sso_config` | `OrganizationSSOConfig` | Org-level Entra SSO: tenant/client id, encrypted secret, redirect URI, auto-create + default role |

### Migrations

- Raw idempotent SQL files in `migrations/` — **no Alembic**. See `migrations/README.md`.
- **Tenant migrations**: `python migrations/run_migration.py <name>` — single-tenant: runs against `DB_NAME`; multi-tenant: iterates every `active` tenant from the master DB, connecting with `PG_ADMIN_*` (preferred) or the decrypted per-tenant credentials.
- **Master migrations**: `python migrations/run_migration_master.py <name>` — statement-by-statement execution via `split_sql_statements()`, which **correctly preserves `DO $$ ... END $$;` blocks** (covered by `tests/test_migration_parser.py`).
- The list of available migrations is the set of `.sql` files in `migrations/` — run either runner with no argument to list them. One stray legacy migration lives at `scripts/sql/migrations/001_add_max_capacity.sql`.
- **Auto-migrations run in two places** on top of the SQL files: `master_db._apply_pending_migrations()` (master schema drift, on startup) and `tenant_manager._run_auto_migrations()` (per-tenant drift, on first pool creation). Both are idempotent DDL.
- `setup_databases.sql` is the canonical fresh-install schema and must stay in sync with the models (see the schema-change checklist above).

---

## API Reference

All routers are mounted under `/api` (multi-tenant deployments reach them at `/t/{slug}/api/...`; the admin portal is always at `/api/admin/*` with no tenant prefix). Auth column: **user** = `get_current_user`, **superuser** = `require_superuser` (admin OR superuser), **admin** = `require_admin`, **portal** = `get_current_admin` (master DB), **superadmin** = `require_superadmin`, **public** = no auth.

### Health & diagnostics (`app/routers/health.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` and `/api/health` | public | Status, mode, version, DB reachability |
| GET | `/api/ws-debug` | user | WebSocket diagnostics (tenant, connection/online counts) |
| POST | `/api/ws-debug/broadcast` | user | Fire a synthetic `change:project` broadcast |

### Authentication & SSO (`app/routers/auth.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/login` | public | Email/password login → session + `connect.sid` cookie |
| POST | `/auth/logout` | session | Destroy session, clear cookie |
| GET | `/auth/me` | public | Current user (fresh from DB) or `{user: null}` |
| POST | `/auth/change-password` | user | Change own password (verifies current) |
| GET | `/sso/config` | public | Public SSO info for the login page (no secret) |
| GET | `/sso/config/full` | admin | Full SSO config incl. masked secret + org-precedence info |
| PUT | `/sso/config` | admin | Update tenant SSO (409 if org SSO active) |
| GET | `/auth/sso/config` | public | Public SSO config (`SSOConfigResponse`) |
| PUT | `/auth/sso/config` | admin | Update tenant SSO (alternate path, same guardrail) |
| GET | `/auth/sso/status` | public | Effective SSO status (org vs tenant) + group requirements |
| GET | `/auth/sso/login` | public | Build the Entra authorization URL (HMAC-signed `state` carries the slug) |
| GET | `/auth/sso/callback` | public | OAuth callback: token exchange, Graph `/me`, group validation, find/auto-create user, create session |

### Users & staff (`users.py`, `staff.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/users`, `/users/{id}` | superuser | List / detail |
| POST | `/users` | admin | Create user |
| PUT | `/users/{id}` | superuser | Update user |
| DELETE | `/users/{id}` | admin | Delete (rejects `is_system`) |
| PUT | `/users/{id}/toggle-active` | admin | Enable/disable |
| GET | `/staff`, `/staff/{id}` | user | Staff read views (staff *are* users — created via `/users`) |
| GET | `/staff/{id}/availability` | user | Availability calculation |
| GET | `/staff/{id}/assignments` | user | All assignments for a staff member (in `assignments.py`) |

### Sites, holidays & events (`sites.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/sites` | user | Current user's sites |
| GET | `/sites/all` | admin | All sites |
| GET | `/sites/{id}` | user | Site detail |
| POST / PUT / DELETE | `/sites`, `/sites/{id}` | admin | Site CRUD |
| GET | `/sites/{id}/holidays`, `/holidays` | user | Holidays per site / cross-site |
| POST / DELETE | `/sites/{id}/holidays`, `…/{hid}` | superuser | Add / remove holiday |
| POST | `/sites/{id}/holidays/refresh` | superuser | Fetch public holidays from the Nager API |
| GET | `/sites/{id}/events`, `/events` | user | Company events per site / all |
| POST / DELETE | `/sites/{id}/events`, `…/{eid}` | superuser | Create / delete event |

### Projects, phases & subphases (`projects.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/projects` | user | List (site-scoped, filters) |
| GET | `/projects/{id}` | user | Detail with phases/subphases/assignments |
| POST / PUT / DELETE | `/projects`, `/projects/{id}` | superuser | Project CRUD |
| POST | `/projects/{id}/phases` | superuser | Add phase |
| PUT / DELETE | `/phases/{id}` | superuser | Update / delete phase |
| PUT | `/projects/{id}/phases/reorder` | superuser | Reorder phases |
| POST | `/phases/{id}/subphases` | superuser | Add subphase to a phase |
| POST | `/subphases/{id}/children` | superuser | Add nested subphase |
| PUT / DELETE | `/subphases/{id}` | superuser | Update / delete subphase |
| PUT | `/subphases/{parent}/reorder` | superuser | Reorder subphases |

These handlers call rich `broadcast_change()` — their paths are in `BroadcastMiddleware.SKIP_PATTERNS`.

### Assignments (`assignments.py` — note the three per-level route families)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/projects/{id}/staff` | superuser | Assign staff at project level |
| PUT / DELETE | `/assignments/{id}` | superuser | Update / remove project-level assignment |
| POST | `/phases/{id}/staff` | superuser | Assign staff at phase level |
| PUT / DELETE | `/phase-staff/{id}` | superuser | Update / remove phase-level assignment |
| POST | `/subphases/{id}/staff` | superuser | Assign staff at subphase level |
| PUT / DELETE | `/subphase-staff/{id}` | superuser | Update / remove subphase-level assignment |
| POST | `/projects/{id}/equipment` | superuser | Book equipment on a project |

⚠ `PUT/DELETE /equipment-assignments/{id}` is defined in **both** `assignments.py` and `equipment.py`; `equipment.py` is registered first in `main.py`, so its handlers win. Edit the equipment-router versions.

### Equipment (`equipment.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/equipment-types` | user | Distinct equipment types |
| PUT / DELETE | `/equipment-types/{name}` | superuser | Rename / delete a type |
| GET | `/equipment` | user | Site-scoped list |
| GET | `/equipment/all` | superuser | All equipment |
| GET | `/equipment/{id}` | user | Detail |
| POST / PUT / DELETE | `/equipment`, `/equipment/{id}` | superuser | Equipment CRUD |
| GET | `/equipment/{id}/assignments` | user | Bookings for one piece of equipment |
| PUT / DELETE | `/equipment-assignments/{id}` | superuser | Update / delete booking |
| GET | `/equipment/{id}/availability` | user | Availability calculation |
| GET | `/equipment-blocks`, `/equipment/{id}/blocks` | user | Maintenance blocks (all / per equipment) |
| POST / PUT / DELETE | `/equipment-blocks`, `…/{id}` | superuser | Block CRUD |

### Vacations, notes, skills, tags (`vacations.py`, `notes.py`, `skills.py`, `tags.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET / POST / PUT / DELETE | `/vacations`, `/vacations/{id}` | user | Vacation CRUD (own-user checks inside handlers) |
| GET | `/notes` | user | List staff notes |
| POST / DELETE | `/notes`, `/notes/{id}` | superuser | Create / delete note |
| GET | `/skills`, `/skills/{id}` | user | Skills list / detail |
| POST / PUT / DELETE | `/skills`, `/skills/{id}` | superuser | Skill CRUD |
| GET | `/skills/user/{uid}` | user | A user's skills |
| PUT | `/skills/user/{uid}` | superuser | Replace a user's skills |
| POST / DELETE | `/skills/user/{uid}/{sid}` | superuser | Add / remove one skill |
| GET | `/tags` | user | List tags |
| POST / PUT / DELETE | `/tags`, `/tags/{id}` | superuser | Tag CRUD |

### Custom columns (`custom_columns.py`, prefix `/custom-columns`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/custom-columns`, `/custom-columns/with-values` | user | Columns / columns with values |
| POST / PATCH / DELETE | `/custom-columns`, `…/{id}` | admin | Column CRUD |
| PATCH | `/custom-columns/reorder` | admin | Reorder columns |
| PUT | `/custom-columns/values`, `…/values/batch` | user | Write values (single / batch) |
| DELETE | `/custom-columns/values/{col}/{etype}/{eid}` | user | Clear a value |

### Predefined phases & settings (`predefined_phases.py`, `settings.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/predefined-phases` | user | Active phase templates |
| GET | `/predefined-phases/all` | superuser | All templates |
| POST / PUT / DELETE | `/predefined-phases`, `…/reorder`, `…/{id}` | superuser | Template CRUD + reorder |
| GET | `/settings`, `/settings/{key}` | ⚠ none | Instance settings (no auth dependency — do not store secrets in `settings`) |
| PUT | `/settings/{key}` | admin | Update setting |
| GET / PUT | `/settings/sso` | none / admin | Tenant SSO settings (read / write) |

### Import & export (`mpp_import.py`, `export.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/import/mpp/test` | superuser | Verify the MPP parser (Java/mpxj) is functional |
| POST | `/import/mpp` | superuser | Parse an uploaded MS Project file |
| POST | `/import/project` | superuser | Import a parsed project |
| GET / POST | `/import/test`, `/import/test-upload` | public | Import diagnostics |
| POST | `/export/mpp/{pid}` | superuser | Export project to MPP |
| GET / POST | `/export/csv/{pid}` | superuser | Export project to CSV |
| GET | `/export/site/{sid}/excel` | superuser | Full site export to `.xlsx` (see Site Export contract) |

### Admin portal (`routers/admin/*` → `/api/admin/*`, master DB, `admin_session` cookie)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/admin/auth/login` / `/admin/auth/logout` | public / portal | Portal login/logout |
| GET | `/admin/auth/me` | optional | Current admin |
| POST | `/admin/auth/change-password` | portal | Change password (min 8 chars; clears `must_change_password`) |
| GET | `/admin/tenants`, `/admin/tenants/{id}` | portal | Tenant list / detail |
| POST / PUT / DELETE | `/admin/tenants`, `…/{id}` | portal | Tenant CRUD |
| PUT | `/admin/tenants/{id}/status` | portal | active / suspended / archived |
| POST | `/admin/tenants/{id}/provision` | portal | Provision the tenant database |
| POST | `/admin/tenants/{id}/reset-admin-password` | portal | Reset the tenant's admin password |
| GET | `/admin/tenants/{id}/audit` | portal | Tenant audit log |
| GET | `/admin/stats` | portal | System statistics |
| GET / POST / PUT / DELETE | `/admin/users`, `…/{id}` | superadmin | Admin-user CRUD |

### Organizations (`admin_organizations.py` → `/api/admin/organizations`, all portal auth)

| Method | Path | Description |
|--------|------|-------------|
| GET / POST / PUT / DELETE | ``, `/{id}` | Organization CRUD |
| GET / PUT / DELETE | `/{id}/sso` | Organization SSO config (encrypted secret) |
| PUT / DELETE | `/{id}/tenants/{tid}` | Attach / detach a tenant |
| PATCH | `/tenants/{tid}/groups` | Set tenant SSO group access (`required_group_ids`, `group_membership_mode`) |

### No HTTP presence API

There are no HTTP presence endpoints — presence works exclusively through the WebSocket layer. (A never-registered `presence.py` router and its frontend polling counterpart were removed as dead code.)

---

## Authentication, Sessions & SSO

### Two independent auth systems

| | Tenant app | Admin portal |
|---|---|---|
| Cookie | `connect.sid` (`s%3A<id>.` express format) | `admin_session` (raw id) |
| Session store | `sessions` table, **tenant DB** | `admin_sessions` table, **master DB** |
| Users | `users` (tenant DB) | `admin_users` (master DB) |
| Roles | `admin` > `superuser` > `user` | `superadmin` > `admin` |
| Password hash | bcrypt (rounds=12), lazy upgrade from legacy PBKDF2/plaintext on login | PBKDF2-SHA512 |
| Dependencies | `get_current_user`, `require_superuser`, `require_admin` (`app/middleware/auth.py`) | `get_current_admin`, `require_superadmin` (`app/routers/admin/auth.py`) |

- `SessionService` (`app/services/session.py`) stores the full user dict (incl. site ids/names) in the session; `get_current_user_optional` builds a lightweight `SessionUser` from it without a DB hit, while `get_current_user` fetches fresh and also stashes the user into `scope["state"]` for broadcast attribution.
- On startup, `master_db.verify_admin_exists()` auto-creates `admin@milestone.local` (superadmin, random password logged, `must_change_password=true`) if no admin exists.

### Tenant role model

- `user` — read access + self-service (own vacations, custom-column values).
- `superuser` — everything a user can, plus manage projects/phases/assignments, staff-affecting data, equipment, holidays/events, predefined phases, tags, skills — within their sites.
- `admin` — everything, plus sites, users, settings, SSO config, custom-column definitions, API docs access.
- `is_system=true` marks the provisioned admin; deletion is rejected.

### Microsoft Entra SSO

Two configuration levels, resolved by `SSOService.get_effective_sso_config()`:

1. **Organization SSO** (master DB, `organization_sso_config`) — shared by every tenant in the organization; secret encrypted; **takes precedence**. Tenant-level SSO cannot be enabled while org SSO is active (409, `_reject_if_org_sso_active` — covered by `tests/test_sso_guardrails.py`).
2. **Tenant SSO** (`sso_config` singleton in the tenant DB) — per-tenant fallback.

Flow: `GET /auth/sso/login` builds the Entra authorization URL with an **HMAC-signed `state` carrying the tenant slug** (org SSO uses one shared callback URL with no `/t/{slug}/` prefix, so the slug must survive the round-trip) → `GET /auth/sso/callback` verifies the state, exchanges the code, fetches the profile from Microsoft Graph `/me`, optionally validates group membership (`fetch_user_groups` pages Graph `/me/memberOf`; `required_group_ids` + `group_membership_mode` `any`/`all` on the tenant), finds or auto-creates the user (`auto_create_users`, `default_role`), creates a session, and redirects to `/t/{slug}/`.

## Multi-Tenancy Internals

- **`TenantMiddleware`** (`app/middleware/tenant.py`) is a **pure ASGI middleware** (not `BaseHTTPMiddleware` — that breaks WebSockets). It matches `/t/{slug}/...`, resolves the tenant through a 60-second in-memory cache (plain dicts, not ORM objects, to avoid session-detachment issues), rewrites `scope["path"]` to strip the prefix, and stores `tenant` / `tenant_slug` / `tenant_engine` in `scope["state"]`. Missing/inactive/unreachable tenants → 404/403/503. WebSocket scopes are passed through untouched (the WS handler resolves the tenant itself). Only wraps the app when `MULTI_TENANT=true`.
- ⚠ **`scope["state"]` is a plain dict** here — `request.state.tenant_slug` attribute access does not work; read `request.scope["state"]["tenant_slug"]` (the broadcast helper handles both forms).
- **`tenant_manager`** (`app/services/tenant_manager.py`) keeps lazy per-tenant engine pools (size 20 + 10 overflow), closes pools idle > 15 min (cleanup loop every 5 min), decrypts the tenant DB password on first connect, and runs idempotent per-tenant auto-migrations on pool creation.
- **`tenant_provisioner`** (`app/services/tenant_provisioner.py`) creates the PG role + database, grants, applies the tenant schema, and seeds defaults (predefined phases, skills, "Main Site", admin user). It validates identifiers against injection and handles **managed PostgreSQL** (Azure/RDS/Cloud SQL) where the admin is not a superuser: grants the tenant role to the admin before `CREATE DATABASE` and reassigns `public` schema ownership.
- Tenant DB credentials are stored AES-256-GCM-encrypted (`iv:tag:ciphertext` hex, key = `TENANT_ENCRYPTION_KEY`) in `tenant_credentials`, Node-compatible format.

## Real-Time Collaboration

### Backend (`app/websocket/`)

- Endpoints: `/ws` (single-tenant) and `/t/{slug}/ws` (multi-tenant), in `handler.py`. Auth = the `connect.sid` cookie validated against the tenant DB. Close codes **4001–4006** signal auth/session failures (no session, invalid session, user disabled, replaced connection, …).
- `ConnectionManager` (`manager.py`, global `manager`): per-tenant rooms, multiple connections per user (multi-tab), presence join/leave/list with deduped online users, `broadcast_to_tenant(exclude_user/exclude_connection)`, asyncio-lock guarded.
- **Two broadcast tiers**: routers with meaningful UX events call `broadcast_change(request, user, entity_type, entity_id, project_id, action, summary)` (`broadcast.py`) → clients receive an attributed `change:<entity>` with user name and summary. All other successful writes get a coarse `change:<entity>` from `BroadcastMiddleware` (sender excluded; `SKIP_PATTERNS` prevents doubles).
- Receive loop handles `ping` → `pong` (client pings every 25 s).

### Frontend

- `useWebSocket` (`src/hooks/useWebSocket.ts`): connects to `ws(s)://<host><tenantPrefix>/ws`, exponential backoff (2 s base, 60 s max, 5 attempts), does **not** reconnect on close codes 1000/1001/4000–4006, tracks `onlineUsers` (presence messages) and `recentChanges` (any `change:*`, expiring 30 s after local receipt to dodge clock skew).
- `WebSocketContext` (`src/contexts/WebSocketContext.tsx`) turns changes into data refreshes: `slicesForEntity()` maps entity type → data slices (`phase`→`projects`, `staff`→`staff`+`projects`, unknown → everything), then refreshes via a **200 ms debounced, coalesced** runner with an in-flight guard that re-stages if more changes arrive mid-fetch. A phase drag producing N child updates results in one refetch per slice. Unknown entity types refresh everything, so new backend entities need no client change.
- `useEntityChangeIndicator(entityType, entityId)` drives the `ChangeIndicator` badges ("changed by X"); `OnlineUsers` and `ActivityFeed` render presence and the change feed.

---

## Frontend Architecture

### Tech stack

React 18 + TypeScript 5.6, Vite 7, Zustand 5, TanStack Query 5 (client cache defaults: staleTime 5 min, retry 1, no refetch-on-focus), date-fns 4, CSS Modules. There is **no router package** — `react-router-dom` was removed as unused; there is no route tree.

### Routing without a router

- `src/main.tsx` boots the QueryClient, theme, legacy-storage migration, and wires the API client to `whatIfStore` (`configureApiClient`).
- `src/App.tsx` renders by branching: `window.location.pathname` starting with `/admin` → `AdminApp` (a fully separate admin-portal app: `AdminLoginScreen` / `AdminDashboard` with tenants/organizations/admins/stats tabs); otherwise auth state decides `LoginScreen` vs the main app (`WebSocketProvider` → `MainLayout` + `ModalContainer` + `ContextMenuContainer` + `ActivityFeed`).
- In-app navigation = `viewStore.currentView` (`gantt` | `staff` | `equipment` | `crosssite` | `archived`) switched by the sidebar; **views are state, not URLs**.
- The tenant prefix `/t/{slug}` comes from the URL: `getTenantPrefix()` in `client.ts` prepends it to every `/api/` call. Deep links work because FastAPI's catch-all (prod) or `tenantSpaPlugin` (dev) serve `index.html` for `/t/*` paths.

### Zustand stores (`src/stores/`)

| Store | Persisted | Purpose |
|-------|-----------|---------|
| `appStore` | only `_persistedSiteId` | Domain data (sites, projects, staff, equipment, blocks, vacations, holidays+date Sets, events, users, skills, tags, instance settings), auth state, current site/user, critical-path state. Site switch **clears undo history**. Exports selectors (`selectSiteProjects`, `selectCanManageResources`, …) |
| `viewStore` | yes | View mode (`week`/`month`/`quarter`/`year`) + per-mode cell widths, current view, current date, expansion Sets (projects/phases/subphases/staff/equipment), level-based expand/collapse, scroll position, panel collapse flags, overview toggles (staff/equipment — mutually exclusive) |
| `uiStore` | no | Active modal + editing context, tooltip, drag/resize state, drag indicator, dependency-linking state, phantom-sibling state, context menu, scroll/zoom triggers, resource drag |
| `whatIfStore` | no | What-If mode flag, `structuredClone` snapshot of projects, queued operations |
| `undoStore` | no | Undo/redo stacks of project-tree snapshots (max 50) |
| `customColumnStore` | visibility only | Columns, values map (key `"{columnId}-{entityType}-{entityId}"`), per-column filters (`__empty__` sentinel for blanks), visibility |
| `adminStore` | no | Admin portal: admin user, tenants, organizations, admin users, stats, active tab |

Persistence gotcha: Sets are serialized as arrays and restored in custom `merge` functions; `currentDate` persists as an ISO string.

### API client (`src/api/client.ts`)

- `apiRequest<T>` + `apiGet/Post/Put/Patch/Delete` + `downloadFile` (Content-Disposition-aware).
- Cookie auth (`credentials: 'include'`) — no token headers.
- Dev detection: when the page runs on port 3333, API and WS target `:8485` directly (no Vite proxy).
- FastAPI 422 validation errors are flattened to `field: message` strings; non-JSON responses raise with the first 200 chars logged (catches proxy HTML).
- **What-If interception** happens here (see What-If Mode).

### Transform layer (`src/api/endpoints/projects.ts`)

All backend↔frontend field mapping is centralized: `transformProject/Phase/Subphase/StaffAssignment/EquipmentAssignment` handle snake_case↔camelCase, phase `type`↔`name`, `sort_order`↔`order_index`, and inject theme colors (`getPhaseColor`, `getDepthColor`) client-side. `loadAllProjects()` fetches the list then each project detail in parallel. Assignment CRUD routes differ by level (`/assignments/{id}` vs `/phase-staff/{id}` vs `/subphase-staff/{id}`) — the endpoint module picks the right one.

### Gantt architecture (`src/components/gantt/`)

- `GanttContainer` orchestrates: filters projects to the current site (non-archived), applies per-site custom ordering (localStorage via `getProjectOrder`/`sortProjectsByOrder`; default = confirmed-first, then name), memoizes timeline cells/headers, and renders **`ProjectPanel` (left tree) + resizer + `Timeline` (right)** inside `TimelineScrollProvider`, with optional embedded staff/equipment overview panels below (admin/superuser only).
- `ProjectPanel/`: header actions (new/import/manage columns/visibility) + rows `ProjectRow → PhaseRow → SubphaseRow → AssignmentRow` + custom-column cells; wrapped in `ReorderProvider`.
- `Timeline/`: `TimelineHeader` + `TimelineBody` — grid cells (weekend/holiday/company-event backgrounds; week separators when weekends are hidden), `TodayLine`, per-project bars (`ProjectBar`/`PhaseBar`), `DependencyLayer` (arrows), phantom overlays, `DragIndicator`, `ResourceDropOverlay`. Handles scroll persist/restore (200 ms debounce), zoom re-centering on the visible center date, view-mode changes preserving the left-edge date, Ctrl+wheel zoom, and scroll-to-today/date triggers.
- Scroll sync: `TimelineScrollContext` (horizontal, direct DOM with feedback-loop guard) across Gantt/Staff/Equipment timelines; `useScrollSync` (vertical) between tree panel and timeline body.
- **Drag pipeline** (`useDragAndDrop`): mousedown on a bar → live DOM movement with cell snapping (week/month) and a dependency lag indicator → on drop, `commitDragUpdate` computes new dates from pixels, prompts `window.confirm` for whole-project moves, snapshots undo state, clones and mutates the project tree (cascading children + assignments), updates the store optimistically, then persists via batched `PendingUpdate`s (`savePendingUpdates`). **Any persist error → reload all projects + clear undo.**
- **Auto-calculation semantics** (`gantt/utils/autoCalculation.ts`): dependencies auto-align **only at creation time**; moving an item does *not* cascade to its dependents (users keep manual lead/lag control). Moves do (a) expand/contract parents to the union of their children and (b) auto-fit project dates to phases. Staff-assignment updates must include `allocation` (backend requirement).
- **Critical path** (`utils/criticalPath.ts`): full CPM forward/backward pass, `totalFloat <= 0` = critical; loaded via dynamic import from `appStore.toggleCriticalPath` to avoid a circular dependency.
- **Undo/redo** (`useUndoRedo` + `utils/diffProjects.ts`): restore snapshot, diff old-vs-new date fields into minimal `PendingUpdate`s, persist; on failure reload + clear history.

### Hooks catalog (`src/hooks/`)

| Hook | Purpose |
|------|---------|
| `useAuth` | Mount-time `checkAuth()`, login/logout (logout resets `appStore`) |
| `useDataLoader` | Parallel initial data load + site resolution + granular refreshers (`refreshProjects`, `refreshSiteData`, …) used by the WS refetch layer |
| `useWebSocket` / `WebSocketContext` | See Real-Time Collaboration |
| `useDragAndDrop` | Gantt bar dragging (see drag pipeline); gated on admin/superuser |
| `useResize` | Bar edge resizing with date recalculation |
| `useResourceDragDrop` | HTML5 drag of staff/equipment from ResourcePanel onto rows; creates a 5-day default assignment (staff allocation defaults to `max_capacity`) |
| `useTouchDrag` | Touch → synthetic mouse-event adapter |
| `useDependencyLinking` | Two-click dependency creation |
| `usePhantomSibling` | Shift+click spawns a phantom sibling bar following the cursor (lag computed on placement) |
| `useUndoRedo` | Undo/redo orchestration (see above) |
| `useKeyboardShortcuts` | Esc (modal → linking → phantom priority), Home (today), `+`/`-` zoom (12–120 px), Ctrl/Cmd+Z / Ctrl/Cmd+Y / Ctrl/Cmd+Shift+Z |
| `useEscapeKey` | Escape-to-close for standalone dialogs that can't use the shared `Modal` (e.g. the admin-portal modals) |
| `useCtrlScrollZoom` | Ctrl+wheel zoom keeping the date under the cursor fixed |
| `useScrollSync` | Vertical scroll sync between two elements |
| `useWorkloadCalculation` | Per-cell staff workload for the Staff heatmap (allocations, vacations incl. recurring, visual states) |
| `useEquipmentOverlaps` | Equipment double-booking detection + today-status (`blocked` > `booked` > available) |

### Utilities worth knowing (`src/utils/`)

`date.ts` (~24 date helpers incl. business-day math), `storage.ts` (typed storage wrappers, `STORAGE_KEYS`, theme system setting `data-theme` on `<html>`, legacy `rd_*` key migration, per-site project order), `themeColors.ts` (phase/depth colors from CSS vars), `recurringVacation.ts` (`[R:0,2,4]` pattern), `equipmentOverlap.ts`, `csvExport.ts` (MS-Project-compatible CSV: outline levels, `ID{FS|SS|FF|SF}±lag` predecessors), `xmlExport.ts` (MS Project XML), `criticalPath.ts`, `diffProjects.ts`.

## What-If Mode

A client-side planning sandbox — the server is never aware of it.

- Entering (`WhatIfToggle` → `whatIfStore.enterWhatIfMode`) snapshots `appStore.projects` via `structuredClone` and adds a `what-if-mode` body class.
- While active, the **API client** intercepts every PUT/POST/DELETE (except `/api/auth/*` and `/api/settings/*`): the request is queued as a `WhatIfOperation {method, url, body}` and a fake success `{success: true, whatIfMode: true}` is returned, so optimistic local state updates normally.
- **Discard**: restore the snapshot, drop the queue. **Apply**: temporarily disable the interception check, replay queued operations sequentially with real requests; on error the snapshot is **not** restored (some writes may have landed — the user should reload). The interception check is always restored in `finally`.
- Implications for new code: any new write endpoint is queued by default (see Frontend Conventions); operations that depend on real server responses (created IDs used by later operations) do not work correctly inside What-If — the queue replays with the original bodies.
- Known limitations: MPP import uploads via a raw `fetch` that bypasses the queue, so `ImportProjectModal` blocks importing while What-If is active. Custom-column *definition* changes are queued but live in `customColumnStore`, which is not snapshotted — a definition created/deleted during What-If is not rolled back locally on Discard (reload to resync).

## Import & Export

### Site Export to Excel

- Endpoint: `GET /t/{slug}/api/export/site/{site_id}/excel` (admin / superuser only; superusers limited to sites they belong to).
- Implemented in `app/routers/export.py` — `build_site_export_workbook()` generates a multi-sheet `.xlsx` via `openpyxl`.
- Current sheets: Site, Projects (hierarchy with phases/subphases), Users, Equipment, Skills, User skills, Tags, Project tags, Vacations, Project assignments, Phase assignments, Subphase assignments, Equipment assignments, Custom columns, Custom column values, Bank holidays, Company events, Equipment blocks, Staff notes.
- **IMPORTANT**: any new data added at the site level through future enhancements (e.g. equipment maintenance/blocks, new event types, additional site-scoped settings, new assignment kinds, etc.) **must** be added as a new sheet (or a new column on the existing sheet) in `build_site_export_workbook()`. The site export is the canonical "everything for this site" snapshot — do not let it drift behind the model.

### MS Project & CSV

- **MPP import** (`app/routers/mpp_import.py`) parses `.mpp` files via `jpype1` + `mpxj` — requires a JVM. The Docker image includes `default-jre-headless`; local dev environments usually don't. `GET /import/mpp/test` verifies the toolchain.
- **MPP/CSV export** (`app/routers/export.py`) exports single projects server-side; the frontend also generates MS-Project-compatible CSV (`utils/csvExport.ts` — outline levels, `ID{FS|SS|FF|SF}±lag` predecessor syntax, % complete, milestones) and MS Project XML (`utils/xmlExport.ts`) client-side.

## Security

- **Startup/runtime**: docs endpoints admin-gated; global exception handler returns opaque 500s; Docker runs as non-root `appuser` with a `/health` healthcheck.
- **Secrets at rest**: tenant DB passwords and SSO client secrets AES-256-GCM encrypted (`app/services/encryption.py`); `TENANT_ENCRYPTION_KEY` (64-char hex) required in multi-tenant mode (single-tenant derives a key from `SESSION_SECRET`).
- **Passwords**: bcrypt rounds=12 (tenant users, lazy upgrade from legacy hashes on login); PBKDF2-SHA512 (admin users).
- **Sessions**: HTTP-only cookies; `SECURE_COOKIES=true` for HTTPS deployments; expired-session cleanup in `SessionService`.
- **SSO**: HMAC-signed state; secrets never returned unmasked (`/sso/config/full` masks); optional Entra group gating per tenant.
- **Provisioning**: tenant identifiers validated against SQL injection in `tenant_provisioner`.
- ⚠ `GET /settings` and `GET /settings/{key}` have no auth dependency — never store sensitive values in the tenant `settings` KV table.

## Docker & Deployment

**Dockerfile** (3 stages):
1. `builder` (`python:3.11-slim-bookworm` + libpq-dev/gcc/g++) — pip-installs `requirements.txt` to `/install` (g++ needed for `psutil`/`jpype1` source builds).
2. `frontend` (`node:24-alpine`) — `npm ci && npm run build`.
3. `runtime` (`python:3.11-slim-bookworm`) — runtime libs only (`libpq5`, **`default-jre-headless`** for MPP import, `curl`), non-root `appuser`, copies `VERSION` + `app/` + `migrations/` + built frontend → `public/`, healthcheck on `/health`, `EXPOSE 8485`, uvicorn via `docker-entrypoint.sh` (waits for DB(s), optional `AUTO_INIT_DB`).

**Compose files**:

| File | Services | Ports | Use case |
|------|----------|-------|----------|
| `docker-compose.yml` | `milestone` | 8485 | Production against an external PostgreSQL (`.env`-configured; Unraid-style uploads volume) |
| `docker-compose.fresh.yml` | `db` (postgres:15-alpine) + `milestone` | 8486 app / 5433 db (overridable via `FRESH_*`) | Self-contained fresh install: `AUTO_INIT_DB=true`, seeded admin, named volumes |
| `docker-compose.external-db.yml` | `milestone` | 8485 | Managed PostgreSQL (RDS/Azure/Cloud SQL) with auto-init (needs `PG_ADMIN_*`) |
| `docker-compose.dev.yml` | `milestone` + `milestone-react-dev` | 8485 + 3333 | Backend + hot-reload React dev server |
| `docker-compose.react-dev.yml` | `milestone-api` + `milestone-react-dev` | 8485 + 3333 | Unraid variant of the dev setup |

Health endpoint responds at **both** `/health` and `/api/health` (status, mode, version, DB check).

## CI

Four workflows in `.github/workflows/` (push to `main` + PRs; version-check is PR-only):

| Workflow | Jobs / enforcement |
|----------|--------------------|
| `backend.yml` | ruff check + format check on `app/`; pytest with coverage; mypy |
| `frontend.yml` | eslint; vitest; `npm run build` (tsc + vite) |
| `docker.yml` | `docker build` of the production image |
| `version-check.yml` | `dorny/paths-filter` on app-code paths → fails the PR unless `VERSION` changed vs `main` **and** `CHANGELOG.md` has a matching `## [<version>]` heading |

Docs are **not** built by Actions — Cloudflare Pages builds them from `docs/build.sh` on push. There are no issue or PR templates in `.github/` (only `FUNDING.yml`).

## Gotchas

- The master and tenant databases use **separate SQLAlchemy Base classes** (`MasterBase` vs `Base`). Don't mix them.
- `setup_databases.sql`, the provisioner schema (`tenant_provisioner.get_tenant_schema_sql()`), and `scripts/sql/tenant_schema_template.sql` must all stay in sync with the models — follow the schema-change checklist.
- The `Note` model's tablename is **`staff_notes`**. All schema sources create `staff_notes` now; databases from old installs may carry a legacy `notes` table until `migrations/add_staff_notes.sql` or the tenant auto-migration runs (it migrates the rows and drops `notes`).
- Presence is WebSocket-only — there is no HTTP presence API (a dead, never-registered presence router and its `usePresence` polling hook were removed).
- `PUT/DELETE /equipment-assignments/{id}` is defined in both `equipment.py` and `assignments.py`; `equipment.py` wins (registered first). Edit there.
- `request.state.X` does **not** work for tenant info — `TenantMiddleware` writes a plain dict into `scope["state"]`; read `request.scope["state"]["tenant_slug"]`.
- The Vite dev server (:3333) has **no API proxy** — the client targets `:8485` directly, so the backend must be running; full tenant/WS behaviour is best tested on `:8485` with the built frontend.
- `run_migration_master.py` handles `DO $$ ... END $$;` blocks correctly (`split_sql_statements()`, tested in `tests/test_migration_parser.py`) — but keep migrations idempotent regardless.
- MPP file import requires Java (JRE 11+), included in the Docker image but not in dev environments by default.
- The User model has a `full_name` property — use it instead of manual `first_name + last_name` concatenation.
- Middleware must be **pure ASGI** — `BaseHTTPMiddleware` breaks WebSocket connections (this is why a timing middleware was removed).
- `config.app_version` is a stale, unused default — the real version comes from `/VERSION` via `app/__init__.py`.
- Zustand persistence: Sets serialize as arrays with custom `merge` restore; don't persist Maps.
- New backend write endpoints are What-If-queued and coarse-broadcast by default — check both the client exemption list and `BroadcastMiddleware.SKIP_PATTERNS` when that's wrong for your endpoint.
