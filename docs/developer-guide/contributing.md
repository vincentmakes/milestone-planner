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
