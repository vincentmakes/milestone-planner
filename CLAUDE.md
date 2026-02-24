# CLAUDE.md - Milestone Planner

## Project Overview

Multi-tenant SaaS platform for R&D project management with Gantt charts, staff allocation, equipment booking, and Microsoft Entra SSO. FastAPI backend + React/TypeScript frontend.

## Tech Stack

- **Backend**: Python 3.11+, FastAPI, SQLAlchemy 2.0 (async), asyncpg, Alembic
- **Frontend**: React 18, TypeScript, Vite, Zustand, React Router, TanStack Query
- **Database**: PostgreSQL 15+ (multi-tenant: one master DB + one DB per tenant)
- **Deployment**: Docker, docker-compose, port 8485

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
    tenant.py          # MasterBase + Tenant, AdminUser, etc.
    organization.py    # Organization, OrganizationSSOConfig
  routers/             # FastAPI route handlers
    admin.py           # Tenant CRUD, admin auth
    admin_organizations.py  # Organization CRUD
  schemas/             # Pydantic request/response schemas
  services/
    master_db.py       # Master DB connection + auto-migrations
    tenant_manager.py  # Per-tenant connection pool management
    tenant_provisioner.py  # DB/user creation for new tenants
    encryption.py      # AES-256-GCM credential encryption
  middleware/
    auth.py            # Session-based authentication
    tenant.py          # URL-based tenant resolution (/t/{slug}/*)
frontend/
  src/
    components/        # React components (Gantt/, admin/, modals/, ui/)
    stores/            # Zustand state stores
    api/               # API client functions
    types/             # TypeScript type definitions
migrations/            # SQL migration files (run manually)
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

# Rebuild after backend changes
docker-compose up -d --build

# View logs
docker logs -f milestone

# Run backend tests
docker exec milestone pytest

# Frontend dev server (hot reload, port 3333)
cd frontend && npm install && npm run dev

# Frontend tests
cd frontend && npm test

# Run master DB migration (e.g., add_organizations)
python migrations/run_migration_master.py add_organizations

# Run tenant DB migration across all tenants
python migrations/run_migration.py <migration_name>
```

## Database Migrations

- **No Alembic versions are in use.** Migrations are raw SQL files in `migrations/`.
- Master DB migrations: `python migrations/run_migration_master.py <name>`
- Tenant DB migrations: `python migrations/run_migration.py <name>`
- `master_db.init_db()` auto-applies missing schema (organizations table, new tenant columns) on startup.
- `setup_databases.sql` is the canonical fresh-install schema.

## Environment Variables

Required:
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` - tenant DB
- `SECRET_KEY` - session signing

Multi-tenant mode:
- `MULTI_TENANT=true`
- `MASTER_DB_HOST`, `MASTER_DB_PORT`, `MASTER_DB_NAME`, `MASTER_DB_USER`, `MASTER_DB_PASSWORD`
- `TENANT_ENCRYPTION_KEY` - 64-char hex for AES-256-GCM
- `PG_ADMIN_USER`, `PG_ADMIN_PASSWORD` - for provisioning new tenant DBs

## Important Patterns

- Admin routes are at `/api/admin/*` and use `get_master_db` dependency for master DB sessions.
- Tenant routes are prefixed `/t/{slug}/api/*` and resolved by `TenantMiddleware`.
- The frontend is a React SPA served from `public/` by FastAPI's catch-all route.
- `CustomJSONResponse` formats datetimes to match Node.js `toISOString()` output.
- Organization SSO (Microsoft Entra ID) is configured per-organization and shared across its tenants.

## Gotchas

- The master and tenant databases use **separate SQLAlchemy Base classes** (`MasterBase` vs `Base`). Don't mix them.
- `setup_databases.sql` must stay in sync with SQLAlchemy models. When adding columns to master DB models, also update this file and add a migration in `migrations/`.
- Tenant routes don't work on the Vite dev server (port 3333). Use port 8485 for tenant features.
- The `run_migration_master.py` splits SQL on `;` which can break `DO $$ ... END $$;` blocks. Use `run_migration.py` or apply those manually via `psql`.
