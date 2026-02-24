# Milestone  - https://www.milestoneplanner.net

A comprehensive R&D project management platform for multi-site organizations.

## Features

- **Gantt chart visualization** - Interactive timeline with drag & drop, resize phases
- **Resource management** - Staff allocation with percentage-based assignments
- **Equipment scheduling** - Book equipment across projects and phases
- **Multi-tenant architecture** - Separate databases per organization
- **Organization-level SSO** - Microsoft Entra ID with group-based access control
- **Cross-site visibility** - View resources across locations while maintaining confidentiality
- **What-If planning** - Scenario planning without affecting production data
- **Mobile responsive** - Touch-optimized for tablets

## Tech Stack

- **Backend**: Python 3.11+ / FastAPI / SQLAlchemy 2.0 (async) / PostgreSQL 15+
- **Frontend**: React 18 / TypeScript / Zustand / Vite / TanStack Query
- **Deployment**: Docker / Docker Compose

## Quick Start

### Prerequisites

- Docker and Docker Compose
- PostgreSQL 15+
- (Optional) Node.js 20+ for frontend development

### 1. Clone and Configure

```bash
cp .env.example .env
# Edit .env with your database credentials and secrets
```

### 2. Setup Database

```bash
# Run the full setup script as PostgreSQL superuser
psql -U postgres -f setup_databases.sql
```

Or manually:
```bash
psql -U postgres
CREATE DATABASE milestone;
CREATE USER milestone WITH PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE milestone TO milestone;
\c milestone
-- Run the tenant schema section from setup_databases.sql
```

### 3. Start the Application

```bash
# Production
docker-compose up -d

# Development with hot reload
docker-compose -f docker-compose.react-dev.yml up -d
```

### 4. Create First User

```bash
psql -U milestone -d milestone

-- Create admin user (password: 'admin' - change this!)
INSERT INTO users (email, password, first_name, last_name, role)
VALUES (
    'admin@example.com',
    '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4.G6J8EHyFj2YQXW',
    'Admin',
    'User',
    'admin'
);
```

### 5. Access the Application

- **Main app**: http://localhost:8485/
- **API docs**: http://localhost:8485/api/docs (requires admin login)

## File Structure

```
milestone/
├── app/                    # FastAPI backend
│   ├── main.py            # Application entry point
│   ├── config.py          # Pydantic settings (env vars)
│   ├── database.py        # Tenant DB engine/session
│   ├── routers/           # API endpoints
│   ├── models/            # SQLAlchemy models
│   ├── schemas/           # Pydantic schemas
│   ├── services/          # Business logic (master_db, tenant_manager, encryption)
│   └── middleware/        # Auth, tenant middleware
├── frontend/              # React frontend source
│   └── src/               # Components, stores, API clients, types
├── public/                # Served frontend (built from frontend/dist/)
├── migrations/            # Raw SQL migration files
├── scripts/               # Utility scripts (fresh install, seeding, etc.)
├── docker-compose.yml     # Production deployment
├── docker-compose.dev.yml # Development with hot reload
├── docker-compose.react-dev.yml  # React dev server variant
├── Dockerfile             # Container build
├── setup_databases.sql    # Complete database schema
├── deploy-react.sh        # Frontend deployment helper
├── requirements.txt       # Python dependencies
├── .env.example           # Environment template
└── DEVELOPMENT.md         # Development guide
```

## Documentation

- [Development Guide](DEVELOPMENT.md) - How to make changes and deploy
- [Migration Guide](migrations/README.md) - Database migration procedures
- [Frontend Guide](frontend/README.md) - Frontend development
- [API Documentation](http://localhost:8485/api/docs) - Swagger UI (when running)

## Multi-Tenant Mode

For SaaS deployment with multiple organizations:

1. Set `MULTI_TENANT=true` in `.env`
2. Configure master DB settings (`MASTER_DB_HOST`, `MASTER_DB_NAME`, etc.)
3. Set `TENANT_ENCRYPTION_KEY` (64-char hex, required)
4. Set `PG_ADMIN_USER` / `PG_ADMIN_PASSWORD` for auto-provisioning
5. Access admin panel at `/admin/`

The master database schema (organizations, tenants, SSO config) is auto-applied on startup.

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

Proprietary - All rights reserved
