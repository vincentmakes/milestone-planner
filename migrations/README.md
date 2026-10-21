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

A pure-psql loop over all active tenants also exists for environments where running the Python runner is impractical. It requires the migration file as its argument (there is no default) and stops each tenant's run at the first error:

```bash
PG_HOST=... PG_USER=postgres ./migrations/migrate_all_tenants.sh migrations/add_kanban_tables.sql
```

### Master Database Migrations

Migrations that target the **master database** (multi-tenant admin DB) use a dedicated runner that executes statement-by-statement (safely preserving `DO $$ ... END $$;` blocks — covered by `tests/test_migration_parser.py`):

```bash
python migrations/run_migration_master.py add_organizations
```

In single-tenant mode it falls back to the main `DB_*` database.

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

The authoritative list is the set of `.sql` files in this folder — run either runner with no argument to list them.

| Migration | Target | Description |
|-----------|--------|-------------|
| `add_absence_types_and_event_sites` | tenant | Adds absence_types (seeded), vacations.absence_type_id (existing rows → "Holidays"), and company_event_sites for multi-site events |
| `add_company_events` | tenant | Adds company_events table for non-working-day events |
| `add_company_event_color` | tenant | Adds color column to company_events |
| `add_custom_columns` | tenant | Adds custom_columns and custom_column_values tables (EAV pattern) |
| `add_equipment_blocks` | tenant | Adds equipment_blocks table (maintenance/unavailability) |
| `add_equipment_sites_and_site_closures` | tenant | Adds equipment_sites for multi-site equipment (back-filled from equipment.site_id) and company_events.counts_as_unavailable (site closures) |
| `add_is_system_column` | tenant | Adds is_system flag to protect system users from deletion |
| `add_kanban_tables` | tenant | Adds Kanban card status (back-filled from completion), card_comments and notifications |
| `add_organizations` | **master** | Adds organizations + organization_sso_config tables and tenant columns |
| `add_project_presence` | tenant | Adds project_presence table (active viewers) |
| `add_skills_tables` | tenant | Adds skills and user_skills tables for capability tracking |
| `add_staff_notes` | tenant | Creates staff_notes (migrates rows from and drops the legacy `notes` table) |
| `add_tags_tables` | tenant | Adds tags and project_tags tables |
| `add_teams` | tenant | Adds teams (one site each, name unique per site), team_members, and the project_teams / tag_teams / company_event_teams / equipment_teams links; every FK cascades (1.12.0) |
| `add_tag_groups_and_sites` | tenant | Adds tag_groups (single-select groups) and tag_sites, plus tags.group_id / all_sites / sort_order (existing tags stay ungrouped and available at every site) |
| `card_comments_author_set_null` | tenant | Makes card_comments.author_id nullable with ON DELETE SET NULL, so deleting a user keeps their comments |
| `cleanup_orphaned_values` | tenant | Removes custom-column values and card comments whose project/phase/subphase no longer exists |
| `projects_site_fk_cascade` | tenant | Makes the projects.site_id FK ON DELETE CASCADE (deleting a site deletes its projects, as the app does) |
| `upgrade_to_v90` | tenant | Legacy comprehensive upgrade from the Node.js era (superseded by the files above and the tenant auto-migration) |

Some tenant migrations also run automatically when a tenant's connection pool is created (and at single-tenant startup): `add_tag_groups_and_sites` and `add_teams` via `tenant_manager._run_auto_migrations` (`app/services/tenant_manager.py`), and `card_comments_author_set_null`, `cleanup_orphaned_values`, `projects_site_fk_cascade` via `app/services/tenant_data_migrations.py`. In both cases the SQL is shared with `app/services/tenant_provisioner.py`.

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
