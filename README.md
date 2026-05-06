# Milestone

<img width="1034" height="139" alt="Screenshot 2026-05-04 at 22 55 43" src="https://github.com/user-attachments/assets/277f8f49-e300-4134-8ded-247b6ce9eb22" />  

A comprehensive R&D project management platform for multi-site organizations.


<img width="1440" height="481" alt="Screenshot 2026-05-04 at 22 53 48" src="https://github.com/user-attachments/assets/1ce98a58-67b6-4a28-815b-1372c1b118c2" />  

  <br/>
<br/>
<br/>  

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/vincentmakes/milestone-planner?quickstart=1)

## Features

- **Gantt chart visualization** — Interactive timeline with drag & drop, resize phases
- **Resource management** — Staff allocation with percentage-based assignments
- **Equipment scheduling** — Book equipment across projects and phases
- **Multi-tenant architecture** — Separate databases per organization
- **Organization-level SSO** — Microsoft Entra ID with group-based access control
- **Cross-site visibility** — View resources across locations while maintaining confidentiality
- **What-If planning** — Scenario planning without affecting production data
- **Real-time collaboration** — WebSocket-powered live updates
- **Import/Export** — Microsoft Project (CSV, XML, MPP) support
- **Mobile responsive** — Touch-optimized for tablets

## Tech Stack

- **Backend**: Python 3.11+ / FastAPI / SQLAlchemy 2.0 (async) / PostgreSQL 15+
- **Frontend**: React 18 / TypeScript / Zustand / Vite / TanStack Query
- **Deployment**: Docker / Docker Compose
- **Documentation**: MkDocs Material / Cloudflare Pages

## Quick Start

### Option 1: GitHub Codespaces (Recommended for Demo)

Click the badge above to launch a fully configured environment with PostgreSQL, Python, Node.js, and a pre-seeded demo tenant.

After the Codespace starts, run:

```bash
# Start the backend
uvicorn app.main:app --host 0.0.0.0 --port 8485 --reload

# In another terminal, start the frontend dev server
cd frontend && npm run dev -- --host 0.0.0.0 --port 3333
```

The Codespace automatically creates a demo tenant with sample data:

| Access | URL | Email | Password |
|--------|-----|-------|----------|
| **Admin Portal** | `/admin/` | `admin@demo.local` | `demo1234` |
| **Demo Tenant** | `/t/demo/` | `admin@demo.local` | `demo1234` |

The demo tenant includes 2 sites (Winterthur, Frankfurt), 4 projects with phases and assignments, 8 staff members with skills, and 8 equipment items. All staff accounts use password `demo1234`.

### Option 2: Docker Fresh Install

```bash
git clone https://github.com/vincentmakes/milestone-planner.git
cd milestone-planner
cp .env.example .env
docker compose -f docker-compose.fresh.yml up -d
```

This starts PostgreSQL + the app with auto-initialization. Check `docker logs milestone-fresh` for the admin password. Access at `http://localhost:8486/`.

### Option 3: Production with External DB

```bash
cp .env.example .env
# Edit .env with your database credentials and secrets

# Set up the database
psql -U postgres -f setup_databases.sql

# Start the application
docker compose up -d
```

Access at `http://localhost:8485/`.

## Documentation

Full documentation is published at **[docs-milestone.verdet.me](https://docs-milestone.verdet.me)**.

| Resource | Description |
|----------|-------------|
| [User Guide](https://docs-milestone.verdet.me/user-guide/getting-started/) | Day-to-day usage: Gantt charts, staff, equipment, vacations |
| [Admin Guide](https://docs-milestone.verdet.me/admin-guide/overview/) | Installation, multi-tenant management, SSO configuration |
| [Developer Guide](https://docs-milestone.verdet.me/developer-guide/architecture/) | Architecture, local development, API reference |
| [API Documentation](http://localhost:8485/api/docs) | Swagger UI (when running) |
| [Changelog](CHANGELOG.md) | Release history (SemVer) |

## File Structure

```
milestone-planner/
├── app/                    # FastAPI backend
│   ├── main.py            # Application entry point
│   ├── config.py          # Pydantic settings
│   ├── database.py        # Tenant DB engine/session
│   ├── routers/           # API endpoints (20 modules)
│   ├── models/            # SQLAlchemy models (14 modules)
│   ├── schemas/           # Pydantic schemas
│   ├── services/          # Business logic (encryption, SSO, tenant management)
│   └── middleware/        # Auth and tenant middleware
├── frontend/              # React frontend source
│   └── src/               # Components, stores, API clients, types
├── docs/                  # MkDocs documentation source
│   ├── user-guide/        # End-user documentation
│   ├── admin-guide/       # Admin & multi-tenant docs
│   └── developer-guide/   # Architecture & API reference
├── .devcontainer/         # GitHub Codespaces configuration
├── .github/workflows/     # CI/CD (lint, test, build, docs deploy)
├── migrations/            # Raw SQL migration files
├── scripts/               # Utility scripts
├── public/                # Served frontend (built from frontend/dist/)
├── docker-compose.yml     # Production deployment
├── docker-compose.fresh.yml  # Self-contained fresh install
├── docker-compose.dev.yml # Development with hot reload
├── Dockerfile             # Multi-stage container build
├── mkdocs.yml             # Documentation site config
├── setup_databases.sql    # Complete database schema
└── .env.example           # Environment template
```

## Multi-Tenant Mode

For SaaS deployment with multiple organizations:

1. Set `MULTI_TENANT=true` in `.env`
2. Configure master DB settings (`MASTER_DB_HOST`, `MASTER_DB_NAME`, etc.)
3. Set `TENANT_ENCRYPTION_KEY` (64-char hex, required)
4. Set `PG_ADMIN_USER` / `PG_ADMIN_PASSWORD` for auto-provisioning
5. Access admin panel at `/admin/`

Each tenant gets an isolated PostgreSQL database. Credentials are encrypted with AES-256-GCM. See the [Multi-Tenant Management Guide](docs/admin-guide/multi-tenant.md) for details.

## Access URLs

| URL | Description |
|-----|-------------|
| `/` | Main application |
| `/t/{slug}/` | Tenant-specific access |
| `/admin/` | Multi-tenant admin panel |
| `/api/docs` | API documentation (Swagger) |
| `/health` | Health check endpoint |

## Environment Variables

Key variables (see `.env.example` for full list):

| Variable | Description |
|----------|-------------|
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | PostgreSQL connection |
| `SESSION_SECRET` | Secret for session signing |
| `MULTI_TENANT` | Enable multi-tenant mode (`true`/`false`) |
| `MASTER_DB_HOST`, `MASTER_DB_NAME`, etc. | Master DB (multi-tenant only) |
| `TENANT_ENCRYPTION_KEY` | 64-char hex for credential encryption |
| `PG_ADMIN_USER`, `PG_ADMIN_PASSWORD` | For auto-provisioning tenant DBs |

## License

MIT
