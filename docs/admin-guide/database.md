# Database & Migrations

## Database Architecture

Milestone uses PostgreSQL 15+ with two database tiers:

| Database | Purpose | SQLAlchemy Base |
|----------|---------|-----------------|
| `milestone_admin` | Master DB: tenants, admin users, organizations, SSO config | `MasterBase` |
| `milestone_<slug>` | Per-tenant: projects, users, staff, equipment, settings | `Base` |

In single-tenant mode, only the tenant database is used.

!!! note "Master database name"
    The master database name is whatever `MASTER_DB_NAME` is set to. The application's built-in default is `milestone_master`, but `docker-compose.fresh.yml` and the devcontainer set it to `milestone_admin`. Check your environment's `MASTER_DB_NAME` to know which name your installation uses; the examples in this guide use `milestone_admin`.

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

If `app.scripts.init_db` fails, the container **exits** with its error code instead of
starting the app on a half-initialised schema.

### Automatic Tenant Upgrades

On top of the SQL files below, every tenant database is brought up to date automatically:

- **Multi-tenant**: the first time the application opens a tenant's connection pool after
  start-up (`tenant_manager._run_auto_migrations`).
- **Single-tenant**: at every application start-up (`run_single_tenant_auto_migrations`),
  whether or not `AUTO_INIT_DB` is set. Before 1.5.0 single-tenant installs only got these
  upgrades when `AUTO_INIT_DB` re-applied the schema.

Every step is idempotent, runs in its own transaction and only logs a warning when it fails,
so one failing step never blocks start-up or the other steps. The last steps are not plain
DDL:

1. **Tenant SSO client secret encryption** — a plaintext `sso_config.client_secret` left by
   an earlier version is encrypted in place (this needs the in-process encryption key, so it
   cannot be a SQL file).
2. **Data migrations** (`app/services/tenant_data_migrations.py`, `run_data_migrations()`):
    - `projects.site_id` foreign key → `ON DELETE CASCADE` (deleting a site deletes its
      projects, at the database level as well as in the application);
    - `card_comments.author_id` → nullable, `ON DELETE SET NULL` (deleting a user keeps their
      Kanban comments, shown as *Deleted user*);
    - removal of orphaned `custom_column_values` and `card_comments` whose project, phase or
      subphase no longer exists (these rows have no foreign key; older releases left them
      behind when projects or sites were deleted).

    The foreign-key rewrites only run when the current constraint differs, and the cleanup
    logs how many rows it removed. The same SQL is available as the
    `projects_site_fk_cascade`, `card_comments_author_set_null` and
    `cleanup_orphaned_values` migrations for running by hand.

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

# Pure-psql loop over all active tenants (no Python); the file argument is required
PG_HOST=... PG_USER=... bash migrations/migrate_all_tenants.sh migrations/<migration_name>.sql
```

`migrate_all_tenants.sh` exits with an error (and lists the available files) when no
migration file is given — older versions silently fell back to a built-in
`company_events` definition of the wrong shape. The legacy helpers
`run_migration_all_tenants.sql` and `generate_tenant_migrations.sql` were removed for the
same reason; use `run_migration.py` instead.

### Available Migrations

| Migration | Target | Description |
|-----------|--------|-------------|
| `add_organizations` | Master | Organization and SSO tables |
| `add_skills_tables` | Tenant | Skills management |
| `add_custom_columns` | Tenant | Custom column support |
| `add_company_events` | Tenant | Company events on timeline |
| `add_company_event_color` | Tenant | Color column for company events |
| `add_equipment_blocks` | Tenant | Equipment maintenance blocks |
| `add_tags_tables` | Tenant | Project tags |
| `add_tag_groups_and_sites` | Tenant | Tag groups, per-site tags (`tag_sites`) and the `group_id` / `all_sites` / `sort_order` tag columns |
| `add_project_presence` | Tenant | Real-time presence tracking |
| `add_is_system_column` | Tenant | System column flag |
| `add_staff_notes` | Tenant | Staff notes table (migrates and drops the legacy `notes` table) |
| `add_kanban_tables` | Tenant | Kanban board: `status` column on `project_phases`/`project_subphases` (backfilled from `completion`), plus the `card_comments` and `notifications` tables |
| `add_absence_types_and_event_sites` | Tenant | Absence types and multi-site company events (1.5.0) — see below |
| `add_equipment_sites_and_site_closures` | Tenant | Multi-site equipment (`equipment_sites`) and site-closure events (`company_events.counts_as_unavailable`) (1.5.0) — see below |
| `projects_site_fk_cascade` | Tenant | `projects.site_id` FK → `ON DELETE CASCADE` (1.5.0, also automatic) |
| `card_comments_author_set_null` | Tenant | `card_comments.author_id` nullable, FK `ON DELETE SET NULL` (1.5.0, also automatic) |
| `cleanup_orphaned_values` | Tenant | Delete orphaned custom-column values and card comments (1.5.0, also automatic) |
| `add_teams` | Tenant | Teams per site, team membership and team scoping of projects, tags, equipment and company events (1.12.0, also applied automatically on startup) |
| `upgrade_to_v90` | Tenant | Major version upgrade |

### Absence Types and Multi-Site Events (1.5.0)

`add_absence_types_and_event_sites` is idempotent. The same steps also run **automatically** (see [Automatic Tenant Upgrades](#automatic-tenant-upgrades)) — in multi-tenant mode the first time the application connects to each tenant database after the upgrade, in single-tenant mode at start-up — so running it by hand is optional. It:

- Creates the `absence_types` table and, when the table is empty, seeds the default types: Holidays, Home Office (does not count as unavailable), Illness, Business Trip and Training
- Adds `vacations.absence_type_id` (nullable, `ON DELETE SET NULL`) and files every **existing absence under Holidays** — this backfill runs only together with the column creation, so a re-run never re-files absences
- Creates the `company_event_sites` junction table (if missing) and links every event that has no site link yet to its `site_id`, so every existing event keeps its site — this step runs on every execution, even when the table already exists, and never touches events that already have links
- Makes `company_events.site_id` nullable and re-points its foreign key to `ON DELETE SET NULL`. The column is now **legacy**: the application keeps it set to the event's first linked site for compatibility, but reads site links from `company_event_sites`

```bash
python migrations/run_migration.py add_absence_types_and_event_sites
```

With `AUTO_INIT_DB=true`, the container's start-up schema run also brings an older database up to date idempotently (it adds `absence_types`, `vacations.absence_type_id`, `company_event_sites` with its back-fill, and the `site_id` changes) — but it does **not** file existing absences under Holidays. If that schema run reached a single-tenant database before the migration, existing absences stay without a type (they still count as unavailable); the migration's one-time filing only runs when it adds the column itself. To file them under Holidays, run once: `UPDATE vacations SET absence_type_id = (SELECT id FROM absence_types WHERE name = 'Holidays') WHERE absence_type_id IS NULL;`

### Multi-Site Equipment and Site Closures (1.5.0)

`add_equipment_sites_and_site_closures` is idempotent and, like the migration above, also runs **automatically** (per tenant on first connection in multi-tenant mode, at start-up in single-tenant mode); `setup_databases.sql` and the tenant provisioner create the same schema for fresh installs. It:

- Creates the `equipment_sites` junction table — `(equipment_id, site_id)` composite primary key, both foreign keys `ON DELETE CASCADE`, index `idx_equipment_sites_site` — so one piece of equipment can belong to several sites
- Links every piece of equipment that has no site link yet to its `equipment.site_id`, so existing equipment keeps its site. This step runs on every execution and never touches equipment that already has links. `equipment.site_id` stays as a **legacy** "primary site" column, kept equal to the lowest linked site id
- Adds `company_events.counts_as_unavailable BOOLEAN NOT NULL DEFAULT FALSE`. `true` marks the event as a **site closure**: staff on the event's sites are unavailable for its dates. Existing events stay plain events

```bash
python migrations/run_migration.py add_equipment_sites_and_site_closures
```

After the upgrade, deleting a site only deletes equipment that is left without any site; equipment shared with another site is kept.

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

Both migration runners handle `DO $$ ... END $$;` blocks correctly — `run_migration_master.py` splits statements with a parser that preserves dollar-quoted blocks.

## Backup & Recovery

See [Backup & Recovery](backup-recovery.md) for detailed backup procedures.

## Connection Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | Database host |
| `DB_PORT` | `5432` | Database port |
| `DB_NAME` | `milestone_dev` | Database name |
| `DB_USER` | `milestone_dev_user` | Database user |
| `DB_PASSWORD` | — | Database password |
| `DB_SSL` | `false` | Enable SSL connections |
| `DB_POOL_SIZE` | `20` | Connection pool size |
| `DB_POOL_MAX_OVERFLOW` | `10` | Max overflow connections |
| `DB_POOL_TIMEOUT` | `30` | Pool checkout timeout (seconds) |
