# Architecture

## Overview

Milestone Planner is a full-stack application with a FastAPI backend serving a React SPA frontend, backed by PostgreSQL with per-tenant database isolation.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Python 3.11+, FastAPI, SQLAlchemy 2.0 (async), asyncpg |
| **Frontend** | React 18, TypeScript, Vite, Zustand, React Router, TanStack Query |
| **Database** | PostgreSQL 15+ |
| **Deployment** | Docker, Docker Compose |
| **CI/CD** | GitHub Actions (lint, test, type check, Docker build) |

## Backend Structure

```
app/
├── main.py                  # FastAPI app with lifespan, SPA fallback routing
├── config.py                # Pydantic settings (env vars)
├── database.py              # Tenant DB engine/session (Base)
├── routers/                 # API endpoint handlers
│   ├── admin/               # Multi-tenant admin routes
│   ├── admin_organizations.py  # Organization CRUD
│   ├── assignments.py       # Staff/equipment assignments
│   ├── auth.py              # Authentication (login, SSO, sessions)
│   ├── custom_columns.py    # Custom data columns
│   ├── equipment.py         # Equipment CRUD and bookings
│   ├── export.py            # CSV/XML project export
│   ├── health.py            # Health check endpoint
│   ├── mpp_import.py        # Microsoft Project file import
│   ├── notes.py             # Project/phase notes
│   ├── predefined_phases.py # Phase templates
│   ├── presence.py          # Real-time presence tracking
│   ├── projects.py          # Project CRUD
│   ├── settings.py          # Instance settings
│   ├── sites.py             # Site management
│   ├── skills.py            # Skills management
│   ├── staff.py             # Staff management
│   ├── users.py             # User management
│   └── vacations.py         # Vacation/time-off management
├── models/                  # SQLAlchemy ORM models
│   ├── tenant.py            # MasterBase: Tenant, AdminUser
│   ├── organization.py      # Organization, OrganizationSSOConfig
│   ├── project.py           # Project, Phase, Subphase
│   ├── user.py              # User
│   ├── assignment.py        # StaffAssignment, EquipmentAssignment
│   ├── equipment.py         # Equipment, EquipmentType
│   ├── site.py              # Site
│   ├── skill.py             # Skill
│   ├── vacation.py          # Vacation, RecurringAbsence
│   ├── custom_column.py     # CustomColumn, CustomColumnValue
│   ├── note.py              # Note
│   ├── settings.py          # InstanceSettings
│   ├── session.py           # Session
│   └── presence.py          # Presence
├── schemas/                 # Pydantic request/response schemas
├── services/                # Business logic
│   ├── auth.py              # Authentication logic
│   ├── encryption.py        # AES-256-GCM credential encryption
│   ├── master_db.py         # Master DB connection + auto-migrations
│   ├── proxy.py             # Proxy service
│   ├── response_builders.py # Shared response formatting
│   ├── session.py           # Session management
│   ├── sso.py               # Microsoft Entra SSO
│   ├── tenant_manager.py    # Per-tenant connection pool management
│   └── tenant_provisioner.py # DB/user creation for new tenants
└── middleware/              # Request middleware
    ├── auth.py              # Session-based authentication
    └── tenant.py            # URL-based tenant resolution
```

## Frontend Structure

```
frontend/src/
├── App.tsx                  # Root component with routing
├── main.tsx                 # React entry point
├── api/                     # API client
│   ├── client.ts            # Base HTTP client
│   ├── index.ts             # Re-exports
│   └── endpoints/           # Per-resource API functions
│       ├── admin.ts, auth.ts, customColumns.ts, equipment.ts
│       ├── presence.ts, projects.ts, settings.ts, sites.ts
│       ├── skills.ts, staff.ts, users.ts, vacations.ts
├── components/
│   ├── admin/               # Admin portal (AdminApp, TenantList, OrgList, etc.)
│   ├── gantt/               # Gantt chart components
│   ├── views/               # Main views (ArchivedView, CrossSiteView, EquipmentView, StaffView)
│   ├── screens/             # Full-screen pages (LoginScreen, LoadingScreen)
│   ├── modals/              # Modal dialogs
│   ├── common/              # Shared components
│   └── layout/              # Layout components
├── stores/                  # Zustand state stores
│   ├── appStore.ts          # Main application state
│   ├── adminStore.ts        # Admin portal state
│   ├── uiStore.ts           # UI state (sidebar, modals)
│   ├── viewStore.ts         # Current view state
│   ├── whatIfStore.ts       # What-If mode state
│   ├── customColumnStore.ts # Custom columns state
│   └── undoStore.ts         # Undo/redo state
├── types/                   # TypeScript type definitions
│   ├── models.ts            # Data model types
│   └── index.ts             # Re-exports
├── hooks/                   # Custom React hooks
├── styles/                  # CSS files
└── utils/                   # Utility functions
```

## Dual-Database Model

The application uses two separate SQLAlchemy base classes:

- **`MasterBase`** (from `app/models/tenant.py`) — Models for the master database
- **`Base`** (from `app/database.py`) — Models for tenant databases

!!! warning
    Never mix these base classes. Master models go with `MasterBase`, tenant models go with `Base`.

## Request Flow

### Tenant Routes (`/t/{slug}/api/*`)

1. Request hits FastAPI
2. `TenantMiddleware` extracts `{slug}` from URL
3. `TenantManager` looks up the tenant in master DB and provides a database session
4. `AuthMiddleware` validates the session cookie against the tenant's user store
5. Router handler executes with the tenant-scoped database session

### Admin Routes (`/api/admin/*`)

1. Request hits FastAPI
2. `get_master_db` dependency provides a master database session
3. Admin authentication validates against admin user store
4. Router handler executes with the master database session

### SPA Fallback

All non-API, non-static routes serve `public/index.html` (the React SPA), which handles client-side routing.

## Real-Time Architecture

Milestone uses two complementary real-time mechanisms:

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
- **Authentication**: Session cookie (`connect.sid`) validated on connection
- **Tenant isolation**: Each tenant has a separate connection room — users only see activity within their tenant
- **Keepalive**: Client sends ping every 25 seconds; server responds with pong
- **Reconnection**: Exponential backoff (2s base, 60s max, 5 attempts)
- **Broadcasting**: API routers (`projects.py`, `assignments.py`) call `broadcast_change()` after mutations, which sends a message to all connected users in that tenant

### REST Presence (Conflict Detection)

```
Browser ──── HTTP ──── FastAPI (app/routers/presence.py)
  │                         │
  ├─ POST /presence/heartbeat  (every 30s while viewing a project)
  ├─ GET  /presence/project/{id}  (list active viewers)
  ├─ POST /presence/check-conflict/{id}  (before saving)
  └─ DELETE /presence/{id}  (leave project)
```

- **Heartbeat**: Frontend sends a heartbeat every 30 seconds with `activity: "viewing"` or `"editing"`
- **Timeout**: Presence records expire after 300+ seconds without a heartbeat
- **Conflict check**: Before saving, the frontend calls `check-conflict` which returns:
  - Whether other users are actively editing
  - The last modification timestamp and author
  - A list of active editors with their names
