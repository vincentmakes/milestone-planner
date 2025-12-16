# Milestone

A comprehensive R&D project management platform for multi-site organizations.

## Features

- **Gantt chart visualization** - Interactive timeline with drag & drop, resize phases
- **Resource management** - Staff allocation with percentage-based assignments
- **Equipment scheduling** - Book equipment across projects and phases
- **Multi-tenant architecture** - Separate databases per organization
- **Cross-site visibility** - View resources across locations while maintaining confidentiality
- **Microsoft Entra SSO** - Enterprise single sign-on integration
- **What-If planning** - Scenario planning without affecting production data
- **Mobile responsive** - Touch-optimized for tablets

## Tech Stack

- **Backend**: Python 3.11+ / FastAPI / SQLAlchemy 2.0 / PostgreSQL
- **Frontend**: React 18 / TypeScript / Zustand / Vite
- **Deployment**: Docker / Docker Compose

## Quick Start

### Prerequisites

- Docker and Docker Compose
- PostgreSQL 15+
- (Optional) Node.js 20+ for frontend development

### 1. Clone and Configure

```bash
cd /your/install/path
# Extract or clone the milestone files here

# Create environment file
cp .env.example .env
# Edit .env with your database credentials
```

### 2. Setup Database

```bash
# Connect as PostgreSQL superuser
psql -U postgres

# Create database and user
CREATE DATABASE milestone;
CREATE USER milestone WITH PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE milestone TO milestone;

# Connect to the new database and run schema
\c milestone
# Run the tenant schema section from setup_databases.sql
```

Or run the full setup script:
```bash
psql -U postgres -f setup_databases.sql
```

### 3. Start the Application

```bash
# Production (recommended)
docker-compose up -d

# Or with hot reload for development
docker-compose -f docker-compose.dev.yml up -d
```

### 4. Create First User

```bash
# Connect to your database
psql -U milestone -d milestone

# Create admin user (password: 'admin' - change this!)
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
- **API docs**: http://localhost:8485/api/docs

## File Structure

```
milestone/
├── app/                    # FastAPI backend
│   ├── main.py            # Application entry point
│   ├── routers/           # API endpoints
│   ├── models/            # SQLAlchemy models
│   ├── schemas/           # Pydantic schemas
│   ├── services/          # Business logic
│   └── middleware/        # Auth, tenant middleware
├── frontend/              # React frontend source
│   ├── src/               # React components
│   └── dist/              # Built React app
├── public/                # Served frontend (copy of dist/)
├── alembic/               # Database migrations
├── docker-compose.yml     # Production deployment
├── docker-compose.dev.yml # Development with hot reload
├── Dockerfile             # Container build
├── setup_databases.sql    # Database schema
├── deploy-react.sh        # Frontend deployment helper
├── requirements.txt       # Python dependencies
├── .env.example           # Environment template
├── README.md              # This file
└── DEVELOPMENT.md         # Development guide
```

## Documentation

- [Development Guide](DEVELOPMENT.md) - How to make changes and deploy
- [API Documentation](http://localhost:8485/api/docs) - Swagger UI (when running)
- `setup_databases.sql` - Complete database schema with comments

## Multi-Tenant Mode

For SaaS deployment with multiple organizations:

1. Set `MULTI_TENANT=true` in `.env`
2. Configure `MASTER_DATABASE_URL` 
3. Set `TENANT_ENCRYPTION_KEY` (required)
4. Access admin panel at `/admin/`

See `setup_databases.sql` for master database schema.

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
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Secret for session signing |
| `MULTI_TENANT` | Enable multi-tenant mode |
| `MASTER_DATABASE_URL` | Master DB (multi-tenant only) |
| `TENANT_ENCRYPTION_KEY` | Credential encryption (multi-tenant) |

## License

Proprietary - All rights reserved
