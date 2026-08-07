# Contributing

## Development Workflow

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Run tests and linting locally
5. Submit a pull request

## Code Standards

### Backend (Python)

- **Formatter**: Ruff (`ruff format app/`)
- **Linter**: Ruff (`ruff check app/`)
- **Type checker**: mypy (`mypy app/`)
- **Tests**: pytest (`pytest --cov=app`)

### Frontend (TypeScript/React)

- **Linter**: ESLint (`npm run lint`)
- **Tests**: Vitest (`npm test`)
- **Build check**: `npm run build` (includes TypeScript compilation)

## Pull Request Checklist

- [ ] Backend tests pass (`pytest`)
- [ ] Frontend tests pass (`npm test`)
- [ ] Linting passes (Ruff, ESLint)
- [ ] Type checking passes (mypy, TypeScript)
- [ ] Docker build succeeds
- [ ] Database migrations included if schema changed
- [ ] `setup_databases.sql` updated if schema changed
- [ ] **`/VERSION` bumped** if the PR touches code paths listed in [Versioning & Changelog](#versioning-changelog)
- [ ] **`CHANGELOG.md` entry added** under a new `## [<version>] - YYYY-MM-DD` heading matching the bump

## Versioning & Changelog

This project uses [Semantic Versioning](https://semver.org/) and the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The **single source of truth for the version is `/VERSION`** (one line, e.g. `1.2.3`, no `v` prefix). The backend reads it at startup in [`app/__init__.py`](https://github.com/vincentmakes/milestone-planner/blob/main/app/__init__.py) and exposes it via `/health` and `/api/health`.

### When you MUST bump

Bump `/VERSION` and add a `CHANGELOG.md` entry — **in the same PR** — for any change to:

| Path | Why |
|---|---|
| `app/**` | Backend code |
| `frontend/src/**`, `frontend/package.json`, `frontend/package-lock.json`, `frontend/vite.config.ts`, `frontend/tsconfig*.json`, `frontend/index.html` | Frontend code/build |
| `migrations/**`, `setup_databases.sql` | DB schema |
| `Dockerfile`, `docker-compose*.yml` | Runtime / deployment |
| `scripts/**` | Operational scripts that ship with the app |
| `requirements*.txt`, `pyproject.toml` | Backend dependencies |

### When you must NOT bump

Changes confined to the following paths do **not** trigger a bump:

- `README.md`, `CLAUDE.md`, `CHANGELOG.md` itself
- `docs/**`, `mkdocs.yml`, `docs/requirements.txt` — MkDocs site
- `LICENSE.txt`, `.gitignore`, `.dockerignore`, `.editorconfig`
- `.github/**` — workflows and repo metadata
- `.devcontainer/**` — Codespaces config

### How to bump (SemVer)

| Bump type | Example | When |
|---|---|---|
| **PATCH** | `1.0.0` → `1.0.1` | Bug fix, no API or UX change |
| **MINOR** | `1.0.0` → `1.1.0` | New feature, backwards-compatible |
| **MAJOR** | `1.0.0` → `2.0.0` | Breaking change to the API, non-additive DB schema, env-var rename, etc. |

**One bump per PR**, not per commit. All commits in a feature branch share one version.

### CHANGELOG entry format

Add a new `## [<version>] - YYYY-MM-DD` heading at the top of `CHANGELOG.md`, under the preamble. Use only the categories that apply, in this order:

- **Added** — new features
- **Changed** — changes to existing behaviour
- **Deprecated** — features marked for removal
- **Removed** — features removed in this release
- **Fixed** — bug fixes
- **Security** — security-relevant fixes

Each entry is a single, human-readable line written from the user's perspective — not implementation detail. Do **not** use an `[Unreleased]` section; every change belongs to a concrete numbered release.

### CI gate

The workflow [`.github/workflows/version-check.yml`](https://github.com/vincentmakes/milestone-planner/blob/main/.github/workflows/version-check.yml) runs on every PR:

- It diffs the changed files against the "must bump" path list above.
- If any of those paths changed and `/VERSION` did **not** change, the check fails.
- If `/VERSION` changed but `CHANGELOG.md` does not contain a matching `## [<new-version>]` heading, the check fails.

The check is required to merge — there is no override. If the gate is wrong about your PR, fix the categorisation in the workflow rather than skipping it.

!!! note
    `frontend/package.json`'s `version` field is a **static placeholder** kept aligned with `/VERSION` at major releases. Do not edit it on every bump — only `/VERSION` is the source of truth, and the published release notes live in `CHANGELOG.md` (mirrored at [Release Notes](../release-notes.md)).

## Database Changes

When modifying the database schema:

1. Update the SQLAlchemy model in `app/models/`
2. Create a migration SQL file in `migrations/`
3. Update `setup_databases.sql` to reflect the new schema
4. Test the migration: `python migrations/run_migration.py <name>`

## Project Conventions

- Backend routes follow REST conventions
- Frontend uses Zustand for state management (not Redux)
- API clients are organized by resource in `frontend/src/api/endpoints/`
- Use `MasterBase` for master DB models, `Base` for tenant DB models
- Session-based authentication (no JWT tokens)
