# Local Development

## Prerequisites

- Docker and Docker Compose
- Python 3.11+ (for backend development without Docker)
- Node.js 24 (for frontend development)
- PostgreSQL 15+ (or use Docker)

## Quick Start with GitHub Codespaces

The fastest way to get a development environment:

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/vincentmakes/milestone-planner?quickstart=1)

Everything is pre-configured: Python, Node.js, PostgreSQL, VS Code extensions, and a pre-seeded demo tenant.

| Access | URL | Email | Password |
|--------|-----|-------|----------|
| **Admin Portal** | `/admin/` | `admin@demo.local` | `demo1234` |
| **Demo Tenant** | `/t/demo/` | `admin@demo.local` | `demo1234` |

All demo staff accounts also use password `demo1234`.

## Local Setup

### 1. Clone and Configure

```bash
git clone https://github.com/vincentmakes/milestone-planner.git
cd milestone-planner
cp .env.example .env
# Edit .env with your database credentials and a SESSION_SECRET
```

`SESSION_SECRET` ships empty in `.env.example` and is **required**: with `DEBUG=false` the
backend refuses to start on an empty or published example value, and
`docker-compose.fresh.yml` refuses to start without it (even for `up -d db`, since compose
interpolates the whole file). Generate one with
`python -c "import secrets; print(secrets.token_hex(32))"`. For a throwaway local backend,
`DEBUG=true` also lets it start with an insecure secret (a warning is logged).

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
docker run --rm -v $(pwd)/frontend:/app -w /app node:24-alpine sh -c "npm install && npm run build"

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
# Local, with coverage (fails below the floor in pyproject.toml)
pytest --cov=app --cov-report=term-missing --cov-report=xml

# Coverage of the lines your branch changes (what CI checks on a PR)
pip install diff-cover
diff-cover coverage.xml --compare-branch=origin/main

# Docker
docker exec milestone pytest
```

### Frontend Tests

```bash
cd frontend
npm test              # Watch mode
npx vitest run        # Single run
npm run test:coverage # Single run with coverage (fails below the floors in vitest.config.ts)

# Coverage of the lines your branch changes (run from frontend/)
diff-cover coverage/lcov.info --compare-branch=origin/main
```

Compare against the branch your pull request targets — `origin/main` in most cases.

### Coverage gates

Every new feature and bug fix ships with automated tests in the same pull request. CI enforces it in two ways:

- **Changed lines**: on every pull request, `diff-cover` fails the backend or frontend test job when less than **80 %** of the lines the PR adds or changes are covered by tests.
- **Suite floors**: `fail_under` in `pyproject.toml` and `coverage.thresholds` in `frontend/vitest.config.ts` sit just under the measured totals. Raise them in a PR that lifts coverage; never lower them, and never exclude a file to get past one — every frontend `src/**` file is measured, whether a test imports it or not.

Both test jobs write a coverage table to the GitHub Actions job summary. On push to `main`, a `Coverage Badges` job publishes the totals to the `coverage` branch, which the README badges read.

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

GitHub Actions run on every push to `main` and on every pull request, whatever branch it targets (the two dependency-audit jobs also run on weekly crons; the version check runs only on pull requests to `main`):

| Workflow | Jobs |
|----------|------|
| `backend.yml` | `pip-audit` dependency audit (blocking), Ruff lint + format, pytest with coverage (suite floor; diff-cover ≥ 80 % on changed lines in PRs), mypy type checking; `Coverage Badges` on push to `main` |
| `frontend.yml` | `npm audit --audit-level=moderate` (blocking), ESLint, Vitest with coverage (suite floors; diff-cover ≥ 80 % on changed lines in PRs), TypeScript build; `Coverage Badges` on push to `main` |
| `docker.yml` | Docker image build |
| `version-check.yml` | Pull requests to `main`: fails those that touch app code without a `VERSION` bump and matching `CHANGELOG.md` entry |

The coverage badges are generated data on the orphan `coverage` branch, written only by the `Coverage Badges` jobs — never edit it by hand.

Documentation is **not** built by GitHub Actions — Cloudflare Pages builds and deploys the MkDocs site from `docs/build.sh` on push.
