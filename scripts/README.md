# Milestone Scripts

This directory contains utility scripts for managing Milestone installations.

## Fresh Installation

### Option 1: Automated Setup (Recommended)

```bash
# Run the automated installer
python scripts/fresh_install.py

# With options
python scripts/fresh_install.py \
  --pg-host localhost \
  --pg-port 5432 \
  --pg-user postgres \
  --admin-email admin@mycompany.com
```

This will:
1. Create `milestone_master` database
2. Create `milestone_dev` database (optional)
3. Set up all required tables
4. Create admin user with your password
5. Generate `.env` file

### Option 2: Manual SQL Setup

```bash
# 1. Run the SQL script
psql -U postgres -f scripts/sql/milestone_master_fresh_install.sql

# 2. Set admin password
python scripts/setup_admin_password.py

# 3. Configure .env file manually (see .env.example)
```

## Database Migrations

### Upgrading Existing Installations

When upgrading an existing installation to the latest version:

```bash
# Run the comprehensive upgrade migration
docker exec -it milestone python /app/migrations/run_migration.py upgrade_to_v90

# Or from the project root
python -m migrations.run_migration upgrade_to_v90
```

This will apply all schema changes since the initial release.

### Migrating All Tenants

After deploying code with database schema changes, run the tenant migration runner — in multi-tenant mode it automatically applies the migration to **every active tenant** listed in the master database:

```bash
# Apply a migration to all active tenants (or the single DB in single-tenant mode)
python -m migrations.run_migration <migration_name>

# List available migrations
python -m migrations.run_migration
```

For master-database migrations use the dedicated runner:

```bash
python migrations/run_migration_master.py <migration_name>
```

A pure-psql fallback loop also exists at `migrations/migrate_all_tenants.sh`. See [migrations/README.md](../migrations/README.md) for credentials and details. There is **no Alembic** in this project — migrations are raw idempotent SQL files.

## Seeding Data

### Seed a Tenant with Sample Data

```bash
python scripts/seed_tenant_data.py --tenant acme-corp
```

## Script Reference

| Script | Purpose |
|--------|---------|
| `fresh_install.py` | Automated fresh installation |
| `setup_admin_password.py` | Set/reset admin password |
| `seed_tenant_data.py` | Seed a tenant with sample data |
| `screenshots/` | Playwright pipeline for the MkDocs documentation screenshots |
| `sql/milestone_master_fresh_install.sql` | Master database schema |
| `sql/tenant_schema_template.sql` | Tenant database schema reference |
| `sql/migrations/001_add_max_capacity.sql` | Legacy migration (max_capacity column on users) |

Tenant/master migrations live in [`migrations/`](../migrations/) at the repo root, not here.

## Environment Variables

Required for multi-tenant mode:

```env
MULTI_TENANT=true

# Master database
MASTER_DB_HOST=localhost
MASTER_DB_PORT=5432
MASTER_DB_NAME=milestone_master
MASTER_DB_USER=postgres
MASTER_DB_PASSWORD=your_password

# PostgreSQL admin (for provisioning)
PG_ADMIN_USER=postgres
PG_ADMIN_PASSWORD=your_password
```

## Troubleshooting

### "Permission denied" errors
Make sure the PostgreSQL user has CREATEDB and CREATEROLE privileges:
```sql
ALTER USER postgres WITH CREATEDB CREATEROLE;
```

### "Database does not exist"
Run fresh_install.py or the SQL script first.

### "Connection refused"
Check that PostgreSQL is running and accepting connections on the configured host/port.

### Migration fails on specific tenant
```bash
# Re-run the migration (it is idempotent) and read the per-tenant output
python -m migrations.run_migration <migration_name>

# Manually inspect the tenant database
psql -U postgres -d milestone_problem_tenant
```
