# Database Migrations

This folder contains database migration scripts for Milestone.

## Running Migrations

### From Docker (Recommended)

```bash
# Run a specific migration
docker exec -it milestone python /app/migrations/run_migration.py add_company_events

# List available migrations
docker exec -it milestone python /app/migrations/run_migration.py
```

### Locally

```bash
# From the project root
python -m migrations.run_migration add_company_events

# Or using the shell script
./migrations/run_migration.sh add_company_events
```

## How It Works

The migration runner automatically detects deployment mode:

- **Single-tenant mode**: Runs migration against the main database (`DB_NAME`)
- **Multi-tenant mode**: Runs migration against ALL active tenant databases

### Environment Variables

The migration runner uses these environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `DB_HOST` | Database host | `localhost` |
| `DB_PORT` | Database port | `5432` |
| `DB_NAME` | Main database name (single-tenant) | `milestone_dev` |
| `DB_USER` | Database user (single-tenant) | `milestone_dev_user` |
| `DB_PASSWORD` | Database password | `devpassword` |
| `MULTI_TENANT` | Enable multi-tenant mode | `false` |
| `MASTER_DB_NAME` | Master database name | `milestone_admin` |
| `MASTER_DB_HOST` | Master database host | same as `DB_HOST` |
| `MASTER_DB_PORT` | Master database port | same as `DB_PORT` |
| `MASTER_DB_USER` | Master database user (needs read access to tenants table) | same as `DB_USER` |
| `MASTER_DB_PASSWORD` | Master database password | same as `DB_PASSWORD` |
| `PG_ADMIN_USER` | PostgreSQL admin user (has access to ALL databases) | - |
| `PG_ADMIN_PASSWORD` | PostgreSQL admin password | - |
| `TENANT_ENCRYPTION_KEY` | Key for decrypting tenant passwords (if not using PG_ADMIN) | - |

**Recommended for multi-tenant**: Set `PG_ADMIN_USER` and `PG_ADMIN_PASSWORD` to a PostgreSQL superuser or a user with access to all tenant databases. This is the simplest way to run migrations across all tenants.

## Creating New Migrations

1. Create a new `.sql` file in this folder with a descriptive name:
   ```
   migrations/add_new_feature.sql
   ```

2. Write idempotent SQL (use `IF NOT EXISTS`, `DO $$ ... $$` blocks):
   ```sql
   CREATE TABLE IF NOT EXISTS new_table (
     id SERIAL PRIMARY KEY,
     ...
   );
   ```

3. Run the migration:
   ```bash
   docker exec -it milestone python /app/migrations/run_migration.py add_new_feature
   ```

## Available Migrations

| Migration | Description |
|-----------|-------------|
| `add_company_events` | Adds company_events table for non-working-day events |
| `add_custom_columns` | Adds custom_columns and custom_column_values tables for EAV pattern |
| `add_is_system_column` | Adds is_system flag to protect system users from deletion |
| `add_skills_tables` | Adds skills and user_skills tables for capability tracking |

### Additional Migrations (in scripts/sql/migrations/)

| Migration | Description |
|-----------|-------------|
| `001_add_max_capacity` | Adds max_capacity column to users table for part-time staff |

## Fresh Installation

For a fresh installation, use the scripts in `scripts/`:

```bash
# Run the fresh install script
python scripts/fresh_install.py --pg-user postgres --pg-password yourpassword
```

This creates the master database and sets up the admin panel. Tenants are then created through the admin panel, which automatically applies the full schema.
