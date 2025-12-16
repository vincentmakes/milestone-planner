# Milestone - Development Guide

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
│  │  /assets/*       → Static files from public/            ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Development Options

### Option 1: Without Hot Reload (Recommended for most changes)

This is the simplest workflow. Make changes, build, deploy, refresh.

```bash
# 1. Make changes to frontend/src/**/*.tsx

# 2. Build the React app (using Docker - no local Node.js needed)
docker run --rm -v $(pwd)/frontend:/app -w /app node:20-alpine sh -c "npm install && npm run build"

# 3. Deploy to public folder
./deploy-react.sh

# 4. Hard refresh browser: Ctrl+Shift+R (or Cmd+Shift+R on Mac)
```

### Option 2: With Hot Reload (For rapid UI iteration)

Use the Vite dev server for instant updates during development.

```bash
# Start both backend and frontend dev server
docker-compose -f docker-compose.dev.yml up -d

# Access at http://localhost:3333/
# Changes to .tsx files appear instantly
```

**Note**: Tenant routes (`/t/slug/`) don't work on the dev server (port 3333).
Use port 8485 when testing tenant-specific features.

### Option 3: Local Node.js Development

If you have Node.js installed locally:

```bash
cd frontend
npm install
npm run dev
# Access at http://localhost:3333/
```

## Making Changes

### Frontend Changes

```bash
# Edit files in frontend/src/
vim frontend/src/components/SomeComponent.tsx

# Build (choose one method):

# Method A: Using Docker (no local Node.js)
docker run --rm -v $(pwd)/frontend:/app -w /app node:20-alpine sh -c "npm run build"

# Method B: Using local Node.js
cd frontend && npm run build && cd ..

# Method C: Using dev container
docker exec milestone-react-dev sh -c "npm run build"

# Deploy
./deploy-react.sh

# Refresh browser
```

### Backend Changes

```bash
# Edit files in app/
vim app/routers/projects.py

# Rebuild container
docker-compose up -d --build

# Or restart if only Python files changed
docker-compose restart milestone
```

### Both Frontend and Backend

```bash
# Build frontend
docker run --rm -v $(pwd)/frontend:/app -w /app node:20-alpine sh -c "npm run build"
./deploy-react.sh

# Rebuild backend
docker-compose up -d --build
```

## Useful Commands

### View Logs
```bash
# All logs
docker-compose logs -f

# Just the app
docker logs -f milestone
```

### Check Status
```bash
docker-compose ps
```

### Rebuild Everything
```bash
docker-compose down
docker-compose up -d --build
```

### Database Access
```bash
# If using local PostgreSQL
psql -U milestone -d milestone

# If using Docker PostgreSQL
docker exec -it milestone-db psql -U milestone
```

### Run Backend Tests
```bash
docker exec milestone pytest
```

## Project Structure Details

### Backend (`app/`)

```
app/
├── main.py              # FastAPI app, routes, middleware setup
├── config.py            # Environment configuration
├── database.py          # SQLAlchemy setup, session management
├── routers/             # API endpoint handlers
│   ├── projects.py      # Project CRUD
│   ├── staff.py         # Staff management
│   ├── equipment.py     # Equipment booking
│   ├── auth.py          # Authentication
│   └── admin.py         # Multi-tenant admin
├── models/              # SQLAlchemy ORM models
├── schemas/             # Pydantic request/response models
├── services/            # Business logic
│   ├── encryption.py    # Credential encryption
│   ├── tenant_manager.py
│   └── tenant_provisioner.py
└── middleware/          # Request middleware
    ├── auth.py          # Session authentication
    └── tenant.py        # Multi-tenant routing
```

### Frontend (`frontend/src/`)

```
frontend/src/
├── App.tsx              # Root component, routing
├── main.tsx             # React entry point
├── components/          # React components
│   ├── Gantt/           # Gantt chart components
│   ├── admin/           # Admin panel components
│   ├── modals/          # Modal dialogs
│   └── ui/              # Shared UI components
├── stores/              # Zustand state stores
├── api/                 # API client functions
├── hooks/               # Custom React hooks
├── types/               # TypeScript type definitions
├── styles/              # CSS files
└── utils/               # Utility functions
```

## Environment Setup

### Required for Production
```bash
# .env
DATABASE_URL=postgresql://user:pass@host:5432/milestone
SESSION_SECRET=your-64-char-random-string
```

### Required for Multi-Tenant
```bash
MULTI_TENANT=true
MASTER_DATABASE_URL=postgresql://user:pass@host:5432/milestone_master
TENANT_ENCRYPTION_KEY=your-64-char-hex-string
PG_ADMIN_USER=postgres
PG_ADMIN_PASSWORD=admin-password
```

### Generate Secure Keys
```bash
# Session secret
python -c "import secrets; print(secrets.token_hex(32))"

# Encryption key
python -c "import secrets; print(secrets.token_hex(32))"
```

## Troubleshooting

### Frontend changes not appearing

1. Make sure you ran `npm run build`
2. Make sure you ran `./deploy-react.sh`
3. Hard refresh browser: `Ctrl+Shift+R`
4. Check browser console for errors
5. Verify files in `public/`:
   ```bash
   ls -la public/
   ls -la public/assets/
   ```

### API errors

```bash
# Check backend logs
docker logs milestone

# Test API endpoint
curl http://localhost:8485/api/health

# Check API docs
open http://localhost:8485/api/docs
```

### Container won't start

```bash
# Check logs
docker-compose logs

# Rebuild from scratch
docker-compose down
docker-compose up -d --build
```

### Database connection issues

```bash
# Test connection
docker exec milestone python -c "from app.database import engine; print(engine.url)"

# Check environment
docker exec milestone env | grep DB
```

## Deployment Checklist

Before deploying to production:

- [ ] Update `.env` with production values
- [ ] Change `SESSION_SECRET` to a secure random value
- [ ] Change `TENANT_ENCRYPTION_KEY` if using multi-tenant
- [ ] Set `DEBUG=false`
- [ ] Configure proper database credentials
- [ ] Set up SSL/TLS (via reverse proxy)
- [ ] Configure backup strategy for database
- [ ] Set up monitoring/logging
