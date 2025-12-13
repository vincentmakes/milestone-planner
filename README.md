# Milestone

A comprehensive R&D project management platform for multi-site organizations.

## Features

- **Multi-tenant architecture** - Separate databases per organization
- **Gantt chart visualization** - Interactive timeline with drag & drop
- **Resource management** - Staff allocation with percentage-based assignments
- **Equipment scheduling** - Book equipment across projects and phases
- **Cross-site visibility** - View resources across locations while maintaining confidentiality
- **Microsoft Entra SSO** - Enterprise single sign-on integration
- **What-If planning** - Scenario planning without affecting production data
- **Mobile responsive** - Touch-optimized for tablets

## Tech Stack

- **Backend**: Python 3.11+ / FastAPI / SQLAlchemy 2.0 / PostgreSQL
- **Frontend**: React 18 / TypeScript / Zustand / Vite
- **Deployment**: Docker / Docker Compose

## Quick Start

```bash
# Clone and configure
cd /mnt/user/appdata/milestone
cp .env.example .env
# Edit .env with your database credentials

# Start the application
docker-compose -f docker-compose.prod.yml up -d

# Access at http://your-server:8485/
```

## Documentation

- [Development Guide](DEVELOPMENT.md) - How to make changes and deploy
- [API Documentation](http://your-server:8485/api/docs) - Swagger UI (when running)

## Project Structure

```
milestone/
├── app/                    # FastAPI backend
├── frontend/               # React frontend source
├── public/                 # Deployed frontend (served by FastAPI)
├── alembic/                # Database migrations
├── deploy-react.sh         # Frontend deployment script
├── docker-compose.prod.yml # Production deployment
└── DEVELOPMENT.md          # Development workflow guide
```

## Access URLs

| URL | Description |
|-----|-------------|
| `/` | Main application |
| `/t/{slug}/` | Tenant-specific access |
| `/admin/` | Multi-tenant admin panel |
| `/api/docs` | API documentation |

## License

Proprietary - All rights reserved
