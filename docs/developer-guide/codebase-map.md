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
- Docs endpoints (`/api/docs`, `/api/redoc`, `/api/openapi.json`) require an authenticated tenant user holding `system.api_docs` (admins by default).
- A global exception handler returns an opaque 500 (no stack traces to clients).

## Terminology

- **Tenant** — an isolated customer workspace with its own PostgreSQL database (`milestone_<slug>`), reached at `/t/{slug}/`. Managed from the admin portal.
- **Site** — a physical location *within* a tenant (labs/offices). Most data (projects, equipment, holidays, events) is site-scoped; users belong to one or more sites via `user_sites`, equipment via `equipment_sites`, company events via `company_event_sites`. **Sites scope access**: without `sites.view_all` (admin-only by default) a user reads and writes only the data of their *visible sites* (their live `user_sites`), see [Tenant role model](auth-and-tenancy.md#tenant-role-model).
- **Organization** — a master-DB grouping of tenants that share one Microsoft Entra SSO configuration.
- **Tenant role** (`users.role`, FK → `roles.key`) — a named **permission set**: one mode per catalogue key (`allow`, `approval` on the three own-booking keys, or deny). Three system roles are seeded — `admin` (every key, in code; not editable), `superuser` and `user` (editable defaults reproducing the pre-1.13 behaviour) — and admins add custom roles in Settings → Roles. See [Tenant role model](auth-and-tenancy.md#tenant-role-model).
- **Permission key** — one entry of the catalogue in `app/services/permissions.py` (58 keys, 17 groups), e.g. `projects.create`, `sites.view_all`. Locked: `projects.view` (always allow) and `roles.manage` (admin only). The **PM bundle** is the 6 keys a holder of `projects.manage_as_pm` gets on the projects whose `pm_id` they are.
- **Visible sites** — the sites a user reads and writes: every site with `sites.view_all`, otherwise their live `user_sites`.
- **Approval request** — an own booking (`assignments.self_*` in approval mode) waiting for an approver; its pending create is a real assignment row with `approval_status = 'pending'`.
- **My Work** — the per-user view replacing My Todos (2.0.0; personal tasks were removed): **My Approvals** (requests the user may decide), **My Assignments** (their approved bookings, derived client-side) and **My Requests** (their own requests).
- **Comment thread** — the comments of one Kanban card (phase/subphase), shared by the Kanban card dialog and the booking dialog of that card, or of one project (`entity_type = 'project'`, the thread of its project-level bookings); `card_comments` holds both.
- **Admin-portal roles** (`admin_users.role`): `superadmin` > `admin`. These are master-DB accounts for the `/admin` portal, completely separate from tenant users. Don't confuse tenant `admin` with portal `admin`.
- **Phase / Subphase** — projects contain phases; subphases nest recursively under phases or other subphases (`parent_type` = `phase`|`subphase`, with `depth`).
- **Equipment block** — maintenance/unavailability window on equipment (the equipment analogue of a vacation).
- **Site closure** — a company event with `counts_as_unavailable = true`: every staff member on one of the event's sites is unavailable for its dates (like an unavailable absence). Plain events and bank holidays never reduce capacity.
- **Tag** — a coloured project label, tenant-wide but optionally limited to some sites (`all_sites` + `tag_sites`) and teams (`tag_teams`), ungrouped (tag groups became project fields in 2.0.0). Admin-managed in Settings → Tags; attaching is part of editing a project.
- **Project field** — a field on every project, instance-wide: `text` (≤ 2000 chars), `number` (optional `decimals` 0–3: new values rounded half-up on write, mirrored by `roundFieldNumber`), `toggle`, `select` (one item) or `multiselect`; dropdown *items* (`project_field_options`) are coloured, ordered and limited to sites/teams like tags. Values live in `project_field_values` (text/number/toggle) and `project_field_selections` (items); none is required. The four **built-in fields** (Customer, Sales PM, Volume, Confirmed — `projects` columns) can be renamed and the first three hidden (settings `project_field_labels` / `project_fields_hidden`); Confirmed is never hidden (it drives stripes, ordering and counts). Managed in Settings → Project fields (`project_fields.manage`); filled in the project dialog. Any user filters (*Filter*), groups (*Group by*, dropdown fields) and colours (*Colour by*, dropdown fields or *Tags*) the Gantt by them — per-browser preferences, not field settings.
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
  permission-keys.json # Committed mirror of the permission catalogue ({keys, approvable, pm_bundle, disableable}),
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
    tag.py             # Tag (all_sites, sort_order, sites M:N), TagSite, ProjectTag (no groups since 2.0.0)
    project_field.py   # ProjectField (field_type, options), ProjectFieldOption (sites/teams M:N),
                       #   ProjectFieldValue, project_field_selections; PROJECT_FIELD_TYPES / DROPDOWN_FIELD_TYPES
    team.py            # Team (per site, name unique per site, active), TeamMember, ProjectTeam,
                       #   TagTeam, CompanyEventTeam, EquipmentTeam — every FK cascades
    card_comment.py    # CardComment — Kanban card comments, polymorphic (entity_type, entity_id),
                       #   mentioned_user_ids derived from the body
    notification.py    # Notification — per-recipient inbox (due-soon/overdue are derived client-side)
    rbac.py            # Role, RolePermission, ApprovalPolicy, ApprovalPolicyRole, ApprovalRequest
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
    kanban.py          # Card status moves, assignees, comment threads (cards and projects, + @-mentions),
                       #   comment counts, mentionable users — the board itself has no read endpoint
    mpp_import.py      # Microsoft Project file import (requires Java)
    notes.py           # Staff notes
    notifications.py   # Own inbox only (list, unread count, mark read) — no user_id parameter
    predefined_phases.py # Phase template management
    projects.py        # Project/phase/subphase CRUD + reorder (+ project field_values)
    project_fields.py  # Project fields + dropdown items CRUD, reorder, usage (writes: project_fields.manage)
    roles.py           # GET /permissions (the catalogue for the matrix) + role CRUD (writes require_admin)
    settings.py        # Instance settings (KV; known keys validated, see Settings keys) + tenant SSO settings
    sites.py           # Sites, bank holidays (edit, .ics import, Nager refresh), multi-site
                       #   company events (/events routes + legacy /sites/{id}/events)
    skills.py          # Skills + user-skill assignment
    staff.py           # Staff read endpoints (staff are users; created via /users)
    tags.py            # Project tag CRUD + reorder (writes: tags.manage; read for everyone)
    teams.py           # Team CRUD + members (writes: teams.manage at visible sites; read for everyone)
    users.py           # User management
    vacations.py       # Vacation/absence CRUD + bulk import (/vacations/import)
  schemas/             # Pydantic request/response schemas (one file per domain;
                       #   base.py holds Node-compatible serializers + DateRangeOrdered;
                       #   project_field.py the field / item bodies; project.py carries field_values;
                       #   TagCreate / TagUpdate are extra="forbid", so a stale group_id is a 422;
                       #   sso.py the SSO test request/response shared by org and tenant tests)
  services/
    approvals.py       # Own-booking approval workflow: submit_request (202), resolve_row_write,
                       #   plan_placement / apply_shrink (auto-placed second booking), approve / reject / cancel, approver_user_ids / can_decide (live),
                       #   expire_overtaken / cancel_for_entity hooks, publish (broadcast + pushes)
    auth.py            # Shared admin-session validation
    card_access.py     # require_card_status_write: kanban.move_any, or an approved assignee
    card_status.py     # apply_status / apply_completion — the only writers of status/completion
                       #   (mirrored in frontend/src/utils/kanbanCards.ts)
    booking_segments.py # fit_segments_to_card / segments_overlap / effective_dates — how unlinked
                       #   card bookings follow their card (mirrored in frontend/src/utils/bookingSegments.ts);
                       #   place_booking — where a dateless second booking goes (server-only, no mirror)
    change_notifications.py # assignment_changed / project_changed: ChangeIntent builders +
                       #   deliver() after the caller's commit (advisory lock, 10-min coalescing)
    demo_seed.py       # insert_demo_data(conn, demo, admin_password_hash=…): the guarded
                       #   names→ids loader of the demo set, shared by seed_demo and the admin
                       #   portal's "Seed demo data" provisioning option
    date_range.py      # parse_day / parse_day_range (400 on bad/inverted/>366-day ranges),
                       #   ensure_date_order (422) for partial updates
    encryption.py      # AES-256-GCM credentials + bcrypt/PBKDF2 password hashing
    holidays.py        # Nager API client (v4, legacy v3 auto-detected), parsing, region matching
    instance_settings.py # KNOWN_SETTINGS (admin defaults + feature switches): canonicalise (422),
                       #   defaults, is_enabled / flag_enabled, FLAG_DISABLES. Import-light
    login_throttle.py  # In-memory, per-process failed-login throttle (tenant + admin portal)
    master_db.py       # Master DB singleton: init, idempotent auto-migrations,
                       #   verify_admin_exists() (auto-creates admin@milestone.local)
    mentions.py        # @[Name](id) mention tokens: parse_mention_ids / strip_mention_tokens
                       #   (mirrored in frontend/src/utils/mentions.ts)
    notifications.py   # Notification rows for Kanban and approval events (actor excluded,
                       #   one per recipient, priority order; the change notifications live in
                       #   change_notifications.py)
    permissions.py     # The permission catalogue (PERMISSIONS, APPROVABLE_KEYS, PM_BUNDLE, LOCKED_KEYS,
                       #   SYSTEM_ROLES, DISABLEABLE_KEYS, default seed SQL, permission_keys_json) +
                       #   PermissionSet / load_permission_set / effective_permission_set (per-request
                       #   resolution, feature switches applied). Import-light: no models
    project_field_rules.py # Item scoping (option_applies_to_site/_project), the item 409 counters,
                       #   count_projects_using_field, validate_field_values / apply_field_values /
                       #   load_project_field_values (the project field_values read/write path)
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
    sso_test.py        # Entra diagnostic (local checks, outbound proxy, discovery, client-credentials
                       #   token) shared by the organization and tenant SSO test routes
    tag_rules.py       # validate_project_tags (site / team applicability → 400) and the conflict
                       #   counters behind the 409s of tag edits (generic linked-project counters
                       #   shared with project_field_rules)
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
                       #   (per-user approval:changed pushes)
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
      endpoints/       # absenceTypes, admin, auth, customColumns, equipment (incl. getEquipmentTypes),
                       #   projects (transform layer), settings (INSTANCE_SETTING_KEYS / _DEFAULTS),
                       #   sites, skills, staff, tags, projectFields (projectFieldsApi), teams, users,
                       #   vacations, roles
                       #   (rolesApi), health (getAppVersion), importChunks (postInChunks), kanban,
                       #   notifications, approvals (approvalsApi, isPendingResponse), mentionableCache
                       #   (the @-mention list per site for the session), sso (testTenantSSOConfig,
                       #   SSOTestResult — re-exported by admin for the organization test)
    components/
      __tests__/       # rawFormControls.test.ts (+ rawFormControlsAllowlist.json): raw <input>/<select> ratchet
      admin/           # AdminApp, AdminLoginScreen, AdminDashboard, TenantList, OrganizationList,
                       #   AdminUserList, SystemStatsPanel + modals/ (Create*/…DetailsModal,
                       #   CredentialsModal — standalone, useEscapeKey, no overlay close)
      gantt/           # GanttContainer, ProjectPanel/ (ProjectRow → PhaseRow → SubphaseRow →
                       #   AssignmentRow + CardBadge, SectionRow, GroupBy/ColorBy dropdowns over
                       #   FieldChoiceDropdown), Timeline/ (bars, DependencyLayer, phantom
                       #   overlays, ResourceDropOverlay), CustomColumns/, CompletionSlider/,
                       #   ShiftTooltip/ (Shift-hover date tooltip), ContextMenuContainer.tsx,
                       #   utils/ (autoCalculation, completionStatus, criticalPath, dependencies,
                       #   diffProjects, projectSections, rowPositions, timeline)
      views/           # StaffView (workload heatmap), EquipmentView, CrossSiteView, ArchivedView,
                       #   KanbanView/ (KanbanView, KanbanBoard, KanbanColumn, KanbanCard, KanbanToolbar),
                       #   WorkView/ (My Work: WorkView tabs, ApprovalRequestRow + MyRequestRow, MyAssignmentRow, CardLink)
      screens/         # LoginScreen, LoadingScreen, LoadErrorScreen (initial load failed → Retry)
      settings/        # Settings hub: SettingsHub.tsx (shell), sections.tsx (SETTINGS_SECTIONS
                       #   registry: group/id/label/permission/Panel, canOpenSettings), PanelToolbar.tsx,
                       #   types.ts, useReportDirty.ts, panels/ (General, Defaults (Features &
                       #   defaults), Roles (RolesPanel + RoleForm, PermissionMatrix, ApprovalPoliciesForm),
                       #   Sites, Teams, BankHolidays,
                       #   CompanyEvents, Users, Skills, AbsenceTypes, Equipment, EquipmentTypes,
                       #   PredefinedPhases, ProjectFields, Tags, SSO + helpers ColorSwatchPicker, SiteChecklist,
                       #   SiteForm, TeamForm, TeamScope, calendarUtils, useDragReorder)
      modals/          # ModalContainer (lazy) + dialogs: Project/Phase/Subphase, Assignment
                       #   (Staff/Equipment), EquipmentBlock, KanbanCardModal, TagPicker
                       #   (over common/OptionPicker), ProjectFieldInputs (the dialog's fields),
                       #   ManageSettingsLink ("Manage tags…" / "Manage fields…"),
                       #   CustomColumn(+sManager), ImportProjectModal, MyAbsencesModal,
                       #   VacationModal, VacationICSImport, AbsenceTypeSelect
      common/          # Icon/ (Icon wrapper + icons.ts, the app's Material icon set, IconStyles),
                       #   Button, Input, Select, ToggleSwitch, Modal, ContextMenu, OnlineUsers,
                       #   ActivityFeed, NotificationBell, MentionTextarea (+ MentionText),
                       #   ProjectFilterDropdown (the Gantt/Kanban Filter), OptionPicker (coloured-item
                       #   combobox), MultiSelectDropdown (multi-select field dropdown; `searchable` for team
                       #   members), SearchableSelect (single pick with a focused search box: every people
                       #   picker) + dropdownShell (shared shell CSS, filterOptions, useListboxNav), AnchoredPanel
                       #   (portaled, trigger-anchored dropdown panel), AllocationSlider, OverlapWarningIcon,
                       #   Notice (the one inline error/warning/info box, role alert/status),
                       #   ICSImportPanel (shared .ics preview/import, 5 MB cap),
                       #   ConfirmDialog (the one confirm host, fed by utils/confirmDialog.ts),
                       #   SSOTestResult/ (SSO test checks; Settings → SSO and the admin org modal),
                       #   RoleChecklist, PendingBadge, ApprovalActions (+ RejectRequestDialog),
                       #   CardComments/ (one comment thread: list, MentionTextarea composer, own guard;
                       #   in KanbanCardModal and, after the form, in AssignmentModal),
                       #   DateRangeField/ (DateRangeField + DateField on one react-day-picker
                       #   calendar panel, DatePickerPopover, dateRangeLogic click rules),
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
    hooks/             # useAuth, useDataLoader, useWebSocket, useDragAndDrop, useProjectFilter,
                       #   useTeamFilter, useCan, useVisibleSites, useAllowedViews, useRoles,
                       #   useApprovalPolicies, useHeaderDensity, useDerivedDueNotifications, … (see frontend-architecture.md → Hooks catalog)
    utils/             # date, storage (STORAGE_KEYS, themes, project order), csvExport,
                       #   confirmDialog (confirmAction / setConfirmHandler),
                       #   xmlExport, ics, recurringVacation, siteClosure, permissions, tags, projectFields,
                       #   projectFilters,
                       #   kanbanCards, mentions, equipmentOverlap, subphaseUtils, persistFailure,
                       #   reorder, localProjectTree, whatIf, uniqueById, touchEvents, teams,
                       #   roles, pendingBookings (+ assignmentLock), myAssignments, relativeTime, themeColors, colorSwatches, projectLevels,
                       #   instanceSettings (parseIdList / parseNameList / isSettingOn / ganttDefaultPanel /
                       #   builtInFieldLabel / isBuiltInFieldHidden / volumeDecimals)
                       #   (criticalPath/diffProjects/dependencies/completionStatus live in
                       #   components/gantt/utils/)
    styles/            # global.css, variables.css (design tokens), themes/themes.css,
                       #   __tests__/cssTokens.test.ts (every var(--x) read is defined)
    test/              # setup.ts (Vitest setup), factories.ts (make* test builders),
                       #   permissionFixtures.ts (role defaults, asSignedIn, makeCatalogue),
                       #   confirmDialog.ts (stubConfirm / restoreConfirm for confirmAction),
                       #   datePicker.ts (pickRange / pickDate / dateValue for the date fields)
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

- Endpoint: `GET /t/{slug}/api/export/site/{site_id}/excel` (`sites.export` — superusers and admins by default — and the site must be visible).
- Implemented in `app/routers/export.py` — `build_site_export_workbook()` generates a multi-sheet `.xlsx` via `openpyxl`.
- Current sheets: Site, Projects (hierarchy with phases/subphases), Users (with a Bookable column), Teams (the site's teams with member count), Team members, Equipment (with Sites and Teams columns), Skills, User skills, Tags (those applicable to the site, with All sites / Sites / Teams columns), Project tags, Project teams, Project fields (all fields: ID, Name, Type, Decimals, Sort order), Project field options (the items applicable to the site, with Field / Color / All sites / Sites / Teams at the site), Project field values (one row per project and field with a value; items joined by ", ", toggles Yes/No, numbers rounded to the field's decimals), Absence types, Vacations (with Type / Type ID columns), Project assignments, Phase assignments, Subphase assignments (each with Approval status / Pending change columns; the phase/subphase sheets also Start / End (effective) / Linked), Approval requests, Equipment assignments (with a Note column), Custom columns, Custom column values, Bank holidays, Company events (selected via `company_event_sites`, with Sites, Staff unavailable and Teams columns), Equipment blocks, Staff notes, Card comments (project threads too, Card type `project` with the project id; the Projects sheet also carries a `Kanban status` column). Notifications are deliberately excluded — transient per-user inbox state, not site content.
- **IMPORTANT**: any new data added at the site level through future enhancements (e.g. equipment maintenance/blocks, new event types, additional site-scoped settings, new assignment kinds, etc.) **must** be added as a new sheet (or a new column on the existing sheet) in `build_site_export_workbook()`. The site export is the canonical "everything for this site" snapshot — do not let it drift behind the model. Teams columns list only the entity's teams **at the exported site** (empty = the whole site).

### MS Project & CSV

- **MPP import** (`app/routers/mpp_import.py`) parses `.mpp` files via `jpype1` + `mpxj` — requires a JVM. The Docker image includes `default-jre-headless`; local dev environments usually don't. `GET /import/mpp/test` verifies the toolchain.
- **MPP/CSV export** (`app/routers/export.py`) exports single projects server-side; the frontend also generates MS-Project-compatible CSV (`utils/csvExport.ts` — outline levels, `ID{FS|SS|FF|SF}±lag` predecessor syntax, % complete, milestones) and MS Project XML (`utils/xmlExport.ts`) client-side.

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
| `frontend.yml` | eslint; vitest in 2 shards + aggregate `Tests` with the merged coverage — the `coverage.thresholds` floors, a summary table + `::notice` total, and on PRs **diff-cover ≥ 80 %** on changed lines; `npm run build` (tsc + vite); `npm audit --audit-level=moderate` (**blocking** — see [below](#ci)); on push to `main`, a `Coverage Badges` job publishes `frontend.json` |
| `docker.yml` | `docker build` of the production image (only when an image input changed) |
| `version-check.yml` | PRs to `main` only: `dorny/paths-filter` on app-code paths → fails the PR unless `VERSION` changed vs the PR's **base commit** (not the live `main`, so a race with a merge cannot false-fail) **and** `CHANGELOG.md` has a matching `## [<version>]` heading; its paths-filter runs in git mode like the other three |

The README coverage badges are shields.io endpoint badges reading `backend.json` / `frontend.json` from the orphan **`coverage`** data branch. Only the two `Coverage Badges` jobs write it (push to `main`, `contents: write`, one shared `coverage-badges` concurrency group, `[skip ci]` commits, each job touching only its own file) — never commit to it by hand.

Docs are **not** built by Actions — Cloudflare Pages builds them from `docs/build.sh` on push. There are no issue or PR templates in `.github/` (only `FUNDING.yml`).

**Both `Audit` jobs are blocking, and a new advisory can turn them red on a PR that didn't touch dependencies.** That is intended. On the backend, fix the pin in `requirements*.txt`; if a finding is genuinely unexploitable here, a `--ignore-vuln` flag with an explanatory comment in `backend.yml` is the sanctioned escape hatch. On the frontend, the audit is the only check that notices when a pin in `frontend/package.json`'s `overrides` block has gone stale, which happens silently whenever a *newer* advisory widens the affected range of an already-pinned package — the block currently holds ~8 transitive security pins (note the scoped `"minimatch@3"` syntax, which overrides only the v3 range). When it fires, fix the pin rather than lowering the threshold; `--audit-level=moderate` was chosen deliberately (the advisories that originally motivated the job were moderate). If a finding is genuinely unreachable (dev-only tooling, no patched release available) and blocking is unacceptable, prefer a scoped, commented `overrides` entry over relaxing the gate.
