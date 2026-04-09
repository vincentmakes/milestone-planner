# Database & Migrations

## Database Architecture

Milestone uses PostgreSQL 15+ with two database tiers:

| Database | Purpose | SQLAlchemy Base |
|----------|---------|-----------------|
| `milestone_admin` | Master DB: tenants, admin users, organizations, SSO config | `MasterBase` |
| `milestone_<slug>` | Per-tenant: projects, users, staff, equipment, settings | `Base` |

In single-tenant mode, only the tenant database is used.

## Schema Management

The canonical schema is defined in `setup_databases.sql`. This file must stay in sync with SQLAlchemy models.

### Fresh Install

```bash
# Apply the full schema
psql -U postgres -f setup_databases.sql
```

### Auto-Initialization

When `AUTO_INIT_DB=true` is set (used by `docker-compose.fresh.yml`), the entrypoint script runs `app.scripts.init_db` which:

1. Creates the database if it doesn't exist
2. Applies the schema
3. Seeds default settings and admin user

The master database schema is also auto-applied on startup by `master_db.init_db()`.

## Migrations

Migrations are raw SQL files in the `migrations/` directory (no Alembic).

### Running Migrations

```bash
# Tenant databases (applies to all tenants)
python migrations/run_migration.py <migration_name>

# Master database only
python migrations/run_migration_master.py <migration_name>

# Or use the shell script
bash migrations/run_migration.sh <migration_name>
```

### Available Migrations

| Migration | Target | Description |
|-----------|--------|-------------|
| `add_organizations` | Master | Organization and SSO tables |
| `add_skills_tables` | Tenant | Skills management |
| `add_custom_columns` | Tenant | Custom column support |
| `add_company_events` | Tenant | Company events on timeline |
| `add_project_presence` | Tenant | Real-time presence tracking |
| `add_is_system_column` | Tenant | System column flag |
| `upgrade_to_v90` | Tenant | Major version upgrade |

### Writing New Migrations

1. Create a SQL file in `migrations/` (e.g., `add_feature_x.sql`)
2. Use idempotent SQL (check before creating):

    ```sql
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'projects' AND column_name = 'new_field'
        ) THEN
            ALTER TABLE projects ADD COLUMN new_field TEXT;
        END IF;
    END $$;
    ```

3. Run the migration: `python migrations/run_migration.py add_feature_x`
4. Update `setup_databases.sql` to include the new schema

!!! warning
    The `run_migration_master.py` script splits SQL on `;` which breaks `DO $$ ... END $$;` blocks. For master DB migrations with PL/pgSQL blocks, use `psql` directly or `run_migration.py`.

## Backup & Recovery

See [Backup & Recovery](backup-recovery.md) for detailed backup procedures.

## Connection Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | Database host |
| `DB_PORT` | `5432` | Database port |
| `DB_NAME` | `milestone` | Database name |
| `DB_USER` | `milestone` | Database user |
| `DB_PASSWORD` | — | Database password |
| `DB_SSL` | `false` | Enable SSL connections |
| `DB_POOL_SIZE` | `20` | Connection pool size |
| `DB_POOL_MAX_OVERFLOW` | `10` | Max overflow connections |
| `DB_POOL_TIMEOUT` | `30` | Pool checkout timeout (seconds) |
