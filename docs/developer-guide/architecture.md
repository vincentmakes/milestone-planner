# Architecture

## Overview

Milestone Planner is a full-stack application with a FastAPI backend serving a React SPA frontend, backed by PostgreSQL with per-tenant database isolation.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Python 3.11+, FastAPI, SQLAlchemy 2.0 (async), asyncpg |
| **Frontend** | React 18, TypeScript, Vite, Zustand, TanStack Query (no client-side router) |
| **Database** | PostgreSQL 15+ |
| **Deployment** | Docker, Docker Compose |
| **CI/CD** | GitHub Actions (dependency audits, lint, test, type check, Docker build, version gate) |

## Backend Structure

```
app/
├── main.py                  # FastAPI app with lifespan, SPA fallback routing
├── config.py                # Pydantic settings (env vars)
├── database.py              # Tenant DB engine/session (Base)
├── routers/                 # API endpoint handlers
│   ├── absence_types.py     # Absence types (admin-managed categories of time off)
│   ├── admin/               # Multi-tenant admin routes
│   ├── admin_organizations.py  # Organization CRUD
│   ├── approval_policies.py # Who approves own bookings, per action
│   ├── approvals.py         # Approval requests: lists, approve / reject / cancel
│   ├── assignments.py       # Staff/equipment assignments (own bookings may answer 202)
│   ├── auth.py              # Authentication (login, SSO, sessions)
│   ├── custom_columns.py    # Custom data columns
│   ├── equipment.py         # Equipment CRUD and bookings
│   ├── export.py            # CSV/XML project export
│   ├── health.py            # Health check endpoint
│   ├── mpp_import.py        # Microsoft Project file import
│   ├── notes.py             # Project/phase notes
│   ├── predefined_phases.py # Phase templates
│   ├── projects.py          # Project CRUD
│   ├── roles.py             # Permission catalogue + role CRUD
│   ├── settings.py          # Instance settings
│   ├── sites.py             # Sites, bank holidays (edit/import), multi-site company events
│   ├── skills.py            # Skills management
│   ├── tags.py              # Project tags
│   ├── staff.py             # Staff management
│   ├── users.py             # User management
│   └── vacations.py         # Vacation/absence management (+ bulk .ics import)
├── models/                  # SQLAlchemy ORM models
│   ├── tenant.py            # MasterBase + Tenant, TenantCredentials, TenantAuditLog,
│   │                        #   AdminUser, AdminSession (master DB)
│   ├── organization.py      # Organization, OrganizationSSOConfig (master DB)
│   ├── project.py           # Project, ProjectPhase, ProjectSubphase (recursive)
│   ├── user.py              # User, UserSite
│   ├── assignment.py        # ProjectAssignment, PhaseStaffAssignment, SubphaseStaffAssignment
│   ├── equipment.py         # Equipment, EquipmentSite (M:N), EquipmentAssignment, EquipmentBlock
│   │                        #   (equipment "types" are a free-form string, not a model)
│   ├── site.py              # Site, BankHoliday, CompanyEvent (counts_as_unavailable = site closure),
│   │                        #   CompanyEventSite (M:N)
│   ├── skill.py             # Skill, UserSkill
│   ├── vacation.py          # Vacation (absence_type_id; recurring pattern encoded in description)
│   ├── absence_type.py      # AbsenceType (counts_as_unavailable, sort_order, is_active)
│   ├── custom_column.py     # CustomColumn, CustomColumnValue
│   ├── tag.py               # Tag, ProjectTag
│   ├── rbac.py              # Role, RolePermission, ApprovalPolicy(+Role), ApprovalRequest
│   ├── note.py              # Note (tablename: staff_notes)
│   ├── settings.py          # Settings (KV), PredefinedPhase, SSOConfig
│   ├── session.py           # Session (express-session compatible)
│   └── presence.py          # ProjectPresence
├── schemas/                 # Pydantic request/response schemas
├── scripts/                 # init_db.py (AUTO_INIT_DB), seed_demo.py
├── services/                # Business logic
│   ├── auth.py              # Authentication logic
│   ├── date_range.py        # parse_day / parse_day_range / ensure_date_order (date validation)
│   ├── encryption.py        # AES-256-GCM credential encryption, bcrypt / PBKDF2 hashing
│   ├── login_throttle.py    # Failed-login throttle (in-memory, per process)
│   ├── master_db.py         # Master DB connection + auto-migrations
│   ├── permissions.py       # Permission catalogue + PermissionSet (per-request resolution)
│   ├── approvals.py         # Own-booking approval workflow
│   ├── project_access.py    # Per-project rights: PM bundle, editor-first self-booking
│   ├── user_access.py       # Account rules: edit targets, role escalation, last admin
│   ├── proxy.py             # Proxy service
│   ├── response_builders.py # Shared response formatting
│   ├── session.py           # Session management
│   ├── site_access.py       # Visible sites: visible_site_ids, ensure_site_visible, ensure_site_access, …
│   ├── sso.py               # Microsoft Entra SSO + tenant client-secret encryption helpers
│   ├── sso_test.py          # Entra diagnostic shared by the org test and POST /auth/sso/test
│   ├── tenant_data_migrations.py # run_data_migrations(): FK rewrites + orphan cleanup
│   ├── tenant_manager.py    # Per-tenant connection pool management + auto-migrations
│   └── tenant_provisioner.py # DB/user creation for new tenants
├── middleware/              # Pure-ASGI middleware + auth dependencies
│   ├── auth.py              # Session-based authentication dependencies
│   ├── tenant.py            # URL-based tenant resolution
│   └── broadcast.py         # Coarse change:<entity> WebSocket broadcast on writes
└── websocket/               # Real-time layer
    ├── manager.py           # ConnectionManager (per-tenant rooms, presence)
    ├── handler.py           # /ws endpoints, cookie auth
    └── broadcast.py         # broadcast_change() helper (rich attribution)
```

## Frontend Structure

```
frontend/src/
├── App.tsx                  # Root component (pathname branching: /admin vs main app — no router)
├── main.tsx                 # React entry point; wires the API client (What-If, onUnauthorized)
├── api/                     # API client
│   ├── client.ts            # Base HTTP client
│   ├── index.ts             # Re-exports
│   └── endpoints/           # Per-resource API functions
│       ├── absenceTypes.ts, admin.ts, auth.ts, customColumns.ts, equipment.ts
│       ├── projects.ts, settings.ts, sites.ts
│       ├── skills.ts, staff.ts, users.ts, vacations.ts
├── components/
│   ├── admin/               # Admin portal (AdminApp, TenantList, OrgList, etc.)
│   ├── gantt/               # Gantt chart components
│   ├── views/               # Main views (ArchivedView, CrossSiteView, EquipmentView, StaffView,
│   │                        #   KanbanView, WorkView = My Work)
│   ├── screens/             # Full-screen pages (LoginScreen, LoadingScreen, LoadErrorScreen)
│   ├── settings/            # Settings hub (SettingsHub, sections.tsx registry, useReportDirty, panels/)
│   ├── modals/              # Modal dialogs
│   ├── common/              # Shared components (+ useSubmitGuard double-submit guard)
│   └── layout/              # Layout components (Header: SyncStatus "Offline" badge, WhatIfToggle)
├── contexts/                # WebSocketContext + wsSlices.ts (entity → refetch slices), …
├── stores/                  # Zustand state stores (index.ts: resetAllStores / expireSession)
│   ├── appStore.ts          # Main application state
│   ├── adminStore.ts        # Admin portal state
│   ├── uiStore.ts           # UI state (modals, Settings hub section, drag/resize)
│   ├── viewStore.ts         # Current view state
│   ├── whatIfStore.ts       # What-If mode state
│   ├── customColumnStore.ts # Custom columns state
│   ├── workStore.ts         # My Work: approval requests to decide and my own requests
│   └── undoStore.ts         # Undo/redo state
├── types/                   # TypeScript type definitions
│   ├── models.ts            # Data model types
│   └── index.ts             # Re-exports
├── hooks/                   # Custom React hooks (incl. useWhatIfBlocked)
├── styles/                  # CSS files
└── utils/                   # Utility functions
    ├── permissions.ts       # Per-project gates (canEditProject, canEditAssignment, …) —
    │                        #   mirrors app/services/project_access.py
    ├── persistFailure.ts    # recoverFromPersistFailure (reload + clear undo)
    ├── localProjectTree.ts  # Local patch/remove helpers for the project tree
    ├── reorder.ts           # Local phase/subphase reorder
    ├── whatIf.ts            # whatIfUnavailableMessage() for blocked creates
    ├── touchEvents.ts       # Touch → mouse-like event helpers for the Gantt bars
    ├── uniqueById.ts        # De-duplicate one-row-per-site equipment rows
    └── siteClosure.ts       # buildClosureIndex / getClosureOn — company events that close a site
```

Gantt-specific helpers live in `components/gantt/utils/`: `criticalPath.ts`, `diffProjects.ts` (undo/redo diff, incl. dependency arrays), `dependencies.ts` (`resolveDependencyPredecessor`, `dependencyMatches`, `wouldCreateDependencyCycle`) and `completionStatus.ts`.

### Session expiry and logout

A `401` from any session-bound API call fires the API client's `onUnauthorized` hook, wired in `main.tsx` to `expireSession()` (`stores/index.ts`): it calls `resetAllStores()` — app data (keeping only the persisted site id), the What-If sandbox, undo history, notifications and custom-column data — and returns to the login screen. Logout uses the same `resetAllStores()`, so nothing carries over to the next person on the same tab.

### What-If mode

What-If is a Gantt-only mode: the header renders the toggle only while `currentView === 'gantt'`, and while a sandbox is open the sidebar navigation, the notification bell's card links and every entry to the Settings hub are disabled through `useWhatIfBlocked` (store guards back this up: `viewStore.setCurrentView` accepts only `gantt`, and `uiStore.openSettings` and its legacy modal aliases are no-ops while a sandbox is open). While What-If is active the API client queues every `POST`/`PUT`/`PATCH`/`DELETE` instead of sending it, except auth, settings, admin-portal, notification and comment calls, the RBAC endpoints (roles, permissions, approval policies, approval requests) and the **configuration endpoints** (tags, project fields, teams, absence types, skills, equipment types, predefined phases, users, site and equipment definitions), which are not part of the sandbox. Own bookings stay queued: one whose key is in approval mode becomes an approval request (`202`) on Apply. Create entry points are disabled (`useWhatIfBlocked`), including absences and equipment blocks, and so are the Delete buttons for equipment and users (their bookings are plan data) and the holiday/event deletes in the embedded Staff view rows (calendar data is not in the snapshot). Apply replays the queue in order and **stops at the first failure**: the rest stays queued, the view reloads from the server, and `whatIfApplyError` drives a header banner with Retry / Discard / Dismiss. Edits queued while the post-Apply reload runs are kept. Undo history is cleared on enter, Discard and Apply.

## Permissions Model

A user's **role** (`users.role`, a foreign key to `roles.key`) is a permission set: one mode per key of the catalogue in `app/services/permissions.py` — `allow`, `approval` (only on the three own-booking keys) or nothing (deny). The Administrator role holds every key in code and cannot be edited; the Superuser and User system roles ship with defaults that reproduce the pre-1.13 behaviour, and administrators add custom roles in Settings → Roles. `get_current_user` resolves the live role and matrix on every request (`load_live_user`), so a role edit applies on the next request.

- **Gates** are dependencies from `app/middleware/auth.py`: `require_permission(key)`, `require_any_permission(*keys)` and `require_project_permission(key)`. `require_admin` guards only the role and approval-policy writes (lockout-proof). Never gate on a role name.
- **PM bundle** — a role holding `projects.manage_as_pm` gets six keys (`projects.edit_any`, `projects.archive`, `assignments.manage_others`, `equipment_bookings.manage`, `kanban.move_any`, `custom_columns.set_values`) on the projects whose `pm_id` is the user (`project_access.can_on_project`). Never delete, create, import or export.
- **Own bookings, editor first** — `assignments.manage_others` (or the PM) books anyone without approval; otherwise a user may book only themself, in the mode of `assignments.self_create` / `self_update` / `self_remove`: `allow` writes, `approval` files a request and answers `202` (`app/services/approvals.py`), no mode is `403`.
- **Visible sites** — every read and write is limited to the user's sites unless the role holds `sites.view_all` (`app/services/site_access.py`, a request-cached `visible_site_ids`). The `views.*` keys gate the reads behind each view.
- **Accounts** — `app/services/user_access.py`: editing an admin needs `users.edit_admins`; roles are assignable only within the caller's own permissions (escalation guard), never one's own; the last active admin is protected.

Handlers apply the per-entity rules after loading the entity, with a `project_id` derived server-side. The frontend mirrors the rules in `frontend/src/utils/permissions.ts` (`can(user, key, project?)`) on the keys `/auth/me` returns; the key spellings are shared through `shared/permission-keys.json`.

## Dual-Database Model

The application uses two separate SQLAlchemy base classes:

- **`MasterBase`** (from `app/models/tenant.py`) — Models for the master database
- **`Base`** (from `app/database.py`) — Models for tenant databases

!!! warning
    Never mix these base classes. Master models go with `MasterBase`, tenant models go with `Base`.

## Request Flow

### Tenant Routes (`/t/{slug}/api/*`)

1. Request hits FastAPI
2. `TenantMiddleware` extracts `{slug}` from URL and looks the tenant up through a 60-second cache (misses are cached too); unknown → 404, not active → 403
3. `TenantManager` provides the tenant's connection pool (created once per slug under a lock); if it can't, the response is a 503 with a fixed message — `get_db` never falls back to the `DB_*` database
4. The auth dependency validates the session cookie against the tenant's `sessions` table and re-reads the user's `active` flag and role
5. Router handler executes with the tenant-scoped database session

Error bodies are generic: `/health` reports `database: "error"`, tenant 503s carry a fixed message, unhandled exceptions are opaque 500s. Details go to the server log.

### Startup

The lifespan first calls `Settings.check_startup_security()`: with `DEBUG=false`, an empty or published `SESSION_SECRET` (the old default or an example placeholder) is a fatal error. It then initialises the master database and, in single-tenant mode, the tenant database plus the per-tenant auto-migrations (`run_single_tenant_auto_migrations`). In multi-tenant mode those run on each tenant's first pool creation. Both end with the tenant SSO secret encryption step and `run_data_migrations()` (`app/services/tenant_data_migrations.py`).

### Admin Routes (`/api/admin/*`)

1. Request hits FastAPI
2. `get_master_db` dependency provides a master database session
3. Admin authentication validates the `admin_session` cookie against `admin_sessions`; `get_current_admin` also refuses (403) an admin who must still change their password
4. Router handler executes with the master database session

### SPA Fallback

All non-API, non-static routes serve `public/index.html` (the React SPA). There is no client-side router — the app branches on `window.location.pathname` (`/admin*` vs main app) and switches in-app views through store state.

## Real-Time Architecture

Milestone's real-time collaboration runs entirely over WebSockets — both live data updates and presence (who is online / viewing a project):

### WebSocket (Live Updates)

```
Browser ──── WebSocket ──── FastAPI (app/websocket/)
  │                              │
  ├─ Receives:                   ├─ handler.py   → Accepts connections, authenticates via session cookie
  │   presence:list/join/leave   ├─ manager.py   → Manages connections per tenant (isolation)
  │   change:phase/subphase/...  └─ broadcast.py → Called from API routes after mutations
  │
  └─ Sends: ping (keepalive)
```

- **Endpoints**: `/ws` (single-tenant) and `/t/{slug}/ws` (multi-tenant)
- **Origin check**: a handshake whose `Origin` is another site is closed with 4003 (must match `Host` / `X-Forwarded-Host` or `CORS_ORIGINS`)
- **Authentication**: Session cookie (`connect.sid`) validated on connection
- **Revocation**: deactivating, deleting or demoting a user, or setting their password, destroys their sessions and closes their sockets on that process (`manager.disconnect_user`, close 4001)
- **Tenant isolation**: Each tenant has a separate connection room — users only see activity within their tenant
- **Keepalive**: Client sends ping every 25 seconds; server responds with pong
- **Reconnection**: Exponential backoff (2s base, 60s max, 5 attempts), plus an immediate retry on the browser `online` event and when the tab becomes visible. No reconnect after 1000/1001/4000–4006; 4001 and 4003 trigger a session re-check (login screen if gone). The context exposes an `offline` flag shown as the header's **Offline** badge
- **Refetch slices**: `contexts/wsSlices.ts` maps `change:<entity>` to data slices — e.g. `custom_column` → `customColumns`, `settings` → `settings`, `user` → `staff` + `currentUser` + `projects`, `note` / `card_comment` → nothing, unknown → everything. Project and custom-column refreshes are deferred while What-If is active
- **Broadcasting**: API routers (`projects.py`, `assignments.py`) call `broadcast_change()` after mutations, which sends a message to all connected users in that tenant

There are no HTTP presence endpoints — presence join/leave/list messages travel over the same WebSocket connection as change broadcasts.
