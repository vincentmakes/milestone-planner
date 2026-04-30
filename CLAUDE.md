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
    assignment.py      # StaffAssignment, EquipmentAssignment
    equipment.py       # Equipment, EquipmentType
    site.py            # Site
    skill.py           # Skill
    vacation.py        # Vacation, RecurringAbsence
    custom_column.py   # CustomColumn, CustomColumnValue
    note.py            # Note
    settings.py        # InstanceSettings
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
frontend/
  src/
    App.tsx            # Root component with routing
    main.tsx           # React entry point
    api/               # API client and per-resource endpoint functions
      client.ts        # Base HTTP client
      endpoints/       # admin, auth, customColumns, equipment, presence,
                       # projects, settings, sites, skills, staff, users, vacations
    components/
      admin/           # AdminApp, TenantList, OrganizationList, AdminUserList, SystemStatsPanel
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
- Available migrations: `add_organizations`, `add_skills_tables`, `add_custom_columns`, `add_company_events`, `add_project_presence`, `add_is_system_column`, `upgrade_to_v90`

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
- Current sheets: Site, Projects (hierarchy with phases/subphases), Users, Equipment, Skills, User skills, Vacations, Project assignments, Phase assignments, Subphase assignments, Equipment assignments, Custom columns, Custom column values, Bank holidays, Company events.
- **IMPORTANT**: any new data added at the site level through future enhancements (e.g. equipment maintenance/blocks, new event types, additional site-scoped settings, new assignment kinds, etc.) **must** be added as a new sheet (or a new column on the existing sheet) in `build_site_export_workbook()`. The site export is the canonical "everything for this site" snapshot — do not let it drift behind the model.

## Important Patterns

- Admin routes are at `/api/admin/*` and use `get_master_db` dependency for master DB sessions.
- Tenant routes are prefixed `/t/{slug}/api/*` and resolved by `TenantMiddleware`.
- The frontend is a React SPA served from `public/` by FastAPI's catch-all route.
- `CustomJSONResponse` formats datetimes to match Node.js `toISOString()` output.
- Organization SSO (Microsoft Entra ID) is configured per-organization and shared across its tenants.
- WebSocket connections provide real-time collaboration (presence tracking, live updates).
- The Dockerfile is a multi-stage build: Python deps, Node.js frontend build, slim runtime.

## Gotchas

- The master and tenant databases use **separate SQLAlchemy Base classes** (`MasterBase` vs `Base`). Don't mix them.
- `setup_databases.sql` must stay in sync with SQLAlchemy models. When adding columns to master DB models, also update this file and add a migration in `migrations/`.
- Tenant routes don't work on the Vite dev server (port 3333). Use port 8485 for tenant features.
- The `run_migration_master.py` splits SQL on `;` which can break `DO $$ ... END $$;` blocks. Use `run_migration.py` or apply those manually via `psql`.
- MPP file import requires Java (JRE 11+), included in the Docker image but not in dev environments by default.
- The User model has a `full_name` property at `user.py` — use it instead of manual `first_name + last_name` concatenation.
