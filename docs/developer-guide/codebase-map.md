# Codebase map

The orientation reference for Milestone Planner: the request path through the middleware, the vocabulary used across code and docs, the file-by-file project tree, every environment variable, the site export and MS Project import/export, the Docker image and compose files, and the CI workflows. It was moved verbatim out of the repo-root [`CLAUDE.md`](https://github.com/vincentmakes/milestone-planner/blob/main/CLAUDE.md), which keeps only the rules and links here.

Code described: the whole repository — `app/`, `frontend/`, `migrations/`, `scripts/`, `tests/`, `Dockerfile`, `docker-compose*.yml`, `.github/workflows/`.

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
│  milestone_master │   │  milestone_<slug>                    │
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
- **Site** — a physical location *within* a tenant (labs/offices). Most data (projects, equipment, holidays, events) is site-scoped; users belong to one or more sites via `user_sites`, equipment via `equipment_sites`, company events via `company_event_sites`. **Sites scope the UI, not access**: superusers act tenant-wide on projects/phases/assignments/vacations/notes (deliberate — `project_access.py`); site membership is enforced only for holidays, events, equipment, equipment blocks and equipment types (`site_access.py`).
- **Organization** — a master-DB grouping of tenants that share one Microsoft Entra SSO configuration.
- **Tenant roles** (`users.role`): `admin` > `superuser` > `user`. Superusers manage projects/staff/equipment (calendar and equipment data only at their own sites, see [Site](#terminology)); admins additionally manage sites, users, and settings. A `user` set as a project's manager (`pm_id`) edits that one project, and anyone manages their own staff assignments (see [Tenant role model](auth-and-tenancy.md#tenant-role-model)).
- **Admin-portal roles** (`admin_users.role`): `superadmin` > `admin`. These are master-DB accounts for the `/admin` portal, completely separate from tenant users. Don't confuse tenant `admin` with portal `admin`.
- **Phase / Subphase** — projects contain phases; subphases nest recursively under phases or other subphases (`parent_type` = `phase`|`subphase`, with `depth`).
- **Equipment block** — maintenance/unavailability window on equipment (the equipment analogue of a vacation).
- **Site closure** — a company event with `counts_as_unavailable = true`: every staff member on one of the event's sites is unavailable for its dates (like an unavailable absence). Plain events and bank holidays never reduce capacity.
- **Tag / tag group** — tags are coloured project labels, tenant-wide but optionally limited to some sites (`all_sites` + `tag_sites`). A *tag group* (e.g. *Project type*) categorises tags; a **single-select** group allows one of its tags per project. Any user can colour the Gantt project bars by a group (*Colour by*, a per-browser preference — the bar takes the colour of the project's tag from that group; not a group setting). Admin-managed in Settings → Tags; attaching is part of editing a project.
- **Absence / absence type** — a vacation row is an *absence*; its tenant-wide *absence type* (Holidays, Home Office, Illness, …) decides via `counts_as_unavailable` whether it reduces capacity. Home Office is shown but leaves the person plannable.
- **What-If mode** — a client-side sandbox: edits are queued locally instead of sent to the server, then applied or discarded.

## Project Structure

```
VERSION                # Single source of truth for the app version (one line, no `v`)
CHANGELOG.md           # Keep a Changelog; one `## [x.y.z] - date` heading per release
LICENSE                # FSL-1.1-MIT (each release becomes MIT two years after publication)
README.md              # Badges, features, quick start, license summary
UI_GUIDELINES.md       # Frontend design tokens, shared components, layout patterns, known drift
CONTRIBUTING.md / SECURITY.md  # Pointers to the contributing guide / private vulnerability reporting
pyproject.toml         # pytest (asyncio_mode=auto), coverage (fail_under, greenlet concurrency)
requirements.txt / requirements-dev.txt
mkdocs.yml             # MkDocs Material nav (Home, User / Admin / Developer Guide)
Dockerfile             # 3-stage build (see Docker & Deployment)
docker-compose*.yml    # yml (Unraid prod), fresh, external-db, dev, react-dev
docker-entrypoint.sh   # DB wait + optional AUTO_INIT_DB, then uvicorn
deploy-react.sh        # Copies frontend/dist → public/ atomically
setup_databases.sql    # Canonical full schema for fresh installs
.env.example           # Environment template
app/
  __init__.py          # Reads /VERSION → __version__
  main.py              # create_app()/create_wrapped_app(), lifespan, router registration,
                       #   CustomJSONResponse, CORS, gated API docs, static mounts + SPA catch-all
  config.py            # Pydantic settings (env vars); get_settings() lru_cached
  database.py          # Tenant DB engine/session (get_db / get_db_readonly) + declarative Base
  utils.py             # utcnow_naive() — all DB datetime columns are naive TIMESTAMP holding UTC
  scripts/             # init_db.py (AUTO_INIT_DB target), seed_demo.py (CLI for the `demo`
                       #   tenant: provision + register, then services/demo_seed), demo_data.py
                       #   (the demo data set as plain Python, keyed by names, dates relative to
                       #   today, admin e-mail / instance title as parameters — tested without a DB)
  models/              # SQLAlchemy ORM models
    tenant.py          # MasterBase + Tenant, TenantCredentials, TenantAuditLog,
                       #   AdminUser, AdminSession (master DB)
    organization.py    # Organization, OrganizationSSOConfig (master DB)
    project.py         # Project, ProjectPhase, ProjectSubphase (recursive)
    user.py            # User (full_name property, role, max_capacity, is_system), UserSite
    assignment.py      # ProjectAssignment, PhaseStaffAssignment, SubphaseStaffAssignment
    equipment.py       # Equipment (sites M:N, site_ids), EquipmentSite, EquipmentAssignment, EquipmentBlock
    site.py            # Site, BankHoliday, CompanyEvent (counts_as_unavailable = closure),
                       #   CompanyEventSite (event ↔ site M:N)
    skill.py           # Skill, UserSkill
    vacation.py        # Vacation (absence_type_id; recurring pattern encoded in description)
    absence_type.py    # AbsenceType (+ DEFAULT_ABSENCE_TYPES seed list)
    custom_column.py   # CustomColumn, CustomColumnValue (EAV)
    tag.py             # Tag (group_id, all_sites, sort_order, sites M:N), TagGroup (single_select),
                       #   TagSite, ProjectTag
    card_comment.py    # CardComment — Kanban card comments, polymorphic (entity_type, entity_id),
                       #   mentioned_user_ids derived from the body
    notification.py    # Notification — per-recipient inbox (due-soon/overdue are derived client-side)
    note.py            # Note — tablename is staff_notes
    settings.py        # Settings (KV), PredefinedPhase, SSOConfig (singleton)
    session.py         # Session (express-session compatible)
    presence.py        # ProjectPresence
  routers/             # FastAPI route handlers (registered in main.py)
    absence_types.py   # Absence type CRUD + reorder (writes admin-only)
    admin/             # Admin portal: auth.py, tenants.py, users.py → /api/admin/*
    admin_organizations.py  # Organization CRUD + org SSO (+ /sso/test diagnostic) + tenant attach
                       #   → /api/admin/organizations
    assignments.py     # Staff assignments (3 levels) + equipment assignments
    auth.py            # Login/logout/me, password change, SSO config/login/callback
    custom_columns.py  # Custom column + value CRUD
    equipment.py       # Equipment, equipment types, bookings, blocks
    export.py          # MPP/CSV project export + full site export to Excel (.xlsx)
    health.py          # /health + /api/health + WS debug endpoints
    kanban.py          # Card status moves, assignees, comments (+ @-mentions), comment counts,
                       #   mentionable users — the board itself has no read endpoint
    mpp_import.py      # Microsoft Project file import (requires Java)
    notes.py           # Staff notes
    notifications.py   # Own inbox only (list, unread count, mark read) — no user_id parameter
    predefined_phases.py # Phase template management
    projects.py        # Project/phase/subphase CRUD + reorder
    settings.py        # Instance settings (KV) + tenant SSO settings
    sites.py           # Sites, bank holidays (edit, .ics import, Nager refresh), multi-site
                       #   company events (/events routes + legacy /sites/{id}/events)
    skills.py          # Skills + user-skill assignment
    staff.py           # Staff read endpoints (staff are users; created via /users)
    tag_groups.py      # Tag group CRUD + reorder (admin writes)
    tags.py            # Project tag CRUD + reorder (admin writes; read for everyone)
    users.py           # User management
    vacations.py       # Vacation/absence CRUD + bulk import (/vacations/import)
  schemas/             # Pydantic request/response schemas (one file per domain;
                       #   base.py holds Node-compatible serializers + DateRangeOrdered)
  services/
    auth.py            # Shared admin-session validation
    card_access.py     # require_card_status_write: project editor or assignee of that card
    card_status.py     # apply_status / apply_completion — the only writers of status/completion
                       #   (mirrored in frontend/src/utils/kanbanCards.ts)
    demo_seed.py       # insert_demo_data(conn, demo, admin_password_hash=…): the guarded
                       #   names→ids loader of the demo set, shared by seed_demo and the admin
                       #   portal's "Seed demo data" provisioning option
    date_range.py      # parse_day / parse_day_range (400 on bad/inverted/>366-day ranges),
                       #   ensure_date_order (422) for partial updates
    encryption.py      # AES-256-GCM credentials + bcrypt/PBKDF2 password hashing
    holidays.py        # Nager API client (v4, legacy v3 auto-detected), parsing, region matching
    login_throttle.py  # In-memory, per-process failed-login throttle (tenant + admin portal)
    master_db.py       # Master DB singleton: init, idempotent auto-migrations,
                       #   verify_admin_exists() (auto-creates admin@milestone.local)
    mentions.py        # @[Name](id) mention tokens: parse_mention_ids / strip_mention_tokens
                       #   (mirrored in frontend/src/utils/mentions.ts)
    notifications.py   # Notification rows for Kanban events (actor excluded, one per recipient)
    project_access.py  # Per-project ACL: is_privileged, can_edit_project, require_project_editor
                       #   (PM rule), require_assignment_write (self-assignment), project_id_for_*
    proxy.py           # Corporate proxy resolution (env vars or PAC file)
    response_builders.py # Shared ORM→dict response helpers
    session.py         # SessionService (express-session compatible)
    site_access.py     # can_access_sites / ensure_site_access (superuser site scoping for
                       #   multi-site events + equipment)
    sso.py             # SSOService: effective config (org > tenant), Graph groups,
                       #   authorization URL + HMAC-signed state; tenant client-secret
                       #   at-rest helpers (read_/store_tenant_client_secret, apply_secret_update)
    sso_errors.py      # Entra token-endpoint failures → fixed messages (only an AADSTS code
                       #   may reach the user)
    tag_rules.py       # validate_project_tags (site applicability + single-select → 400) and the
                       #   conflict counters behind the 409s of tag/group edits
    tenant_data_migrations.py # run_data_migrations(): guarded FK rewrites + orphan cleanups,
                       #   called at the end of tenant_manager._run_auto_migrations
    tenant_manager.py  # Lazy per-tenant connection pools (per-slug creation lock) + idle
                       #   cleanup + auto-migrations
    tenant_provisioner.py # Tenant DB/user creation, schema, seed (defaults or demo data); managed-PG support
  middleware/
    auth.py            # Session auth dependencies (get_current_user, require_*)
    tenant.py          # Pure-ASGI tenant resolution (/t/{slug}/* rewrite, 60s cache)
    broadcast.py       # Pure-ASGI coarse change:<entity> broadcast on 2xx writes
  websocket/
    manager.py         # ConnectionManager: per-tenant rooms, multi-tab, presence, send_to_user
    handler.py         # /ws and /t/{slug}/ws endpoints, cookie auth, close codes
    broadcast.py       # broadcast_change() (rich attribution) + send_notification()
frontend/
  package.json         # Node ≥ 24 (engines), license FSL-1.1-MIT, "version" is a static placeholder
  vite.config.ts       # tenantSpaPlugin (/t/* SPA fallback in dev), @ → src alias, port 3333
  vitest.config.ts     # Vitest (jsdom) config, coverage include/exclude + thresholds
  src/
    main.tsx           # Entry: initTheme, configureApiClient (What-If wiring), render <App />
    App.tsx            # Top-level branching (/admin vs main app), no router; TenantApp shows
                       #   Loading/LoadError screens, sets the what-if-mode body class
    api/
      client.ts        # Fetch wrapper: cookie auth, tenant prefix, What-If interception
      endpoints/       # absenceTypes, admin, auth, customColumns, equipment, projects (transform
                       #   layer), settings, sites, skills, staff, tags, users, vacations,
                       #   health (getAppVersion), importChunks (postInChunks), kanban, notifications
    components/
      __tests__/       # rawFormControls.test.ts (+ rawFormControlsAllowlist.json): raw <input>/<select> ratchet
      admin/           # AdminApp, AdminLoginScreen, AdminDashboard, TenantList, OrganizationList,
                       #   AdminUserList, SystemStatsPanel + modals/ (Create*/…DetailsModal,
                       #   CredentialsModal — standalone, useEscapeKey, no overlay close)
      gantt/           # GanttContainer, ProjectPanel/ (ProjectRow → PhaseRow → SubphaseRow →
                       #   AssignmentRow, SectionRow, GroupBy/ColorBy dropdowns over
                       #   TagGroupChoiceDropdown), Timeline/ (bars, DependencyLayer, phantom
                       #   overlays, ResourceDropOverlay), CustomColumns/, CompletionSlider/,
                       #   ShiftTooltip/ (Shift-hover date tooltip), ContextMenuContainer.tsx,
                       #   utils/ (autoCalculation, completionStatus, criticalPath, dependencies,
                       #   diffProjects, projectSections, rowPositions, timeline)
      views/           # StaffView (workload heatmap), EquipmentView, CrossSiteView, ArchivedView,
                       #   KanbanView/ (KanbanView, KanbanBoard, KanbanColumn, KanbanCard, KanbanToolbar)
      screens/         # LoginScreen, LoadingScreen, LoadErrorScreen (initial load failed → Retry)
      settings/        # Settings hub: SettingsHub.tsx (shell), sections.tsx (SETTINGS_SECTIONS
                       #   registry: group/id/label/minRole/Panel), PanelToolbar.tsx, types.ts,
                       #   useReportDirty.ts, panels/ (General, Sites, BankHolidays, CompanyEvents,
                       #   Users, Skills, AbsenceTypes, Equipment, EquipmentTypes, PredefinedPhases,
                       #   Tags, SSO + helpers ColorSwatchPicker, SiteChecklist, SiteForm,
                       #   calendarUtils, PanelIcons)
      modals/          # ModalContainer (lazy) + dialogs: Project/Phase/Subphase, Assignment
                       #   (Staff/Equipment), EquipmentBlock, KanbanCardModal, TagPicker,
                       #   CustomColumn(+sManager), ImportProjectModal, MyAbsencesModal,
                       #   VacationModal, VacationICSImport, AbsenceTypeSelect
      common/          # Button, Input, Select, ToggleSwitch, Modal, ContextMenu, OnlineUsers,
                       #   ActivityFeed, NotificationBell, MentionTextarea (+ MentionText),
                       #   TagFilterDropdown, AllocationSlider, OverlapWarningIcon,
                       #   Notice (the one inline error/warning/info box, role alert/status),
                       #   ICSImportPanel (shared .ics preview/import, 5 MB cap),
                       #   ConfirmDialog (the one confirm host, fed by utils/confirmDialog.ts),
                       #   useSubmitGuard.ts (double-submit guard)
      layout/          # MainLayout, Header/ (density tiers + HeaderOverflowMenu, SyncStatus
                       #   "Offline" badge, WhatIfToggle + Apply-failure banner, UserMenu, …),
                       #   Sidebar/ (Navigation, AdminSection, QuickStats), ResourcePanel/
    contexts/          # WebSocketContext (WS → debounced refetch), wsSlices.ts (entity →
                       #   slice map), TimelineScrollContext, ReorderContext (row reordering),
                       #   KanbanDragContext (card drag, optimistic move)
    stores/            # 9 Zustand stores + index.ts (resetAllStores, expireSession) — see
                       #   Frontend Architecture
    types/models.ts    # All frontend entity types (snake_case, YYYY-MM-DD dates)
    hooks/             # useAuth, useDataLoader, useWebSocket, useDragAndDrop, useTagFilter,
                       #   useHeaderDensity, useDerivedDueNotifications, … (see frontend-architecture.md → Hooks catalog)
    utils/             # date, storage (STORAGE_KEYS, themes, project order), csvExport,
                       #   confirmDialog (confirmAction / setConfirmHandler),
                       #   xmlExport, ics, recurringVacation, siteClosure, permissions, tags,
                       #   kanbanCards, mentions, equipmentOverlap, subphaseUtils, persistFailure,
                       #   reorder, localProjectTree, whatIf, uniqueById, touchEvents,
                       #   themeColors, colorSwatches, projectLevels
                       #   (criticalPath/diffProjects/dependencies/completionStatus live in
                       #   components/gantt/utils/)
    styles/            # global.css, variables.css (design tokens), themes/themes.css,
                       #   __tests__/cssTokens.test.ts (every var(--x) read is defined)
    test/              # setup.ts (Vitest setup), factories.ts (make* test builders),
                       #   confirmDialog.ts (stubConfirm / restoreConfirm for confirmAction)
docs/                  # MkDocs Material source (user-guide/, admin-guide/, developer-guide/,
                       #   index.md, release-notes.md embedding CHANGELOG.md)
  build.sh             # Cloudflare Pages build command (mkdocs build --strict)
migrations/            # Raw idempotent SQL migrations + run_migration.py / run_migration_master.py,
                       #   shell wrappers (run_migration.sh, migrate_all_tenants.sh), README.md
scripts/
  README.md            # Script usage
  fresh_install.py     # Automated master-DB installer (+ .env generation)
  seed_tenant_data.py  # Seed a tenant with sample data
  setup_admin_password.py
  sql/                 # milestone_master_fresh_install.sql, tenant_schema_template.sql,
                       #   migrations/001_add_max_capacity.sql
  screenshots/         # Playwright screenshot pipeline (capture.py, capture_collab.py,
                       #   capture_admin.py, README.md) — data comes from app.scripts.seed_demo
tests/                 # Backend pytest suite (mock-based, no live DB): conftest.py (fixtures),
                       #   support.py (mock Result builders), shard_plugin.py (--shard=K/N)
public/                # Built frontend served by FastAPI (deploy-react.sh copies dist/ here)
.devcontainer/         # Codespaces: multi-tenant dev env, demo seed, uvicorn autostart
.github/               # FUNDING.yml + workflows/ (backend.yml, frontend.yml, docker.yml,
                       #   version-check.yml)
.claude/               # settings.json (Trail hooks), hooks/session-start.sh, skills/trail/
.trail/                # learnings/ (committed session notes), hook.cjs; cache/ is git-ignored
```

## Environment Variables

Settings are loaded by `app/config.py` (pydantic-settings, `.env`, case-insensitive) unless marked *env-only*.

| Variable | Default | Description |
|----------|---------|-------------|
| `DEBUG` | `false` | Debug mode (enables localhost CORS defaults) |
| `APP_NAME` | `Milestone API` | FastAPI title (API docs) |
| `PORT` | `8485` | Backend HTTP port |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | `localhost`/`5432`/`milestone_dev`/`milestone_dev_user`/`""` | Tenant DB (single-tenant mode) |
| `DATABASE_URL` | *(unset)* | Overrides individual `DB_*` vars (`postgres://` auto-rewritten to `postgresql+asyncpg://`) |
| `DB_SSL` | `false` | Require SSL to the tenant DB |
| `DB_POOL_SIZE` / `DB_POOL_MAX_OVERFLOW` / `DB_POOL_TIMEOUT` | `20`/`10`/`30` | Connection pool tuning |
| `SESSION_SECRET` | insecure default (`.env.example` ships it empty) | Session signing / SSO-state HMAC secret; single-tenant mode also derives the encryption key from it. **Required in production**: with `DEBUG=false`, startup refuses an empty or published placeholder value (`Settings.check_startup_security()`, `INSECURE_SESSION_SECRETS` in `app/config.py`); `DEBUG=true` only logs |
| `SESSION_COOKIE_NAME` | `connect.sid` | Tenant session cookie (express-session compatible) |
| `SESSION_MAX_AGE` | `86400` | Session lifetime (seconds) |
| `SECURE_COOKIES` | `false` | Set `Secure` on cookies (enable behind HTTPS) |
| `CORS_ORIGINS` | *(unset)* | Comma-separated allowed origins (localhost defaults in debug; same-origin otherwise) |
| `FORWARDED_ALLOW_IPS` | *(env-only)* `127.0.0.1` | Read by uvicorn (`--proxy-headers --forwarded-allow-ips` in the Dockerfile `CMD`; passed through by `docker-compose.fresh.yml`): proxy addresses whose `X-Forwarded-For` is trusted. **Set it behind a reverse proxy** — otherwise every client is the proxy's IP and the per-(IP, e-mail) login lockout applies to everyone. `*` only when the app port is reachable solely via the proxy |
| `MULTI_TENANT` | `false` | Enable multi-tenant mode (TenantMiddleware + master-driven tenant pools) |
| `DEFAULT_TENANT` | *(unset)* | Optional default tenant slug |
| `MASTER_DB_HOST` / `MASTER_DB_PORT` / `MASTER_DB_NAME` / `MASTER_DB_USER` / `MASTER_DB_PASSWORD` | `DB_HOST`/`5432`/`milestone_master`/`DB_USER`/`DB_PASSWORD` | Master DB connection (host, user and password fall back to the `DB_*` values; the migration runners use the same `milestone_master` default). `docker-compose.fresh.yml` and the devcontainer set `MASTER_DB_NAME=milestone_admin` explicitly — keep it set on those deployments |
| `PG_ADMIN_USER` / `PG_ADMIN_PASSWORD` | *(unset)* | PostgreSQL admin (CREATEROLE+CREATEDB) for tenant provisioning and cross-tenant migrations |
| `TENANT_ENCRYPTION_KEY` | *(env-only)* | 64-char hex AES-256-GCM key for tenant credentials — **required** in multi-tenant mode |
| `NAGER_API_URL` | `https://nagerholidays.com/api/v4` | Public-holiday API for bank-holiday refresh (v3 URLs still detected; v3 EOL 2027-01-31) |
| `HTTP_PROXY` / `HTTPS_PROXY` / `PROXY_USERNAME` / `PROXY_PASSWORD` / `PROXY_PAC_URL` / `PROXY_VERIFY_SSL` / `PROXY_CA_CERT` | *(unset)* | Corporate proxy. ⚠ The full resolution (PAC file, credentials, CA, verify) applies to the **Nager holiday import only** (`app/services/holidays.py`). SSO token exchange and Microsoft Graph use plain `httpx` clients, which follow only the process `HTTP(S)_PROXY` environment variables |
| `AUTO_INIT_DB` | *(env-only)* `false` | Run `app.scripts.init_db` on container start (fresh installs); a failed init exits the container non-zero |
| `DB_WAIT_ATTEMPTS` | *(env-only)* `30` | Database wait attempts in `docker-entrypoint.sh` before starting anyway (the wait is non-fatal) |
| `INIT_ADMIN_EMAIL` / `INIT_ADMIN_PASSWORD` | *(env-only)* | Initial admin credentials for auto-init (password auto-generated if empty) |
| `TZ` | *(env-only)* `Europe/Zurich` | Container timezone |
| `JAVA_HOME` | *(env-only)* `/usr/lib/jvm/default-java` (Dockerfile) | JVM for MPP import; `mpp_import.py` searches common locations when unset |

Fresh-compose overrides: `FRESH_APP_PORT` (default 8486), `FRESH_DB_PORT` (5433).

## Import & Export

### Site Export to Excel

- Endpoint: `GET /t/{slug}/api/export/site/{site_id}/excel` (admin / superuser only; superusers limited to sites they belong to).
- Implemented in `app/routers/export.py` — `build_site_export_workbook()` generates a multi-sheet `.xlsx` via `openpyxl`.
- Current sheets: Site, Projects (hierarchy with phases/subphases), Users, Equipment (with a Sites column), Skills, User skills, Tag groups, Tags (those applicable to the site, with Group / All sites / Sites columns), Project tags (with Group), Absence types, Vacations (with Type / Type ID columns), Project assignments, Phase assignments, Subphase assignments, Equipment assignments, Custom columns, Custom column values, Bank holidays, Company events (selected via `company_event_sites`, with Sites and Staff unavailable columns), Equipment blocks, Staff notes, Card comments (the Projects sheet also carries a `Kanban status` column). Notifications are deliberately excluded — transient per-user inbox state, not site content.
- **IMPORTANT**: any new data added at the site level through future enhancements (e.g. equipment maintenance/blocks, new event types, additional site-scoped settings, new assignment kinds, etc.) **must** be added as a new sheet (or a new column on the existing sheet) in `build_site_export_workbook()`. The site export is the canonical "everything for this site" snapshot — do not let it drift behind the model.

### MS Project & CSV

- **MPP import** (`app/routers/mpp_import.py`) parses `.mpp` files via `jpype1` + `mpxj` — requires a JVM. The Docker image includes `default-jre-headless`; local dev environments usually don't. `GET /import/mpp/test` verifies the toolchain.
- **MPP/CSV export** (`app/routers/export.py`) exports single projects server-side; the frontend also generates MS-Project-compatible CSV (`utils/csvExport.ts` — outline levels, `ID{FS|SS|FF|SF}±lag` predecessor syntax, % complete, milestones) and MS Project XML (`utils/xmlExport.ts`) client-side.

## Docker & Deployment

**Dockerfile** (3 stages):
1. `builder` (`python:3.11-slim-bookworm` + libpq-dev/gcc/g++) — pip-installs `requirements.txt` to `/install` (g++ needed for `psutil`/`jpype1` source builds).
2. `frontend` (`node:24-alpine`) — `npm ci && npm run build`.
3. `runtime` (`python:3.11-slim-bookworm`) — runtime libs only (`libpq5`, **`default-jre-headless`** for MPP import, `curl`), non-root `appuser`, sets `PORT=8485` and `JAVA_HOME`, copies `VERSION` + `app/` + `migrations/` + built frontend → `public/` + the static `public/img/` logos, creates `/app/uploads`, healthcheck on `/health`, `EXPOSE 8485`, uvicorn via `docker-entrypoint.sh` (waits for DB(s) — non-fatal after `DB_WAIT_ATTEMPTS` — then optional `AUTO_INIT_DB`, whose failure exits the container non-zero).

**Compose files**:

| File | Services | Ports | Use case |
|------|----------|-------|----------|
| `docker-compose.yml` | `milestone` | 8485 | Production against an external PostgreSQL (`.env`-configured). Unraid-specific: joins the external `guac-net` network and bind-mounts `/mnt/user/appdata/milestone/uploads` — adapt before using elsewhere |
| `docker-compose.fresh.yml` | `db` (postgres:15-alpine) + `milestone` | 8486 app / 5433 db (overridable via `FRESH_*`) | Self-contained fresh install: `AUTO_INIT_DB=true`, seeded admin, named volumes. **Needs `.env` with `SESSION_SECRET`** (`${SESSION_SECRET:?…}` — compose refuses to start without it) |
| `docker-compose.external-db.yml` | `milestone` | 8485 | Managed PostgreSQL (RDS/Azure/Cloud SQL) with auto-init (needs `PG_ADMIN_*`) |
| `docker-compose.dev.yml` | `milestone` + `milestone-react-dev` | 8485 + 3333 | Backend + hot-reload React dev server (also expects the external `guac-net` network) |
| `docker-compose.react-dev.yml` | `milestone-api` + `milestone-react-dev` | 8485 + 3333 | Unraid variant of the dev setup (`guac-net`) |

Health endpoint responds at **both** `/health` and `/api/health` (status, mode, version, DB check).

## CI

Four workflows in `.github/workflows/`. `backend.yml`, `frontend.yml` and `docker.yml` trigger on push to `main` **and every PR, whatever its base branch** (so stacked PRs get the full gates); version-check runs only on PRs targeting `main`. `backend.yml` and `frontend.yml` additionally run weekly on crons — offset a day apart — where only their `Audit` jobs execute:

- **Path-filtered.** Each of the three starts with a `Detect Changes` job (`dorny/paths-filter@v3` in **git mode** — `token: ""`, `base` = the PR's base branch — because the REST API mode silently treats files past its 3000-file limit as unchanged). Every other job `needs: changes` and runs only when its filter matched: backend = `app/**`, `tests/**`, `requirements*.txt`, `pyproject.toml`, `migrations/**`, `VERSION`; frontend = `frontend/**`; docker = everything the image `COPY`s (`Dockerfile`, `.dockerignore`, `docker-entrypoint.sh`, `requirements.txt`, `app/`, `frontend/`, `migrations/`, `VERSION`, `public/`). **A change to a workflow file re-runs that whole workflow.** The outputs are compared with `== 'true'` — paths-filter emits the *string* `'false'`, which is truthy, so never shorten them to `a || b`. The `Audit` jobs use `!cancelled() && (schedule || changed)` so the cron still runs them while `changes` is skipped. A workflow-level `concurrency` group cancels superseded PR runs, never `main` pushes (they publish the badges).
- **Sharded tests.** Backend tests run as 3 `Tests (shard K/3)` jobs (`pytest --shard=K/3 --cov=app --cov-report= --cov-fail-under=0`, each uploading its `.coverage` as `coverage.shard-K`); frontend tests as 2 `Tests (shard K/2)` jobs (`vitest run --shard=K/2 --reporter=blob --coverage.enabled` with the thresholds zeroed, uploading `.vitest-reports/`). An aggregate **`Tests`** job per workflow fails unless every shard passed, checks that every shard's artifact arrived, then combines (`coverage combine` / `vitest run --merge-reports --coverage.enabled`) and enforces the suite floors, writes the summary, runs diff-cover on PRs and hands the badge total on `main`. Per-shard runs never gate on coverage. **Only the aggregate `Tests` job is the one to require in branch protection — the shard jobs need no rule of their own** (it runs even when a shard failed, via `!cancelled()`, so it fails instead of being skipped). The `matrix` is the **only** place the shard count is set: `strategy.job-total` carries it into the job names, the commands and the aggregate's count check.

| Workflow | Jobs / enforcement |
|----------|--------------------|
| `backend.yml` | `pip-audit --strict` over `requirements*.txt` (**blocking**); ruff check + format check on `app/`; pytest in 3 shards + aggregate `Tests` with the combined coverage — the `fail_under` floor, a per-file table + `::notice` total in the job summary, and on PRs **diff-cover ≥ 80 %** on changed lines; mypy; on push to `main`, a `Coverage Badges` job publishes `backend.json` |
| `frontend.yml` | eslint; vitest in 2 shards + aggregate `Tests` with the merged coverage — the `coverage.thresholds` floors, a summary table + `::notice` total, and on PRs **diff-cover ≥ 80 %** on changed lines; `npm run build` (tsc + vite); `npm audit --audit-level=moderate` (**blocking** — see [below](#ci)); on push to `main`, a `Coverage Badges` job publishes `frontend.json` |
| `docker.yml` | `docker build` of the production image (only when an image input changed) |
| `version-check.yml` | PRs to `main` only: `dorny/paths-filter` on app-code paths → fails the PR unless `VERSION` changed vs the PR's **base commit** (not the live `main`, so a race with a merge cannot false-fail) **and** `CHANGELOG.md` has a matching `## [<version>]` heading; its paths-filter runs in git mode like the other three |

The README coverage badges are shields.io endpoint badges reading `backend.json` / `frontend.json` from the orphan **`coverage`** data branch. Only the two `Coverage Badges` jobs write it (push to `main`, `contents: write`, one shared `coverage-badges` concurrency group, `[skip ci]` commits, each job touching only its own file) — never commit to it by hand.

Docs are **not** built by Actions — Cloudflare Pages builds them from `docs/build.sh` on push. There are no issue or PR templates in `.github/` (only `FUNDING.yml`).

**Both `Audit` jobs are blocking, and a new advisory can turn them red on a PR that didn't touch dependencies.** That is intended. On the backend, fix the pin in `requirements*.txt`; if a finding is genuinely unexploitable here, a `--ignore-vuln` flag with an explanatory comment in `backend.yml` is the sanctioned escape hatch. On the frontend, the audit is the only check that notices when a pin in `frontend/package.json`'s `overrides` block has gone stale, which happens silently whenever a *newer* advisory widens the affected range of an already-pinned package — the block currently holds ~8 transitive security pins (note the scoped `"minimatch@3"` syntax, which overrides only the v3 range). When it fires, fix the pin rather than lowering the threshold; `--audit-level=moderate` was chosen deliberately (the advisories that originally motivated the job were moderate). If a finding is genuinely unreachable (dev-only tooling, no patched release available) and blocking is unacceptable, prefer a scoped, commented `overrides` entry over relaxing the gate.
