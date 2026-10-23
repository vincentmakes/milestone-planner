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
      behind when projects or sites were deleted);
    - the roles seed of `add_rbac` (1.13.0): the three system roles with their default
      permissions and one approval policy per own-booking action, then `users.role` moves from
      a CHECK constraint to a foreign key on `roles.key`;
    - expiry of approval requests whose phase, subphase or booking is gone, removal of pending
      bookings whose request is closed, and clearing of stale request pointers on approved
      bookings.

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
| `add_tag_groups_and_sites` | Tenant | Tag groups, per-site tags (`tag_sites`) and the `group_id` / `all_sites` / `sort_order` tag columns (the groups are converted into project fields by `add_project_fields` since 2.0.0; the automatic upgrade no longer creates `tag_groups`) |
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
| `add_rbac` | Tenant | Roles and permissions, approval policies and requests for own bookings (1.13.0, also applied automatically on startup) — see below |
| `add_change_notifications` | Tenant | Widens the notification types with `assignment_changed` and `project_changed` (1.15.0, also applied automatically on startup) — see below |
| `add_user_is_resource` | Tenant | Adds `users.is_resource`, the "Bookable as a resource" flag (1.16.0, also applied automatically on startup) — see below |
| `add_booking_segments` | Tenant | Adds optional own dates to phase and subphase bookings (1.17.0, also applied automatically on startup) — see below |
| `add_project_fields` | Tenant | Project fields and their values; converts the tag groups into dropdown fields and drops `tag_groups` and `tags.group_id` (2.0.0, also applied automatically on startup; requires `add_teams`) — see below |
| `add_project_comments` | Tenant | Lets a project carry its own comment thread: the `card_comments` entity-type CHECK gains `project` (2.0.0, also applied automatically on startup) — see below |
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

### Teams (1.12.0)

`add_teams` is idempotent and, like the migrations above, also runs **automatically** (see [Automatic Tenant Upgrades](#automatic-tenant-upgrades)); `setup_databases.sql` and the tenant provisioner create the same schema for fresh installs. It creates:

- `teams` — a named group of people at **one** site (`site_id`, name unique per site, description, colour, `active`)
- `team_members` — which users belong to a team; a member must also belong to the team's site
- `project_teams`, `tag_teams`, `company_event_teams` and `equipment_teams` — the links that scope projects, tags, company events and equipment to teams. For tags, events and equipment the rule is per site: a site with none of the item's teams keeps the whole site

Every foreign key is `ON DELETE CASCADE`: deleting a site removes its teams, and deleting a team removes its memberships and links. Existing data is not touched — every project, tag, event and piece of equipment stays whole-site until someone assigns teams in [Settings → Teams](../user-guide/settings.md#teams).

```bash
python migrations/run_migration.py add_teams
```

### Roles and Approvals (1.13.0)

`add_rbac` is idempotent and also runs **automatically** (see [Automatic Tenant Upgrades](#automatic-tenant-upgrades)); `setup_databases.sql` and the tenant provisioner create the same schema for fresh installs. It:

- Creates `roles` (key, name, description, `is_system`, sort order) and `role_permissions` (one row per permission a role holds, mode `allow` or `approval`; no row means deny). The three system roles — Administrator, Superuser and User — are seeded with their default permissions, which reproduce what each role could do before 1.13.0. The defaults are written only when the role row is created, so permissions an admin has edited are never re-seeded
- Creates `approval_policies` and `approval_policy_roles` (who approves each own-booking action; seeded with "the project's manager approves" for all three) and `approval_requests` (one row per request, with its status and outcome)
- Adds `approval_status` and `approval_request_id` to the three staff assignment tables; every existing booking is `approved`
- Widens the notification types with `approval_requested` and `approval_decided`, and drops the default-role CHECK of the tenant SSO configuration (a custom role can be the SSO default)
- Replaces the `users.role` CHECK constraint with a foreign key to `roles.key` (`ON UPDATE CASCADE`, `ON DELETE RESTRICT`). A user whose role is not a known role key is reset to `user` first

Nobody's access changes on upgrade: existing admins, superusers and users keep the same rights through the seeded defaults, except that superusers now manage only the data of the sites they belong to (see [Roles & permissions](../user-guide/settings.md#roles-permissions)).

```bash
python migrations/run_migration.py add_rbac
```

### Change Notifications (1.15.0)

`add_change_notifications` widens the CHECK constraint on `notifications.type` with `assignment_changed` (someone else changed your booking) and `project_changed` (someone else changed a project you manage). It replaces the constraint only when `project_changed` is missing, so a second run changes nothing. The same step runs **automatically** every time a tenant's connection pool is created (see [Automatic Tenant Upgrades](#automatic-tenant-upgrades)) — including on tenants already upgraded to 1.13 or 1.14 — so running it by hand is optional. No data changes, and the new instance settings of 1.15.0 need no migration: a setting without a stored value reads as its default.

```bash
python migrations/run_migration.py add_change_notifications
```

### Bookable Users (1.16.0)

`add_user_is_resource` adds `users.is_resource` (`BOOLEAN NOT NULL DEFAULT TRUE`), the **Bookable as a resource** flag: only bookable people are listed in the Staff view and panel and can receive new bookings (see [Settings → Users](../user-guide/settings.md#bookable-as-a-resource)). When it adds the column it back-fills existing administrators as **not bookable** and leaves everyone else bookable, so the upgrade changes nobody's bookability. It does nothing when the column already exists, so a second run never resets a choice made since. The same step runs **automatically** every time a tenant's connection pool is created (see [Automatic Tenant Upgrades](#automatic-tenant-upgrades)), so running it by hand is optional.

```bash
python migrations/run_migration.py add_user_is_resource
```

### Booking Segments (1.17.0)

`add_booking_segments` adds `start_date` and `end_date` (`DATE`, nullable) to `phase_staff_assignments` and `subphase_staff_assignments`, with a CHECK (`<table>_segment_dates_check`) that both are empty or both set. Both empty is a **linked** booking that follows its phase or subphase — every existing booking stays that way, so the upgrade changes nobody's plan. Both set is an **unlinked** booking with its own dates inside the phase (see [Bookings on Phases and Subphases](../user-guide/gantt-charts.md#bookings-on-phases-and-subphases)). Each column and the CHECK are added only when missing. The same statements run **automatically** every time a tenant's connection pool is created (see [Automatic Tenant Upgrades](#automatic-tenant-upgrades)), so running it by hand is optional.

```bash
python migrations/run_migration.py add_booking_segments
```

### Project Fields (2.0.0)

`add_project_fields` creates the project-field tables — `project_fields` (name unique, `field_type` one of `text` / `number` / `toggle` / `select` / `multiselect`, `sort_order`), `project_field_options` (the dropdown items: name unique per field, colour, `all_sites`, `sort_order`), `project_field_option_sites` and `project_field_option_teams` (the items' site and team limits, shaped like `tag_sites` / `tag_teams`), `project_field_values` (one row per project and text, number or switch field) and `project_field_selections` (the items chosen per project, shaped like `project_tags`); every foreign key cascades. It needs the `teams` table (`add_teams`).

Then, **only while `tag_groups` exists**, one `DO` block converts the tag groups:

- each group becomes a field — `select` for a single-select group, `multiselect` otherwise — with the group's order; a name already used by a field gets ` (tags)` appended (then ` (tags 2)`, …);
- each grouped tag becomes an item of that field with its name, colour, `all_sites` and order, and its `tag_sites` / `tag_teams` rows become the item's site and team limits;
- every project carrying such a tag gets the item as a selection;
- the grouped tags are deleted (with their project, site and team links), the remaining tags are renumbered `0..n-1` by their order and name, and `idx_tags_group`, `tags.group_id` and `tag_groups` are dropped.

Ungrouped tags stay tags. **This is a breaking change** (hence 2.0.0): the `/api/tag-groups` routes are gone. Take a backup first; the conversion cannot be undone by a later migration. The same statements run **automatically** when a tenant's connection pool is created and a project-field table is missing or `tag_groups` still exists (see [Automatic Tenant Upgrades](#automatic-tenant-upgrades)), so running it by hand is optional, and a second run does nothing.

```bash
python migrations/run_migration.py add_project_fields
```

### Project Comment Threads (2.0.0)

`add_project_comments` widens the CHECK constraint on `card_comments.entity_type` (`card_comments_entity_type_check`) from `phase` / `subphase` to `phase` / `subphase` / `project`, so a project can carry its own comment thread — the thread shown in the dialog of its project-level bookings (see [Comments on a Booking](../user-guide/my-work.md#comments-on-a-booking)). A project thread's comments have `entity_type = 'project'` and `entity_id` = the project's id, and are deleted with the project through the `project_id` foreign key. It replaces the constraint only when `project` is missing, so a second run changes nothing. The same step runs **automatically** every time a tenant's connection pool is created (see [Automatic Tenant Upgrades](#automatic-tenant-upgrades)), so running it by hand is optional.

```bash
python migrations/run_migration.py add_project_comments
```

!!! note "Pre-release databases"
    Personal tasks (My Todos) were removed before 2.0.0 shipped, so `add_rbac` no longer creates a `todos` table and no migration names a `todo_assigned` notification type. A database upgraded from a pre-release 2.0.0 build keeps its unused `todos` table and the wider notification CHECK; nothing writes either any more.

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
