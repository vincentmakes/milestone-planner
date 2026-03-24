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

After deploying code with database schema changes:

```bash
# Preview what would be migrated
python scripts/migrate_all_tenants.py --dry-run

# Run migrations on all tenants
python scripts/migrate_all_tenants.py

# Migrate a specific tenant only
python scripts/migrate_all_tenants.py --tenant acme-corp

# Include master database
python scripts/migrate_all_tenants.py --include-master
```

### Single Tenant Migration

For single-tenant mode or manual migrations:

```bash
# Standard Alembic migration
alembic upgrade head
```

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
| `migrate_all_tenants.py` | Run migrations on all tenant databases |
| `seed_tenant_data.py` | Seed a tenant with sample data |
| `sql/milestone_master_fresh_install.sql` | Master database schema |
| `sql/tenant_schema_template.sql` | Tenant database schema reference |

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
# Check the specific tenant
python scripts/migrate_all_tenants.py --tenant problem-tenant --verbose

# Manually inspect the database
psql -U postgres -d milestone_problem_tenant
```
