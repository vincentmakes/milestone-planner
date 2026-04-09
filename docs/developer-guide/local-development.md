# Local Development

## Prerequisites

- Docker and Docker Compose
- Python 3.11+ (for backend development without Docker)
- Node.js 20+ (for frontend development)
- PostgreSQL 15+ (or use Docker)

## Quick Start with GitHub Codespaces

The fastest way to get a development environment:

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/vincentmakes/milestone-planner?quickstart=1)

Everything is pre-configured: Python, Node.js, PostgreSQL, VS Code extensions.

## Local Setup

### 1. Clone and Configure

```bash
git clone https://github.com/vincentmakes/milestone-planner.git
cd milestone-planner
cp .env.example .env
# Edit .env with your database credentials
```

### 2. Start Dependencies

```bash
# Option A: Use docker-compose.fresh.yml (includes PostgreSQL)
docker compose -f docker-compose.fresh.yml up -d db

# Option B: Use an existing PostgreSQL instance
psql -U postgres -f setup_databases.sql
```

### 3. Backend Development

```bash
# Install Python dependencies
pip install -r requirements.txt -r requirements-dev.txt

# Start with hot reload
uvicorn app.main:app --host 0.0.0.0 --port 8485 --reload
```

### 4. Frontend Development

```bash
cd frontend
npm install
npm run dev
# Access at http://localhost:3333/
```

!!! note
    Tenant routes (`/t/{slug}/`) don't work on the Vite dev server (port 3333). Use port 8485 for tenant features.

## Development Options

### Option 1: Without Hot Reload

Build, deploy, refresh:

```bash
# Build frontend
docker run --rm -v $(pwd)/frontend:/app -w /app node:20-alpine sh -c "npm install && npm run build"

# Deploy to public/
./deploy-react.sh

# Hard refresh: Ctrl+Shift+R
```

### Option 2: Docker Compose Dev

```bash
docker compose -f docker-compose.dev.yml up -d
# Access at http://localhost:3333/
```

### Option 3: Full Docker

```bash
docker compose -f docker-compose.fresh.yml up -d
# Access at http://localhost:8486/
```

## Testing

### Backend Tests

```bash
# Local
pytest --cov=app --cov-report=term-missing

# Docker
docker exec milestone pytest
```

### Frontend Tests

```bash
cd frontend
npm test              # Watch mode
npx vitest run        # Single run
npm run test:coverage # With coverage
```

### Linting

```bash
# Backend
ruff check app/
ruff format --check app/
mypy app/

# Frontend
cd frontend && npm run lint
```

## CI/CD

GitHub Actions run on every push to `main` and on pull requests:

| Workflow | Jobs |
|----------|------|
| `backend.yml` | Ruff lint + format, pytest with coverage, mypy type checking |
| `frontend.yml` | ESLint, Vitest, TypeScript build |
| `docker.yml` | Docker image build |
| `docs.yml` | MkDocs build and deploy to Cloudflare Pages |
