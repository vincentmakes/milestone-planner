# CLAUDE.md - Milestone Planner

Multi-tenant SaaS platform for R&D project management: interactive Gantt charts with phase/subphase hierarchies and dependencies, staff allocation with workload heatmaps, equipment booking with conflict detection, vacation/holiday tracking, real-time multi-user collaboration over WebSockets, What-If planning, Microsoft Entra SSO, and MS Project import/export. FastAPI backend + React/TypeScript frontend.

**Current version**: see `/VERSION` (single source of truth, one line, no `v` prefix). The backend reads it at import in `app/__init__.py` and exposes it via `/health`.

**License**: Functional Source License 1.1 with MIT Future License (**FSL-1.1-MIT**, `/LICENSE`) since 1.6.1 — releases up to and including 1.6.0 were MIT. Each release converts to MIT two years after publication, so the README keeps describing Milestone as an open-source platform. Never re-add MIT wording or an MIT `license` field anywhere: the README License section, the README license badge, `frontend/package.json` `license` (mirrored in `package-lock.json`'s root entry) and `/LICENSE` must all say FSL-1.1-MIT.

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

## AI Assistant Guidelines

When working on this codebase, follow these conventions:

### General Principles

- **Two SQLAlchemy declarative bases — never mix them.** Tenant-database models use `Base` (`app/database.py`); master-database models use `MasterBase` (`app/models/tenant.py`). A model on the wrong base silently lands in the wrong `metadata` and breaks provisioning/init.
- **Node.js compatibility is a contract, not an accident.** This app replaced a Node/Express implementation and keeps wire-level compatibility: `CustomJSONResponse` formats datetimes like `toISOString()` (stored values are UTC and are emitted as UTC with a `Z` suffix — no local-offset shift) and coerces whole floats to ints; sessions are express-session-compatible (`connect.sid` cookie, `s%3A<id>.` value format, `sessions` table shape); credential encryption uses the Node `iv:authTag:ciphertext` hex format. Changing any of these serialization behaviours is a breaking change.
- **Optimistic frontend + WebSocket refetch.** The frontend mutates Zustand state immediately and persists after; other clients converge via `change:<entity>` WebSocket events that trigger debounced slice refetches. On a failed persist the frontend reloads everything from the server and clears undo history. Keep new features inside this model — don't invent per-feature sync mechanisms.
- **Site export is a canonical snapshot.** Any new site-scoped data must be added to `build_site_export_workbook()` — see the Site Export contract under Import & Export below.
- **There is no client-side router.** `react-router-dom` was removed from `package.json` (it was never imported) — don't re-add it. `App.tsx` branches on `window.location.pathname` (exactly `/admin` or `/admin/…` → admin portal, everything else → main app), and in-app views (gantt/kanban/todos/staff/equipment/crosssite/archived) are `viewStore` state, not URLs. Don't add routes; add views to `viewStore` + `MainLayout.renderView()`.
- **Raw SQL migrations only — never introduce Alembic.** Migrations are idempotent `.sql` files in `migrations/` executed by `run_migration.py` (tenant DBs) / `run_migration_master.py` (master DB).

### Backend Conventions

- Route handlers live in `app/routers/`, one file per resource domain, and **must be registered in `create_app()` in `app/main.py`** (`app.include_router(...)`). Cautionary tale: a `presence.py` router was once written but never registered — its HTTP endpoints sat dead for a long time before being deleted (presence works over WebSocket). Verify registration when adding a router.
- Use `async def` and `AsyncSession` for all handlers and DB access. For read-only endpoints on hot paths, prefer the `get_db_readonly` dependency (`app/database.py`) over `get_db` — it skips commit/rollback overhead; `GET /projects` and `GET /projects/{id}` are the reference users.
- **Gate on permission keys, never on role names.** Routes use the dependencies from `app/middleware/auth.py`: `get_current_user` (any authenticated user), `require_permission(key)` / `require_any_permission(*keys)` (403 `Permission required: <key>`), `require_project_permission(key)` (adds the PM bundle; the path parameter must be named `project_id`); `require_admin` is only for the lockout-proof surface (roles and approval-policy writes). Every key comes from the catalogue in `app/services/permissions.py`. Rules that need the entity live in the access services: `project_access.py` (`can_on_project`/`require_on_project`, editor-first `resolve_self_booking`), `approvals.py` (own-booking approval requests, see the next bullet), `card_access.py`, `site_access.py` (async `ensure_site_access(request, db, user, site_ids, detail)` on the live visible sites), `user_access.py` (edit target, escalation and last-admin guards). Never define a local role check in a router; admin-ness is `role == 'admin'` (the one admin role), and `staff.py`'s `role != 'admin'` resource filter is the only role literal left in a router. Admin-portal routes use `get_current_admin` / `require_superadmin` from `app/routers/admin/auth.py` against the master DB. The `is_system` flag on users protects the provisioned admin from deletion.
- **Real-time broadcast is two-tier.** For user-facing mutations on projects/phases/subphases/assignments, call `broadcast_change(...)` (`app/websocket/broadcast.py`) with rich attribution (entity, action, summary). Everything else is covered automatically: `BroadcastMiddleware` (`app/middleware/broadcast.py`) fires a coarse `change:<entity>` on any successful 2xx write, and its `SKIP_PATTERNS` list suppresses the paths that already do rich broadcasts (now including `/api/kanban` and `/api/notifications`). When you add rich broadcasting to a new path, add it to `SKIP_PATTERNS` too — otherwise clients receive double events.
- **Approval workflow for own bookings** (`app/services/approvals.py`, routes `app/routers/approvals.py`). The eleven self-booking decision points (POST `/projects/{id}/staff`, `/phases/{id}/staff`, `/subphases/{id}/staff`, PUT/DELETE `/assignments/{id}`, `/phase-staff/{id}`, `/subphase-staff/{id}`, Kanban POST/DELETE assignees) all go one way: `resolve_self_booking` (creates) or `approvals.resolve_row_write` (existing rows) decides editor first; an `"approval"` outcome goes to `approvals.submit_request`, which answers **202** `{success: true, pending: true, request_id, id}` — never decide it on the client. A pending create is a real row (`approval_status = 'pending'`, `approval_request_id`), excluded from availability, card access (`card_access`) and assignee notifications (`card_assignee_ids`); a pending update/removal leaves the row untouched and stores `requested`/`previous` on the request. Request statuses: `pending` → `approved` / `rejected` / `cancelled` / `superseded` / `expired` (`close_reason`: `target_deleted`, `requester_inactive`, `permission_lost`, `overtaken`, `duplicate`); a decision on a closed request is 409 `{detail, status}`. Approvers are resolved live (`approver_user_ids` / `can_decide`: admins always, the PM when the policy's `pm_approves`, holders of the policy's roles — active, seeing the project's site, never the requester); `approve` re-validates in its transaction and closes the request `expired(<reason>)` with a 409 when the booking can no longer apply; stored values no longer valid for the request's level answer 409 `INVALID_VALUES_DETAIL` and leave it pending (reject it instead). Direct writes keep the workflow consistent: a second booking of the same person on a target is 409 (pending included); an editor's PUT/DELETE on a pending-create row is 409 "This booking awaits approval — approve or reject it instead"; a direct write on a row with an open request calls `expire_overtaken`; phase/subphase/project deletes call `cancel_for_entity` first; deactivating or deleting a requester (`users.py` PUT `active=0`, toggle-active, DELETE) calls `expire_for_requester` (`requester_inactive`). The `to_decide` list and My Todos' approval items hold the eligibility rule in SQL (`decider_clause`), so a page is never cut short. Every transition notifies (`approval_requested` / `approval_decided`), broadcasts `change:approval_request` (approve/reject also `change:staff_assignment`) and pushes `approval:changed` per user (`publish`, after the commit).
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
- Secrets at rest (tenant DB passwords, SSO client secrets) go through `app/services/encryption.py` (AES-256-GCM, `iv:tag:ciphertext` hex). Never store plaintext credentials.
- **Before every commit**: `ruff check app/ && ruff format --check app/ && mypy app/`. CI fails on any of these.

### Frontend Conventions

- **Read `UI_GUIDELINES.md` (repo root) before any UI work.** It holds the design tokens (every colour named, per theme), the shared components, the layout patterns and the known drift; the bullets below are one-line summaries of its rules.
- **Store ownership**: domain data (sites/projects/staff/equipment/vacations/absence types/holidays/skills/tags + tag groups/teams/roles + approval policies/settings) → `appStore`; view state (mode, zoom, expansion, scroll, current view, per-site tag filter, Gantt group-by / colour-by, Kanban board preferences) → `viewStore`; transient UI (modals, drag/resize, dependency linking, context menus) → `uiStore`; What-If sandbox → `whatIfStore`; undo/redo snapshots → `undoStore`; custom-column data/filters/visibility → `customColumnStore`; admin portal → `adminStore`; notification inbox → `notificationStore`; My Todos (tasks, requests to decide, own requests) → `todoStore`. Don't put domain data in `uiStore` or UI state in `appStore`. Selectors must not return a freshly allocated array or object (Zustand 5 re-renders forever — the old `selectSiteProjects`-style array selectors were removed for this): select the raw slice and filter with `useMemo`, or wrap the selector in `useShallow`.
- **All backend↔frontend field mapping lives in the API layer**, chiefly `src/api/endpoints/projects.ts` (`transformProject/Phase/Subphase/...` — phase `type`↔`name`, `sort_order`→`order_index`, the tree reshaping; see Transform layer). The frontend model is mostly snake_case like the API. Components consume the frontend model from `src/types/models.ts` only; never transform field names in components.
- **New write endpoints are What-If-intercepted by default.** The API client queues every POST/PUT/PATCH/DELETE while What-If mode is active, except URLs under `/api/auth/`, `/api/settings/`, `/api/admin/`, `/api/notifications`, the Kanban *comment* paths, the RBAC endpoints `/api/roles`, `/api/permissions`, `/api/approval-policies` (configuration), `/api/todos` (private rows) and `/api/approval-requests` (a decision is a message to a person and cannot be rolled back — own bookings stay queued and a 202 on Apply becomes a request), and the **configuration endpoints** `/api/tags`, `/api/tag-groups`, `/api/teams`, `/api/absence-types`, `/api/skills`, `/api/equipment-types`, `/api/predefined-phases`, `/api/users`, plus site and equipment *definitions* only (`/api/sites`, `/api/sites/{id}`, `/api/equipment`, `/api/equipment/{id}` — their calendar and booking sub-resources `/api/sites/{id}/holidays|events`, `/api/events`, `/api/equipment-blocks`, `/api/equipment-assignments` stay queued, they are plan data). Configuration is never part of the What-If snapshot, so queuing it only makes edits vanish and deletes fail on Apply; `isWhatIfExempt()` in `src/api/client.ts` is the one list (card moves and assignments stay queued — they are plan operations; comments are not, and a queued comment cannot be rolled back on Discard and would be duplicated on Apply). If a new endpoint must bypass What-If (rare), extend the exemption list in `src/api/client.ts` deliberately — and if it must be queued, ensure the local optimistic update is complete since the server won't respond for real.
- **Optimistic-write failure protocol**: on persist failure, reload the affected data from the server and call `undoStore.clear()` — a stale undo stack against fresh server state corrupts data. Implemented once in `recoverFromPersistFailure(context, err)` (`src/utils/persistFailure.ts`) — call it from the `catch`, don't open-code the two steps. `useDragAndDrop` and `useUndoRedo` are the reference users.
- **Dialog writes use `useSubmitGuard`** (`src/components/common/useSubmitGuard.ts`, a ref-based in-flight flag) so Enter-twice / double-click cannot create duplicates; Settings-hub panels report unsaved input with `useReportDirty(onDirtyChange, dirty)` (`src/components/settings/useReportDirty.ts`, one combined flag per panel) so the hub asks before switching section or closing.
- **Action buttons use the shared `Button`** (`src/components/common/Button`, `md`, `icon` prop with an icon from `components/settings/panels/PanelIcons.tsx`) inside `PanelToolbar` (`src/components/settings/PanelToolbar.tsx`: `left` = filters/counts, `right` = secondary actions then the primary "Add X"; `align="end"` when the left slot holds labelled fields); never a raw `<button>` with local styles for an action. Back links are ghost `md` Buttons with `BackIcon`; `sm` only for actions repeated on every row. Documented exceptions: the Gantt header's compact 28 px icon buttons and the Kanban filter toolbar — see `UI_GUIDELINES.md`.
- **Errors show in place, never in `alert()`.** A form or panel renders its message with the shared `Notice` (`src/components/common/Notice`, `tone` error/warning/info/success, `role="alert"` for errors); an action with no form of its own reports through `uiStore.showFlash()` (rendered by `layout/FlashNotice`). **Confirmations go through `confirmAction()`** (`src/utils/confirmDialog.ts`): `await confirmAction({ message, title?, destructive?, confirmLabel?, cancelLabel? })` resolves `true`/`false`; the one host `ConfirmDialog` (`src/components/common/ConfirmDialog`, mounted in `App.tsx` so the admin portal is covered too) renders it on the shared `Modal` with a `danger` **Delete** button when `destructive`. Never call `window.confirm` — a handler that confirms must be `async` and `await` the result, and confirm *before* taking a submit guard. Tests stub the service with `stubConfirm(result)` from `src/test/confirmDialog.ts` (restored after each test by `test/setup.ts`) and assert `expect.objectContaining({ message })`, never `vi.spyOn(window, 'confirm')`.
- **Dropdowns, popovers and menus dismiss through `useDismissableOverlay`** (`src/hooks/useDismissableOverlay.ts`): outside mousedown, Tab out, capture-phase Escape with focus back on the trigger. Don't hand-roll a click-outside effect; the panel is a `role="dialog"` (checkbox/radio panels) or `role="menu"` (`ContextMenu`) with a name, and its trigger carries `aria-expanded` + `aria-haspopup`.
- **Form fields are the shared `Input` / `Select`** (`src/components/common/Input|Select`): every text-like `<input>` (text, email, password, number, date, …) and every `<select>` in a dialog, Settings panel, admin modal or login screen, with the visible label passed as `label` (or an `aria-label`). The only raw ones left are documented exceptions (inline row-rename editors, the two ARIA comboboxes, the Gantt cell editor, the header `SiteSelector`, the phone-only Settings section picker, the credentials copy fields); `src/components/__tests__/rawFormControls.test.ts` counts raw controls per component against `rawFormControlsAllowlist.json` and fails when a count rises or the allowlist names a file that no longer needs it. Native date pickers follow the theme through `color-scheme` in `styles/variables.css` — never set it in a component stylesheet.
- **Stylesheets use tokens only.** `src/styles/__tests__/cssTokens.test.ts` fails on an undefined `var(--x)`, on a fallback value for a defined token, and on any `*.module.css` whose hex/rgba count rises above `rawColorAllowlist.json` (a ratchet: lower a file's number when you pay its debt, never raise one). Alpha variants are `color-mix(in srgb, var(--accent-red) 25%, transparent)`, shadows the `--shadow-*` tokens; `PhaseBar`/`ProjectBar` text colour comes from `barTextColor()`.
- **Modals close only via explicit buttons or the Escape key — never on backdrop/outside click.** Clicking outside a modal must NOT close it (it discards in-progress input, e.g. when a text-selection drag ends on the backdrop). The shared `Modal` component (`src/components/common/Modal/`) enforces this and has no overlay-click prop; new dialogs must use it. Standalone dialogs that can't (like the admin-portal modals in `src/components/admin/modals/`) must not attach close handlers to their overlay and should use the `useEscapeKey` hook for Escape support. This rule is for modals/dialogs only — dropdowns, context menus, and popovers keep their click-outside-to-close behavior.
- **Gate on permission keys, never on role names.** Every check goes through `src/utils/permissions.ts` — `can(user, key, project?)` (a held key, or a `PM_BUNDLE` key on a project whose `pm_id` is the user while `projects.manage_as_pm` is held), `canSelf` / `needsApproval` (own bookings: allow **or** approval mode counts as "may"; the server decides the 202), `canEditProject(ById)`, `canEditAssignment(user, project, staffId, selfKey?)`, `canBookSelf`, `canBookEquipment(ById/OnAny)` (`equipment_bookings.manage`), `canManageAbsencesOf`, `canManageAnyProject`, `isSelf` — or the hooks `useHasPermission` / `useNeedsApproval` / `useCan` (`src/hooks/useCan.ts`); the helpers mirror `app/services/project_access.py`. The user's keys come from `/auth/me` (`permissions` = allow keys, `approval_required`, `can_see_all_sites`, `role_name`, mapped by `transformUser`); a user object without `permissions` is denied — there is no role fallback. Key spellings live in `src/types/permissions.ts`, mirrored from `shared/permission-keys.json` (`permissions.catalogue.test.ts` fails on drift). Visible sites come from `useVisibleSites()`, view access from `useAllowedViews()` (`VIEW_PERMISSIONS`), Settings sections from their `permission` field. The one role literal left is `UsersPanel`'s "target is an admin" check (`ADMIN_ROLE_KEY`, the backend's admin-ness rule).
- Direct localStorage access goes through the typed helpers and `STORAGE_KEYS` in `src/utils/storage.ts` (which also documents the Zustand `persist` key names — keep that list in sync). Zustand stores declare their persist keys inline (`milestone-app-storage-v3`, `milestone-view-storage-v1`, `milestone-custom-columns-storage-v1`) and serialize `Set`s as arrays with custom `merge` — follow the existing pattern in `viewStore`.
- ESLint: `react-hooks/rules-of-hooks` is an **error** (fails CI); most other rules are at **warn** level, so CI's lint job will not catch everything else. Treat warnings as errors when writing new code.
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
- API docs (`/api/docs`, `/api/redoc`, `/api/openapi.json`) are gated to the `system.api_docs` permission (admins only by default) — keep them gated.

### Testing Conventions

- Backend tests live in `tests/` (pytest, `asyncio_mode=auto`, config in `pyproject.toml`). Style is **unit tests with mocks, no live DB**: `mock_db_session` (AsyncMock) and `app_client` (httpx `AsyncClient` + `ASGITransport` with dependency overrides) from `tests/conftest.py`.
- `tests/test_lint.py` shells out to ruff — lint failures fail the test suite too.
- `tests/test_migration_parser.py` covers `run_migration_master.py`'s `split_sql_statements()` (including `DO $$ ... END $$;` handling). Extend it when the migration runner must support new SQL constructs.
- Frontend uses Vitest 4 + Testing Library (`frontend/vitest.config.ts`, jsdom, setup in `src/test/setup.ts`). `Modal.test.tsx` and `CredentialsModal.test.tsx` are the executable guards of the modal no-backdrop-close rule (see Frontend Conventions) — breaking that rule fails CI.
- Shared test helpers: `frontend/src/test/factories.ts` (`makeProject`, `makePhase`, `makeSubphase`, `makeUser`, `makeStaff`, `makeSite`, `makeTeam`, `makeEquipment`, `makeVacation`, `makeTag`, `makeCustomColumn`, `makeRole` / `makeSystemRoles`, `makeTodo`, `makeApprovalRequest` — each takes a `Partial<T>` override; `makeUser` derives `permissions`, `role_name` and `can_see_all_sites` from `role` unless given), `frontend/src/test/permissionFixtures.ts` (`USER_DEFAULTS` / `SUPERUSER_DEFAULTS` / `ALL_PERMISSIONS`, `permissionsForRole`, `asSignedIn`, `makeCatalogue`), `tests/conftest.py` (`FakeUser(role, permissions=…, site_ids=…)` — `permissions` takes keys, a `{key: mode}` dict or a `PermissionSet`, default the role's shipped defaults; `permissive_user()`; the `site_links` fixture placing people, projects and equipment at sites) and `tests/support.py` (`scalar_result`, `scalars_result`, `unique_scalar_result` mock `Result` builders, `fake_websocket()`, the approval fakes `ApprovalFakeDB` / `approval_request` / `pending_phase_row`). Use them instead of redeclaring fixtures per file.
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
- **Greenlet gotcha**: keep `concurrency = ["greenlet", "thread"]` in `[tool.coverage.run]`. Async SQLAlchemy runs queries on greenlets, and without it coverage.py stops tracing a handler at its first `await db.execute()`. The suite is mock-only today, so it changes nothing yet — but the day a real-DB test lands, a file that looks untested past its first query is this setting, not a missing test.
- Run locally:
  - backend: `pytest --cov=app --cov-report=term-missing --cov-report=xml && diff-cover coverage.xml --compare-branch=origin/main` (`pip install diff-cover` once; it is a CI-step install, not a `requirements-dev.txt` pin);
  - frontend: `cd frontend && npm run test:coverage` (then `diff-cover coverage/lcov.info --compare-branch=origin/main` from `frontend/`); plain `npm run test -- --run` skips coverage.
- **Sharding**: `pytest --shard=K/N` (`tests/shard_plugin.py`, hooks imported by `tests/conftest.py`) runs one slice of the suite locally exactly as a CI shard does. Test **files** are dealt whole (largest first into the lightest shard), so a module's fixtures stay together and the N shards partition the suite (`tests/test_shard_option.py` proves it). Pass the same paths and `-k` to every shard. Frontend: Vitest's own `npx vitest run --shard=K/N`.

### Documentation (MkDocs)

- The user/admin/developer manual lives in `docs/`, built with **MkDocs Material** (`mkdocs.yml`; nav: Home (`index.md`) / User Guide / Admin Guide / Developer Guide, with Release Notes under Developer Guide).
- **Deployment is Cloudflare Pages, not GitHub Actions** — there is no `docs.yml` workflow. Cloudflare runs `docs/build.sh` (`pip install -r docs/requirements.txt && mkdocs build --strict`) with output dir `site/`.
- `docs/release-notes.md` embeds the root `CHANGELOG.md` via a pymdownx snippet — don't duplicate release notes in docs.
- Validate any docs change with `mkdocs build --strict` (catches broken links/images).
- User-facing feature changes should update the relevant `docs/user-guide/` or `docs/admin-guide/` page. Map: Gantt, tags, grouping → `gantt-charts.md`; Kanban, comments, notifications → `kanban-board.md`; My Todos, tasks, approval requests → `my-todos.md`; roles, permissions, approvals → `settings.md`; staff, workload → `staff-management.md`; equipment → `equipment-booking.md`; absences, holidays, closures, `.ics` imports → `vacations.md` (calendar `.ics` in Settings → `settings.md`); What-If → `what-if-planning.md`; Settings hub → `settings.md`; presence, live updates → `collaboration.md`; shortcuts → `keyboard-shortcuts.md`; frontend conventions → `UI_GUIDELINES.md` in the repo root (not on the docs site); MS Project, CSV, Excel export → `import-export.md`; SSO and organizations → `admin-guide/organizations-sso.md`; tenants → `admin-guide/multi-tenant.md`; migrations → `admin-guide/database.md`.

### Documentation Screenshots

When asked to **add, update, or refresh screenshots in the MkDocs docs** (`docs/`), use the canonical capture pipeline in [scripts/screenshots/](scripts/screenshots/) — do not capture by hand.

**Pipeline:**
1. **Spin up the demo instance** (self-contained Postgres + app on port 8486):
   ```bash
   cp .env.example .env  # if missing — generate SESSION_SECRET and TENANT_ENCRYPTION_KEY (64-char hex each)
   docker compose -f docker-compose.fresh.yml up -d --build
   docker exec milestone-fresh python -m app.scripts.seed_demo
   ```
   This produces tenant `demo` (Demo Company) with the canonical projects (Bioprocess Scale-Up, Catalyst Optimization, Analytical Method Transfer, Quality System Upgrade) and everything the screenshots show: tag groups, subphases, dependencies, staff and equipment bookings, blocks, Swiss and German bank holidays, a site closure, every absence type, custom columns, Kanban comments and notifications, a *Team Lead* custom role, the User role booking itself with approval, Diana's pending request to join Bob's *Bioprocess Scale-Up* and a few tasks. The data is one Python module, `app/scripts/demo_data.py` (dates relative to the day you seed); the same seed runs in Codespaces, so there is no second SQL step. Login: `admin@demo.local` / `demo1234` (and `bob.brown@demo.local` for multi-user collab shots). **`.env` must set `MULTI_TENANT=true`, a `TENANT_ENCRYPTION_KEY`, and `INIT_ADMIN_PASSWORD`** (deterministic admin-portal login for `capture_admin.py`) — see `scripts/screenshots/README.md`.
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

All three capture scripts default to `http://localhost:8486`; set `SCREENSHOT_BASE_URL` (e.g. `http://localhost:8487`) to capture from another instance.

**Without the Docker image** (cloud sessions, where the image build cannot trust the session proxy's CA): run PostgreSQL alone in a container, the backend from a Python venv with uvicorn on 8485, build and `deploy-react.sh` the frontend **before** starting uvicorn, seed with `python -m app.scripts.init_db` then `seed_demo`, and capture with `SCREENSHOT_BASE_URL=http://localhost:8485`. Playwright must match the preinstalled Chromium (never `playwright install`). The step list is in `scripts/screenshots/README.md` → "Capturing without the Docker image".

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
- Docs endpoints (`/api/docs`, `/api/redoc`, `/api/openapi.json`) require an authenticated tenant user holding `system.api_docs` (admins by default).
- A global exception handler returns an opaque 500 (no stack traces to clients).

## Terminology

- **Tenant** — an isolated customer workspace with its own PostgreSQL database (`milestone_<slug>`), reached at `/t/{slug}/`. Managed from the admin portal.
- **Site** — a physical location *within* a tenant (labs/offices). Most data (projects, equipment, holidays, events) is site-scoped; users belong to one or more sites via `user_sites`, equipment via `equipment_sites`, company events via `company_event_sites`. **Sites scope access**: without `sites.view_all` (admin-only by default) a user reads and writes only the data of their *visible sites* (their live `user_sites`), see Tenant role model.
- **Organization** — a master-DB grouping of tenants that share one Microsoft Entra SSO configuration.
- **Tenant role** (`users.role`, FK → `roles.key`) — a named **permission set**: one mode per catalogue key (`allow`, `approval` on the three own-booking keys, or deny). Three system roles are seeded — `admin` (every key, in code; not editable), `superuser` and `user` (editable defaults reproducing the pre-1.13 behaviour) — and admins add custom roles in Settings → Roles. See Tenant role model.
- **Permission key** — one entry of the catalogue in `app/services/permissions.py` (59 keys, 17 groups), e.g. `projects.create`, `sites.view_all`. Locked: `projects.view` (always allow) and `roles.manage` (admin only). The **PM bundle** is the 7 keys a holder of `projects.manage_as_pm` gets on the projects whose `pm_id` they are.
- **Visible sites** — the sites a user reads and writes: every site with `sites.view_all`, otherwise their live `user_sites`.
- **Approval request** — an own booking (`assignments.self_*` in approval mode) waiting for an approver; its pending create is a real assignment row with `approval_status = 'pending'`.
- **Todo** — a personal task in My Todos (`todos` table); the requests a user may decide are listed there too as virtual approval todos (never stored).
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
shared/
  permission-keys.json # Committed mirror of the permission catalogue ({keys, approvable, pm_bundle}),
                       #   generated by permissions.permission_keys_json(); read by the frontend tests
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
    user.py            # User (full_name, role FK → roles.key, role_name column_property, permissions,
                       #   max_capacity, is_system), UserSite
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
    team.py            # Team (per site, name unique per site, active), TeamMember, ProjectTeam,
                       #   TagTeam, CompanyEventTeam, EquipmentTeam — every FK cascades
    card_comment.py    # CardComment — Kanban card comments, polymorphic (entity_type, entity_id),
                       #   mentioned_user_ids derived from the body
    notification.py    # Notification — per-recipient inbox (due-soon/overdue are derived client-side)
    rbac.py            # Role, RolePermission, ApprovalPolicy, ApprovalPolicyRole, ApprovalRequest
    todo.py            # Todo — a task for one assignee (approval todos are virtual, not stored)
    note.py            # Note — tablename is staff_notes
    settings.py        # Settings (KV), PredefinedPhase, SSOConfig (singleton)
    session.py         # Session (express-session compatible)
    presence.py        # ProjectPresence
  routers/             # FastAPI route handlers (registered in main.py)
    absence_types.py   # Absence type CRUD + reorder (writes: absence_types.manage)
    admin/             # Admin portal: auth.py, tenants.py, users.py → /api/admin/*
    admin_organizations.py  # Organization CRUD + org SSO (+ /sso/test diagnostic) + tenant attach
                       #   → /api/admin/organizations
    approval_policies.py # Who approves each own-booking action (GET any user, PUT require_admin)
    approvals.py       # Approval requests: list (mine / to_decide / all), detail, approve / reject /
                       #   cancel (the workflow lives in services/approvals.py)
    assignments.py     # Staff assignments (3 levels; own bookings may answer 202) + equipment assignments
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
    roles.py           # GET /permissions (the catalogue for the matrix) + role CRUD (writes require_admin)
    settings.py        # Instance settings (KV) + tenant SSO settings
    sites.py           # Sites, bank holidays (edit, .ics import, Nager refresh), multi-site
                       #   company events (/events routes + legacy /sites/{id}/events)
    skills.py          # Skills + user-skill assignment
    staff.py           # Staff read endpoints (staff are users; created via /users)
    tag_groups.py      # Tag group CRUD + reorder (writes: tags.manage)
    tags.py            # Project tag CRUD + reorder (writes: tags.manage; read for everyone)
    teams.py           # Team CRUD + members (writes: teams.manage at visible sites; read for everyone)
    todos.py           # My Todos: own / assigned tasks + the approvals to decide (private rows,
                       #   per-user todo:changed pushes, no tenant-wide broadcast)
    users.py           # User management
    vacations.py       # Vacation/absence CRUD + bulk import (/vacations/import)
  schemas/             # Pydantic request/response schemas (one file per domain;
                       #   base.py holds Node-compatible serializers + DateRangeOrdered)
  services/
    approvals.py       # Own-booking approval workflow: submit_request (202), resolve_row_write,
                       #   approve / reject / cancel, approver_user_ids / can_decide (live),
                       #   expire_overtaken / cancel_for_entity hooks, publish (broadcast + pushes)
    auth.py            # Shared admin-session validation
    card_access.py     # require_card_status_write: kanban.move_any, or an approved assignee
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
    notifications.py   # Notification rows for Kanban, approval and todo events (actor excluded,
                       #   one per recipient, priority order)
    permissions.py     # The permission catalogue (PERMISSIONS, APPROVABLE_KEYS, PM_BUNDLE, LOCKED_KEYS,
                       #   SYSTEM_ROLES, default seed SQL, permission_keys_json) + PermissionSet /
                       #   load_permission_set (per-request resolution). Import-light: no models
    project_access.py  # Per-project ACL on keys + PM bundle: user_can, can_on_project /
                       #   require_on_project, require_project_editor, resolve_self_booking (editor
                       #   first), project_id_for_*
    user_access.py     # Account rules: edit target (users.edit / edit_admins), escalation guard,
                       #   last active admin
    proxy.py           # Corporate proxy resolution (env vars or PAC file)
    response_builders.py # Shared ORM→dict response helpers
    session.py         # SessionService (express-session compatible)
    site_access.py     # Visible sites: visible_site_ids (request-cached), visible_sites_clause,
                       #   ensure_site_visible / ensure_project_visible / ensure_equipment_visible,
                       #   person_is_visible, ensure_site_access / can_access_sites (all of a list)
    sso.py             # SSOService: effective config (org > tenant), Graph groups,
                       #   authorization URL + HMAC-signed state; tenant client-secret
                       #   at-rest helpers (read_/store_tenant_client_secret, apply_secret_update)
    sso_errors.py      # Entra token-endpoint failures → fixed messages (only an AADSTS code
                       #   may reach the user)
    tag_rules.py       # validate_project_tags (site applicability + single-select → 400) and the
                       #   conflict counters behind the 409s of tag/group edits
    team_rules.py      # load_teams / ensure_teams_within_sites / prune_teams_to_sites /
                       #   load_site_members — the shared team-at-site checks (400/404)
    tenant_data_migrations.py # run_data_migrations(): guarded FK rewrites + orphan cleanups,
                       #   called at the end of tenant_manager._run_auto_migrations
    tenant_manager.py  # Lazy per-tenant connection pools (per-slug creation lock) + idle
                       #   cleanup + auto-migrations
    tenant_provisioner.py # Tenant DB/user creation, schema, seed (defaults or demo data); managed-PG support
  middleware/
    auth.py            # Session auth dependencies (get_current_user + live role/matrix via
                       #   load_live_user, require_permission / require_any_permission /
                       #   require_project_permission, require_admin)
    tenant.py          # Pure-ASGI tenant resolution (/t/{slug}/* rewrite, 60s cache)
    broadcast.py       # Pure-ASGI coarse change:<entity> broadcast on 2xx writes
  websocket/
    manager.py         # ConnectionManager: per-tenant rooms, multi-tab, presence, send_to_user
    handler.py         # /ws and /t/{slug}/ws endpoints, cookie auth, close codes
    broadcast.py       # broadcast_change() (rich attribution), send_notification(), send_user_event()
                       #   (per-user approval:changed / todo:changed pushes)
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
                       #   layer), settings, sites, skills, staff, tags, teams, users, vacations, roles
                       #   (rolesApi), health (getAppVersion), importChunks (postInChunks), kanban,
                       #   notifications, approvals (approvalsApi, isPendingResponse), todos (todosApi)
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
                       #   KanbanView/ (KanbanView, KanbanBoard, KanbanColumn, KanbanCard, KanbanToolbar),
                       #   TodosView/ (TodosView tabs, TodoList, ApprovalRequestRow, TodoDialog, CardLink)
      screens/         # LoginScreen, LoadingScreen, LoadErrorScreen (initial load failed → Retry)
      settings/        # Settings hub: SettingsHub.tsx (shell), sections.tsx (SETTINGS_SECTIONS
                       #   registry: group/id/label/permission/Panel, canOpenSettings), PanelToolbar.tsx,
                       #   types.ts, useReportDirty.ts, panels/ (General, Roles (RolesPanel + RoleForm,
                       #   PermissionMatrix, ApprovalPoliciesForm), Sites, Teams, BankHolidays,
                       #   CompanyEvents, Users, Skills, AbsenceTypes, Equipment, EquipmentTypes,
                       #   PredefinedPhases, Tags, SSO + helpers ColorSwatchPicker, SiteChecklist,
                       #   SiteForm, TeamForm, TeamScope, calendarUtils, PanelIcons)
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
                       #   RoleChecklist, PendingBadge, ApprovalActions (+ RejectRequestDialog),
                       #   useSubmitGuard.ts (double-submit guard)
      layout/          # MainLayout, Header/ (density tiers + HeaderOverflowMenu, SyncStatus
                       #   "Offline" badge, WhatIfToggle + Apply-failure banner, UserMenu, …),
                       #   Sidebar/ (Navigation, AdminSection, QuickStats), ResourcePanel/
    contexts/          # WebSocketContext (WS → debounced refetch), wsSlices.ts (entity →
                       #   slice map), TimelineScrollContext, ReorderContext (row reordering),
                       #   KanbanDragContext (card drag, optimistic move)
    stores/            # 10 Zustand stores + index.ts (resetAllStores, expireSession) — see
                       #   Frontend Architecture
    types/models.ts    # All frontend entity types (snake_case, YYYY-MM-DD dates)
    types/permissions.ts # PERMISSION_KEYS / PermissionKey, APPROVABLE_KEYS, PM_BUNDLE, ADMIN_ROLE_KEY
                       #   (mirror of shared/permission-keys.json)
    hooks/             # useAuth, useDataLoader, useWebSocket, useDragAndDrop, useTagFilter,
                       #   useTeamFilter, useCan, useVisibleSites, useAllowedViews, useRoles,
                       #   useApprovalPolicies, useHeaderDensity, useDerivedDueNotifications, … (see catalog)
    utils/             # date, storage (STORAGE_KEYS, themes, project order), csvExport,
                       #   confirmDialog (confirmAction / setConfirmHandler),
                       #   xmlExport, ics, recurringVacation, siteClosure, permissions, tags,
                       #   kanbanCards, mentions, equipmentOverlap, subphaseUtils, persistFailure,
                       #   reorder, localProjectTree, whatIf, uniqueById, touchEvents, teams,
                       #   roles, pendingBookings, relativeTime, themeColors, colorSwatches, projectLevels
                       #   (criticalPath/diffProjects/dependencies/completionStatus live in
                       #   components/gantt/utils/)
    styles/            # global.css, variables.css (design tokens), themes/themes.css,
                       #   __tests__/cssTokens.test.ts (every var(--x) read is defined)
    test/              # setup.ts (Vitest setup), factories.ts (make* test builders),
                       #   permissionFixtures.ts (role defaults, asSignedIn, makeCatalogue),
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

## Database Schema

Two declarative bases: **`Base`** (tenant databases, `app/database.py`) and **`MasterBase`** (master database, `app/models/tenant.py`). Never mix them.

### Tenant database tables (one DB per tenant: `milestone_<slug>`)

**Users & access**

| Table | Model | Purpose |
|-------|-------|---------|
| `users` | `User` | App users *and* staff resources. email (unique), password, names, job_title, `role` (FK → `roles.key`, `ON UPDATE CASCADE`; the old CHECK is gone), `max_capacity` % (part-time), SSO fields, `active`, `is_system` (protects provisioned admin). Props: `full_name`, `is_admin` (`role == 'admin'`), `site_ids`, `team_ids`, `role_name` (correlated subquery on `roles.name`), `permissions` (the resolved `PermissionSet`, not mapped) |
| `user_sites` | `UserSite` | M:N user ↔ site (composite PK) |
| `sessions` | `Session` | express-session-compatible session store: `sid` PK, `sess` JSON text, `expired` (ms epoch) |
| `roles` / `role_permissions` | `Role` / `RolePermission` | Roles (`key` unique, `^[a-z][a-z0-9_]{1,19}$`, immutable; `name`, `is_system` for admin/superuser/user, `sort_order`) and their `{permission, mode}` rows (`allow`/`approval`; no row = deny; the admin role has none and holds everything in code). System roles and their defaults are seeded from the catalogue (`app/services/permissions.py`) |
| `approval_policies` / `approval_policy_roles` | `ApprovalPolicy` / `ApprovalPolicyRole` | Per approvable action (`assignments.self_*`): `pm_approves` + the approving roles (M:N, both FKs CASCADE). Seeded: PM approves, no roles |
| `approval_requests` | `ApprovalRequest` | Own-booking requests: requester (FK CASCADE), `action`, `project_id` (FK CASCADE), `level` + `target_id`, `assignment_id` (no FK, three tables), `requested`/`previous` JSON, `note`, `status` (`pending`/`approved`/`rejected`/`cancelled`/`superseded`/`expired`) + `close_reason`, `decided_by` (SET NULL), `decided_at`, `decision_note`, `superseded_by_id` |
| `todos` | `Todo` | My Todos tasks: `title`, `notes`, `due_date`, `assignee_id` (FK CASCADE), `created_by` (SET NULL), `status` (`open`/`done`/`cancelled`), optional `project_id` (FK CASCADE) + card (`entity_type` phase/subphase, `entity_id`, no FK), `completed_at`. Private: no site-export sheet |
| `sso_config` | `SSOConfig` | Tenant-level SSO singleton (CHECK `id = 1`): enabled, Entra tenant/client id, `client_secret` (**AES-256-GCM encrypted**, legacy plaintext encrypted by the auto-migration — use the `sso.py` helpers), redirect URI, auto_create_users, default_role |

**Sites & calendar**

| Table | Model | Purpose |
|-------|-------|---------|
| `sites` | `Site` | Physical locations: name (unique), location, `city`, country/region codes, timezone, `active`, `last_holiday_fetch` |
| `bank_holidays` | `BankHoliday` | Public holidays per site (affect working-day calc); `date` + optional `end_date` (multi-day), `year` (NOT NULL); `is_custom` for manual, imported or edited entries (editing a Nager row sets `is_custom = 1`); refreshable from the Nager API — a refresh replaces only non-custom rows, only for the years the API actually returned (a failed year keeps its rows; `replace_existing` also clears stale years), and skips Nager entries on any day a custom holiday covers, or sharing a name (trimmed, case-insensitive) with a custom holiday of the same year (moved holidays) |
| `company_events` | `CompanyEvent` | Audits/meetings with color — displayed but do **not** affect working-day calc. `counts_as_unavailable` (BOOLEAN NOT NULL DEFAULT FALSE) marks a **site closure**: staff of the event's sites are unavailable for its dates (evaluated client-side). `site_id` is **legacy** (nullable, FK `ON DELETE SET NULL`), kept equal to the first linked site; site links live in `company_event_sites` |
| `company_event_sites` | `CompanyEventSite` | M:N event ↔ site (composite PK, both FKs CASCADE). Deleting a site deletes events left with no site |

**Teams** (1.12.0, `app/models/team.py`; every FK `ON DELETE CASCADE`, so deleting a site or a team removes all its links)

| Table | Model | Purpose |
|-------|-------|---------|
| `teams` | `Team` | A named group of people at **one** site: `site_id`, name (unique per site, `teams_site_name_unique`), description, color, `active`. Inactive teams still scope everything; only the header filter hides them |
| `team_members` | `TeamMember` | M:N team ↔ user. A member must belong to the team's site (`user_sites`); removing a site from a user drops that site's memberships |
| `project_teams` | `ProjectTeam` | M:N project ↔ team; every team at the project's site (a site-less project has none) |
| `tag_teams` | `TagTeam` | M:N tag ↔ team. Per site: no team row at a site = the whole site; rows = only projects sharing one of those teams |
| `company_event_teams` | `CompanyEventTeam` | M:N event ↔ team, same per-site rule. A team-limited closure takes out only those teams' members (client-side) |
| `equipment_teams` | `EquipmentTeam` | M:N equipment ↔ team, same per-site rule |

**Projects**

| Table | Model | Purpose |
|-------|-------|---------|
| `projects` | `Project` | R&D projects: name, `site_id` (FK `ON DELETE CASCADE` — deleting a site deletes its projects), customer, `pm_id` (FK `users` `ON DELETE SET NULL`), `sales_pm` (free text), confirmed, volume, dates, notes, archived, `updated_at`; `tags` M:N |
| `project_phases` | `ProjectPhase` | Phases: project_id (CASCADE), `type` (name), dates, `is_milestone`, `sort_order`, `completion`, `status` (Kanban column), `dependencies` (JSON text) |
| `project_subphases` | `ProjectSubphase` | **Recursive** subphases: `parent_id` + `parent_type` CHECK(`phase`/`subphase`), `depth`, dates, milestone/completion/`status`/dependencies |
| `tag_groups` | `TagGroup` | Tag categories: name (unique), `single_select`, `sort_order`. Colouring the Gantt by a group is a per-user frontend preference (`viewStore.ganttColorBy`), not stored here |
| `tags` / `project_tags` | `Tag` / `ProjectTag` | Project tags: name (unique tenant-wide), color, `group_id` (FK `tag_groups` `ON DELETE SET NULL`), `all_sites` (default true), `sort_order` + M:N join with projects |
| `tag_sites` | `TagSite` | M:N tag ↔ site, consulted only when `all_sites = false` (both FKs CASCADE). Deleting a site deletes restricted tags left with no site |
| `custom_columns` | `CustomColumn` | User-defined Gantt columns: `column_type` CHECK(`text`/`boolean`/`list`), `list_options` JSON, site_id (NULL = global), display_order, width |
| `custom_column_values` | `CustomColumnValue` | EAV values: `entity_type` CHECK(`project`/`phase`/`subphase`) + entity_id, unique per (column, entity). No FK to the entity: project/site/phase/subphase deletes remove them explicitly, and orphans are cleaned by the tenant data migrations |

**Assignments** (three staff levels + equipment)

| Table | Model | Purpose |
|-------|-------|---------|
| `project_assignments` | `ProjectAssignment` | Project-level staff: allocation %, own start/end dates |
| `phase_staff_assignments` | `PhaseStaffAssignment` | Phase-level staff: allocation only (dates come from the phase) |
| `subphase_staff_assignments` | `SubphaseStaffAssignment` | Subphase-level staff: allocation only |
| `equipment_assignments` | `EquipmentAssignment` | Equipment bookings: project + equipment + dates (project-level only; tenants provisioned before 1.0.15 may carry unused legacy phase/subphase columns) |

The three staff tables carry `approval_status` (`approved`/`pending`, a pending own booking — excluded from availability, capacity, card access and assignee notifications) and `approval_request_id` (FK `approval_requests` SET NULL: the open request on the row).

**Resources & time-off**

| Table | Model | Purpose |
|-------|-------|---------|
| `equipment` | `Equipment` | Lab equipment: name, type (free-form string, managed via `/equipment-types`). `site_id` is **legacy** "primary site" (FK `ON DELETE SET NULL`), kept equal to the lowest linked site id; site links live in `equipment_sites` |
| `equipment_sites` | `EquipmentSite` | M:N equipment ↔ site (composite PK, both FKs CASCADE, index `idx_equipment_sites_site`). Deleting a site deletes only equipment left with no site and re-points survivors' `site_id` (`Site.equipment` has no delete cascade) |
| `equipment_blocks` | `EquipmentBlock` | Maintenance/unavailability windows (the vacation analogue for equipment) |
| `vacations` | `Vacation` | Staff time-off (absences). `absence_type_id` FK → `absence_types` (nullable, `ON DELETE SET NULL`; NULL = treated as unavailable). Recurring absences are encoded in `description` as `[R:0,2,4]` (days of week, 0=Sun) — parsed by `frontend/src/utils/recurringVacation.ts` |
| `absence_types` | `AbsenceType` | Tenant-wide absence categories: name (unique), color `#RRGGBB`, `counts_as_unavailable` (false = shown but capacity not reduced, e.g. Home Office), `sort_order`, `is_active`. Seeded when empty: Holidays, Home Office, Illness, Business Trip, Training |
| `skills` / `user_skills` | `Skill` / `UserSkill` | Global skills + M:N with proficiency CHECK(1–5) |

**Misc**

| Table | Model | Purpose |
|-------|-------|---------|
| `card_comments` | `CardComment` | Comments on Kanban cards. Polymorphic `(entity_type, entity_id)` → phase/subphase, `entity_type` CHECK(`phase`/`subphase`) (same shape as `custom_column_values`, so **no FK on `entity_id`** — phase/subphase deletes must clear them explicitly; orphans are cleaned by the tenant data migrations). `project_id` FK `ON DELETE CASCADE`. `body` stores `@[Name](id)` mention tokens; `mentioned_user_ids` (TEXT, JSON id list) is derived from them server-side. `author_id` is nullable, FK `ON DELETE SET NULL` (comments survive user deletion; UI shows "Deleted user") + `created_at`/`updated_at`. Indexes `idx_card_comments_entity`, `idx_card_comments_project` |
| `notifications` | `Notification` | Per-recipient inbox: `user_id` (FK CASCADE), `type` CHECK(`assigned`/`comment`/`mention`/`status_change`/`approval_requested`/`approval_decided`/`todo_assigned`), `actor_id` (SET NULL), entity refs, `project_id` (FK CASCADE), rendered `title`/`body`, `read_at`. Indexes: partial `idx_notifications_user_unread` + `idx_notifications_user_created`. Due-soon/overdue are **derived client-side**, never stored |
| `staff_notes` | `Note` | Notes pinned to a site/date. Class is `Note` but tablename is **`staff_notes`**. All schema sources now create `staff_notes`; a legacy `notes` table on old installs is migrated and dropped by `migrations/add_staff_notes.sql` / the tenant auto-migration |
| `settings` | `Settings` | Instance key-value settings (e.g. `instance_title`, `show_weekends`) |
| `predefined_phases` | `PredefinedPhase` | Phase name templates offered in the UI |
| `project_presence` | `ProjectPresence` | Active-viewer rows (60s timeout). Written by the WS layer; presence has no HTTP API |

### Master database tables (`MASTER_DB_NAME`, app default `milestone_master`)

| Table | Model | Purpose |
|-------|-------|---------|
| `tenants` | `Tenant` | Tenant registry: UUID id, name, slug (unique), database_name/user, status (`active`/`suspended`/`pending`/`archived` — `TenantStatus` Literal in `app/schemas/tenant.py`; create/update/status/delete/provision reset the tenant cache, and all but create also close the pool, so changes apply immediately), plan/limits, `organization_id`, `required_group_ids` (JSONB) + `group_membership_mode` (`any`/`all`) for SSO group gating |
| `tenant_credentials` | `TenantCredentials` | Per-tenant DB password, AES-256-GCM encrypted (`iv:tag:ciphertext` hex) |
| `tenant_audit_log` | `TenantAuditLog` | Admin actions on tenants (actor, action, JSONB details) |
| `admin_users` | `AdminUser` | Portal admins: email, PBKDF2-SHA512 password hash (`pbkdf2_sha512$600000$salt$hash`; legacy `salt:hash` upgraded on login), role (`admin`/`superadmin`, `Literal`-validated), `must_change_password` (enforced by `get_current_admin`) |
| `admin_sessions` | `AdminSession` | Admin-portal session store (same shape as tenant `sessions`) |
| `organizations` | `Organization` | Groups tenants for shared SSO |
| `organization_sso_config` | `OrganizationSSOConfig` | Org-level Entra SSO: tenant/client id, encrypted secret, redirect URI, auto-create + default role |

### Migrations

- Raw idempotent SQL files in `migrations/` — **no Alembic**. See `migrations/README.md`. Shell wrappers `migrations/run_migration.sh` and `migrations/migrate_all_tenants.sh` exist for container use.
- **Tenant migrations**: `python migrations/run_migration.py <name>` — single-tenant: runs against `DB_NAME`; multi-tenant: iterates every `active` tenant from the master DB, connecting with `PG_ADMIN_*` (preferred) or the decrypted per-tenant credentials.
- **Master migrations**: `python migrations/run_migration_master.py <name>` — statement-by-statement execution via `split_sql_statements()`, which **correctly preserves `DO $$ ... END $$;` blocks** (covered by `tests/test_migration_parser.py`).
- The list of available migrations is the set of `.sql` files in `migrations/` — run either runner with no argument to list them. One stray legacy migration lives at `scripts/sql/migrations/001_add_max_capacity.sql`.
- **Auto-migrations run in two places** on top of the SQL files: `master_db._apply_pending_migrations()` (master schema drift, on startup) and `tenant_manager._run_auto_migrations()` (per-tenant drift, on first pool creation — and, in single-tenant mode, at startup via `run_single_tenant_auto_migrations()` in the lifespan). Both are idempotent. The tenant one ends with two non-DDL steps: `encrypt_tenant_sso_secret()` (legacy plaintext `sso_config.client_secret` → encrypted; needs the in-process key, so it cannot be a SQL file) and the Python data-migration hook `run_data_migrations()` (`app/services/tenant_data_migrations.py`: guarded FK rewrites `projects.site_id` → CASCADE, `card_comments.author_id` → nullable SET NULL, then orphan cleanup of `custom_column_values` / `card_comments`). Each step runs in its own transaction and never raises. The SQL lives in `tenant_provisioner` constants shared with the fresh-install schema and the `.sql` files — add new data fixes there, not inline.
- 1.13.0 migration: `add_rbac.sql` (`roles`, `role_permissions`, `approval_policies`, `approval_policy_roles`, `approval_requests`, `todos`, the assignment `approval_status` / `approval_request_id` columns, the widened notification types, `users.role` CHECK → FK; also applied by the tenant auto-migration, with the role/policy seed and the orphan cleanups — expired requests, orphan pending rows, stale pointers — in `run_data_migrations()`).
- 1.12.0 migration: `add_teams.sql` (`teams`, `team_members`, `project_teams`, `tag_teams`, `company_event_teams`, `equipment_teams`; every FK cascades; also applied by the tenant auto-migration via the provisioner's `TEAMS_SCHEMA_STATEMENTS`).
- 1.6.0 migration: `add_tag_groups_and_sites.sql` (`tag_groups`, `tag_sites`, the three new `tags` columns; also applied by the tenant auto-migration via the provisioner's `TAGS_UPGRADE_SQL`).
- 1.5.0 migrations: `add_absence_types_and_event_sites.sql` (`absence_types`, `vacations.absence_type_id`, `company_event_sites`), `add_equipment_sites_and_site_closures.sql` (`equipment_sites`, `company_events.counts_as_unavailable`), plus `projects_site_fk_cascade.sql`, `card_comments_author_set_null.sql`, `cleanup_orphaned_values.sql` (all also applied automatically by the tenant auto-migration and the hook above). `migrations/migrate_all_tenants.sh` now **requires** a migration file argument; the legacy `run_migration_all_tenants.sql` / `generate_tenant_migrations.sql` helpers (which created a wrong-shaped `company_events`) were removed.
- 1.4.0 migration: `add_kanban_tables.sql` (`status` + CHECK on `project_phases` / `project_subphases`, `card_comments`, `notifications`).
- `upgrade_to_v90.sql` is a **legacy** pre-1.0 catch-up script, superseded by the tenant auto-migrations; it adds nothing the models lack (`tests/test_follow_up_defaults.py` guards that).
- `setup_databases.sql` is the canonical fresh-install schema and must stay in sync with the models (see the schema-change checklist above).

---

## API Reference

All routers are mounted under `/api` (multi-tenant deployments reach them at `/t/{slug}/api/...`; the admin portal is always at `/api/admin/*` with no tenant prefix). Auth column (every gate is a permission key of `app/services/permissions.py`; the label names the system roles whose shipped defaults hold it): **user** = `get_current_user`, **superuser** = `require_permission(<key>)` held by superusers and admins by default, **admin** = `require_permission(<key>)` held only by admins by default (`require_admin` itself guards only the roles/approval-policy writes), **portal** = `get_current_admin` (master DB), **superadmin** = `require_superadmin`, **public** = no auth. **user (PM)** = `get_current_user` + `require_project_editor` / `require_on_project` from `app/services/project_access.py` (the key, or the project's `pm_id` through the PM bundle); **user (PM/own-assignment)** = `resolve_self_booking` / `approvals.resolve_row_write` (`assignments.manage_others` or the PM, else an own row in the mode of `assignments.self_*`: allow → as before, approval → **202** approval request, none → 403). Both are checked after loading the entity, against the server-derived `project_id`. On top of the auth column, every tenant route is limited to the caller's **visible sites** and reads gate on the `views.*` keys (see Tenant role model).

### Health & diagnostics (`app/routers/health.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` and `/api/health` | public | Status, mode, version, backend id, `default_tenant`, DB reachability (`database: "error"` on failure — details only in the log) |
| GET | `/api/ws-debug` | admin (`system.ws_debug`) | WebSocket diagnostics (tenant, connection/online counts) |
| POST | `/api/ws-debug/broadcast` | admin (`system.ws_debug`) | Fire a synthetic `change:project` broadcast |
| GET | `/api/docs`, `/api/redoc`, `/api/openapi.json` | admin (`system.api_docs`) | Swagger / ReDoc / schema, defined in `app/main.py` (not a router). Checked against the session user's **live** `PermissionSet` (`get_current_user_from_session` re-reads role and matrix), 401 otherwise |

### Authentication & SSO (`app/routers/auth.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/login` | public | Email/password login → session + `connect.sid` cookie. Throttled: 10 failures / 15 min per (tenant, IP, e-mail) → 429 + `Retry-After`; password > 72 bytes → 400 |
| POST | `/auth/logout` | session | Destroy session, clear cookie |
| GET | `/auth/me` | public | Current user (fresh from DB) with `roleName`, `permissions` (allow keys; admin: every key), `approvalRequired` (keys in approval mode) and `canSeeAllSites`, or `{user: null}` (login answers the same shape) |
| POST | `/auth/change-password` | user | Change own password (verifies current; new ≥ 8 chars) |
| GET | `/sso/config` | public | Public SSO info for the login page (no secret) |
| GET | `/sso/config/full` | admin (`settings.sso`) | Full SSO config incl. masked secret (`****` + last 4, never the plaintext) + org-precedence info |
| PUT | `/sso/config` | admin (`settings.sso`) | Update tenant SSO (409 if org SSO active; `default_role` any existing non-admin role key, else 400). Secret: omitted or masked value keeps the stored one, `""` clears it; stored encrypted (same on every SSO write route) |
| GET | `/auth/sso/config` | public | Public SSO config (`SSOConfigResponse`) |
| PUT | `/auth/sso/config` | admin (`settings.sso`) | Update tenant SSO (alternate path, same guardrails) |
| GET | `/auth/sso/status` | public | Effective SSO status (org vs tenant) + group requirements |
| GET | `/auth/sso/login` | public | Build the Entra authorization URL (HMAC-signed `state` carries the slug + a nonce; sets the one-time `sso_nonce` cookie, 10 min) |
| GET | `/auth/sso/callback` | public | OAuth callback: verify state **and** that its nonce matches this browser's `sso_nonce` cookie (cleared whatever the outcome), token exchange, Graph `/me`, group validation, find/auto-create user, create session |

### Users & staff (`users.py`, `staff.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/users`, `/users/{id}` | superuser (`users.view`) | List / detail |
| POST | `/users` | admin (`users.create`) | Create user (password ≥ 8 chars; optional `team_ids`, each at one of its sites; sites and teams within the caller's visible sites). A role other than `user` also needs `users.change_role` and the escalation guard |
| PUT | `/users/{id}` | any of `users.edit` / `edit_admins` / `edit_credentials` / `change_role` / `toggle_active` | Update user, one key per kind of change: profile fields, sites, teams, skills `users.edit`; any change to an admin account `users.edit_admins`; another user's email/password `users.edit_credentials` (own: always); role `users.change_role` + escalation guard; `active` `users.toggle_active`. Nobody changes their own role or deactivates themself; the system admin and the last active admin stay active admins; password ≥ 8 chars, > 72 bytes → 400; unknown site/skill ids rejected; sites only within the caller's visible sites. `team_ids` replaces the memberships (unknown → 404, only teams at the caller's visible sites → 403, each team at one of the user's sites → 400); `site_ids` alone drops the teams of removed sites |
| DELETE | `/users/{id}` | admin (`users.delete`) | Delete (rejects self, `is_system`, the last active admin; an admin target also needs `users.edit_admins`) |
| PUT | `/users/{id}/toggle-active` | admin (`users.toggle_active`) | Enable/disable (same self / system / last-admin / `users.edit_admins` rules as delete) |
| GET | `/staff`, `/staff/{id}` | user (visible sites; `/staff/{id}` 404 outside) | Staff read views (staff *are* users — created via `/users`). `team_ids`: on `/staff` rows the user's teams at that row's site, on `/staff/{id}` all of them |
| GET | `/staff/{id}/availability` | user (`views.staff`) | Availability calculation (`startDate`/`endDate` validated, ≤ 366 days, else 400) |
| GET | `/staff/{id}/assignments` | user (`views.staff`) | All assignments for a staff member at visible sites, with `approval_status` (in `assignments.py`) |

User list/detail responses carry `team_ids` + `team_names` (sorted by id).

### Sites, holidays & events (`sites.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/sites` | user | The caller's visible sites |
| GET | `/sites/all` | admin (`sites.manage`) | All sites |
| GET | `/sites/{id}` | user | Site detail (404 outside the visible sites) |
| POST / PUT / DELETE | `/sites`, `/sites/{id}` | admin (`sites.manage`) | Site CRUD. PUT: an explicit `null` clears `location`/`city`/`country_code`/`region_code` (`model_fields_set`; omitted = unchanged). DELETE deletes the site's projects (FK CASCADE) and their polymorphic comments/custom-column values; equipment linked to other sites survives |
| GET | `/sites/{id}/holidays`, `/holidays` | user | Holidays per site / cross-site (`?startDate=&endDate=` returns every holiday that overlaps the window) |
| POST | `/sites/{id}/holidays` | superuser (`bank_holidays.manage`) | Add custom holiday (a span over 366 days → 400, like every holiday/event write and import) |
| PUT | `/sites/{id}/holidays/{hid}` | superuser (`bank_holidays.manage`) | Edit any holiday (sets `is_custom = 1`) |
| DELETE | `/sites/{id}/holidays/{hid}` | superuser (`bank_holidays.manage`) | Delete any holiday — custom or Nager (a Nager one returns on the next refresh) |
| POST | `/sites/{id}/holidays/import` | superuser (`bank_holidays.manage`) | Bulk import `{items:[{date,end_date,name}]}` (≤ 1 000 items, else 422) as custom; dedup on (date, name) → `{created, skipped}` |
| POST | `/sites/{id}/holidays/refresh` | superuser (`bank_holidays.manage`) | Fetch public holidays from the Nager API |
| GET | `/sites/{id}/events`, `/events?siteId=` | user | Company events linked to a site (via `company_event_sites`; date bounds match overlapping events, each bound optional); responses carry `site_ids` + legacy `site_id` + `counts_as_unavailable` |
| POST / PUT / DELETE | `/events`, `/events/{id}` | superuser (`company_events.manage`) | Multi-site event CRUD (`site_ids` + `counts_as_unavailable` + optional `team_ids` on create/update — each team at one of the event's sites, 400 otherwise; PUT `team_ids` replaces them, a `site_ids` change alone drops the teams of removed sites; DELETE removes it from every site). Responses carry `team_ids`. Import and the legacy single-site create stay whole-site |
| POST | `/events/import` | superuser (`company_events.manage`) | Bulk import `{site_ids, color, counts_as_unavailable, items}` (≤ 1 000 items, else 422; the flag applies to newly created events only); an existing (date, end_date, name) gains missing site links → `{created, linked, skipped}` |
| POST / DELETE | `/sites/{id}/events`, `…/{eid}` | superuser (`company_events.manage`) | Legacy single-site create / unlink (event deleted only when no site is left) |

All holiday/event writes also require every site involved to be visible (`ensure_site_access` from `app/services/site_access.py`; `sites.view_all` holders any site), and the calendar reads 403 on a site outside the visible ones.

### Projects, phases & subphases (`projects.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/projects` | user | List (visible sites; `includeOtherSites` needs `views.crosssite`). Without `views.archived`, `archived=true` is a 403 but `archived=all` degrades to active projects only (no 403 — `fetchAllProjects()` asks for `all`) |
| GET | `/projects/{id}` | user | Detail with phases/subphases/assignments (403 outside the visible sites; an archived one needs `views.archived`) |
| POST / DELETE | `/projects`, `/projects/{id}` | superuser (`projects.create` / `projects.delete`) | Create (at a visible site; site-less needs `sites.view_all`) / delete project (not in the PM bundle — a PM may **not** delete) |
| PUT | `/projects/{id}` | user (PM) | Update project (`projects.edit_any`; a change of `archived` needs `projects.archive`, and a request flipping only `archived` needs nothing else) — through the PM bundle the PM may change every field, incl. `pm_id` (hand-over), `archived`, `tag_ids` and `team_ids` |
| POST | `/projects/{id}/phases` | user (PM) | Add phase |
| PUT / DELETE | `/phases/{id}` | user (PM) | Update / delete phase. PUT: explicit `"completion": null` → 0 % via `apply_completion` (omitted = unchanged). DELETE also removes its subphases, their assignments, comments and custom-column values |
| PUT | `/projects/{id}/phases/reorder` | user (PM) | Reorder phases |
| POST | `/phases/{id}/subphases` | user (PM) | Add subphase to a phase (`project_id` taken from the phase, body value ignored) |
| POST | `/subphases/{id}/children` | user (PM) | Add nested subphase (`project_id` taken from the parent) |
| PUT / DELETE | `/subphases/{id}` | user (PM) | Update / delete subphase (404 if missing; PUT `completion: null` → 0 % like phases) |
| PUT | `/subphases/{parent}/reorder` | user (PM) | Reorder subphases (parent resolved first; 404 if missing) |

These handlers call rich `broadcast_change()` — their paths are in `BroadcastMiddleware.SKIP_PATTERNS`.

**Validation (all write routes):** dates where `end < start` → 422 (`DateRangeOrdered` mixin in `app/schemas/base.py` on request bodies, `ensure_date_order()` in `app/services/date_range.py` for merged partial updates) on projects, phases, subphases, assignments, equipment bookings/blocks and absences. Unknown referenced ids (site, `pm_id`, staff, skill, …) → 400/404 instead of an FK 500. Date query filters are parsed with `parse_day` / `parse_day_range` (400 on malformed input; availability ranges capped at 366 days).

### Assignments (`assignments.py` — note the three per-level route families)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/projects/{id}/staff` | user (PM/own-assignment) | Assign staff at project level |
| PUT / DELETE | `/assignments/{id}` | user (PM/own-assignment) | Update / remove project-level assignment |
| POST | `/phases/{id}/staff` | user (PM/own-assignment) | Assign staff at phase level (`project_id` resolved from the phase, body value ignored) |
| PUT / DELETE | `/phase-staff/{id}` | user (PM/own-assignment) | Update / remove phase-level assignment |
| POST | `/subphases/{id}/staff` | user (PM/own-assignment) | Assign staff at subphase level (`project_id` resolved from the subphase) |
| PUT / DELETE | `/subphase-staff/{id}` | user (PM/own-assignment) | Update / remove subphase-level assignment |
| POST | `/projects/{id}/equipment` | user (PM) (`equipment_bookings.manage`) | Book equipment on a project (no self-service) |

The nine staff routes (the three POSTs, PUTs and DELETEs) and the two Kanban join/leave routes answer **202** `{success: true, pending: true, request_id, id}` when the caller's own `assignments.self_*` key is in approval mode (see the Approval workflow bullet); cancelling one's own pending create through DELETE answers 200 `{success, cancelled: true, request_id, id}`. The POSTs 409 when the person is already booked on the target (a pending booking counts; at project level only with the same dates); PUT/DELETE on someone else's pending create → 409. Rows carry `approval_status` (`approved` / `pending`) and, in `GET /projects/{id}`, `approval: null | {request_id, action, requester_id, requested, previous, created_at, can_decide}`.

`PUT/DELETE /equipment-assignments/{id}` live in `equipment.py` only (the shadowed duplicates that once sat in `assignments.py` were removed).

### Equipment (`equipment.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/equipment-types` | user | Distinct equipment types (no create route — types come from equipment; not site-scoped) |
| PUT / DELETE | `/equipment-types/{name}` | superuser (`equipment_types.manage`) | Rename (`?new_type=`) / delete a type. Only when every equipment of that type is at a visible site (403 otherwise; site-less items need `sites.view_all`). DELETE → 409 while any equipment uses the type |
| GET | `/equipment?siteId=&includeAllSites=` | user (`views.equipment`) | Active equipment at visible sites, plain array (no pagination), **one row per equipment–site pair** (like `GET /staff`): `site_id`/`site_name` = that pair, plus `site_ids`/`site_names` |
| GET | `/equipment/all` | superuser (`equipment.manage`) | All equipment at visible sites incl. inactive, one row each (with `site_ids`) |
| GET | `/equipment/{id}` | user (`views.equipment`) | Detail (one row, `site_ids`; 404 unless linked to a visible site) |
| POST / PUT / DELETE | `/equipment`, `/equipment/{id}` | superuser (`equipment.manage`) | Equipment CRUD; `site_ids: int[]` (legacy `site_id` accepted as `[site_id]`; empty → 422); optional `team_ids` (each at one of its sites, 400; per site, no team = whole site; a `site_ids` change alone drops the teams of removed sites). Responses carry `team_ids` / `team_names`. Only for equipment whose sites are **all** visible (`ensure_site_access`; `sites.view_all` any) |
| GET | `/equipment/{id}/assignments` | user (`views.equipment`) | Bookings for one piece of equipment (bookings by projects outside the visible sites show `[External Project]`) |
| PUT / DELETE | `/equipment-assignments/{id}` | user (PM) (`equipment_bookings.manage`) | Update / delete booking |
| GET | `/equipment/{id}/availability` | user (`views.equipment`) | Availability calculation (`startDate`/`endDate` validated, ≤ 366 days, else 400) |
| GET | `/equipment-blocks`, `/equipment/{id}/blocks` | user (`views.equipment`) | Maintenance blocks (all / per equipment; `?siteId=` joins through `equipment_sites`) |
| POST / PUT / DELETE | `/equipment-blocks`, `…/{id}` | superuser (`equipment_blocks.manage`) | Block CRUD (same visible-site rule as the equipment) |

### Vacations, absence types, notes, skills, tags (`vacations.py`, `absence_types.py`, `notes.py`, `skills.py`, `tags.py`, `tag_groups.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET / POST / PUT / DELETE | `/vacations`, `/vacations/{id}` | user | Vacation CRUD (own-user checks inside handlers; `absences.manage_others` for people sharing a visible site); optional `absence_type_id`. `GET` with `siteId`: `absences.view_others` + a visible site (403); without: own + members of the visible sites with `absences.view_others` (`sites.view_all`: all), own only without it; `GET /vacations/{id}` is a 404 outside that scope |
| POST | `/vacations/import` | user | Bulk import `{staff_id, items:[{start_date,end_date,description,absence_type_id}]}` (≤ 1 000 items, else 422); same own-user rule; dedup on (staff, start, end) → `{created, skipped}` |
| GET | `/absence-types` | user | Absence types (active and inactive) |
| POST / PUT / DELETE | `/absence-types`, `/absence-types/{id}` | admin (`absence_types.manage`) | Absence type CRUD; DELETE → 409 while any vacation uses the type |
| PUT | `/absence-types/reorder` | admin (`absence_types.manage`) | Reorder (`{type_order: [ids]}`) |
| GET | `/notes` | user | List staff notes (a site outside the visible ones → 403) |
| POST / DELETE | `/notes`, `/notes/{id}` | superuser (`staff_notes.manage`) | Create / delete note (visible sites) |
| GET | `/skills`, `/skills/{id}` | user | Skills list / detail |
| POST / PUT / DELETE | `/skills`, `/skills/{id}` | superuser (`skills.manage`) | Skill CRUD |
| GET | `/skills/user/{uid}` | user | A user's skills (404 for a person outside the visible sites) |
| PUT | `/skills/user/{uid}` | superuser (`skills.assign`) | Replace a user's skills (the target must be editable: `users.edit`, or `users.edit_admins` for an admin, and visible) |
| POST / DELETE | `/skills/user/{uid}/{sid}` | superuser (`skills.assign`) | Add / remove one skill (same target rule) |
| GET | `/tags` | user | List tags (`group_id`, `all_sites`, `site_ids`, `team_ids`, `sort_order`; ordered by group, sort order, name) |
| POST / PUT / DELETE | `/tags`, `/tags/{id}` | admin (`tags.manage`) | Tag CRUD (`all_sites` true clears `site_ids`; unknown group/site/team → 404; `team_ids` must be at one of the tag's sites unless `all_sites`, 400). PUT → 409 (string detail with the count) when moving the tag into a single-select group a project already has another tag of, when restricting sites while projects at a removed site use it, or when narrowing `team_ids` while projects at those teams' sites outside them use it |
| PUT | `/tags/reorder` | admin (`tags.manage`) | `{tag_order: [ids]}` → `sort_order = index` |
| GET | `/tag-groups` | user | List groups |
| POST / PUT / DELETE | `/tag-groups`, `/tag-groups/{id}` | admin (`tags.manage`) | Group CRUD. PUT `single_select: true` → 409 while a project holds 2+ tags of the group. DELETE ungroups the tags |
| PUT | `/tag-groups/reorder` | admin (`tags.manage`) | `{group_order: [ids]}` |

Project writes (`POST /projects`, `PUT /projects/{id}`) validate `tag_ids` with `validate_project_tags()` (`app/services/tag_rules.py`): a tag that does not apply to the project's site, a tag limited to teams at that site the project shares none of, or two tags of one single-select group → 400; unknown ids are dropped silently (What-If replay). Inline project tags are `{id, name, color, group_id}`. `team_ids` (list/detail responses, create/update bodies) must all be at the project's site (400; a site-less project cannot have teams); unknown team ids are dropped silently too, and a team change re-validates the current tags.

### Teams (`teams.py`, prefix `/teams`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/teams?siteId=` | user | Every team at the visible sites, inactive ones included (`{id, site_id, name, description, color, active, member_ids, created_at, updated_at}`), ordered by site then name; `siteId` limits to one site |
| GET | `/teams/{id}` | user | One team with `member_ids` (404 if missing or outside the visible sites) |
| POST | `/teams` | superuser (`teams.manage`) | Create `{site_id, name, description?, color?, active?, member_ids?}` — only at a visible site (403); unknown site → 404; a spaces-only or duplicate name at the site → 400 (empty → 422); a member not at the site → 400 |
| PUT | `/teams/{id}` | superuser (`teams.manage`) | Partial update (site cannot change); explicit `null` clears `description` / `color`; `member_ids` replaces the members (same 400 rule) |
| DELETE | `/teams/{id}` | superuser (`teams.manage`) | Delete; its member, project, tag, event and equipment links cascade |

Writes are What-If-exempt (configuration) and coarse-broadcast as `change:team` (refreshes the `teams`, `staff`, `projects`, `tags`, `equipment` and `siteCalendar` slices).

### Kanban (`kanban.py`, prefix `/kanban`)

The board itself has **no read endpoint** — `GET /projects/{id}` already returns the tree, so the client derives cards from `appStore.projects`. Card = leaf phase/subphase (`frontend/src/utils/kanbanCards.ts`).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/kanban/projects/{id}/comment-counts` | user (`views.kanban`) | Comment counts per card (kept out of `GET /projects/{id}`, which `fetchAllProjects()` calls once per project) |
| GET | `/kanban/sites/{site_id}/comment-counts` | user (`views.kanban`) | Counts for every card of a site in one query (the board's "All projects" mode) |
| GET | `/kanban/sites/{site_id}/mentionable-users` | user (`views.kanban`) | Mention picker: active members of the site plus every active user whose role sees all sites (admins, and roles allowing `sites.view_all`) → `{id, name, job_title}`. Deliberately not `GET /staff`, which leaves admins out |
| PUT | `/kanban/cards/{entity_type}/{id}/status` | user **+ `kanban.move_any` or approved assignee** | Move a card (`kanban.move_any`, the PM through the bundle, or an approved assignee of that card holding `kanban.move_assigned`); echoes the derived `{status, completion}` so the client reconciles without a refetch |
| POST / DELETE | `/kanban/cards/{et}/{id}/assignees`, `…/{staff_id}` | user (PM/own-assignment) | Assign/unassign (editors manage anyone; any user may join/leave a card themself — **202** approval request in approval mode) — **creates the phase/subphase staff assignment** at `allocation` (1–100) or the assignee's `max_capacity` (409 on duplicate, a pending booking included) |
| GET / POST | `/kanban/cards/{et}/{id}/comments` | user | Comment thread; GET needs `views.kanban`, POST `kanban.comment` (every user by default). Mentions are parsed from the body (`@[Name](id)`, unknown ids dropped) into `mentioned_user_ids`; POST notifies the mentioned users and the card's assignees (someone both gets only the mention) |
| PUT / DELETE | `/kanban/comments/{id}` | user (author with `kanban.comment`; deleting others' comments `kanban.moderate_comments`) | Edit / delete a comment; an edit re-reads the mentions and notifies only people newly mentioned |

⚠ `require_card_status_write` (`app/services/card_access.py`): `kanban.move_any` (the route passes `can_move_any=await can_on_project(..., "kanban.move_any", ...)`, so the PM too), **or** an approved assignee of that card holding `kanban.move_assigned`. It takes `user_id`/boolean primitives, not a `User`, because `get_current_user` often returns the lightweight `SessionUser`.

### Notifications (`notifications.py`, prefix `/notifications`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/notifications?unread_only&limit` | user | Own notifications, newest first |
| GET | `/notifications/unread-count` | user | Badge count (served by the partial unread index) |
| PUT | `/notifications/{id}/read`, `/notifications/read-all` | user | Mark read |

⚠ Every query is pinned to `Notification.user_id == user.id` — there is **no `user_id` parameter**, by design (it would be an IDOR). Due-soon/overdue are derived client-side (`useDerivedDueNotifications`), never stored.

### Permissions & roles (`roles.py`)

Role writes use `require_admin` (the lockout-proof surface: `roles.manage` is locked to the admin role). Coarse-broadcast as `change:role`; What-If-exempt.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/permissions` | user | The catalogue for the matrix: `{groups: [{name, permissions: [{key, label, description, approvable, locked, defaults: {superuser, user}}]}], pm_bundle}` |
| GET | `/roles`, `/roles/{id}` | user | Roles in `sort_order`: `{id, key, name, description, is_system, sort_order, permissions: {key: mode}, user_count}` (the admin role lists every key as `allow`; `projects.view` is always `allow`) |
| POST | `/roles` | `require_admin` | Create `{key, name, description?, sort_order?, permissions}` → 201. Key `^[a-z][a-z0-9_]{1,19}$` (422), taken (system keys included) or a duplicate / blank name (case-insensitive) → 400; unknown key 422 `Unknown permission: x`; `approval` on a non-approvable key 422; a locked key changed 422 `Permission is locked: x` |
| PUT | `/roles/{id}` | `require_admin` | Partial update; the admin role is 403 (`Administrator permissions cannot be edited`); a different `key` is 422 (the key never changes); `permissions` replaces the matrix (same 422 rules); explicit `null` clears `description` |
| DELETE | `/roles/{id}` | `require_admin` | 204; a system role 403; a role held by users 409 `N users hold this role. Give them another role first.` |

A matrix edit applies on the holders' next request (`get_current_user` resolves the role live) and, through `change:role`, refreshes `/auth/me` in open clients.

### Approval policies (`approval_policies.py`, prefix `/approval-policies`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/approval-policies` | user | One entry per approvable action, in catalogue order: `{action, label, pm_approves, role_ids}` (a missing row reads as the seeded default: PM approves, no roles) |
| PUT | `/approval-policies/{action}` | `require_admin` | Full replace `{pm_approves, role_ids}`; unknown action or role id → 404. Admins approve whatever the policy says |

### Approval requests (`approvals.py`, prefix `/approval-requests`)

Requests are filed by the self-booking routes (202, see Assignments); this router reads and decides them. Rich `change:approval_request` broadcasts (the path is in `SKIP_PATTERNS`) plus per-user `approval:changed` pushes.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/approval-requests?scope=mine\|to_decide\|all&status=&limit=` | user (`all`: `approvals.view_all`, else 403) | `mine` = own requests; `to_decide` = pending requests the caller may decide (visible sites, never their own); `all` = every request at the visible sites. Newest first; items `{id, action, status, close_reason, requester_id/_name, project_id/_name, level, target_id/_name, assignment_id, requested, previous, note, decided_by/_name, decided_at, decision_note, superseded_by_id, created_at, updated_at, can_decide}` |
| GET | `/approval-requests/{id}` | user (requester, eligible approver, or `approvals.view_all`) | One request; 404 for anyone else |
| POST | `/approval-requests/{id}/approve`, `…/reject` | eligible approver, never the requester (403) | Body `{note?}` (≤ 2000). Approve re-validates and applies; if the booking can no longer apply the request closes `expired` → 409 `{detail, status: "expired", close_reason}`. Reject deletes a pending create's row / drops a pending change. 409 `{detail: "Request already <status>", status}` when not pending; 404 unknown |
| POST | `/approval-requests/{id}/cancel` | requester or admin (403) | Withdraw (`{note?}`); the requester is notified only when an admin cancelled |

### Todos (`todos.py`, prefix `/todos`)

Private like notifications: every query is pinned to the caller (assignee or creator), anyone else gets 404. No tenant-wide broadcast (`/api/todos` is in `SKIP_PATTERNS`); the assignee and the creator get a per-user `todo:changed` push `{id, kind, action}`, a new assignee other than the actor a `todo_assigned` notification.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/todos/mine?status=open\|all` | user | The caller's tasks (`kind: 'task'`, assigned to or created by them) merged with the pending approval requests they may decide (`kind: 'approval'`, id `approval:<n>`, the request in `approval_request`); open first, then due date (none last), then oldest. Items `{id, kind, title, notes, due_date, status, assignee_id/_name, created_by/_name, project_id/_name, entity_type, entity_id, completed_at, approval_request, created_at, updated_at}` |
| POST | `/todos` | `todos.manage_own` (own) / `todos.assign_others` or the PM bundle on `project_id` (someone else) | `{title, notes?, due_date?, assignee_id?, project_id?, entity_type?, entity_id?}` → 201; assignee defaults to the caller and must be an active person they can see (404 / 400 inactive); a card resolves its project (400 if another project given); 403 at an invisible site |
| PUT | `/todos/{id}` | assignee or creator (else 404), same keys for the todo as it is and becomes | Partial update incl. `status` (`done` sets `completed_at`), reassigning (notifies) and re-linking; explicit `null` clears `notes` / `due_date` / the link |
| DELETE | `/todos/{id}` | creator (or the assignee once the creator is gone; else 403 / 404) | Delete |

### Custom columns (`custom_columns.py`, prefix `/custom-columns`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/custom-columns`, `/custom-columns/with-values` | user | Columns / columns with values (values only of projects at visible sites; a site outside → 403) |
| POST / PATCH / DELETE | `/custom-columns`, `…/{id}` | admin (`custom_columns.manage`) | Column CRUD |
| PATCH | `/custom-columns/reorder` | admin (`custom_columns.manage`) | Reorder columns |
| PUT | `/custom-columns/values`, `…/values/batch` | user (`custom_columns.set_values`, or the PM bundle on every entity's project) | Write values (single / batch ≤ 500, one transaction, validated like single writes) on projects at visible sites; every role holds the key by default |
| DELETE | `/custom-columns/values/{col}/{etype}/{eid}` | user (same rule) | Clear a value |

### Predefined phases & settings (`predefined_phases.py`, `settings.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/predefined-phases` | user | Active phase templates |
| GET | `/predefined-phases/all` | superuser (`predefined_phases.manage`) | All templates |
| POST / PUT / DELETE | `/predefined-phases`, `…/reorder`, `…/{id}` | superuser (`predefined_phases.manage`) | Template CRUD + reorder |
| GET | `/settings`, `/settings/{key}` | ⚠ none | Instance settings (no auth dependency — do not store secrets in `settings`) |
| PUT | `/settings/{key}` | admin (`settings.general`) | Update setting |
| GET / PUT | `/settings/sso` | none / admin (`settings.sso`) | Tenant SSO settings (read / write) |

### Import & export (`mpp_import.py`, `export.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/import/mpp/test` | superuser (`projects.import`) | Verify the MPP parser (Java/mpxj) is functional |
| POST | `/import/mpp` | superuser (`projects.import`) | Parse an uploaded MS Project file (preview) |
| POST | `/import/project` | superuser (`projects.import`) | Upload + parse (CSV/XML/MPP/MPT/MPX) and create the project at a visible site with its phase tree (completion clamped 0–100 via `apply_completion`, so finished tasks → Done) |
| GET / POST | `/import/test`, `/import/test-upload` | superuser (`projects.import`) | Import diagnostics |
| POST | `/export/mpp/{pid}` | superuser (`projects.export`) | Export project to MPP (visible sites) |
| GET / POST | `/export/csv/{pid}` | superuser (`projects.export`) | Export project to CSV (visible sites) |
| GET | `/export/site/{sid}/excel` | superuser (`sites.export`) | Full site export of a visible site to `.xlsx` (see Site Export contract) |

All `/import/*` uploads are read with `read_upload_capped()` — **20 MB** cap (`MAX_IMPORT_UPLOAD_BYTES`, else 413) — and parsing runs via `run_in_threadpool` so mpxj/JPype never blocks the event loop.

### Admin portal (`routers/admin/*` → `/api/admin/*`, master DB, `admin_session` cookie)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/admin/auth/login` / `/admin/auth/logout` | public / public | Portal login/logout (login throttled like `/auth/login`, scope `admin`; logout has no auth dependency — it deletes the cookie's session if there is one) |
| GET | `/admin/auth/me` | optional | Current admin (also while `must_change_password`) |
| POST | `/admin/auth/change-password` | portal* | Change password (min 8 chars; clears `must_change_password`). *The only write an admin with `must_change_password` may call — every other portal route returns 403 until then |
| GET | `/admin/tenants`, `/admin/tenants/{id}` | portal | Tenant list / detail |
| POST / PUT / DELETE | `/admin/tenants`, `…/{id}` | portal | Tenant CRUD |
| PUT | `/admin/tenants/{id}/status` | portal | active / suspended / archived |
| POST | `/admin/tenants/{id}/provision` | portal | Provision the tenant database (the seeded tenant admin gets a bcrypt hash; an admin password > 72 bytes → 400). Body `{adminEmail?, adminPassword?, seedDemoData?}`: with `seedDemoData` the demo set (`app/scripts/demo_data.py`, loaded by `app/services/demo_seed.py`) replaces the bare defaults — the tenant admin is its system admin with the returned password, the tenant name its instance title, sample people get a random discarded password (`demo1234` is the Codespaces tenant only), no "Main Site" |
| POST | `/admin/tenants/{id}/reset-admin-password` | portal | Reset the tenant's admin password |
| GET | `/admin/tenants/{id}/audit` | portal | Tenant audit log |
| GET | `/admin/stats` | portal | System statistics |
| GET / POST | `/admin/users` | superadmin | List / create portal admins |
| PUT / DELETE | `/admin/users/{id}` | superadmin | Update / delete a portal admin (there is no `GET /admin/users/{id}`) |

### Organizations (`admin_organizations.py` → `/api/admin/organizations`, all portal auth)

| Method | Path | Description |
|--------|------|-------------|
| GET / POST / PUT / DELETE | ``, `/{id}` | Organization CRUD |
| GET / PUT / DELETE | `/{id}/sso` | Organization SSO config (encrypted secret) |
| POST | `/{id}/sso/test` | SSO diagnostic: local checks, outbound-proxy report, Entra discovery and a client-credentials token request → `{credentials_ok, summary, checks[]}`. Proves the directory id, client id and secret, not the redirect URI (reported as a manual check); failures go through `parse_entra_token_error` |
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
| Roles | A role key per user (FK `roles.key`): system roles `admin` / `superuser` / `user` + custom roles, each a permission set | `superadmin` > `admin` |
| Password hash | bcrypt (rounds=12), lazy upgrade from legacy PBKDF2/plaintext on login | PBKDF2-SHA512 `pbkdf2_sha512$600000$salt$hash`, lazy upgrade from legacy `salt:hash` |
| Login throttle | 10 failures / 15 min per (`tenant:<slug>`, IP, e-mail) → 429; plus 100 / 15 min per public IP (all scopes) | same, scope `admin` |
| Forced change | — | `must_change_password` → 403 everywhere but change-password / me |
| Dependencies | `get_current_user`, `require_permission` / `require_any_permission` / `require_project_permission`, `require_admin` (roles only) (`app/middleware/auth.py`) | `get_current_admin`, `require_superadmin` (`app/routers/admin/auth.py`) |

- `SessionService` (`app/services/session.py`) stores the full user dict (incl. site ids/names) in the session; `get_current_user_optional` builds a lightweight `SessionUser` from it without a DB hit, while `get_current_user` re-reads `active`, `role` and the role's permission matrix on every request (`load_live_user`: one `users` ⟕ `roles` ⟕ `role_permissions` query; 401 + session destroyed for missing/inactive users; the live role and matrix win over the snapshot, so a role edit applies on the next request) and stashes the user into `scope["state"]` for broadcast attribution. `SessionService.destroy_user_sessions()` is called on deactivate/delete/role change/password set so revocation is immediate — and also closes the user's open WebSockets on this process (`manager.disconnect_user`, close code 4001).
- On startup, `master_db.verify_admin_exists()` auto-creates `admin@milestone.local` (superadmin, random password logged, `must_change_password=true`) if no admin exists.

### Tenant role model

- **Roles are permission sets.** Every gate is a catalogue key (`app/services/permissions.py`); `admin` holds every key in code, and the shipped `superuser` / `user` defaults reproduce the bullets below, so they describe the defaults of those two system roles. The PM rule is the PM bundle (`projects.manage_as_pm`); staff assignments are editor first (`assignments.manage_others`, else own rows under `assignments.self_*`); reads and writes are limited to the live visible sites (`sites.view_all` = every site). Account rules: editing an admin needs `users.edit_admins`, a non-default role is assignable only with `users.change_role` and only if its permissions are within the caller's (the admin role: admins only; `users.create` alone creates accounts with the default `user` role), a non-admin may change the role only of users whose current role is within theirs, nobody changes their own role, and the last active admin cannot be demoted, deactivated or deleted (`app/services/user_access.py`).
- **Visible sites scope every read and write** (`app/services/site_access.py`). With `sites.view_all` every site is visible and nothing is filtered; otherwise only the user's live `user_sites`. A site parameter or body `site_id` outside them is a 403 (`ensure_site_visible`; site-less projects/equipment need `sites.view_all`), lists without one are filtered (`visible_sites_clause`), a project outside is a 403 on reads and on every project write even with `projects.edit_any` (`ensure_project_visible`), equipment / a site / a team / a person outside is a 404 on reads; people (staff, users, absences of others, skills) are visible when oneself or sharing a visible site (`person_is_visible`). The view keys gate their reads: `views.kanban` (`/kanban` reads), `views.staff` (`/staff/{id}/availability|assignments`), `views.equipment` (equipment, booking, availability and block reads), `views.crosssite` (`includeOtherSites=true`), `views.archived` (`archived=true` → 403; `archived=all` leaves archived projects out without it). Route tests serve other people's, projects' and equipment's sites from the `site_links` fixture (`tests/conftest.py`). Custom-column values are read and written only on projects (and their phases/subphases) at visible sites; bookings of shared equipment by projects outside show `[External Project]`. Not scoped: `GET /equipment-types` (configuration).
- `user` — read access within their sites (absences: with `absences.view_others` their own plus those of the members of their visible sites — the `siteId` form needs the key and a visible site — without it their own only; `GET /vacations/{id}` is a 404 outside that scope) + self-service (own vacations, custom-column **values** (definitions are admin-only), **own staff assignments**: a user may add/update/remove assignments where `staff_id` is their own id at project/phase/subphase level, and join/leave Kanban cards).
- **Project manager rule (PM bundle)** — a role holding `projects.manage_as_pm` (both editable system roles by default) gets the `PM_BUNDLE` keys on the projects whose `pm_id` is the user: `projects.edit_any` (all fields incl. handing over via `pm_id`, phases/subphases), `projects.archive`, `assignments.manage_others`, `equipment_bookings.manage`, `kanban.move_any`, `custom_columns.set_values`, `todos.assign_others`. Never `projects.delete`, `projects.create`, import, exports or tag definitions. Evaluated by `PermissionSet.can(key, pm_id=, user_id=)` / `project_access.user_can` / `can_on_project`.
- `superuser` (default) — everything a user can, plus create/edit/archive/delete/import/export projects, manage anyone's bookings and equipment bookings, move any card, moderate comments, others' absences, staff notes, equipment, equipment types and blocks, holidays/events, teams, predefined phases, skills (definitions and assignment), view and edit non-admin users, site export, What-If — all within their visible sites. Not: `sites.view_all`, site definitions, user creation/credentials/roles/activation/deletion, admin accounts, settings, SSO, tags, absence types, custom-column definitions, roles, `approvals.view_all`, the API docs and WS debug.
- `admin` — every key in code (no `role_permissions` rows; never editable or deletable), so it always sees every site and is the only holder of `roles.manage` (Settings → Roles, `require_admin` routes). Admins always approve own-booking requests.
- **Own-booking approvals** — a role may hold `assignments.self_create` / `self_update` / `self_remove` in `approval` mode (the shipped defaults are `allow`); see the Approval workflow bullet under Backend Conventions. Who approves is per action in `approval_policies` (PM and/or roles; admins always).
- `is_system=true` marks the provisioned admin; deletion is rejected.

### Microsoft Entra SSO

Two configuration levels, resolved by `SSOService.get_effective_sso_config()`:

1. **Organization SSO** (master DB, `organization_sso_config`) — shared by every tenant in the organization; secret encrypted; **takes precedence**. Tenant-level SSO cannot be enabled while org SSO is active (409, `_reject_if_org_sso_active` — covered by `tests/test_sso_guardrails.py`).
2. **Tenant SSO** (`sso_config` singleton in the tenant DB) — per-tenant fallback. Its `client_secret` is encrypted at rest with the same key as tenant credentials (`TENANT_ENCRYPTION_KEY`; single-tenant: derived from `SESSION_SECRET`). If the key changes, `read_tenant_client_secret` logs once and returns `None` → SSO reports "not configured" until the secret is re-entered.

Flow: `GET /auth/sso/login` builds the Entra authorization URL with an **HMAC-signed `state` carrying the tenant slug and a nonce** (org SSO uses one shared callback URL with no `/t/{slug}/` prefix, so the slug must survive the round-trip) and sets the nonce as the `sso_nonce` cookie (10 min) → `GET /auth/sso/callback` verifies the state signature and that its nonce equals this browser's cookie (so the flow only completes in the browser that started it and a callback URL cannot be replayed; the cookie is cleared on every outcome), exchanges the code, fetches the profile from Microsoft Graph `/me`, optionally validates group membership (`fetch_user_groups` pages Graph `/me/memberOf`; `required_group_ids` + `group_membership_mode` `any`/`all` on the tenant), finds or auto-creates the user (`auto_create_users`, `default_role`), creates a session, and redirects to `/t/{slug}/`.

**Failure handling** (`app/routers/auth.py`, `app/services/sso_errors.py`):
- Entra token-endpoint and Graph failures go through `parse_entra_token_error()`: the only remote-derived text a user can see is a regex-validated `AADSTS\d{4,7}` code, mapped to one of our fixed messages; Entra's `error` / `error_description` are never reflected.
- Callback failures redirect to `/t/{slug}/?sso_error=<message>` (`_sso_error_redirect`, slug recovered from the signed state); unexpected exceptions are caught and redirected the same way instead of a 500, and an unreachable identity provider reads "Could not reach the identity provider".
- An organization-SSO lookup or decrypt failure **fails closed** (`OrgSSOLookupError` → "temporarily unavailable"); it never falls back to tenant-level SSO.
- Both hops log a config fingerprint (`_config_fingerprint`, no secrets) so an operator can see which config served a sign-in; config values are whitespace-stripped.
- `SSOConfig.is_configured` requires a client secret, so a row without one hides the sign-in button instead of failing with Entra's misleading "invalid client".
- Admins can test an organization's credentials without a user sign-in: `POST /api/admin/organizations/{id}/sso/test`.

## Multi-Tenancy Internals

- **`TenantMiddleware`** (`app/middleware/tenant.py`) is a **pure ASGI middleware** (not `BaseHTTPMiddleware` — that breaks WebSockets). It matches `/t/{slug}/...`, resolves the tenant through a 60-second in-memory cache (plain dicts, not ORM objects, to avoid session-detachment issues), rewrites `scope["path"]` to strip the prefix, and stores `tenant` / `tenant_slug` / `tenant_engine` in `scope["state"]`. Missing/inactive/unreachable tenants → 404/403/503 (the 503 body is a fixed message; the DB error goes only to the log). **Misses are cached too** (60 s, in a separate `_negative_cache` capped at 1 000 entries, expired/oldest evicted first — hits are never evicted by a miss flood), so a flood of unknown slugs doesn't hit the master DB; `clear_tenant_cache(slug)` drops hits and misses. WebSocket scopes are passed through untouched (the WS handler resolves the tenant itself). Only wraps the app when `MULTI_TENANT=true`.
- **Tenant info lives in `scope["state"]` (a plain dict).** In HTTP handlers, `request.state.tenant_slug` attribute access works — Starlette's `Request.state` lazily wraps `scope["state"]` in a `State` object. In code that handles raw ASGI scopes (middleware, helpers that may not receive a full `Request`), read `scope["state"]["tenant_slug"]` directly; the broadcast helper handles both forms.
- **No fallthrough to `DB_*`**: when a request carries a tenant slug but no pool exists, `get_db` / `get_db_readonly` raise 503 (`resolve_tenant_session_factory` in `app/database.py`) instead of silently serving the default database.
- **`tenant_manager`** (`app/services/tenant_manager.py`) keeps lazy per-tenant engine pools (size 20 + 10 overflow; creation guarded by a per-slug `asyncio.Lock` so concurrent first requests build one pool), closes pools idle > 15 min (cleanup loop every 5 min), decrypts the tenant DB password on first connect, pins the session timezone to UTC like the default engine, and runs idempotent per-tenant auto-migrations on pool creation.
- **`tenant_provisioner`** (`app/services/tenant_provisioner.py`) creates the PG role + database, grants, applies the tenant schema, and seeds defaults (predefined phases, skills, "Main Site", admin user). It validates identifiers against injection and handles **managed PostgreSQL** (Azure/RDS/Cloud SQL) where the admin is not a superuser: grants the tenant role to the admin before `CREATE DATABASE` and reassigns `public` schema ownership.
- Tenant DB credentials are stored AES-256-GCM-encrypted (`iv:tag:ciphertext` hex, key = `TENANT_ENCRYPTION_KEY`) in `tenant_credentials`, Node-compatible format.

## Real-Time Collaboration

### Backend (`app/websocket/`)

- Endpoints: `/ws` (single-tenant) and `/t/{slug}/ws` (multi-tenant), in `handler.py`. **Origin check first** (`is_origin_allowed`: the `Origin` must match `Host`/`X-Forwarded-Host` or a configured CORS origin; absent `Origin` = non-browser client, allowed) → else close **4003**. Auth = the `connect.sid` cookie validated against the tenant DB. Close codes: 4001 no/invalid/expired session **or revoked** (`disconnect_user`), 4002 auth error, 4003 origin not allowed / user disabled, 4004 tenant not found, 4005 tenant not active, 4006 tenant DB not configured.
- `ConnectionManager` (`manager.py`, global `manager`): per-tenant rooms, multiple connections per user (multi-tab), presence join/leave/list with deduped online users, `broadcast_to_tenant(exclude_user/exclude_connection)`, **`send_to_user(tenant, user_id, message)`** for per-user delivery (notifications), **`disconnect_user(tenant, user_id, except_session_id=…)`** for session revocation (per process, best effort), asyncio-lock guarded. Fan-outs count only successful sends and prune a connection whose send failed (which emits `presence:leave`).
- **Two broadcast tiers**: routers with meaningful UX events call `broadcast_change(request, user, entity_type, entity_id, project_id, action, summary)` (`broadcast.py`) → clients receive an attributed `change:<entity>` with user name and summary. All other successful writes get a coarse `change:<entity>` from `BroadcastMiddleware` (sender excluded; `SKIP_PATTERNS` prevents doubles).
- Receive loop handles `ping` → `pong` (client pings every 25 s).
- **Per-user pushes**: `approval:changed` and `todo:changed` (`send_user_event(request, user_id, type, payload)`, after the commit) tell the requester, the live approvers, a todo's assignee and creator to refetch their lists — todos are never broadcast tenant-wide. Like `notification:new`, each needs its own `case` in `useWebSocket`.
- **`notification:new`** is sent per-user via `send_notification()` (`websocket/broadcast.py`). It is a *live hint only* — the manager is per-process, so a user on another worker misses it; the DB row is the source of truth and the bell reloads on mount/focus. On the client it needs its **own `case`** in `useWebSocket` (the `default:` branch only handles `change:*`).

### Frontend

- `useWebSocket` (`src/hooks/useWebSocket.ts`): connects to `ws(s)://<host><tenantPrefix>/ws`, exponential backoff (2 s base, 60 s max, 5 attempts), does **not** reconnect on close codes 1000/1001/4000–4006; after giving up (or a non-terminal drop) it retries immediately on the browser `online` event and when the tab becomes visible (`visibilitychange`) — never after 4000–4006. 4001/4003 call `onSessionInvalid` → `WebSocketContext` re-checks `/auth/me` and calls `expireSession()` if the session is gone; if `/auth/me` says the session is still valid (a handshake cookie race), the hook retries **once** with a fresh backoff budget, and a repeated 4001/4003 stays terminal. Exposes `offline` (browser offline, or settled and not connected/connecting) → the Header's `SyncStatus` "Offline" badge. Tracks `onlineUsers` (presence messages) and `recentChanges` (any `change:*`, expiring 30 s after local receipt to dodge clock skew).
- `WebSocketContext` (`src/contexts/WebSocketContext.tsx`) turns changes into data refreshes: `slicesForEntity()` maps entity type → data slices (`project`/`phase`/`subphase`/`assignment`/`staff_assignment`/`equipment_assignment`/`predefined_phase`→`projects`, `staff`→`staff`+`projects`, `equipment`→`equipment`+`projects`, `equipment_block`→`equipmentBlocks`, `vacation`→`vacations`, `skill`→`skills`+`staff`, `bank_holiday`/`company_event`→`siteCalendar` (current site's holidays + events), `absence_type`→`absenceTypes`+`vacations`, `site`→`sites`+`siteCalendar`+`projects`+`tags`+`equipment`+`teams` (site writes are rare; a site delete cascades its projects, site-only tags and site-only equipment), `tag`→`tags`+`projects`, `tag_group`→`tags` (the `tags` slice reloads tags **and** groups), `custom_column`/`custom_column_value`→`customColumns` (customColumnStore only, no project reload), `settings`→`settings`, `user`→`staff`+`currentUser`+`projects`+`teams`+`roles` (role/site changes and deactivation of the signed-in user apply live; role user counts move), `team`→`teams`+`staff`+`projects`+`tags`+`equipment`+`siteCalendar`, `note`/`card_comment`→ nothing, `role`→`currentUser`+`roles` (a matrix edit re-reads `/auth/me`), `approval_policy`→`approvalPolicies`+`approvals` (a policy never changes `/auth/me`; `approval_required` follows the role), `approval_request`→`projects`+`approvals`, `todo`→`todos` (todo writes are never broadcast tenant-wide: the per-user `todo:changed` / `approval:changed` pushes refresh the `todos` / `approvals` slices, which both run one `todoStore.refresh()`), unknown → everything; the mapping lives in `src/contexts/wsSlices.ts`; Kanban writes reuse `phase`/`subphase`/`staff_assignment`/`card_comment`, there is no Kanban-specific entity), then refreshes via a **200 ms debounced, coalesced** runner with an in-flight guard that re-stages if more changes arrive mid-fetch. A phase drag producing N child updates results in one refetch per slice. Unknown entity types refresh everything, so new backend entities need no client change.
- While What-If is active, refreshes of the sandboxed slices (`projects`, `customColumns` — `WHAT_IF_SANDBOXED_SLICES` in `wsSlices.ts`) are deferred and run once What-If ends, so a teammate's change never replaces the plan being edited.
- `notification:new` → `WebSocketContext.handleNotificationReceived` → `notificationStore.receive()` (dedupes by id). It is only a live hint; the bell reloads from the server on mount and focus. The provider also loads `todoStore` on mount and window focus (it feeds the My Todos badge).
- `OnlineUsers` and `ActivityFeed` render presence and the change feed (`recentChanges` from `useWebSocket`). A per-entity "changed by X" badge (`ChangeIndicator` + `useEntityChangeIndicator`) was built but never wired up and has been removed as dead code, together with its per-entity query helpers; the context exposes `recentChanges` only.

---

## Frontend Architecture

### Tech stack

React 18 + TypeScript 5.6, Vite 7, Vitest 4, Zustand 5, date-fns 4, CSS Modules. All data flows through the Zustand stores — there is **no query library** (TanStack Query was installed but unused and has been removed; don't re-add it) and **no router package** — `react-router-dom` was removed as unused; there is no route tree.

### Routing without a router

- `src/main.tsx` boots the theme and wires the API client (`configureApiClient`): What-If check + queue from `whatIfStore`, and `onUnauthorized: expireSession`. (The legacy `rd_*` storage migration was removed.)
- `src/App.tsx` renders by branching: `window.location.pathname` exactly `/admin` or under `/admin/` (`isAdminPath`) → `AdminApp` (a fully separate admin-portal app: `AdminLoginScreen` / `AdminDashboard` with tenants/organizations/admins/stats tabs); otherwise `TenantApp`: auth state decides `LoginScreen` vs the main app, with `LoadingScreen` during the initial load and `LoadErrorScreen` (Retry) if it failed, then `WebSocketProvider` → `MainLayout` + `ModalContainer` + `ContextMenuContainer` + `ActivityFeed`. `TenantApp` also owns the `what-if-mode` body class.
- In-app navigation = `viewStore.currentView` (`gantt` | `kanban` | `todos` | `staff` | `equipment` | `crosssite` | `archived`) switched by the sidebar; **views are state, not URLs**. `useAllowedViews()` decides which ones the sidebar lists (`VIEW_PERMISSIONS`: `views.*` keys; Gantt always, My Todos for anyone signed in) and disables Cross-site while only one site is visible; `MainLayout` falls back to `gantt` when the current view is no longer allowed and re-selects the lowest-id visible site when the current one is gone. `setCurrentView` refuses every view but `gantt` while What-If is active (see What-If Mode).
- **All administration is one Settings hub** (`components/settings/`), a full-size shared `Modal` with a grouped section list. The sidebar `AdminSection` has a single **Settings** entry, shown when `canOpenSettings(user)` (any section gated by a held key). Sections come from the `SETTINGS_SECTIONS` registry, each with a `permission` (a key, any-of keys, or `null`) mirroring the backend: General `null` (per-browser theme for everyone; instance-wide settings with `settings.general`), Roles `roles.manage`, Sites `sites.manage` or `sites.export`, Teams `teams.manage`, Bank holidays `bank_holidays.manage`, Company events `company_events.manage`, Users `users.view`, Skills `skills.manage`, Absence types `absence_types.manage`, Equipment `equipment.manage`, Equipment types `equipment_types.manage`, Predefined phases `predefined_phases.manage`, Tags `tags.manage`, SSO `settings.sso`. Settings → Roles has two tabs: the role list / `RoleForm` with the `PermissionMatrix`, and `ApprovalPoliciesForm`. Add new admin UI as a registry entry + `…Panel` component (no `<Modal>` wrapper), not as a new sidebar item or standalone modal. The General panel reports unsaved changes to the hub (`onDirtyChange`) so switching section/closing asks first. Custom columns stay in the Gantt project panel. Self-service time off is **My absences** (`MyAbsencesModal`, user menu).
- The tenant prefix `/t/{slug}` comes from the URL: `getTenantPrefix()` in `client.ts` prepends it to every `/api/` call. Deep links work because FastAPI's catch-all (prod) or `tenantSpaPlugin` (dev) serve `index.html` for `/t/*` paths.

### Zustand stores (`src/stores/`)

| Store | Persisted | Purpose |
|-------|-----------|---------|
| `appStore` | only `_persistedSiteId` | Domain data (sites, projects, staff, equipment, blocks, vacations, absence types, holidays+date Sets, events + derived `closureIndex` (built in `setCompanyEvents`), users, skills, tags + `tagGroups`, `teams` (every site, inactive included), `roles` and `approvalPolicies` (loaded on first use by `useRoles` / `useApprovalPolicies`, not persisted), instance settings), auth state, current site/user (with its `permissions`), critical-path state. Site switch **clears undo history**. Exports only non-array selectors (`selectStaffSiteIds`, `selectStaffTeamIds`, `selectTeamSiteById`, `selectAbsenceTypesById`, `selectCanManageOthersAbsences`) — array selectors were removed because they re-render forever under Zustand 5 |
| `viewStore` | yes | View mode (`week`/`month`/`quarter`/`year`) + a single `cellWidth` (per-mode *defaults* applied on mode switch, then freely zoomed — widths are not remembered per mode), current view, current date (memory-only), resource tab, expansion Sets (persisted: projects/phases/subphases; session-only: staff/equipment/bank-holidays), level-based expand/collapse, scroll position, panel collapse flags, overview toggles (staff/equipment — mutually exclusive), `teamFilters` (header team filter `{teamIds, noTeam}` per tenant + site, same `tagFilterKey` keying, absent = Whole site, sanitised on rehydrate and listed in `merge`), `tagFilters` (project tag filter `{tagIds, noneGroupIds}` keyed `"<tenant slug>:<site id>"` via `tagFilterKey()` in `utils/tags.ts` — the storage key is per origin, so tenants must not share entries; persisted, stale ids pruned when applied), `ganttGrouping` (tag group id) + `collapsedGanttSections` (`tag-<id>`/`none` keys) for the Gantt "Group by", and `ganttColorBy` (tag group id) for the Gantt "Colour by" (independent of Group by), same `tagFilterKey` keying and rehydrate sanitising (`sanitizeSiteGroupIds`), not cleared on logout; Kanban board prefs `kanbanProjectId`, `kanbanGrouping` (`none`/`project`/`phase`/`assignee`/`customColumn`) + `kanbanGroupingColumnId`, `kanbanMyTodoOnly` (persisted) |
| `uiStore` | no | Active modal + editing context, Settings hub state (`openSettings(section?, intent?)` → `activeModal: 'settingsHub'` + `settingsSection` + `settingsIntent` view/add/edit; legacy modal keys `settings`/`manageSites`/`siteManagement`/`site`/`userManagement`/`manageEquipment`/`predefinedPhases`/`ssoConfig`/`bankHoliday`/`customHoliday`/`companyEvent` are aliases that open the hub at the matching section; `openSettings`, `setActiveModal('settingsHub')` and the alias keys are no-ops while What-If is active), tooltip, drag/resize state, drag indicator, dependency-linking state, phantom-sibling state, context menu, scroll/zoom triggers, resource drag, Kanban card dialog (`openKanbanCardModal`), `modalContext.returnTo` (reopen the previous modal on close, e.g. My absences → absence dialog), `isLoading` / `loadingMessage`, `flashNotice` + `showFlash(message, tone)` / `dismissFlash()` (a detached error with no form to sit in — context-menu deletes, refused dependency links, failed card moves — rendered bottom-right by `layout/FlashNotice`, auto-cleared after 6 s) |
| `whatIfStore` | no | What-If mode flag, `structuredClone` snapshot of projects, queued operations, `whatIfApplyError` `{applied, total, message}` + `dismissApplyError`, `reset` |
| `undoStore` | no | Undo/redo stacks of project-tree snapshots (max 50) |
| `customColumnStore` | visibility only | Columns, values map (key `"{columnId}-{entityType}-{entityId}"`), per-column filters (`__empty__` sentinel for blanks), visibility |
| `notificationStore` | no | In-app notification inbox (server-owned; not persisted — the bell reloads on mount/focus), `unreadCount`, `panelOpen`; `receive()` dedupes live pushes by id. Derived due-soon/overdue reminders are **not** here — the bell merges them in from `useDerivedDueNotifications` |
| `todoStore` | no | My Todos: `tasks`, `mine` (own requests), `toDecide`, `openCount` (the sidebar badge: requests to decide + open tasks assigned to me, `isMyOpenTask`), `toDecideByAssignment`, `activeTab` / `statusFilter`, `loadError`; `refresh()` loads the three lists together (shared in-flight promise, a failed list keeps its last value), `applyDecisionLocal`, `upsertTaskLocal`, `removeTaskLocal`. In `resetAllStores()` |
| `confirmStore` | no | Queue of pending `confirmAction()` requests (first in shows); `ConfirmDialog` settles the head. Reset by `resetAllStores()`, which resolves every pending request `false` |
| `adminStore` | no | Admin portal: admin user + `mustChangePassword`, tenants, organizations, admin users, stats, active tab, `selectedTenantId` / `selectedOrganizationId`. Not re-exported from `stores/index.ts` and not touched by `resetAllStores()` |

Persistence gotchas: Sets are serialized as arrays and restored in custom `merge` functions. viewStore's `merge` is **field by field**, so every field added to `partialize` must also be listed in `merge`, or it silently resets on every reload. `currentDate` and `timelineScrollLeft` are memory-only — the app always opens on today.

### API client (`src/api/client.ts`)

- `apiRequest<T>` + `apiGet/Post/Put/Patch/Delete` + `downloadFile` (Content-Disposition-aware).
- Cookie auth (`credentials: 'include'`) — no token headers.
- Dev detection: when the page runs on port 3333, API and WS target `:8485` directly (no Vite proxy).
- FastAPI 422 validation errors are flattened to `field: message` strings; non-JSON responses raise with the first 200 chars logged (catches proxy HTML). Every non-2xx throws `ApiError` (an `Error` carrying `status`; `isForbidden(err)` for 403s). A 202 own-booking body is recognised with `isPendingResponse()` (`api/endpoints/approvals.ts`), never by status.
- **Session expiry**: a 401 on a session-bound call fires the `onUnauthorized` hook → `expireSession()` (`src/stores/index.ts`): `resetAllStores()` (appStore except the persisted site id, What-If, undo, notifications, custom-column data, `uiStore` back to its initial state, and the transient body classes `phantom-sibling-mode` / `resource-dragging` / `kanban-dragging` / `what-if-mode` removed; viewStore and column visibility are kept, adminStore is left alone) and back to the login screen. `useAuth.logout` also calls `resetAllStores()`, so nothing carries over to the next person on the tab. Add new stores to `resetAllStores()`.
- **What-If interception** happens here (see What-If Mode).
- Endpoint modules beyond the per-domain ones: `health.ts` (`getAppVersion()`), `importChunks.ts` (`postInChunks()`, used by `sites.ts` / `vacations.ts`), `kanban.ts`, `notifications.ts`, `approvals.ts`, `todos.ts`. The last four are imported directly, not re-exported from `api/index.ts` (`roles.ts` is).

### Transform layer (`src/api/endpoints/projects.ts`)

All backend↔frontend field mapping is centralized. The frontend model is mostly snake_case like the API. Inbound, `transformProject/Phase/Subphase/StaffAssignment/EquipmentAssignment` map phase `type`→`name` and `sort_order`→`order_index`, reshape the tree (`subphases`→`children`, `parent_type`/`parent_id`→`parent_phase_id`/`parent_subphase_id`), camelCase the assignment arrays, map each staff assignment's `approval_status` (`pending` / `approved`) and `approval` (the open request, or null), default `status` to `todo`, and inject theme colors (`getPhaseColor`, `getDepthColor`). Outbound, only phase `name`→`type` is mapped. `fetchAllProjects()` fetches the list then each project detail in parallel; `loadAllProjects()` wraps it and is a no-op during What-If. Assignment CRUD routes differ by level (`/assignments/{id}` vs `/phase-staff/{id}` vs `/subphase-staff/{id}`) — the endpoint module picks the right one.

### Gantt architecture (`src/components/gantt/`)

- `GanttContainer` orchestrates: filters projects to the current site (non-archived), orders them with `orderSiteProjects()` (`utils/storage.ts`, shared with the Kanban board: per-site custom order from localStorage, default = confirmed-first, then name), applies the tag filter (`useTagFilteredProjects`), memoizes timeline cells/headers, and renders **`ProjectPanel` (left tree) + resizer + `Timeline` (right)** inside `TimelineScrollProvider`, with optional embedded staff/equipment overview panels below (`canManageAnyProject`: `projects.edit_any`, or the PM of at least one project).
- `ProjectPanel/`: header actions, right-aligned across the name column + custom columns (new/import/manage columns/visibility/tag filter — `TagFilterDropdown` from `components/common`, also mounted in the Kanban toolbar — then `GroupByDropdown` and `ColorByDropdown`, both thin wrappers over the shared `TagGroupChoiceDropdown` shell; the header dropdowns hang from the positioned `.headerContent`, right-aligned and width-capped) + `SectionRow` (Group-by section header) + rows `ProjectRow → PhaseRow → SubphaseRow → AssignmentRow` + custom-column cells; wrapped in `ReorderProvider`.
- `Timeline/`: `TimelineHeader` + `TimelineBody` — grid cells (weekend/holiday/company-event backgrounds; week separators when weekends are hidden), `TodayLine`, per-project bars (`ProjectBar`/`PhaseBar`), `DependencyLayer` (arrows), phantom overlays, `DragIndicator`, `ResourceDropOverlay`. Handles scroll persist/restore (200 ms debounce), zoom re-centering on the visible center date, view-mode changes preserving the left-edge date, Ctrl+wheel zoom, and scroll-to-today/date triggers.
- **Group by tag group**: `GanttContainer` turns `useGanttGrouping()` + the tag-filtered projects into one flat `GanttRow[]` (`components/gantt/utils/projectSections.ts`: `buildProjectSections` → `buildGanttRows`; first tag in group order wins, empty sections omitted, "No <group>" last) and hands the **same array** to `ProjectPanel` (`SectionRow`) and `TimelineBody` (`div.groupBand`, a direct child of `.rows`); both panes fall back to a memoised flat list when `rows` is omitted. Section rows are `--section-row-height` (36 px) + 1 px border, content-box, = `SECTION_ROW_TOTAL_HEIGHT` (37) in `calculateRowPositions(rows, …)`, keyed `section-<key>`; collapsed sections' projects get no position (no arrows, no drop target). Section class names must not contain `row` and carry no `data-project-id`/`data-phase-id` (the drag/resize hooks and `DependencyLayer` find rows by `[class*="row"]` / data attributes). Project drag-reorder is off while grouped (`onProjectReorder` undefined).
- Scroll sync: `TimelineScrollContext` (horizontal, direct DOM with feedback-loop guard) across Gantt/Staff/Equipment timelines; `useScrollSync` (vertical) between tree panel and timeline body — wheel-driven in the same frame, echo-free, and padding the shorter pane so both reach the same scroll end (never a fixed scrollbar-height padding in CSS).
- **Drag pipeline** (`useDragAndDrop`): mousedown or touchstart on a bar (touches become a mouse-like event via `toMouseLikeEvent`) → live DOM movement with cell snapping (week/month) and a dependency lag indicator → on drop, `commitDragUpdate` computes new dates from pixels, awaits `confirmAction()` for whole-project moves (cancel snaps the bar back), snapshots undo state, clones and mutates the project tree (cascading children + project-level assignments — phase/subphase staff rows take their dates from their item and pending rows are never moved; every `PendingUpdate` carries its assignment `level`, so a staff update goes to the right route), updates the store optimistically, then persists via batched `PendingUpdate`s (`savePendingUpdates`). **Any persist error → reload all projects + clear undo.** The document `mousemove`/`mouseup` **and `touchmove`/`touchend`/`touchcancel`** listeners (here and in `useResize`) are attached at drag start and removed on mouse-up/touch-end and on unmount — never left on the document between drags. Touch: the bars hand the hooks a mouse-like event built by `utils/touchEvents.ts` (`toMouseLikeEvent`, an explicit object — never spread a SyntheticEvent, its methods are lost; its `preventDefault` is a no-op for the passive touchstart), and every touch start waits for a 5 px move first (`armTouchGesture` for project, assignment and resize-handle touches; the PhaseBar body has its own threshold) so a wobbly tap never commits a move; the non-passive `touchmove` listener calls `preventDefault()` only on interactive bars (React's root `touchstart` listener is passive, so only CSS `touch-action: none` on the *interactive* bars — the `interactive` class, set when a bar has drag/resize handlers, so read-only bars still scroll — plus that listener stop the timeline from scrolling), `touchend` is default-prevented so the browser sends no emulated click, and `touchcancel` restores the bar without saving (`cancelDrag`/`cancelResize`).
- **Auto-calculation semantics** (`gantt/utils/autoCalculation.ts`): dependencies auto-align **only at creation time**; moving an item does *not* cascade to its dependents (users keep manual lead/lag control). Moves do (a) expand/contract parents to the union of their children and (b) auto-fit project dates to phases. Staff-assignment updates must include `allocation` (backend requirement).
- **Critical path** (`components/gantt/utils/criticalPath.ts`): full CPM forward/backward pass, `totalFloat <= 0` = critical; loaded via dynamic import from `appStore.toggleCriticalPath` to avoid a circular dependency.
- **Undo/redo** (`useUndoRedo` + `components/gantt/utils/diffProjects.ts`): restore snapshot, diff old-vs-new date fields **and dependency arrays** into minimal `PendingUpdate`s (pending assignment rows skipped), persist; on failure reload + clear history.
- **Pending bookings**: a pending create (`isPendingAssignment`) renders as a dashed `AssignmentRow` / hatched `AssignmentBar` with a `PendingBadge`, a row with an open change shows `40% → 60%`; any open request freezes the bar. The context menu offers Approve / Reject (`approval.can_decide`) and Cancel request (the requester); a pending create is locked for everyone but its requester (`lockedPending`, same rule as `KanbanCardModal`). A 202 from a write goes through `utils/pendingBookings.ts` (`markRequestPendingLocally`, `reloadAfterPendingWrite`, `flashSentForApproval`).
- **Dependencies** are stored per phase/subphase as JSON `[{id, type, lag?, entity?: 'phase'|'subphase'}]`. Phase and subphase ids are separate sequences, so new links always write `entity`; legacy entries without it resolve **phase-first**. Always go through `components/gantt/utils/dependencies.ts`: `resolveDependencyPredecessor` (lookup), `dependencyMatches` (find/delete a link, legacy-aware, missing `type` = FS), `wouldCreateDependencyCycle` (walks phases and subphases alike). Arrows, critical path and linking all use them.
- **Timeline headers**: generated in `components/gantt/utils/timeline.ts` (`generateTimelineCells` / `generateTimelineHeaders`); week labels are ISO 8601 (date-fns `getISOWeek` / `getISOWeekYear` — 1–3 Jan 2027 is W53); the current month is highlighted.
- **Custom-column cells** write one value with `setCustomColumnValue`, and a cascade to children with `setCustomColumnValuesBatch` (chunks of ≤ 500, the backend limit); on failure the touched cells are rolled back unless edited again since.

### Kanban architecture (`src/components/views/KanbanView/`)

- The board is a second rendering of the Gantt tree, not a separate dataset: `KanbanView` takes `appStore.projects`, orders them with `orderSiteProjects()`, filters with `useTagFilteredProjects()`, and derives cards with `utils/kanbanCards.ts` (card = leaf phase/subphase, milestones included; `groupCards()` builds the swimlanes for the `viewStore.kanbanGrouping` choice). `KanbanBoard` → `KanbanColumn` → `KanbanCard`; `KanbanToolbar` holds the project picker, grouping, tag filter and My-to-do toggle.
- Comment counts come from `api/endpoints/kanban.ts` (`getCommentCounts` for one project, `getSiteCommentCounts` in "All projects" mode); the card dialog is `modals/KanbanCardModal.tsx` (assignees with `AllocationSlider`, comments with `MentionTextarea`, mention candidates from `getMentionableUsers`).
- Assignees are approved rows only (`assigneeIdsOf`); pending ones (`pendingAssigneeIds`) show as dashed avatars, count for **My Todo**, but never make a card movable or due-reminded. `KanbanCardModal` relabels Join / leave / slider writes in approval mode and shows `ApprovalActions` to deciders.
- Dragging is `contexts/KanbanDragContext.tsx` — hand-rolled HTML5 drag events like `ReorderContext` and `useResourceDragDrop`, no DnD library. The move is optimistic; the server echoes `{status, completion}` and the client reconciles without a refetch.
- Server writes broadcast as `phase` / `subphase` / `staff_assignment` / `card_comment` (see Real-Time Collaboration); a card status change from the Gantt slider is applied locally by `statusAfterCompletionWrite` because the rich broadcast excludes the sender.

### Hooks catalog (`src/hooks/`)

| Hook | Purpose |
|------|---------|
| `useAuth` | Mount-time `checkAuth()`, login/logout (logout calls `resetAllStores()`) |
| `useDataLoader` | Parallel initial data load + site resolution (the persisted site only if still visible, else the lowest-id visible site; `selectSite(site)` is exported) + `loadGated(key, load)` (no request without the view key, a 403 → empty slice; the equipment and block loads use it) + granular refreshers (`refreshProjects`, `refreshSiteData`, `refreshCustomColumns`, `refreshStaff`, `refreshEquipmentBlocks`, `refreshAbsenceTypes`) that components call after their own writes. `WebSocketContext` does **not** use it — it fetches on its own |
| `useWebSocket` / `WebSocketContext` | See Real-Time Collaboration |
| `useDragAndDrop` | Gantt bar dragging, mouse and touch (see drag pipeline); gated per project (`canEditProjectById`), per equipment booking (`canBookEquipmentById`) and per own assignment (`canEditAssignment`); a 202 on an own bar → `reloadAfterPendingWrite()` (reload, clear undo, "Sent for approval") |
| `useResize` | Bar edge resizing with date recalculation (mouse and touch; a `touchcancel` restores the bar without saving); same gates and 202 handling as `useDragAndDrop` |
| `useResourceDragDrop` | Drag **source** only for staff/equipment from ResourcePanel and the Staff/Equipment views: permission check (project editors drag anything; everyone else only their own staff card, and only with `assignments.self_create` in allow or approval mode — `canBookSelf`), drag data, uiStore drag state and body class. It deliberately has no create path: `Timeline/ResourceDropOverlay.tsx` creates the 5-day default assignment (staff allocation defaults to `max_capacity`), checks the target's permission and blocks drops during What-If |
| `useDependencyLinking` | Two-click dependency creation |
| `usePhantomSibling` | Shift+click spawns a phantom sibling bar following the cursor (lag computed on placement) |
| `useUndoRedo` | Undo/redo orchestration (see above) |
| `useKeyboardShortcuts` | Esc (linking → phantom priority), Home (today), `+`/`-` zoom (±4 px, 12–120 px), Ctrl/Cmd+Z / Ctrl/Cmd+Y / Ctrl/Cmd+Shift+Z. **Every shortcut is ignored while a modal is open** (`uiStore.activeModal`) — the modal owns the keyboard, and the shared `Modal` owns Escape so guarded `onClose`s like the Settings hub's run. Also ignored while focus is in an input, textarea or contentEditable |
| `useCan` | `useHasPermission(key)` / `useNeedsApproval(key)` (primitive selectors) and `useCan()` (a stable `(key, project?) => boolean`) over `utils/permissions.ts` |
| `useVisibleSites` | The sites the user may see (`can_see_all_sites` → every site, else `site_ids`), for the site selector, Cross-site and the Settings site pickers; `visibleSitesFor()` is the pure form |
| `useAllowedViews` | `{visible, disabledReason, isAllowed}` from `VIEW_PERMISSIONS` (+ `CROSS_SITE_DISABLED_REASON` below two visible sites) — the one key-per-view map, read by `Navigation` and `MainLayout` |
| `useRoles` | `appStore.roles`, fetched once on first use (shared in-flight promise); `refreshRoles()` after writes. Import from `@/hooks/useRoles` |
| `useApprovalPolicies` | `appStore.approvalPolicies`, loaded on first use; `useApproverSummary(action, projectId)` → the `PendingBadge` tooltip ("Awaiting approval by … (project manager), Team Lead or an administrator") |
| `useWhatIfBlocked` | `{blocked, reason(action)}` for create entry points during What-If (`whatIfUnavailableMessage()`) — use it for any new create button/dialog |
| `useGanttGrouping` | Current site's Gantt "Group by" (`{siteId, group, siteTags, collapsedKeys, setGroup, toggleSection, collapseAll, expandAll}`); primitive selectors, stale group id → `group: null` without a write. Import from `@/hooks/useGanttGrouping` (tests mock `@/hooks` partially) |
| `useGanttColorBy` | Current site's Gantt "Colour by" (`{siteId, group, setGroup}`), read by every `ProjectTimeline` row and the `ColorByDropdown`; same rules as `useGanttGrouping` (primitive selectors, stale id → `null` without a write, no-op without a site). Import from `@/hooks/useGanttColorBy` |
| `useEscapeKey` | Escape-to-close for standalone dialogs that can't use the shared `Modal` (e.g. the admin-portal modals). Stands down while a `confirmAction()` request is pending, so Escape on the confirm never also closes the dialog that asked |
| `useCtrlScrollZoom` | Ctrl+wheel zoom keeping the date under the cursor fixed |
| `useScrollSync` | Bidirectional vertical scroll sync between two elements (used by GanttContainer and the Staff/Equipment/CrossSite/Archived views). Three behaviours: no echo (a write remembers the value and ignores the follower's matching `scroll` event, so the follower never snaps the source back), a non-passive `wheel` handler that moves both panes in the same frame (Ctrl+wheel and horizontal deltas are left alone), and equalised scroll range — it measures both panes' natural `scrollHeight - clientHeight` and pads the shorter one (`ResizeObserver`, `window` resize fallback), which replaced the fixed 8 px bottom padding that only matched a classic horizontal scrollbar |
| `useWorkloadCalculation` | Per-cell staff workload for the Staff heatmap (allocations — pending bookings excluded —, vacations incl. recurring, visual states). Only absences whose type `counts_as_unavailable` (or untyped ones) zero capacity. An optional closure lookup (`ClosureLookup`, usually `getClosureOn` bound to the person's sites) zeroes capacity on site-closure days → `vacation`/`conflict` state, `closureName`/`closureColor`, tooltip *Site closed: …* |
| `useEquipmentOverlaps` / `useEquipmentTodayStatus` | Equipment double-booking detection / today-status (`blocked` > `booked` > available) — two hooks in one file |
| `useTagFilter` | `useSiteTagFilter()` (the current site's `viewStore.tagFilters` entry, shared by the Gantt, the Kanban board and `TagFilterDropdown`; ids of tags deleted or re-scoped away from the site are ignored on read and pruned on the next write) + `useTagFilteredProjects(projects)` |
| `useTeamFilter` | `useTeamFilter()` — the current site's header team filter (`viewStore.teamFilters`, keyed like `tagFilters`; `null` = Whole site) with `projectMatches` / `staffMatches` / `equipmentMatches` / `eventMatches` / `tagMatches`, shared by `TeamSelector`, the views, the pickers and the tag filter options. Its options are the site's **active** teams (stale ids ignored, pruned on the next write), but scoping considers **all** teams, inactive ones included — equipment limited only to an inactive team is hidden under any team filter. Plus `useTeamFilteredProjects(projects)` and `useTeamFilteredCompanyEvents()` (the current site's events and their date Set, narrowed — every timeline and the Staff view's Company Events row read it). Pure predicates live in `utils/teams.ts` |
| `useHeaderDensity` | The one definition of the header's width tiers: `full` ≥ 1600 px, `compact` ≥ 1280, `condensed` ≥ 1024, `minimal` below (matchMedia). The Header sets it as `data-density` and moves controls into `HeaderOverflowMenu` by tier; header CSS must contain no pixel breakpoints |
| `useDismissableOverlay` | The one dismiss behaviour for dropdowns, popovers and menus (`{open, onClose, wrapperRef, triggerRef?}` → `{onBlur}` for the wrapper): outside `mousedown`, Tab out, and Escape in the capture phase with `stopPropagation` + focus back on the trigger, so only the innermost overlay closes and the app-wide shortcuts never see the key. Every overlay uses it (`TagFilterDropdown`, `TagGroupChoiceDropdown`, header menus, `NotificationBell`, column visibility/filters, Staff/Equipment filters, `DependencyPopup`, `ContextMenu`). Never for a dialog — `Modal` must not close on an outside click. Both it and `useEscapeKey` stand down while a `confirmAction()` request is pending, so the confirm on top owns Escape and the overlay that asked stays open until the answer |
| `useDerivedDueNotifications` | Due-soon (`DUE_SOON_DAYS` = 7) and overdue reminders for the current user's cards (approved assignments only), derived from `appStore.projects` (no scheduler server-side; nothing fires while the app is closed). Negative ids, `source: 'derived'`; dismissals in localStorage (`STORAGE_KEYS.KANBAN_DUE_DISMISSED`) keyed by card + due date, so a rescheduled card notifies afresh. Only consumer: `NotificationBell` |

### Utilities worth knowing (`src/utils/`)

`date.ts` (~28 date helpers incl. business-day math, week labels, plus date-fns re-exports), `storage.ts` (typed storage wrappers, `STORAGE_KEYS` incl. `KANBAN_DUE_DISMISSED`, theme system setting `data-theme` on `<html>`, per-site project order + `orderSiteProjects()` / `compareProjectsDefault()` — the one ordering rule for the Gantt and the Kanban board), `kanbanCards.ts` (card derivation from the project tree, `groupCards()` / `KanbanGrouping`, `dueStateOf()`, `cardKey()`, the pending-booking helpers `isPendingAssignment` / `requestedAllocation` / `isRemovalRequested` / `assigneeIdsOf` (approved only) / `pendingAssigneeIdsOf`, and the status↔completion mirror of `app/services/card_status.py` guarded by `cardStatusMirror.test.ts`), `mentions.ts` (`@[Name](id)` tokens — mirror of `app/services/mentions.py` — plus the composer's offset-anchored mentions, which survive edits instead of being re-matched by name), `colorSwatches.ts` (`EVENT_COLOR_SWATCHES` / `DEFAULT_EVENT_COLOR` for events and absence types, `SKILL_COLOR_SWATCHES`), `avatarColor.ts` (`avatarColorFor(id)` — the one avatar palette for presence, activity toasts and Kanban assignees), `projectLevels.ts` (expansion levels shared by viewStore's level expand/collapse and the project row's +/- buttons), `themeColors.ts` (phase/depth colors from CSS vars), `recurringVacation.ts` (`[R:0,2,4]` pattern + absence-type helpers: `getAbsenceOn()` is the single "is this person on an absence / unavailable on this day" check (site closures are separate, see `siteClosure.ts`) — honours recurring patterns and `counts_as_unavailable`; `guessAbsenceTypeId()` for .ics imports), `siteClosure.ts` (`buildClosureIndex()` expands closure events into a day → events index once, in `appStore.setCompanyEvents`; `getClosureOn(staffSiteIds, date, index, staffTeamIds?, teamSiteById?)` is the closure counterpart of `getAbsenceOn()` — an event limited to teams at the shared sites applies only to their members, so **every caller must pass the person's teams** (`selectStaffTeamIds`) and `selectTeamSiteById`, or it falls back to whole-site; a team-limited closure never shades the timeline header (`timeline.ts`) — used by the Staff heatmap, StaffView `calcAvailability`, ResourceCard and Gantt assignment-bar markers), `permissions.ts` (`can()` and the key-based gates, mirrors `app/services/project_access.py` — see Frontend Conventions), `roles.ts` (`roleWithin` — mirror of `user_access.role_within`, the escalation rule of the role pickers — `roleKeyFromName`, `matrixEquals`, `confirmRoleDelete`), `pendingBookings.ts` (the 202 helpers: `markRequestPendingLocally`, `reloadAfterPendingWrite`, `flashSentForApproval`, `approverSummary`), `relativeTime.ts` (shared by the bell and My Todos), `ics.ts` (the one `.ics` parser/generator: multi-VEVENT, all-day exclusive DTEND, `RRULE:FREQ=YEARLY` expansion, CATEGORIES, Outlook BUSYSTATUS, UTF-16; `buildICS()` for every export), `equipmentOverlap.ts`, `csvExport.ts` (MS-Project-compatible CSV: outline levels, `ID{FS|SS|FF|SF}±lag` predecessors), `xmlExport.ts` (MS Project XML), `subphaseUtils.ts` (subphase tree helpers), `persistFailure.ts` (`recoverFromPersistFailure` — the failure protocol), `reorder.ts` (local phase/subphase reorder applied before the server call, so it shows in What-If too), `localProjectTree.ts` (clone-and-replace patch/remove helpers for phases, subphases, assignments — dialogs apply edits to the store with these so they show while What-If skips the reload), `whatIf.ts` (`whatIfUnavailableMessage()` for blocked creates), `touchEvents.ts` (`getEventCoordinates`/`getPointerClientX`/`isTouchEvent`/`toMouseLikeEvent`/`armTouchGesture`/`NON_PASSIVE` — the one touch→mouse-like mapping used by `PhaseBar`, `ProjectBar`, the assignment bars and the drag/resize hooks), `uniqueById.ts` (dedupe the one-row-per-equipment–site-pair `GET /equipment` rows in unfiltered views), `teams.ts` (pure team helpers: `teamsForSite`, `teamIdsWithinSites`, `normalizeTeamFilter`, and the filter predicates `projectMatchesTeamFilter` / `staffMatchesTeamFilter` and, for per-site "no team here = whole site" entities, `equipmentMatchesTeamFilter` / `eventMatchesTeamFilter` / `tagMatchesTeamFilter` over `siteScopedTeamsMatchFilter`), `tags.ts` (pure tag helpers: `tagsForSite`, `groupedTags`, `applyTagSelection` (radio behaviour in single-select groups), `projectPassesTagFilter` (within a group OR, across groups AND, `noneGroupIds` = "no tag from that group", unresolvable ids ignored), `projectBarColor(project, tagById, group)` — the colour of the project's tag in the "Colour by" group, first in group order (`sort_order`, name — the tag Group by files it under), null for no group / no tag; always resolve colour/group through `appStore.tags`/`tagGroups` by id (`indexTags`), never from the inline `project.tags[].color`, which is stale during What-If; also `normalizeSiteTagFilter`, `isTagFilterActive`, `violatesSingleSelect`, `barTextColor`). Note: the Gantt utilities live in `src/components/gantt/utils/`, not here — `autoCalculation.ts`, `completionStatus.ts` (`statusAfterCompletionWrite` — the slider applies the Kanban status locally, since the rich broadcast excludes the sender), `criticalPath.ts`, `dependencies.ts`, `diffProjects.ts`, `projectSections.ts`, `rowPositions.ts` (`calculateRowPositions`, row heights incl. `SECTION_ROW_TOTAL_HEIGHT`) and `timeline.ts` (timeline cells and headers, `calculateBarPosition`, today position / scroll, `centredDayRangeAtX`).

## What-If Mode

A client-side planning sandbox — the server is never aware of it.

- Entering (`WhatIfToggle`, shown with `whatif.use` — admins and superusers by default → `whatIfStore.enterWhatIfMode`) snapshots `appStore.projects` via `structuredClone`; `TenantApp` adds the `what-if-mode` body class while the flag is on.
- While active, the **API client** intercepts every POST/PUT/PATCH/DELETE (exemption list: see Frontend Conventions): the request is queued as a `WhatIfOperation {id, method, url, body?, timestamp}` and a fake success `{success: true, whatIfMode: true, id: Date.now()}` is returned, so optimistic local state updates normally.
- **Discard**: restore the snapshot, drop the queue. **Apply**: temporarily disable the interception check (always restored in `finally`), replay queued operations sequentially with real requests, then reload from the server (`fetchAllProjects()`) and exit. **On the first failure Apply stops**: the failed and remaining operations stay queued, What-If stays **active**, projects are reloaded from the server and the snapshot is reset to that state (so a later Discard restores what really landed), and `whatIfApplyError {applied, total, message}` is set — `WhatIfToggle` shows it as a header banner with **Retry / Discard / Dismiss** (`dismissApplyError`), not an alert. Interception is back on during the post-Apply reload, so edits made in that window are queued and **kept** (appended after the remaining operations; on success What-If stays active with just those). If the stores were reset meanwhile (401 → `expireSession`, logout), Apply leaves them reset.
- Undo history is cleared on enter, Discard and Apply (its snapshots straddle the sandbox boundary); undo/redo *inside* What-If persists through the API client, so it is queued like any edit.
- `loadAllProjects()` is a **no-op during What-If** (returns the local projects) — every "reload after a write" goes through it, so a reload never wipes the sandbox. Use `fetchAllProjects()` when a real fetch is required. Consequently an edit must update the store locally (optimistically, or with `utils/localProjectTree.ts` after the queued call) or it stays invisible until Apply.
- **Gantt-only.** `Header.tsx` renders `WhatIfToggle` only while `currentView === 'gantt'` (or a sandbox is already open). While What-If is active, view switching and the Settings hub are blocked in two layers: store guards (`viewStore.setCurrentView` accepts only `'gantt'`; `uiStore.openSettings`, `setActiveModal('settingsHub')` and the legacy `openModal` settings aliases are no-ops) cover every present or future caller, and `useWhatIfBlocked()` visibly disables the controls with the reason. That covers `Sidebar/Navigation.tsx`, the Kanban deep link in `NotificationBell.tsx`, and every Gantt-reachable entry point: `AdminSection`, `TagPicker` "Manage tags…", and the embedded Staff view's `BankHolidaysRow` / `CompanyEventsRow`. The Delete buttons in `EquipmentPanel`/`UsersPanel` are disabled too (their bookings are plan data), and so are the holiday/event deletes in the embedded rows (calendar data is not in the snapshot, and the refetch after a queued delete would resurrect the row). Nothing is auto-discarded. Keep new navigation or Settings entry points behind the same hook.
- **Creates are blocked during What-If** (a queued POST has no server id, and the new item could only appear after Apply): Phase/Subphase/Project dialogs and the Assignment dialog in create mode, absences (`VacationModal`, `MyAbsencesModal`), equipment blocks (`EquipmentBlockModal`), Kanban "add assignee"/"join", resource drops on the timeline and the context-menu "Add …"/"Assign …"/"Assign me" items are disabled via `useWhatIfBlocked()` / `whatIfUnavailableMessage()` (same wording as the import dialogs). Edits and deletes stay allowed, except holiday/event deletes in the Staff view rows (not snapshotted).
- Project and custom-column WebSocket refreshes are deferred until What-If ends (see Real-Time Collaboration).
- Implications for new code: any new write endpoint is queued by default (see Frontend Conventions); operations that depend on real server responses (created IDs used by later operations) do not work correctly inside What-If — the queue replays with the original bodies. New create entry points must be blocked the same way.
- Known limitations: MPP import uploads via a raw `fetch` that bypasses the queue, so `ImportProjectModal` blocks importing while What-If is active. `.ics` calendar imports (`ICSImportPanel`: holidays, events, absences) are blocked too — calendar data is not part of the What-If snapshot. Custom-column *definition* changes are queued but live in `customColumnStore`, which is not snapshotted — a definition created/deleted during What-If is not rolled back locally on Discard (reload to resync). Configuration edits (tags, tag groups, absence types, skills, equipment types, phase templates, users, site and equipment definitions — see the exemption list in Frontend Conventions) bypass the queue entirely; the Settings hub and the equipment/user Delete buttons are unreachable during What-If, so a cascading delete (site → projects, equipment → bookings, user → assignments) cannot desync the sandbox from the UI — a delete issued another way (another tab, the API) still does, and the deferred refresh resyncs once What-If ends. A queued project edit that holds two tags of a group an admin makes single-select meanwhile fails on Apply with the backend 400 (Retry cannot fix it — Discard that edit). Own bookings stay queued: a queued own edit or removal whose key is in approval mode looks applied in the sandbox, and on Apply the server answers 202 and files an approval request instead (no "needs approval" hint is shown before Apply). Roles, approval policies, approval decisions and todos are exempt (see Frontend Conventions); Approve / Reject / Cancel request and **New task** are disabled while What-If is active, because the post-decision reload is a no-op there.

## Import & Export

### Site Export to Excel

- Endpoint: `GET /t/{slug}/api/export/site/{site_id}/excel` (`sites.export` — superusers and admins by default — and the site must be visible).
- Implemented in `app/routers/export.py` — `build_site_export_workbook()` generates a multi-sheet `.xlsx` via `openpyxl`.
- Current sheets: Site, Projects (hierarchy with phases/subphases), Users, Teams (the site's teams with member count), Team members, Equipment (with Sites and Teams columns), Skills, User skills, Tags (those applicable to the site, with Group / All sites / Sites / Teams columns), Tag groups, Project tags (with Group), Project teams, Absence types, Vacations (with Type / Type ID columns), Project assignments, Phase assignments, Subphase assignments (each with Approval status / Pending change columns), Approval requests, Equipment assignments, Custom columns, Custom column values, Bank holidays, Company events (selected via `company_event_sites`, with Sites, Staff unavailable and Teams columns), Equipment blocks, Staff notes, Card comments (the Projects sheet also carries a `Kanban status` column). Notifications (and personal todos) are deliberately excluded — transient per-user inbox state, not site content.
- **IMPORTANT**: any new data added at the site level through future enhancements (e.g. equipment maintenance/blocks, new event types, additional site-scoped settings, new assignment kinds, etc.) **must** be added as a new sheet (or a new column on the existing sheet) in `build_site_export_workbook()`. The site export is the canonical "everything for this site" snapshot — do not let it drift behind the model. Teams columns list only the entity's teams **at the exported site** (empty = the whole site).

### MS Project & CSV

- **MPP import** (`app/routers/mpp_import.py`) parses `.mpp` files via `jpype1` + `mpxj` — requires a JVM. The Docker image includes `default-jre-headless`; local dev environments usually don't. `GET /import/mpp/test` verifies the toolchain.
- **MPP/CSV export** (`app/routers/export.py`) exports single projects server-side; the frontend also generates MS-Project-compatible CSV (`utils/csvExport.ts` — outline levels, `ID{FS|SS|FF|SF}±lag` predecessor syntax, % complete, milestones) and MS Project XML (`utils/xmlExport.ts`) client-side.

## Security

- **Startup/runtime**: the lifespan calls `Settings.check_startup_security()` — with `DEBUG=false` an empty or published `SESSION_SECRET` (`INSECURE_SESSION_SECRETS`) is a `RuntimeError`, so the app does not start; docs endpoints gated on `system.api_docs`; global exception handler returns opaque 500s; `/health` and the tenant 503 never echo DB hosts/users/SQL; Docker runs as non-root `appuser` with a `/health` healthcheck.
- **Secrets at rest**: tenant DB passwords, org SSO secrets **and tenant-level SSO secrets** (`sso_config.client_secret`, since 1.5.0; legacy plaintext encrypted by the tenant auto-migration) AES-256-GCM encrypted (`app/services/encryption.py`); `TENANT_ENCRYPTION_KEY` (64-char hex) required in multi-tenant mode (single-tenant derives a key from `SESSION_SECRET`).
- **Passwords**: bcrypt rounds=12 (tenant users, lazy upgrade from legacy hashes on login, > 72 bytes rejected); PBKDF2-SHA512 600 000 iterations, self-describing `pbkdf2_sha512$…` (admin users, lazy upgrade from legacy `salt:hash`). Minimum 8 characters for new/changed passwords in both systems; existing shorter passwords still log in.
- **Login throttle** (`app/services/login_throttle.py`): sliding window, 10 failures / 15 min per (scope, client IP, e-mail) → 429 with `Retry-After`; success clears the key; plus a per-IP bucket (100 failures / 15 min across scopes and e-mails, **not** cleared by a success) that only applies to *global* addresses — private/loopback/CGNAT ones may be a shared proxy or NAT, where it would be a site-wide lockout switch; ≤ 10 000 tracked keys per bucket. The lockout is per (IP, e-mail), so behind a reverse proxy `FORWARDED_ALLOW_IPS` must list the proxy or every client shares one key. **In-memory and per process** — N workers allow N × 10. Unknown e-mails run a dummy hash (`dummy_verify_user_password` / `dummy_verify_admin_password`) so timing doesn't reveal accounts.
- **Admin portal**: `must_change_password` is enforced server-side (403 from `get_current_admin`).
- **Sessions**: HTTP-only cookies; `SECURE_COOKIES=true` for HTTPS deployments; expired-session cleanup in `SessionService`; every request re-checks `active`, `role` and the role's permissions; revocation (deactivate/delete/demote/password reset) destroys sessions and closes WebSockets.
- **WebSocket**: `Origin` checked against the host / CORS origins (close 4003) — cross-site WebSocket hijacking guard; `/api/ws-debug*` gated on `system.ws_debug`.
- **SSO**: HMAC-signed state bound to the browser by the `sso_nonce` cookie (one-time, 10 min); only a validated `AADSTS` code from Microsoft ever reaches a user, Entra's own error text is never reflected; secrets never returned unmasked (`/sso/config/full` masks; a masked value submitted back keeps the stored secret on every write route); optional Entra group gating per tenant.
- **Multi-tenant isolation**: a tenant request without a pool is a 503, never the `DB_*` database; tenant status/edit/delete changes reset the tenant cache and pool on the handling process.
- **Provisioning**: tenant identifiers validated against SQL injection in `tenant_provisioner`.
- **Authorization**: every tenant route gates on a catalogue key (`require_permission*`, the access services) and on the live visible sites; the admin role cannot be edited or deleted and is the only one holding `roles.manage`, so nobody can lock the tenant out; role assignment is capped by the escalation guard (`user_access.py`) and the last active admin is protected.
- ⚠ `GET /settings` and `GET /settings/{key}` have no auth dependency — never store sensitive values in the tenant `settings` KV table.
- ⚠ `/health` is public and includes the backend identifier and `default_tenant` in its response — don't add further config values to it.

## Docker & Deployment

**Dockerfile** (3 stages):
1. `builder` (`python:3.11-slim-bookworm` + libpq-dev/gcc/g++) — pip-installs `requirements.txt` to `/install` (g++ needed for `psutil`/`jpype1` source builds).
2. `frontend` (`node:24-alpine`) — `npm ci && npm run build` in `/build/frontend`, with the repo-root `shared/` copied beside it to `/build/shared` (the Vitest permission-catalogue mirror test imports `shared/permission-keys.json`, and `tsc -b` type-checks it).
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

- **Path-filtered.** Each of the three starts with a `Detect Changes` job (`dorny/paths-filter@v3` in **git mode** — `token: ""`, `base` = the PR's base branch — because the REST API mode silently treats files past its 3000-file limit as unchanged). Every other job `needs: changes` and runs only when its filter matched: backend = `app/**`, `tests/**`, `requirements*.txt`, `pyproject.toml`, `migrations/**`, `shared/**`, `VERSION`; frontend = `frontend/**`, `shared/**`; docker = everything the image `COPY`s (`Dockerfile`, `.dockerignore`, `docker-entrypoint.sh`, `requirements.txt`, `app/`, `frontend/`, `shared/`, `migrations/`, `VERSION`, `public/`). `shared/permission-keys.json` is written by the backend catalogue test and read by the Vitest mirror test, so it re-runs all three. **A change to a workflow file re-runs that whole workflow.** The outputs are compared with `== 'true'` — paths-filter emits the *string* `'false'`, which is truthy, so never shorten them to `a || b`. The `Audit` jobs use `!cancelled() && (schedule || changed)` so the cron still runs them while `changes` is skipped. A workflow-level `concurrency` group cancels superseded PR runs, never `main` pushes (they publish the badges).
- **Sharded tests.** Backend tests run as 3 `Tests (shard K/3)` jobs (`pytest --shard=K/3 --cov=app --cov-report= --cov-fail-under=0`, each uploading its `.coverage` as `coverage.shard-K`); frontend tests as 2 `Tests (shard K/2)` jobs (`vitest run --shard=K/2 --reporter=blob --coverage.enabled` with the thresholds zeroed, uploading `.vitest-reports/`). An aggregate **`Tests`** job per workflow fails unless every shard passed, checks that every shard's artifact arrived, then combines (`coverage combine` / `vitest run --merge-reports --coverage.enabled`) and enforces the suite floors, writes the summary, runs diff-cover on PRs and hands the badge total on `main`. Per-shard runs never gate on coverage. **Only the aggregate `Tests` job is the one to require in branch protection — the shard jobs need no rule of their own** (it runs even when a shard failed, via `!cancelled()`, so it fails instead of being skipped). The `matrix` is the **only** place the shard count is set: `strategy.job-total` carries it into the job names, the commands and the aggregate's count check.

| Workflow | Jobs / enforcement |
|----------|--------------------|
| `backend.yml` | `pip-audit --strict` over `requirements*.txt` (**blocking**); ruff check + format check on `app/`; pytest in 3 shards + aggregate `Tests` with the combined coverage — the `fail_under` floor, a per-file table + `::notice` total in the job summary, and on PRs **diff-cover ≥ 80 %** on changed lines; mypy; on push to `main`, a `Coverage Badges` job publishes `backend.json` |
| `frontend.yml` | eslint; vitest in 2 shards + aggregate `Tests` with the merged coverage — the `coverage.thresholds` floors, a summary table + `::notice` total, and on PRs **diff-cover ≥ 80 %** on changed lines; `npm run build` (tsc + vite); `npm audit --audit-level=moderate` (**blocking** — see below); on push to `main`, a `Coverage Badges` job publishes `frontend.json` |
| `docker.yml` | `docker build` of the production image (only when an image input changed) |
| `version-check.yml` | PRs to `main` only: `dorny/paths-filter` on app-code paths → fails the PR unless `VERSION` changed vs the PR's **base commit** (not the live `main`, so a race with a merge cannot false-fail) **and** `CHANGELOG.md` has a matching `## [<version>]` heading; its paths-filter runs in git mode like the other three |

The README coverage badges are shields.io endpoint badges reading `backend.json` / `frontend.json` from the orphan **`coverage`** data branch. Only the two `Coverage Badges` jobs write it (push to `main`, `contents: write`, one shared `coverage-badges` concurrency group, `[skip ci]` commits, each job touching only its own file) — never commit to it by hand.

Docs are **not** built by Actions — Cloudflare Pages builds them from `docs/build.sh` on push. There are no issue or PR templates in `.github/` (only `FUNDING.yml`).

**Both `Audit` jobs are blocking, and a new advisory can turn them red on a PR that didn't touch dependencies.** That is intended. On the backend, fix the pin in `requirements*.txt`; if a finding is genuinely unexploitable here, a `--ignore-vuln` flag with an explanatory comment in `backend.yml` is the sanctioned escape hatch. On the frontend, the audit is the only check that notices when a pin in `frontend/package.json`'s `overrides` block has gone stale, which happens silently whenever a *newer* advisory widens the affected range of an already-pinned package — the block currently holds ~8 transitive security pins (note the scoped `"minimatch@3"` syntax, which overrides only the v3 range). When it fires, fix the pin rather than lowering the threshold; `--audit-level=moderate` was chosen deliberately (the advisories that originally motivated the job were moderate). If a finding is genuinely unreachable (dev-only tooling, no patched release available) and blocking is unacceptable, prefer a scoped, commented `overrides` entry over relaxing the gate.

## Gotchas

- The master and tenant databases use **separate SQLAlchemy Base classes** (`MasterBase` vs `Base`). Don't mix them.
- `setup_databases.sql`, the provisioner schema (`tenant_provisioner.get_tenant_schema_sql()`), and `scripts/sql/tenant_schema_template.sql` must all stay in sync with the models — follow the schema-change checklist.
- The `Note` model's tablename is **`staff_notes`**. All schema sources create `staff_notes` now; databases from old installs may carry a legacy `notes` table until `migrations/add_staff_notes.sql` or the tenant auto-migration runs (it migrates the rows and drops `notes`).
- Presence is WebSocket-only — there is no HTTP presence API (a dead, never-registered presence router and its `usePresence` polling hook were removed).
- `PUT/DELETE /equipment-assignments/{id}` live in `equipment.py` only (the shadowed duplicates in `assignments.py` were removed); `POST /projects/{id}/equipment` stays in `assignments.py`.
- Per-entity write rules (PM bundle, self-booking) live in `app/services/project_access.py` and `app/services/approvals.py`, Kanban's assignee-may-move rule in `app/services/card_access.py`. They read `user.id` and `user.permissions` (a `PermissionSet`) or take primitives, because `get_current_user` usually returns a `SessionUser`, not an ORM `User`. Check them *after* loading the entity, with the server-derived `project_id` — never trust a `project_id` from the request body.
- Tenant info: `TenantMiddleware` writes a plain dict into `scope["state"]`. `request.state.tenant_slug` works in HTTP handlers (Starlette wraps the dict), but code handling raw ASGI scopes must read `scope["state"]["tenant_slug"]` directly.
- The Vite dev server (:3333) has **no API proxy** — the client targets `:8485` directly, so the backend must be running; full tenant/WS behaviour is best tested on `:8485` with the built frontend.
- `run_migration_master.py` handles `DO $$ ... END $$;` blocks correctly (`split_sql_statements()`, tested in `tests/test_migration_parser.py`) — but keep migrations idempotent regardless.
- MPP file import requires Java (JRE 11+), included in the Docker image but not in dev environments by default.
- The User model has a `full_name` property — use it instead of manual `first_name + last_name` concatenation.
- Middleware must be **pure ASGI** — `BaseHTTPMiddleware` breaks WebSocket connections (this is why a timing middleware was removed).
- Zustand persistence: Sets serialize as arrays with custom `merge` restore; don't persist Maps (`appStore` holds `criticalPathItems` and `closureIndex` Maps that are deliberately excluded from `partialize` — keep it that way).
- New backend write endpoints are What-If-queued and coarse-broadcast by default — check both the client exemption list and `BroadcastMiddleware.SKIP_PATTERNS` when that's wrong for your endpoint.
- **Rotating `SESSION_SECRET` in single-tenant mode invalidates the stored tenant SSO client secret** (its encryption key is derived from it): SSO then reports "not configured" until an admin re-enters the secret in Settings → SSO. Same for changing `TENANT_ENCRYPTION_KEY` in multi-tenant mode (which also breaks tenant DB credentials).
- The login throttle, `disconnect_user` and the tenant cache/pool reset are all **per process**: with several uvicorn workers the throttle limit multiplies, a revoked user's socket on another worker stays open until it drops (HTTP is already rejected), and other workers see tenant changes within the 60 s cache TTL.
- WebSocket close code **4003** means both "origin not allowed" and "user disabled"; the client treats it like 4001 (re-check the session, no reconnect).
- `change:note` and `change:card_comment` map to **no** refetch slice on purpose (nothing in the stores holds notes; comment threads fetch themselves). Don't "fix" them to refresh everything.
- `GET /vacations?siteId=` needs `absences.view_others` and a visible site (it used to return any site's absences to anyone).
- **The permission catalogue has a frontend mirror.** Adding, renaming or removing a key in `app/services/permissions.py` means regenerating `shared/permission-keys.json` (`tests/test_permissions_catalogue.py` prints the command when it is stale) and updating `frontend/src/types/permissions.ts` plus the role defaults in `frontend/src/test/permissionFixtures.ts` (`permissions.catalogue.test.ts` compares them). A new tenant-wide default also needs a seed: the defaults are written only when a role row is created (`build_default_role_permissions_sql()`), so existing tenants get a new key as **deny** unless a data migration grants it.
- **`users.role` is a foreign key to `roles.key`** (`ON UPDATE CASCADE`, `ON DELETE RESTRICT`): a role held by users cannot be deleted (409), and a role's key never changes.
- **Pending bookings are real rows.** Anything that sums allocations or lists assignees must skip `approval_status = 'pending'` (backend: availability, `card_access`, `card_assignee_ids`; frontend: `isPendingAssignment` in the workload, availability, resource cards, due reminders, cascades and undo diffs).
- **`MASTER_DB_NAME` defaults to `milestone_master`** in the app and the migration runners alike (`tests/test_follow_up_defaults.py` keeps them equal), but `docker-compose.fresh.yml`, the devcontainer and the admin docs use `milestone_admin` — existing volumes hold a database of that name, so those deployments keep setting it explicitly.
- **Notification rules live in `app/services/notifications.py`**, not in routers: the actor never notifies themselves, one row per recipient per event (priority mention > approval_requested > approval_decided > assigned > todo_assigned > status_change > comment), and rows are staged before the caller's commit so a notification lands in the same transaction as the change that caused it.
- **Nager v3/v4** (`app/services/holidays.py`): the version is read from the last segment of `NAGER_API_URL` (anything unrecognised is treated as v4 with a warning); v3 logs its 2027-01-31 end-of-life warning when fetching; only `public`/`bank` holidays are stored (entries without a type are kept), so school or observance days never reduce capacity.
- **The proxy settings are not symmetric**: PAC, proxy credentials, `PROXY_CA_CERT` and `PROXY_VERIFY_SSL` reach only the Nager import. SSO token exchange, Graph and the org SSO test use plain `httpx` clients that honour only the process `HTTP(S)_PROXY` variables.
- There are no `SSO_*` environment variables (the dead settings were removed in 1.6.2; an old `.env` that still sets them is ignored). Configure SSO in-app: tenant Settings → SSO, or organization SSO in the admin portal.
