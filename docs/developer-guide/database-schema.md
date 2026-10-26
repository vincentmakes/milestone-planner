# Database schema and migrations

Every table of the tenant databases and of the master database, with its model and the rules its columns carry, followed by the migration history: the raw SQL files, the runners, and what the tenant and master auto-migrations apply on upgrade. It was moved verbatim out of the repo-root [`CLAUDE.md`](https://github.com/vincentmakes/milestone-planner/blob/main/CLAUDE.md); the schema-change checklist stays there. The admin-facing notes are in [Database & Migrations](../admin-guide/database.md).

Code described: `app/models/`, `app/database.py`, `setup_databases.sql`, `migrations/`, `app/services/tenant_provisioner.py`, `app/services/tenant_manager.py`, `app/services/tenant_data_migrations.py`, `app/services/master_db.py`, `scripts/sql/tenant_schema_template.sql`.

## Database Schema

Two declarative bases: **`Base`** (tenant databases, `app/database.py`) and **`MasterBase`** (master database, `app/models/tenant.py`). Never mix them.

### Tenant database tables (one DB per tenant: `milestone_<slug>`)

**Users & access**

| Table | Model | Purpose |
|-------|-------|---------|
| `users` | `User` | App users *and* staff resources. email (unique), password, names, job_title, role CHECK(`admin`/`superuser`/`user`), `max_capacity` % (part-time), SSO fields, `active`, `is_system` (protects provisioned admin). Props: `full_name`, `is_admin`, `site_ids`, `can_modify_site()` |
| `user_sites` | `UserSite` | M:N user ↔ site (composite PK) |
| `sessions` | `Session` | express-session-compatible session store: `sid` PK, `sess` JSON text, `expired` (ms epoch) |
| `sso_config` | `SSOConfig` | Tenant-level SSO singleton (CHECK `id = 1`): enabled, Entra tenant/client id, `client_secret` (**AES-256-GCM encrypted**, legacy plaintext encrypted by the auto-migration — use the `sso.py` helpers), redirect URI, auto_create_users, default_role |

**Sites & calendar**

| Table | Model | Purpose |
|-------|-------|---------|
| `sites` | `Site` | Physical locations: name (unique), location, `city`, country/region codes, timezone, `active`, `last_holiday_fetch` |
| `bank_holidays` | `BankHoliday` | Public holidays per site (affect working-day calc); `date` + optional `end_date` (multi-day), `year` (NOT NULL); `is_custom` for manual, imported or edited entries (editing a Nager row sets `is_custom = 1`); refreshable from the Nager API — a refresh replaces only non-custom rows, only for the years the API actually returned (a failed year keeps its rows; `replace_existing` also clears stale years), and skips Nager entries on any day a custom holiday covers, or sharing a name (trimmed, case-insensitive) with a custom holiday of the same year (moved holidays) |
| `company_events` | `CompanyEvent` | Audits/meetings with color — displayed but do **not** affect working-day calc. `counts_as_unavailable` (BOOLEAN NOT NULL DEFAULT FALSE) marks a **site closure**: staff of the event's sites are unavailable for its dates (evaluated client-side). `site_id` is **legacy** (nullable, FK `ON DELETE SET NULL`), kept equal to the first linked site; site links live in `company_event_sites` |
| `company_event_sites` | `CompanyEventSite` | M:N event ↔ site (composite PK, both FKs CASCADE). Deleting a site deletes events left with no site |

**Projects**

| Table | Model | Purpose |
|-------|-------|---------|
| `projects` | `Project` | R&D projects: name, `site_id` (FK `ON DELETE CASCADE` — deleting a site deletes its projects), customer, `pm_id` (FK `users` `ON DELETE SET NULL`), `sales_pm` (free text), confirmed, volume, dates, notes, archived, `updated_at`; `tags` M:N |
| `project_phases` | `ProjectPhase` | Phases: project_id (CASCADE), `type` (name), dates, `is_milestone`, `sort_order`, `completion`, `status` (Kanban column), `dependencies` (JSON text) |
| `project_subphases` | `ProjectSubphase` | **Recursive** subphases: `parent_id` + `parent_type` CHECK(`phase`/`subphase`), `depth`, dates, milestone/completion/`status`/dependencies |
| `tag_groups` | `TagGroup` | Tag categories: name (unique), `single_select`, `sort_order`. Colouring the Gantt by a group is a per-user frontend preference (`viewStore.ganttColorBy`), not stored here |
| `tags` / `project_tags` | `Tag` / `ProjectTag` | Project tags: name (unique tenant-wide), color, `group_id` (FK `tag_groups` `ON DELETE SET NULL`), `all_sites` (default true), `sort_order` + M:N join with projects |
| `tag_sites` | `TagSite` | M:N tag ↔ site, consulted only when `all_sites = false` (both FKs CASCADE). Deleting a site deletes restricted tags left with no site |
| `custom_columns` | `CustomColumn` | User-defined Gantt columns: `column_type` CHECK(`text`/`boolean`/`list`), `list_options` JSON, site_id (NULL = global), display_order, width |
| `custom_column_values` | `CustomColumnValue` | EAV values: `entity_type` CHECK(`project`/`phase`/`subphase`) + entity_id, unique per (column, entity). No FK to the entity: project/site/phase/subphase deletes remove them explicitly, and orphans are cleaned by the tenant data migrations |

**Assignments** (three staff levels + equipment)

| Table | Model | Purpose |
|-------|-------|---------|
| `project_assignments` | `ProjectAssignment` | Project-level staff: allocation %, own start/end dates |
| `phase_staff_assignments` | `PhaseStaffAssignment` | Phase-level staff: allocation only (dates come from the phase) |
| `subphase_staff_assignments` | `SubphaseStaffAssignment` | Subphase-level staff: allocation only |
| `equipment_assignments` | `EquipmentAssignment` | Equipment bookings: project + equipment + dates (project-level only; tenants provisioned before 1.0.15 may carry unused legacy phase/subphase columns) |

**Resources & time-off**

| Table | Model | Purpose |
|-------|-------|---------|
| `equipment` | `Equipment` | Lab equipment: name, type (free-form string, managed via `/equipment-types`). `site_id` is **legacy** "primary site" (FK `ON DELETE SET NULL`), kept equal to the lowest linked site id; site links live in `equipment_sites` |
| `equipment_sites` | `EquipmentSite` | M:N equipment ↔ site (composite PK, both FKs CASCADE, index `idx_equipment_sites_site`). Deleting a site deletes only equipment left with no site and re-points survivors' `site_id` (`Site.equipment` has no delete cascade) |
| `equipment_blocks` | `EquipmentBlock` | Maintenance/unavailability windows (the vacation analogue for equipment) |
| `vacations` | `Vacation` | Staff time-off (absences). `absence_type_id` FK → `absence_types` (nullable, `ON DELETE SET NULL`; NULL = treated as unavailable). Recurring absences are encoded in `description` as `[R:0,2,4]` (days of week, 0=Sun) — parsed by `frontend/src/utils/recurringVacation.ts` |
| `absence_types` | `AbsenceType` | Tenant-wide absence categories: name (unique), color `#RRGGBB`, `counts_as_unavailable` (false = shown but capacity not reduced, e.g. Home Office), `sort_order`, `is_active`. Seeded when empty: Holidays, Home Office, Illness, Business Trip, Training |
| `skills` / `user_skills` | `Skill` / `UserSkill` | Global skills + M:N with proficiency CHECK(1–5) |

**Misc**

| Table | Model | Purpose |
|-------|-------|---------|
| `card_comments` | `CardComment` | Comments on Kanban cards. Polymorphic `(entity_type, entity_id)` → phase/subphase, `entity_type` CHECK(`phase`/`subphase`) (same shape as `custom_column_values`, so **no FK on `entity_id`** — phase/subphase deletes must clear them explicitly; orphans are cleaned by the tenant data migrations). `project_id` FK `ON DELETE CASCADE`. `body` stores `@[Name](id)` mention tokens; `mentioned_user_ids` (TEXT, JSON id list) is derived from them server-side. `author_id` is nullable, FK `ON DELETE SET NULL` (comments survive user deletion; UI shows "Deleted user") + `created_at`/`updated_at`. Indexes `idx_card_comments_entity`, `idx_card_comments_project` |
| `notifications` | `Notification` | Per-recipient inbox: `user_id` (FK CASCADE), `type` CHECK(`assigned`/`comment`/`mention`/`status_change`), `actor_id` (SET NULL), entity refs, `project_id` (FK CASCADE), rendered `title`/`body`, `read_at`. Indexes: partial `idx_notifications_user_unread` + `idx_notifications_user_created`. Due-soon/overdue are **derived client-side**, never stored |
| `staff_notes` | `Note` | Notes pinned to a site/date. Class is `Note` but tablename is **`staff_notes`**. All schema sources now create `staff_notes`; a legacy `notes` table on old installs is migrated and dropped by `migrations/add_staff_notes.sql` / the tenant auto-migration |
| `settings` | `Settings` | Instance key-value settings (e.g. `instance_title`, `show_weekends`) |
| `predefined_phases` | `PredefinedPhase` | Phase name templates offered in the UI |
| `project_presence` | `ProjectPresence` | Active-viewer rows (60s timeout). Written by the WS layer; presence has no HTTP API |

### Master database tables (`MASTER_DB_NAME`, app default `milestone_master`)

| Table | Model | Purpose |
|-------|-------|---------|
| `tenants` | `Tenant` | Tenant registry: UUID id, name, slug (unique), database_name/user, status (`active`/`suspended`/`pending`/`archived` — `TenantStatus` Literal in `app/schemas/tenant.py`; create/update/status/delete/provision reset the tenant cache, and all but create also close the pool, so changes apply immediately), plan/limits, `organization_id`, `required_group_ids` (JSONB) + `group_membership_mode` (`any`/`all`) for SSO group gating |
| `tenant_credentials` | `TenantCredentials` | Per-tenant DB password, AES-256-GCM encrypted (`iv:tag:ciphertext` hex) |
| `tenant_audit_log` | `TenantAuditLog` | Admin actions on tenants (actor, action, JSONB details) |
| `admin_users` | `AdminUser` | Portal admins: email, PBKDF2-SHA512 password hash (`pbkdf2_sha512$600000$salt$hash`; legacy `salt:hash` upgraded on login), role (`admin`/`superadmin`, `Literal`-validated), `must_change_password` (enforced by `get_current_admin`) |
| `admin_sessions` | `AdminSession` | Admin-portal session store (same shape as tenant `sessions`) |
| `organizations` | `Organization` | Groups tenants for shared SSO |
| `organization_sso_config` | `OrganizationSSOConfig` | Org-level Entra SSO: tenant/client id, encrypted secret, redirect URI, auto-create + default role |

### Migrations

- Raw idempotent SQL files in `migrations/` — **no Alembic**. See [`migrations/README.md`](https://github.com/vincentmakes/milestone-planner/blob/main/migrations/README.md). Shell wrappers `migrations/run_migration.sh` and `migrations/migrate_all_tenants.sh` exist for container use.
- **Tenant migrations**: `python migrations/run_migration.py <name>` — single-tenant: runs against `DB_NAME`; multi-tenant: iterates every `active` tenant from the master DB, connecting with `PG_ADMIN_*` (preferred) or the decrypted per-tenant credentials.
- **Master migrations**: `python migrations/run_migration_master.py <name>` — statement-by-statement execution via `split_sql_statements()`, which **correctly preserves `DO $$ ... END $$;` blocks** (covered by `tests/test_migration_parser.py`).
- The list of available migrations is the set of `.sql` files in `migrations/` — run either runner with no argument to list them. One stray legacy migration lives at `scripts/sql/migrations/001_add_max_capacity.sql`.
- **Auto-migrations run in two places** on top of the SQL files: `master_db._apply_pending_migrations()` (master schema drift, on startup) and `tenant_manager._run_auto_migrations()` (per-tenant drift, on first pool creation — and, in single-tenant mode, at startup via `run_single_tenant_auto_migrations()` in the lifespan). Both are idempotent. The tenant one ends with two non-DDL steps: `encrypt_tenant_sso_secret()` (legacy plaintext `sso_config.client_secret` → encrypted; needs the in-process key, so it cannot be a SQL file) and the Python data-migration hook `run_data_migrations()` (`app/services/tenant_data_migrations.py`: guarded FK rewrites `projects.site_id` → CASCADE, `card_comments.author_id` → nullable SET NULL, then orphan cleanup of `custom_column_values` / `card_comments`). Each step runs in its own transaction and never raises. The SQL lives in `tenant_provisioner` constants shared with the fresh-install schema and the `.sql` files — add new data fixes there, not inline.
- 1.6.0 migration: `add_tag_groups_and_sites.sql` (`tag_groups`, `tag_sites`, the three new `tags` columns; also applied by the tenant auto-migration via the provisioner's `TAGS_UPGRADE_SQL`).
- 1.5.0 migrations: `add_absence_types_and_event_sites.sql` (`absence_types`, `vacations.absence_type_id`, `company_event_sites`), `add_equipment_sites_and_site_closures.sql` (`equipment_sites`, `company_events.counts_as_unavailable`), plus `projects_site_fk_cascade.sql`, `card_comments_author_set_null.sql`, `cleanup_orphaned_values.sql` (all also applied automatically by the tenant auto-migration and the hook [above](#migrations)). `migrations/migrate_all_tenants.sh` now **requires** a migration file argument; the legacy `run_migration_all_tenants.sql` / `generate_tenant_migrations.sql` helpers (which created a wrong-shaped `company_events`) were removed.
- 1.4.0 migration: `add_kanban_tables.sql` (`status` + CHECK on `project_phases` / `project_subphases`, `card_comments`, `notifications`).
- `upgrade_to_v90.sql` is a **legacy** pre-1.0 catch-up script, superseded by the tenant auto-migrations; it adds nothing the models lack (`tests/test_follow_up_defaults.py` guards that).
- `setup_databases.sql` is the canonical fresh-install schema and must stay in sync with the models (see the schema-change checklist in [`CLAUDE.md`](https://github.com/vincentmakes/milestone-planner/blob/main/CLAUDE.md#backend-conventions)).
