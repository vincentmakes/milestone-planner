# Milestone - Development & Deployment Guide

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Port 8485                               │
│                   FastAPI Backend                            │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  /api/*          → API endpoints                        ││
│  │  /t/{slug}/api/* → Tenant API endpoints                 ││
│  │  /admin          → React SPA (admin panel)              ││
│  │  /t/{slug}/*     → React SPA (tenant app)               ││
│  │  /*              → React SPA (main app)                 ││
│  │  /img, /assets   → Static files from public/            ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Quick Start (Production)

```bash
cd /mnt/user/appdata/milestone

# Start the application
docker-compose -f docker-compose.prod.yml up -d

# Access at http://your-server:8485/
```

## Development Workflow

### Without Hot Reload (Recommended)

This is the simplest workflow. Make changes, build, deploy, refresh.

```bash
# 1. Make changes to frontend/src/**/*.tsx

# 2. Build the React app
cd /mnt/user/appdata/milestone/frontend
npm run build

# 3. Deploy to public folder
cd /mnt/user/appdata/milestone
./deploy-react.sh

# 4. Refresh browser (Ctrl+Shift+R for hard refresh)
```

**Tip**: Create an alias for quick rebuilds:
```bash
alias milestone-rebuild="cd /mnt/user/appdata/milestone/frontend && npm run build && cd .. && ./deploy-react.sh"
```

### With Hot Reload (Optional)

Use the Vite dev server for instant updates during development.

**Limitation**: Tenant routes (`/t/slug/`) don't work on the dev server.

```bash
# Start the dev server
docker-compose -f docker-compose.react-dev.yml up -d

# Access at http://your-server:3333/
# Changes to .tsx files appear instantly

# For tenant features, use port 8485 instead
```

## File Structure

```
milestone/
├── app/                    # Python FastAPI backend
│   ├── main.py            # Application entry point
│   ├── routers/           # API endpoints
│   ├── models/            # SQLAlchemy models
│   ├── schemas/           # Pydantic schemas
│   └── services/          # Business logic
├── frontend/              # React frontend source
│   ├── src/               # React components & logic
│   ├── dist/              # Built React app (generated)
│   └── package.json       # Node dependencies
├── public/                # Served by FastAPI (deployed React)
│   ├── index.html         # React app entry point
│   ├── assets/            # JS/CSS bundles
│   └── img/               # Images and logos
├── deploy-react.sh        # Deploys frontend/dist → public/
├── docker-compose.prod.yml    # Production (recommended)
└── docker-compose.react-dev.yml # Development with hot reload
```

## Common Tasks

### Update Frontend Code

```bash
# Edit files in frontend/src/
vim frontend/src/components/SomeComponent.tsx

# Build and deploy
cd frontend && npm run build && cd ..
./deploy-react.sh

# Refresh browser
```

### Update Backend Code

```bash
# Edit files in app/
vim app/routers/projects.py

# Rebuild container
docker-compose -f docker-compose.prod.yml up -d --build
```

### Update Both

```bash
# Build frontend
cd frontend && npm run build && cd ..
./deploy-react.sh

# Rebuild backend
docker-compose -f docker-compose.prod.yml up -d --build
```

### View Logs

```bash
# All logs
docker-compose -f docker-compose.prod.yml logs -f

# Just the app
docker logs -f milestone
```

### Check Container Status

```bash
docker-compose -f docker-compose.prod.yml ps
```

## Access URLs

| URL | Description |
|-----|-------------|
| `http://server:8485/` | Main application |
| `http://server:8485/t/tenant-slug/` | Tenant-specific access |
| `http://server:8485/admin/` | Admin panel (multi-tenant management) |
| `http://server:8485/api/docs` | API documentation (Swagger) |
| `http://server:8485/health` | Health check endpoint |

## Troubleshooting

### Frontend changes not appearing

1. Make sure you ran `npm run build`
2. Make sure you ran `./deploy-react.sh`
3. Hard refresh browser: `Ctrl+Shift+R`
4. Check browser console for errors

### API errors

```bash
# Check backend logs
docker logs milestone

# Test API endpoint
curl http://localhost:8485/api/health
```

### Container won't start

```bash
# Check logs
docker-compose -f docker-compose.prod.yml logs

# Rebuild from scratch
docker-compose -f docker-compose.prod.yml down
docker-compose -f docker-compose.prod.yml up -d --build
```

### Database issues

```bash
# Connect to container
docker exec -it milestone bash

# Check database
python -c "from app.database import engine; print(engine.url)"
```

## Environment Variables

Required in `.env`:

```bash
# Database
DATABASE_URL=postgresql://user:pass@host:5432/milestone
MASTER_DATABASE_URL=postgresql://user:pass@host:5432/milestone_master

# Multi-tenant
MULTI_TENANT=true

# Security
SECRET_KEY=your-secret-key
ENCRYPTION_KEY=your-encryption-key
```

## Backup

```bash
# Database backup (adjust for your setup)
pg_dump milestone > backup_$(date +%Y%m%d).sql

# Application files
tar -czf milestone_files_$(date +%Y%m%d).tar.gz \
  /mnt/user/appdata/milestone/uploads \
  /mnt/user/appdata/milestone/.env
```
