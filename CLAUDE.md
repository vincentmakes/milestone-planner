# CLAUDE.md - Milestone Planner

Multi-tenant SaaS platform for R&D project management: interactive Gantt charts with phase/subphase hierarchies and dependencies, staff allocation with workload heatmaps, equipment booking with conflict detection, vacation/holiday tracking, real-time multi-user collaboration over WebSockets, What-If planning, Microsoft Entra SSO, and MS Project import/export. FastAPI backend + React/TypeScript frontend.

**Current version**: see `/VERSION` (single source of truth, one line, no `v` prefix). The backend reads it at import in `app/__init__.py` and exposes it via `/health`.

**License**: Functional Source License 1.1 with MIT Future License (**FSL-1.1-MIT**, `/LICENSE`) since 1.6.1 — releases up to and including 1.6.0 were MIT. Each release converts to MIT two years after publication, so the README keeps describing Milestone as an open-source platform. Never re-add MIT wording or an MIT `license` field anywhere: the README License section, the README license badge, `frontend/package.json` `license` (mirrored in `package-lock.json`'s root entry) and `/LICENSE` must all say FSL-1.1-MIT.

## Start here

Rules live here, the reference in the [Codebase Reference](#reference-pages) pages. Read only what your task touches:

| Area | Read exactly these |
|------|--------------------|
| Route work | **Backend Conventions** and **Security Requirements** below, the router in `app/routers/`, then its section of [Route auth gates and side effects](docs/developer-guide/routes.md) (e.g. [Assignments](docs/developer-guide/routes.md#assignments-assignmentspy-note-the-three-per-level-route-families), [Kanban](docs/developer-guide/routes.md#kanban-kanbanpy-prefix-kanban)) |
| Schema and migrations | the **Schema-change checklist** below, then the table in [Tenant database tables](docs/developer-guide/database-schema.md#tenant-database-tables-one-db-per-tenant-milestone_slug) and [Migrations](docs/developer-guide/database-schema.md#migrations) |
| Frontend and UI | `UI_GUIDELINES.md` §3 and **Frontend Conventions** below, then the matching section of [Frontend architecture](docs/developer-guide/frontend-architecture.md): [Zustand stores](docs/developer-guide/frontend-architecture.md#zustand-stores-srcstores), [Gantt architecture](docs/developer-guide/frontend-architecture.md#gantt-architecture-srccomponentsgantt), [Hooks catalog](docs/developer-guide/frontend-architecture.md#hooks-catalog-srchooks), [Utilities](docs/developer-guide/frontend-architecture.md#utilities-worth-knowing-srcutils), [What-If Mode](docs/developer-guide/frontend-architecture.md#what-if-mode) |
| Roles, sites, tenants, SSO | **Security Requirements** below, [Tenant role model](docs/developer-guide/auth-and-tenancy.md#tenant-role-model), [Multi-Tenancy Internals](docs/developer-guide/auth-and-tenancy.md#multi-tenancy-internals), [Microsoft Entra SSO](docs/developer-guide/auth-and-tenancy.md#microsoft-entra-sso) |
| Real-time and WebSocket | the broadcast rule below, [Real-time collaboration internals](docs/developer-guide/realtime.md) (the slices map is under [Frontend](docs/developer-guide/realtime.md#frontend)) |
| Finding a file or a term | [Project Structure](docs/developer-guide/codebase-map.md#project-structure), [Terminology](docs/developer-guide/codebase-map.md#terminology) |
| Env, Docker, CI | [Environment Variables](docs/developer-guide/codebase-map.md#environment-variables), [Docker & Deployment](docs/developer-guide/codebase-map.md#docker-deployment), [CI](docs/developer-guide/codebase-map.md#ci) |
| Docs and screenshots | **Documentation (MkDocs)** below, [Documentation Screenshots](docs/developer-guide/conventions-in-depth.md#documentation-screenshots) |

## Quick Start

```bash
# Self-contained fresh install (bundled PostgreSQL, app on port 8486, DB on 5433)
cp .env.example .env   # REQUIRED first: the compose fails without SESSION_SECRET (${SESSION_SECRET:?…})
# set SESSION_SECRET in .env to: python -c "import secrets; print(secrets.token_hex(32))"
docker compose -f docker-compose.fresh.yml up -d
# AUTO_INIT_DB=true creates the schema and seeds an admin
# (admin@milestone.local — password printed in the container logs)

# Production (external PostgreSQL configured via .env, port 8485)
cp .env.example .env   # fill in DB credentials + secrets
docker-compose up -d
```

GitHub Codespaces / devcontainer: `.devcontainer/` boots a full **multi-tenant** dev environment (postgres sidecar, `AUTO_INIT_DB=true`, demo login `admin@demo.local` / `demo1234`, uvicorn auto-started on 8485).

---

## Common Commands

```bash
# Build frontend (Docker, no local Node.js needed)
docker run --rm -v $(pwd)/frontend:/app -w /app node:24-alpine sh -c "npm install && npm run build"

# Deploy frontend to public/
./deploy-react.sh

# Start production
docker-compose up -d

# Fresh install (includes PostgreSQL; needs .env with SESSION_SECRET)
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

# Frontend tests (plain `npm test` starts Vitest in watch mode)
cd frontend && npm test -- --run
cd frontend && npm run test:coverage

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
mkdocs build --strict   # Output to site/ (what Cloudflare runs)
```

**Dev-server nuance**: the Vite dev server (:3333) serves `/t/{slug}/…` SPA paths via the custom `tenantSpaPlugin` in `vite.config.ts`, but there is **no API proxy** — `src/api/client.ts` detects port 3333 and sends API/WS traffic directly to `:8485`, so the backend must be running (e.g. via `docker-compose.dev.yml`, which runs both). For full tenant/WebSocket behaviour, test against `:8485` serving the built frontend from `public/`.

---

## AI Assistant Guidelines

When working on this codebase, follow these conventions:

### General Principles

- **Two SQLAlchemy declarative bases — never mix them.** Tenant-database models use `Base` (`app/database.py`); master-database models use `MasterBase` (`app/models/tenant.py`). A model on the wrong base silently lands in the wrong `metadata` and breaks provisioning/init.
- **Node.js compatibility is a contract, not an accident.** This app replaced a Node/Express implementation and keeps wire-level compatibility: `CustomJSONResponse` formats datetimes like `toISOString()` (stored values are UTC and are emitted as UTC with a `Z` suffix — no local-offset shift) and coerces whole floats to ints; sessions are express-session-compatible (`connect.sid` cookie, `s%3A<id>.` value format, `sessions` table shape); credential encryption uses the Node `iv:authTag:ciphertext` hex format. Changing any of these serialization behaviours is a breaking change.
- **Optimistic frontend + WebSocket refetch.** The frontend mutates Zustand state immediately and persists after; other clients converge via `change:<entity>` WebSocket events that trigger debounced slice refetches. On a failed persist the frontend reloads everything from the server and clears undo history. Keep new features inside this model — don't invent per-feature sync mechanisms.
- **Site export is a canonical snapshot.** Any new site-scoped data must be added to `build_site_export_workbook()` (a new sheet, or a new column on an existing sheet) — the site export is the canonical "everything for this site" snapshot; do not let it drift behind the model. See the [Site Export contract](docs/developer-guide/codebase-map.md#site-export-to-excel).
- **There is no client-side router.** `react-router-dom` was removed from `package.json` (it was never imported) — don't re-add it, nor a query library (TanStack Query was removed too): all data flows through the Zustand stores. `App.tsx` branches on `window.location.pathname` (exactly `/admin` or `/admin/…` → admin portal, everything else → main app), and in-app views (gantt/kanban/staff/equipment/crosssite/archived) are `viewStore` state, not URLs. Don't add routes; add views to `viewStore` + `MainLayout.renderView()`.
- **Raw SQL migrations only — never introduce Alembic.** Migrations are idempotent `.sql` files in `migrations/` executed by `run_migration.py` (tenant DBs) / `run_migration_master.py` (master DB).

### Backend Conventions

- Route handlers live in `app/routers/`, one file per resource domain, and **must be registered in `create_app()` in `app/main.py`** (`app.include_router(...)`). Cautionary tale: a `presence.py` router was once written but never registered — its HTTP endpoints sat dead for a long time before being deleted (presence works over WebSocket). Verify registration when adding a router.
- Use `async def` and `AsyncSession` for all handlers and DB access. For read-only endpoints on hot paths, prefer the `get_db_readonly` dependency (`app/database.py`) over `get_db` — it skips commit/rollback overhead; `GET /projects` and `GET /projects/{id}` are the reference users.
- Role gating via dependencies from `app/middleware/auth.py`: `get_current_user` (any authenticated user), `require_superuser` (**admin OR superuser**), `require_admin` (admin only). Always import these — never define a local copy of a role check in a router (skills/tags once did; the duplicates were removed so the role matrix has one source of truth). Admin-portal routes use `get_current_admin` / `require_superadmin` from `app/routers/admin/auth.py` against the master DB. The `is_system` flag on users protects the provisioned admin from deletion.
- **Sites scope the UI, not access.** Superusers act tenant-wide on projects, phases, subphases, assignments, vacations and staff notes (`project_access.py` has no site check, by design); site membership is enforced only for bank holidays, company events, equipment, equipment blocks and equipment types (`site_access.py`). Don't add site checks to project routes without a product decision. Detail: [Tenant role model](docs/developer-guide/auth-and-tenancy.md#tenant-role-model).
- **Real-time broadcast is two-tier.** For user-facing mutations on projects/phases/subphases/assignments, call `broadcast_change(...)` (`app/websocket/broadcast.py`) with rich attribution (entity, action, summary). Everything else is covered automatically: `BroadcastMiddleware` (`app/middleware/broadcast.py`) fires a coarse `change:<entity>` on any successful 2xx write, and its `SKIP_PATTERNS` list suppresses the paths that already do rich broadcasts (now including `/api/kanban` and `/api/notifications`). When you add rich broadcasting to a new path, add it to `SKIP_PATTERNS` too — otherwise clients receive double events.
- **`status` and `completion` on phases/subphases are two views of one thing.** Never assign either field directly — go through `apply_status()` / `apply_completion()` in `app/services/card_status.py`, mirrored byte-for-byte by `statusFromCompletion`/`completionForStatus` in `frontend/src/utils/kanbanCards.ts`. The matching test matrices (`tests/test_card_status.py` / `src/utils/__tests__/cardStatusMirror.test.ts`) are the contract; change one, change both.
- **The `@`-mention wire format is a second mirror contract.** A comment body stores mentions as `@[Name](id)`; `app/services/mentions.py` (`parse_mention_ids`, `strip_mention_tokens`) and `frontend/src/utils/mentions.ts` must stay equivalent — change one, change both (shared table asserted in `tests/test_mentions.py` and `src/utils/__tests__/mentions.test.ts`). Who gets notified is derived from the body on the server, never from a client-supplied id list, so the pills a reader sees and the people notified cannot drift apart. Strip the tokens before truncating a preview.
- **SSO failures show only our own words.** The only remote-derived text that may reach a user is a regex-validated `AADSTS\d{4,7}` code; everything else is a fixed string from `app/services/sso_errors.py` (`parse_entra_token_error`). Never echo Entra's `error` / `error_description` into a response or redirect URL.
- **Schema-change checklist** — when you add/alter a tenant table or column, update ALL of:
  1. The SQLAlchemy model (`app/models/`)
  2. `setup_databases.sql` (canonical fresh-install schema)
  3. A new idempotent migration in `migrations/` (for existing installs)
  4. `app/services/tenant_provisioner.py`'s `get_tenant_schema_sql()` (schema for newly provisioned tenants)
  5. `scripts/sql/tenant_schema_template.sql` (manual-setup reference)
  6. `build_site_export_workbook()` in `app/routers/export.py` if the data is site-scoped
  Master-DB changes: model + `setup_databases.sql` + a migration run by `run_migration_master.py` + the idempotent auto-migration in `app/services/master_db.py` if it must apply automatically on upgrade.
- **Polymorphic rows have no FK on their entity.** `custom_column_values` and `card_comments` reference it through `(entity_type, entity_id)` with no FK on `entity_id`: deleting a phase or subphase (and, for custom-column values, a project or a site) must clear them explicitly; orphans are cleaned by the tenant data migrations.
- **Data fixes go in the `tenant_provisioner` constants** (shared with the fresh-install schema and the `.sql` files) or in `run_data_migrations()` (`app/services/tenant_data_migrations.py`) — never inline in the auto-migration. Each auto-migration step stays idempotent, runs in its own transaction and never raises (see [Migrations](docs/developer-guide/database-schema.md#migrations)).
- Secrets at rest (tenant DB passwords, SSO client secrets) go through `app/services/encryption.py` (AES-256-GCM, `iv:tag:ciphertext` hex). Never store plaintext credentials.
- **Before every commit**: `ruff check app/ && ruff format --check app/ && mypy app/`. CI fails on any of these.

### Frontend Conventions

- **Read `UI_GUIDELINES.md` (repo root) before any UI work.** It holds the design tokens (every colour named, per theme), the shared components, the layout patterns and the known drift; the bullets below are one-line summaries of its rules.
- **Store ownership**: domain data (sites/projects/staff/equipment/vacations/absence types/holidays/skills/tags + tag groups/settings) → `appStore`; view state (mode, zoom, expansion, scroll, current view, per-site tag filter, Gantt group-by / colour-by, Kanban board preferences) → `viewStore`; transient UI (modals, drag/resize, dependency linking, context menus) → `uiStore`; What-If sandbox → `whatIfStore`; undo/redo snapshots → `undoStore`; custom-column data/filters/visibility → `customColumnStore`; admin portal → `adminStore`; notification inbox → `notificationStore`. Don't put domain data in `uiStore` or UI state in `appStore`. Selectors must not return a freshly allocated array or object (Zustand 5 re-renders forever — the old `selectSiteProjects`-style array selectors were removed for this): select the raw slice and filter with `useMemo`, or wrap the selector in `useShallow`.
- **All backend↔frontend field mapping lives in the API layer**, chiefly `src/api/endpoints/projects.ts` (`transformProject/Phase/Subphase/...` — phase `type`↔`name`, `sort_order`→`order_index`, the tree reshaping; see [Transform layer](docs/developer-guide/frontend-architecture.md#transform-layer-srcapiendpointsprojectsts)). The frontend model is mostly snake_case like the API. Components consume the frontend model from `src/types/models.ts` only; never transform field names in components.
- **New write endpoints are What-If-intercepted by default.** The API client queues every POST/PUT/PATCH/DELETE while What-If mode is active, except the exempt URLs (auth, settings, admin, notifications, Kanban comments and the configuration endpoints — the full list: [What-If exemptions](docs/developer-guide/conventions-in-depth.md#what-if-exemptions)). Configuration is never part of the What-If snapshot, so queuing it only makes edits vanish and deletes fail on Apply; `isWhatIfExempt()` in `src/api/client.ts` is the one list. If a new endpoint must bypass What-If (rare), extend the exemption list in `src/api/client.ts` deliberately — and if it must be queued, ensure the local optimistic update is complete since the server won't respond for real. New create, navigation and Settings entry points are blocked during What-If through `useWhatIfBlocked()` (a queued POST has no server id). `loadAllProjects()` is a no-op during What-If, so an edit must update the store locally (optimistically, or with `utils/localProjectTree.ts`); use `fetchAllProjects()` when a real fetch is required.
- **Optimistic-write failure protocol**: on persist failure, reload the affected data from the server and call `undoStore.clear()` — a stale undo stack against fresh server state corrupts data. Implemented once in `recoverFromPersistFailure(context, err)` (`src/utils/persistFailure.ts`) — call it from the `catch`, don't open-code the two steps. `useDragAndDrop` and `useUndoRedo` are the reference users.
- **Dialog writes use `useSubmitGuard`** (`src/components/common/useSubmitGuard.ts`, a ref-based in-flight flag) so Enter-twice / double-click cannot create duplicates; Settings-hub panels report unsaved input with `useReportDirty(onDirtyChange, dirty)` (`src/components/settings/useReportDirty.ts`, one combined flag per panel) so the hub asks before switching section or closing.
- **Action buttons use the shared `Button`** (`src/components/common/Button`, `md`, `icon` prop with an icon from `components/settings/panels/PanelIcons.tsx`) inside `PanelToolbar` (`src/components/settings/PanelToolbar.tsx`: `left` = filters/counts, `right` = secondary actions then the primary "Add X"; `align="end"` when the left slot holds labelled fields); never a raw `<button>` with local styles for an action. Back links are ghost `md` Buttons with `BackIcon`; `sm` only for actions repeated on every row. Documented exceptions: the Gantt header's compact 28 px icon buttons and the Kanban filter toolbar — see `UI_GUIDELINES.md`.
- **Errors show in place, never in `alert()`.** A form or panel renders its message with the shared `Notice` (`src/components/common/Notice`); an action with no form of its own reports through `uiStore.showFlash()` (rendered by `layout/FlashNotice`). **Confirmations go through `confirmAction()`** (`src/utils/confirmDialog.ts`). Never call `window.confirm` — a handler that confirms must be `async` and `await` the result, and confirm *before* taking a submit guard. Tests stub the service with `stubConfirm(result)` from `src/test/confirmDialog.ts` (restored after each test by `test/setup.ts`) and assert `expect.objectContaining({ message })`, never `vi.spyOn(window, 'confirm')`. Detail: [Errors and confirmations](docs/developer-guide/conventions-in-depth.md#errors-and-confirmations).
- **Dropdowns, popovers and menus dismiss through `useDismissableOverlay`** (`src/hooks/useDismissableOverlay.ts`): outside mousedown, Tab out, capture-phase Escape with focus back on the trigger. Don't hand-roll a click-outside effect; the panel is a `role="dialog"` (checkbox/radio panels) or `role="menu"` (`ContextMenu`) with a name, and its trigger carries `aria-expanded` + `aria-haspopup`.
- **Form fields are the shared `Input` / `Select`** (`src/components/common/Input|Select`): every text-like `<input>` (text, email, password, number, date, …) and every `<select>` in a dialog, Settings panel, admin modal or login screen, with the visible label passed as `label` (or an `aria-label`). The only raw ones left are documented exceptions (inline row-rename editors, the two ARIA comboboxes, the Gantt cell editor, the header `SiteSelector`, the phone-only Settings section picker, the credentials copy fields); `src/components/__tests__/rawFormControls.test.ts` counts raw controls per component against `rawFormControlsAllowlist.json` and fails when a count rises or the allowlist names a file that no longer needs it. Native date pickers follow the theme through `color-scheme` in `styles/variables.css` — never set it in a component stylesheet.
- **Stylesheets use tokens only.** `src/styles/__tests__/cssTokens.test.ts` fails on an undefined `var(--x)`, on a fallback value for a defined token, and on any `*.module.css` whose hex/rgba count rises above `rawColorAllowlist.json` (a ratchet: lower a file's number when you pay its debt, never raise one). Alpha variants are `color-mix(in srgb, var(--accent-red) 25%, transparent)`, shadows the `--shadow-*` tokens; `PhaseBar`/`ProjectBar` text colour comes from `barTextColor()`.
- **Modals close only via explicit buttons or the Escape key — never on backdrop/outside click.** Clicking outside a modal must NOT close it (it discards in-progress input, e.g. when a text-selection drag ends on the backdrop). The shared `Modal` component (`src/components/common/Modal/`) enforces this and has no overlay-click prop; new dialogs must use it. Standalone dialogs that can't (like the admin-portal modals in `src/components/admin/modals/`) must not attach close handlers to their overlay and should use the `useEscapeKey` hook for Escape support. This rule is for modals/dialogs only — dropdowns, context menus, and popovers keep their click-outside-to-close behavior.
- **Per-project permission checks go through `src/utils/permissions.ts`** (`isPrivileged`, `canEditProject`, `canEditProjectById`, `canEditAssignment`, `canManageAnyProject`, `isSelf`) — never an inline `role === 'admin' || role === 'superuser'` check. A project's manager (`project.pm_id === currentUser.id`) edits that project like a superuser (except deleting it), and anyone edits staff assignments that book their own time; the helpers mirror `app/services/project_access.py`. Inline role checks remain only for *global* gates (new project, import, custom-column definitions, settings, What-If).
- Direct localStorage access goes through the typed helpers and `STORAGE_KEYS` in `src/utils/storage.ts` (which also documents the Zustand `persist` key names — keep that list in sync). Zustand stores declare their persist keys inline (`milestone-app-storage-v3`, `milestone-view-storage-v1`, `milestone-custom-columns-storage-v1`) and serialize `Set`s as arrays with custom `merge` — follow the existing pattern in `viewStore`. viewStore's `merge` is field by field: every field added to `partialize` must also be listed in `merge`, or it silently resets on every reload.
- ESLint: `react-hooks/rules-of-hooks` is an **error** (fails CI); most other rules are at **warn** level, so CI's lint job will not catch everything else. Treat warnings as errors when writing new code.
- **A WebSocket message other than `change:*` needs its own `case`** in `useWebSocket` (the `default:` branch only handles `change:*`) — `notification:new` is the existing one.
- **Gantt writes**: staff-assignment updates must include `allocation` (backend requirement); new dependency links always write `entity` and go through `components/gantt/utils/dependencies.ts`; Group-by section rows never carry a class name containing `row` nor `data-project-id` / `data-phase-id` (the drag/resize hooks and `DependencyLayer` find rows by them). Detail: [Gantt architecture](docs/developer-guide/frontend-architecture.md#gantt-architecture-srccomponentsgantt).
- Frontend model types live in `src/types/models.ts`; dates are `YYYY-MM-DD` strings throughout the frontend (the backend may send the midnight form `YYYY-MM-DDT00:00:00.000Z`).
- **Never parse a model date with `new Date(str)` / `parseISO(str)` or derive one with `toISOString().split('T')[0]`** — both are UTC and shift the day for users west of UTC. Use `parseLocalDate` / `formatLocalDate` / `toDateOnly` / `addDaysToDateString` / `daysBetweenDateStrings` (and `formatDateISO(new Date())` for "today") from `src/utils/date.ts`; day counts between local midnights are `Math.round`ed (DST). Tests pin `process.env.TZ = 'America/New_York'` before imports (`*.newYork.test.ts`). `new Date(str)` is fine only for real timestamps (`created_at`, …).
- **Node 24** is the required toolchain (declared in `frontend/package.json` `engines`, used by the Dockerfile and all CI jobs) — don't build with older Node locally.
- **The header has no pixel breakpoints in CSS above the global mobile one (≤ 640 px).** `useHeaderDensity()` is the one definition of its width tiers (`full` / `compact` / `condensed` / `minimal`); the Header applies it as a `data-density` attribute, every header rule selects on that, and the same tier decides which controls move into `HeaderOverflowMenu`.
- **Every `var(--x)` a stylesheet reads must be defined** — a design token in `styles/variables.css` (added to `:root`, `[data-theme="light"]` and both S-Theme blocks) or a property the component scopes itself. `src/styles/__tests__/cssTokens.test.ts` fails CI otherwise; a fallback inside `var()` does not exempt it.
- **Bulk imports are chunked.** The import routes (`/vacations/import`, `/sites/{id}/holidays/import`, `/events/import`) reject more than 1 000 items (422), so `.ics` importers send through `postInChunks()` (`src/api/endpoints/importChunks.ts`, 500-item slices, counts added up) — never one big POST.
- **The running version comes from `/health`** (`getAppVersion()` in `src/api/endpoints/health.ts`), never a build-time constant — a build constant would keep showing the old number in a tab opened before an upgrade.

### Repository tooling (Trail)

The repo ships [Trail](https://github.com/trailhq/Trail-Code) for Claude Code sessions. `.claude/settings.json` wires its hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd → `.trail/hook.cjs`), and `.claude/hooks/session-start.sh` installs `@trailhq/trail-code` and runs `trail build` in cloud sessions (`CLAUDE_CODE_REMOTE=true`, telemetry off). The workflow is in `.claude/skills/trail/SKILL.md`:

- Read `.trail/learnings/` (or run `trail ask "<task>" --source`) before exploring — past sessions' decisions and dead ends live there.
- When a task took real digging, or the user corrected how something is done here, save a learning with `trail note` and commit it with the change.
- Run `trail check` before committing, pushing or opening a PR.
- `.trail/cache/` is per-machine (`.trail/.gitignore`); everything else under `.trail/` and `.claude/` is committed.

### Security Requirements

- **Two independent auth systems — never cross them.** Tenant app: `connect.sid` cookie → `sessions` table in the tenant DB. Admin portal: `admin_session` cookie → `admin_sessions` table in the master DB. A tenant session must never grant admin-portal access or vice versa.
- Every tenant route needs an auth dependency (`get_current_user` at minimum). Every admin route needs `get_current_admin` or `require_superadmin`. `get_current_admin` returns 403 while `must_change_password` is set; only `/admin/auth/change-password` (`get_current_admin_allow_password_change`) and `/admin/auth/me` (`get_current_admin_optional`) let such an admin through.
- Tenant user passwords: bcrypt (rounds=12) with lazy upgrade from legacy PBKDF2/plaintext on login. Admin-portal passwords: PBKDF2-SHA512 `pbkdf2_sha512$600000$<salt>$<hash>` with lazy upgrade from the legacy `salt:hash` (10 000 iterations) on login. Both in `app/services/encryption.py`. New/changed passwords ≥ 8 chars (both systems).
- Both login routes go through `app/services/login_throttle.py` (`check_login_allowed` / `record_login_failure` / `record_login_success`) and run a dummy hash verify for unknown e-mails (equal timing). Keep that on any new password route.
- SSO `state` parameters are HMAC-signed (carrying the tenant slug through the shared organization callback) **and** bound to the browser by a one-time `sso_nonce` cookie (10 min) — never accept an unsigned, unvalidated or nonce-less state.
- Tenant-level SSO client secrets are encrypted at rest too: read/write `sso_config.client_secret` only through `read_tenant_client_secret` / `store_tenant_client_secret` / `apply_secret_update` (`app/services/sso.py`; the masked `****abcd` form keeps the stored value). Never return it unmasked.
- Error bodies stay generic (`/health` reports `database: "error"`, the tenant 503 is a fixed message, 500s are opaque) — details go to the log only.
- Organization-level SSO **takes precedence** over tenant-level SSO; enabling tenant SSO while org SSO is active is rejected with 409 (`_reject_if_org_sso_active`). Preserve this guardrail.
- API docs (`/api/docs`, `/api/redoc`, `/api/openapi.json`) are gated to `role == "admin"` — keep them gated.
- **No fallthrough to `DB_*`**: a request carrying a tenant slug but no pool is a 503, never the default database.
- Revocation is immediate: `SessionService.destroy_user_sessions()` is called on deactivate / delete / role change / password set (it also closes the user's open WebSockets) — keep it on any new path that does one of these.
- `GET /settings` and `GET /settings/{key}` have no auth dependency — never store secrets in the `settings` table. `/health` is public — add no further config values to it.
- Tenant `admin` (`users.role`) and portal `admin` (`admin_users.role`, below `superadmin`) are separate accounts in separate databases — don't confuse them.

### Testing Conventions

- Backend tests live in `tests/` (pytest, `asyncio_mode=auto`, config in `pyproject.toml`). Style is **unit tests with mocks, no live DB**: `mock_db_session` (AsyncMock) and `app_client` (httpx `AsyncClient` + `ASGITransport` with dependency overrides) from `tests/conftest.py`.
- `tests/test_lint.py` shells out to ruff — lint failures fail the test suite too.
- `tests/test_migration_parser.py` covers `run_migration_master.py`'s `split_sql_statements()` (including `DO $$ ... END $$;` handling). Extend it when the migration runner must support new SQL constructs.
- Frontend uses Vitest 4 + Testing Library (`frontend/vitest.config.ts`, jsdom, setup in `src/test/setup.ts`). `Modal.test.tsx` and `CredentialsModal.test.tsx` are the executable guards of the modal no-backdrop-close rule (see Frontend Conventions) — breaking that rule fails CI.
- Shared test helpers: `frontend/src/test/factories.ts` (`makeProject`, `makePhase`, `makeSubphase`, `makeUser`, `makeStaff`, `makeSite`, `makeEquipment`, `makeVacation`, `makeTag`, `makeCustomColumn` — each takes a `Partial<T>` override) and `tests/support.py` (`scalar_result`, `scalars_result`, `unique_scalar_result` mock `Result` builders, `fake_websocket()`). Use them instead of redeclaring fixtures per file.
- **Every new feature and bug fix ships with automated tests in the same PR** — no exceptions, no "tests in a follow-up":
  - bug fix → a regression test that fails without the fix;
  - new or changed endpoint → a route test through `authed_client` covering success, the 403/404 paths and at least one rejected input;
  - service / business logic → a unit test;
  - new or changed component, hook or util → a Vitest test beside it (`__tests__/`);
  - pure refactor → the existing tests pass unchanged; say so in the PR. A refactor that rewrites lines
    (a component swap, a moved handler) still has to *exercise* every rewritten line — the diff-coverage
    gate below counts them, and a field whose `onChange` no test fires is an uncovered line; render-only
    assertions do not pass it;
  - docs- or CI-only change → no test needed; say so in the PR.
- **Enforcement (CI):**
  - **Diff coverage**: on every PR, `diff-cover` requires **≥ 80 %** of the lines the PR adds or changes to be covered (backend `coverage.xml`, frontend `coverage/lcov.info`).
  - **Suite floors**: `fail_under` in `pyproject.toml` (`[tool.coverage.report]`) and `coverage.thresholds` in `frontend/vitest.config.ts` sit just under the measured totals. Raise them in any PR that lifts the number; **never lower one, and never exclude a file to get past one** — the frontend `coverage.include`/`exclude` lists are fixed (every `src/**` file is measured, imported by a test or not).
  - **Badges**: the README coverage badges read `backend.json` / `frontend.json` from the orphan `coverage` branch, which the `Coverage Badges` jobs write on push to `main`. Never edit that branch or the badge numbers by hand. The remaining README badges are static shields.io badges in the same style as `vincentmakes/turbo-ea` (license FSL-1.1-MIT, Python, React): bump the Python badge together with the Dockerfile/CI Python version and the React badge together with the `react` dependency. There is no GHCR-pulls badge because `docker.yml` only builds the image, it publishes nothing, and no GitHub Sponsors badge by choice (`.github/FUNDING.yml` still powers the repo's Sponsor button).
- **Workflow edits**: compare `dorny/paths-filter` outputs with `== 'true'` (it emits the *string* `'false'`, which is truthy) — never shorten them to `a || b`; never commit to the `coverage` branch (only the two `Coverage Badges` jobs write it); a red `Audit` job is fixed at the pin, never by lowering `--audit-level`. Detail: [CI](docs/developer-guide/codebase-map.md#ci).
- **Greenlet gotcha**: keep `concurrency = ["greenlet", "thread"]` in `[tool.coverage.run]`. Async SQLAlchemy runs queries on greenlets, and without it coverage.py stops tracing a handler at its first `await db.execute()`. The suite is mock-only today, so it changes nothing yet — but the day a real-DB test lands, a file that looks untested past its first query is this setting, not a missing test.
- Run locally:
  - backend: `pytest --cov=app --cov-report=term-missing --cov-report=xml && diff-cover coverage.xml --compare-branch=origin/main` (`pip install diff-cover` once; it is a CI-step install, not a `requirements-dev.txt` pin);
  - frontend: `cd frontend && npm run test:coverage` (then `diff-cover coverage/lcov.info --compare-branch=origin/main` from `frontend/`); plain `npm run test -- --run` skips coverage.
- **Sharding**: `pytest --shard=K/N` (`tests/shard_plugin.py`, hooks imported by `tests/conftest.py`) runs one slice of the suite locally exactly as a CI shard does. Test **files** are dealt whole (largest first into the lightest shard), so a module's fixtures stay together and the N shards partition the suite (`tests/test_shard_option.py` proves it). Pass the same paths and `-k` to every shard. Frontend: Vitest's own `npx vitest run --shard=K/N`.

### Documentation (MkDocs)

- The user/admin/developer manual lives in `docs/`, built with **MkDocs Material** (`mkdocs.yml`; nav: Home (`index.md`) / User Guide / Admin Guide / Developer Guide, with a **Codebase Reference** group — the pages listed under [Reference pages](#reference-pages) — and Release Notes under Developer Guide).
- **Deployment is Cloudflare Pages, not GitHub Actions** — there is no `docs.yml` workflow. Cloudflare runs `docs/build.sh` (`pip install -r docs/requirements.txt && mkdocs build --strict`) with output dir `site/`.
- `docs/release-notes.md` embeds the root `CHANGELOG.md` via a pymdownx snippet — don't duplicate release notes in docs.
- Validate any docs change with `mkdocs build --strict` (catches broken links/images).
- User-facing feature changes should update the relevant `docs/user-guide/` or `docs/admin-guide/` page. Map: Gantt, tags, grouping → `gantt-charts.md`; Kanban, comments, notifications → `kanban-board.md`; staff, workload → `staff-management.md`; equipment → `equipment-booking.md`; absences, holidays, closures, `.ics` imports → `vacations.md` (calendar `.ics` in Settings → `settings.md`); What-If → `what-if-planning.md`; Settings hub → `settings.md`; presence, live updates → `collaboration.md`; shortcuts → `keyboard-shortcuts.md`; frontend conventions → `UI_GUIDELINES.md` in the repo root (not on the docs site); MS Project, CSV, Excel export → `import-export.md`; SSO and organizations → `admin-guide/organizations-sso.md`; tenants → `admin-guide/multi-tenant.md`; migrations → `admin-guide/database.md`.
- **Keep the reference pages in sync** in the same PR: a route change → `docs/developer-guide/routes.md` + `api-reference.md`; a schema or migration change → `database-schema.md` + `docs/admin-guide/database.md` + `migrations/README.md`; a store, hook or util → `frontend-architecture.md`; a WebSocket slice → `realtime.md`; auth, roles or tenancy → `auth-and-tenancy.md`; a new file, env var, CI job or site-export sheet → `codebase-map.md`; a convention's detail → `conventions-in-depth.md` (its rule stays here). Detail goes to the page, the rule stays in this file.

### Documentation Screenshots

When asked to **add, update, or refresh screenshots in the MkDocs docs** (`docs/`), use the canonical capture pipeline in `scripts/screenshots/` — do not capture by hand. Capture against the **demo tenant only** (seeded by `python -m app.scripts.seed_demo`; login `admin@demo.local` / `demo1234`), then verify with `mkdocs build --strict`. The steps, the conventions the scripts enforce and how to add a shot: [`scripts/screenshots/README.md`](scripts/screenshots/README.md) and [Documentation Screenshots](docs/developer-guide/conventions-in-depth.md#documentation-screenshots).

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

- `README.md`, `CLAUDE.md`, `UI_GUIDELINES.md`, `CHANGELOG.md` itself
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

## Gotchas

- The `Note` model's tablename is **`staff_notes`**. All schema sources create `staff_notes` now; databases from old installs may carry a legacy `notes` table until `migrations/add_staff_notes.sql` or the tenant auto-migration runs (it migrates the rows and drops `notes`).
- Per-entity write rules (project manager, self-assignment) live in `app/services/project_access.py`, Kanban's assignee-may-move rule in `app/services/card_access.py`. Both take primitives/`id`+`role` only, because `get_current_user` usually returns a `SessionUser`, not an ORM `User`. Check them *after* loading the entity, with the server-derived `project_id` — never trust a `project_id` from the request body.
- Tenant info: `TenantMiddleware` writes a plain dict into `scope["state"]`. `request.state.tenant_slug` works in HTTP handlers (Starlette wraps the dict), but code handling raw ASGI scopes must read `scope["state"]["tenant_slug"]` directly.
- The Vite dev server (:3333) has **no API proxy** — the client targets `:8485` directly, so the backend must be running; full tenant/WS behaviour is best tested on `:8485` with the built frontend.
- `run_migration_master.py` handles `DO $$ ... END $$;` blocks correctly (`split_sql_statements()`, tested in `tests/test_migration_parser.py`) — but keep migrations idempotent regardless.
- MPP file import requires Java (JRE 11+), included in the Docker image but not in dev environments by default.
- The User model has a `full_name` property — use it instead of manual `first_name + last_name` concatenation.
- Middleware must be **pure ASGI** — `BaseHTTPMiddleware` breaks WebSocket connections (this is why a timing middleware was removed).
- Zustand persistence: Sets serialize as arrays with custom `merge` restore; don't persist Maps (`appStore` holds `criticalPathItems` and `closureIndex` Maps that are deliberately excluded from `partialize` — keep it that way).
- **Rotating `SESSION_SECRET` in single-tenant mode invalidates the stored tenant SSO client secret** (its encryption key is derived from it): SSO then reports "not configured" until an admin re-enters the secret in Settings → SSO. Same for changing `TENANT_ENCRYPTION_KEY` in multi-tenant mode (which also breaks tenant DB credentials).
- The login throttle, `disconnect_user` and the tenant cache/pool reset are all **per process**: with several uvicorn workers the throttle limit multiplies, a revoked user's socket on another worker stays open until it drops (HTTP is already rejected), and other workers see tenant changes within the 60 s cache TTL.
- WebSocket close code **4003** means both "origin not allowed" and "user disabled"; the client treats it like 4001 (re-check the session, no reconnect).
- `change:note` and `change:card_comment` map to **no** refetch slice on purpose (nothing in the stores holds notes; comment threads fetch themselves). Don't "fix" them to refresh everything.
- `GET /vacations?siteId=` returns everyone at that site for any user; only the no-`siteId` form and `GET /vacations/{id}` are restricted for plain users (own + colleagues sharing a site; anything else is a 404).
- **`MASTER_DB_NAME` defaults to `milestone_master`** in the app and the migration runners alike (`tests/test_follow_up_defaults.py` keeps them equal), but `docker-compose.fresh.yml`, the devcontainer and the admin docs use `milestone_admin` — existing volumes hold a database of that name, so those deployments keep setting it explicitly.
- **Notification rules live in `app/services/notifications.py`**, not in routers: the actor never notifies themselves, one row per recipient per event (priority mention > assigned > status_change > comment), and rows are staged before the caller's commit so a notification lands in the same transaction as the change that caused it.
- **Nager v3/v4** (`app/services/holidays.py`): the version is read from the last segment of `NAGER_API_URL` (anything unrecognised is treated as v4 with a warning); v3 logs its 2027-01-31 end-of-life warning when fetching; only `public`/`bank` holidays are stored (entries without a type are kept), so school or observance days never reduce capacity.
- **The proxy settings are not symmetric**: PAC, proxy credentials, `PROXY_CA_CERT` and `PROXY_VERIFY_SSL` reach only the Nager import. SSO token exchange, Graph and the org SSO test use plain `httpx` clients that honour only the process `HTTP(S)_PROXY` variables.
- There are no `SSO_*` environment variables (the dead settings were removed in 1.6.2; an old `.env` that still sets them is ignored). Configure SSO in-app: tenant Settings → SSO, or organization SSO in the admin portal.

## Reference pages

Published in the developer guide under **Codebase Reference**:

- [Codebase map](docs/developer-guide/codebase-map.md)
- [Database schema and migrations](docs/developer-guide/database-schema.md)
- [Route auth gates and side effects](docs/developer-guide/routes.md)
- [Authentication and tenancy](docs/developer-guide/auth-and-tenancy.md)
- [Real-time collaboration internals](docs/developer-guide/realtime.md)
- [Frontend architecture](docs/developer-guide/frontend-architecture.md)
- [Conventions in depth](docs/developer-guide/conventions-in-depth.md)
- [`UI_GUIDELINES.md`](UI_GUIDELINES.md) — deserves the same split later (8 900 words, about 12k tokens per UI agent).
- User-facing pages: the map in the **Documentation (MkDocs)** bullets above.
