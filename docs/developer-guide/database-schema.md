# Database schema and migrations

Every table of the tenant databases and of the master database, with its model and the rules its columns carry, followed by the migration history: the raw SQL files, the runners, and what the tenant and master auto-migrations apply on upgrade. It was moved verbatim out of the repo-root [`CLAUDE.md`](https://github.com/vincentmakes/milestone-planner/blob/main/CLAUDE.md); the schema-change checklist stays there. The admin-facing notes are in [Database & Migrations](../admin-guide/database.md).

Code described: `app/models/`, `app/database.py`, `setup_databases.sql`, `migrations/`, `app/services/tenant_provisioner.py`, `app/services/tenant_manager.py`, `app/services/tenant_data_migrations.py`, `app/services/master_db.py`, `scripts/sql/tenant_schema_template.sql`.

## Database Schema

Two declarative bases: **`Base`** (tenant databases, `app/database.py`) and **`MasterBase`** (master database, `app/models/tenant.py`). Never mix them.

### Tenant database tables (one DB per tenant: `milestone_<slug>`)

**Users & access**

| Table | Model | Purpose |
|-------|-------|---------|
| `users` | `User` | App users *and* staff resources. email (unique), password, names, job_title, `role` (FK → `roles.key`, `ON UPDATE CASCADE`; the old CHECK is gone), `max_capacity` % (part-time), SSO fields, `active`, `is_resource` ("Bookable as a resource": listed by `GET /staff` and bookable on projects; NOT NULL DEFAULT TRUE, admins FALSE on create and back-filled FALSE on upgrade), `is_system` (protects provisioned admin). Props: `full_name`, `is_admin` (`role == 'admin'`), `site_ids`, `team_ids`, `role_name` (correlated subquery on `roles.name`), `permissions` (the resolved `PermissionSet`, not mapped) |
| `user_sites` | `UserSite` | M:N user ↔ site (composite PK) |
| `sessions` | `Session` | express-session-compatible session store: `sid` PK, `sess` JSON text, `expired` (ms epoch) |
| `roles` / `role_permissions` | `Role` / `RolePermission` | Roles (`key` unique, `^[a-z][a-z0-9_]{1,19}$`, immutable; `name`, `is_system` for admin/superuser/user, `sort_order`) and their `{permission, mode}` rows (`allow`/`approval`; no row = deny; the admin role has none and holds everything in code). System roles and their defaults are seeded from the catalogue (`app/services/permissions.py`) |
| `approval_policies` / `approval_policy_roles` | `ApprovalPolicy` / `ApprovalPolicyRole` | Per approvable action (`assignments.self_*`): `pm_approves` + the approving roles (M:N, both FKs CASCADE). Seeded: PM approves, no roles |
| `approval_requests` | `ApprovalRequest` | Own-booking requests: requester (FK CASCADE), `action`, `project_id` (FK CASCADE), `level` + `target_id`, `assignment_id` (no FK, three tables), `requested`/`previous` JSON, `note`, `status` (`pending`/`approved`/`rejected`/`cancelled`/`superseded`/`expired`) + `close_reason`, `decided_by` (SET NULL), `decided_at`, `decision_note`, `superseded_by_id` |
| `sso_config` | `SSOConfig` | Tenant-level SSO singleton (CHECK `id = 1`): enabled, Entra tenant/client id, `client_secret` (**AES-256-GCM encrypted**, legacy plaintext encrypted by the auto-migration — use the `sso.py` helpers), redirect URI, auto_create_users, default_role |

**Sites & calendar**

| Table | Model | Purpose |
|-------|-------|---------|
| `sites` | `Site` | Physical locations: name (unique), location, `city`, country/region codes, timezone, `active`, `last_holiday_fetch` |
| `bank_holidays` | `BankHoliday` | Public holidays per site (affect working-day calc); `date` + optional `end_date` (multi-day), `year` (NOT NULL); `is_custom` for manual, imported or edited entries (editing a Nager row sets `is_custom = 1`); refreshable from the Nager API — a refresh replaces only non-custom rows, only for the years the API actually returned (a failed year keeps its rows; `replace_existing` also clears stale years), and skips Nager entries on any day a custom holiday covers, or sharing a name (trimmed, case-insensitive) with a custom holiday of the same year (moved holidays) |
| `company_events` | `CompanyEvent` | Audits/meetings with color — displayed but do **not** affect working-day calc. `counts_as_unavailable` (BOOLEAN NOT NULL DEFAULT FALSE) marks a **site closure**: staff of the event's sites are unavailable for its dates (evaluated client-side). `site_id` is **legacy** (nullable, FK `ON DELETE SET NULL`), kept equal to the first linked site; site links live in `company_event_sites` |
| `company_event_sites` | `CompanyEventSite` | M:N event ↔ site (composite PK, both FKs CASCADE). Deleting a site deletes events left with no site |

**Teams** (1.12.0, `app/models/team.py`; every FK `ON DELETE CASCADE`, so deleting a site or a team removes all its links)

| Table | Model | Purpose |
|-------|-------|---------|
| `teams` | `Team` | A named group of people at **one** site: `site_id`, name (unique per site, `teams_site_name_unique`), description, color, `active`. Inactive teams still scope everything; only the header filter hides them |
| `team_members` | `TeamMember` | M:N team ↔ user. A member must belong to the team's site (`user_sites`); removing a site from a user drops that site's memberships |
| `project_teams` | `ProjectTeam` | M:N project ↔ team; every team at the project's site (a site-less project has none) |
| `tag_teams` | `TagTeam` | M:N tag ↔ team. Per site: no team row at a site = the whole site; rows = only projects sharing one of those teams |
| `company_event_teams` | `CompanyEventTeam` | M:N event ↔ team, same per-site rule. A team-limited closure takes out only those teams' members (client-side) |
| `equipment_teams` | `EquipmentTeam` | M:N equipment ↔ team, same per-site rule |

**Projects**

| Table | Model | Purpose |
|-------|-------|---------|
| `projects` | `Project` | R&D projects: name, `site_id` (FK `ON DELETE CASCADE` — deleting a site deletes its projects), customer, `pm_id` (FK `users` `ON DELETE SET NULL`), `sales_pm` (free text), confirmed, volume, dates, notes, archived, `updated_at`; `tags` M:N; `field_values` / `field_selections` relationships (the read path uses `load_project_field_values` column queries instead) |
| `project_phases` | `ProjectPhase` | Phases: project_id (CASCADE), `type` (name), dates, `is_milestone`, `sort_order`, `completion`, `status` (Kanban column), `dependencies` (JSON text) |
| `project_subphases` | `ProjectSubphase` | **Recursive** subphases: `parent_id` + `parent_type` CHECK(`phase`/`subphase`), `depth`, dates, milestone/completion/`status`/dependencies |
| `tags` / `project_tags` | `Tag` / `ProjectTag` | Project tags: name (unique tenant-wide), color, `all_sites` (default true), `sort_order` + M:N join with projects (no group since 2.0.0: `tag_groups` and `tags.group_id` were converted into project fields and dropped) |
| `tag_sites` | `TagSite` | M:N tag ↔ site, consulted only when `all_sites = false` (both FKs CASCADE). Deleting a site deletes restricted tags left with no site |
| `project_fields` | `ProjectField` | Project fields (2.0.0): name (unique, case-insensitive in the API), `field_type` CHECK `project_fields_type_check` (`text`/`number`/`toggle`/`select`/`multiselect`, immutable), `sort_order`. Colouring / grouping the Gantt by a field is a per-user frontend preference, not stored here |
| `project_field_options` | `ProjectFieldOption` | Dropdown items: `field_id` (CASCADE), name (unique per field), color, `all_sites` (default true), `sort_order`; site / team limits in `project_field_option_sites` / `project_field_option_teams` (the `tag_sites` / `tag_teams` shape, every FK CASCADE). A site delete deletes items left with no site |
| `project_field_values` | `ProjectFieldValue` | One row per project and text/number/toggle field: `value_text` / `value_number` (DOUBLE PRECISION) / `value_bool`, UNIQUE (`field_id`, `project_id`); absent = empty |
| `project_field_selections` | (table) | Items chosen per project (`project_id`, `option_id`, `assigned_at`; the `project_tags` shape, FKs CASCADE); one per single-select field, enforced by the API |
| `custom_columns` | `CustomColumn` | User-defined Gantt columns: `column_type` CHECK(`text`/`boolean`/`list`), `list_options` JSON, site_id (NULL = global), display_order, width |
| `custom_column_values` | `CustomColumnValue` | EAV values: `entity_type` CHECK(`project`/`phase`/`subphase`) + entity_id, unique per (column, entity). No FK to the entity: project/site/phase/subphase deletes remove them explicitly, and orphans are cleaned by the tenant data migrations |

**Assignments** (three staff levels + equipment)

| Table | Model | Purpose |
|-------|-------|---------|
| `project_assignments` | `ProjectAssignment` | Project-level staff: allocation %, own start/end dates |
| `phase_staff_assignments` | `PhaseStaffAssignment` | Phase-level staff: allocation + optional own `start_date` / `end_date` (both NULL = **linked**, follows the phase; both set = an **unlinked segment** inside it; CHECK `phase_staff_assignments_segment_dates_check` = both or neither). Several non-overlapping rows per person per phase |
| `subphase_staff_assignments` | `SubphaseStaffAssignment` | Subphase-level staff: same shape and rules as the phase table (CHECK `subphase_staff_assignments_segment_dates_check`) |
| `equipment_assignments` | `EquipmentAssignment` | Equipment bookings: project + equipment + dates (project-level only; tenants provisioned before 1.0.15 may carry unused legacy phase/subphase columns) |

The three staff tables carry `approval_status` (`approved`/`pending`, a pending own booking — excluded from availability, capacity, card access and assignee notifications) and `approval_request_id` (FK `approval_requests` SET NULL: the open request on the row).

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
| `card_comments` | `CardComment` | Comment threads: a Kanban card's (phase/subphase, also shown in the booking dialog of that card) or, since 2.0.0, a project's (the thread of its project-level bookings). Polymorphic `(entity_type, entity_id)`, `entity_type` CHECK(`phase`/`subphase`/`project`) (`COMMENT_ENTITY_TYPES` in the model; same shape as `custom_column_values`, so **no FK on `entity_id`** — phase/subphase deletes must clear them explicitly; orphans are cleaned by the tenant data migrations; a project thread (`entity_id` = `project_id`) goes with the project through the FK cascade). `project_id` FK `ON DELETE CASCADE`. `body` stores `@[Name](id)` mention tokens; `mentioned_user_ids` (TEXT, JSON id list) is derived from them server-side. `author_id` is nullable, FK `ON DELETE SET NULL` (comments survive user deletion; UI shows "Deleted user") + `created_at`/`updated_at`. Indexes `idx_card_comments_entity`, `idx_card_comments_project` |
| `notifications` | `Notification` | Per-recipient inbox: `user_id` (FK CASCADE), `type` CHECK(`assigned`/`comment`/`mention`/`status_change`/`approval_requested`/`approval_decided`/`assignment_changed`/`project_changed` — one constant, `tenant_provisioner.NOTIFICATION_TYPES`), `actor_id` (SET NULL), entity refs (`entity_type` `phase`/`subphase`/`project`), `project_id` (FK CASCADE; NULL on the change notification of a project delete), rendered `title`/`body`, `read_at`. Indexes: partial `idx_notifications_user_unread` + `idx_notifications_user_created`. Due-soon/overdue are **derived client-side**, never stored |
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
- **Auto-migrations run in two places** on top of the SQL files: `master_db._apply_pending_migrations()` (master schema drift, on startup) and `tenant_manager._run_auto_migrations()` (per-tenant drift, on first pool creation — and, in single-tenant mode, at startup via `run_single_tenant_auto_migrations()` in the lifespan). Both are idempotent. The tenant one adds `users.is_resource` on every pool creation (`USERS_IS_RESOURCE_SQL`, early, right after the `is_system` step; the DO block is its own gate), then the booking-segment columns (`BOOKING_SEGMENT_COLUMN_STATEMENTS`, unconditional, one statement per execute), also widens the notification-type CHECK on **every** pool creation (`NOTIFICATIONS_TYPE_CHECK_SQL`, after the RBAC block: the DO block is its own gate — it replaces the constraint only when the newest type, `NOTIFICATION_TYPES[-1]`, is missing — so 1.13/1.14 tenants skipped by the RBAC probe get the 1.15 types), widens the `card_comments` entity-type CHECK with `project` (`PROJECT_COMMENTS_CHECK_SQL`, right after the card-comments step, its own gate like the notifications one, rolled back on failure), and ends with two non-DDL steps: `encrypt_tenant_sso_secret()` (legacy plaintext `sso_config.client_secret` → encrypted; needs the in-process key, so it cannot be a SQL file) and the Python data-migration hook `run_data_migrations()` (`app/services/tenant_data_migrations.py`: guarded FK rewrites `projects.site_id` → CASCADE, `card_comments.author_id` → nullable SET NULL, then orphan cleanup of `custom_column_values` / `card_comments`). Each step runs in its own transaction and never raises. The SQL lives in `tenant_provisioner` constants shared with the fresh-install schema and the `.sql` files — add new data fixes there, not inline.
- 2.0.0 migration: `add_project_comments.sql` (the `card_comments` entity-type CHECK gains `project`; the DO block `tenant_provisioner.PROJECT_COMMENTS_CHECK_SQL`, gated on the constraint lacking `project`, spliced verbatim after `CREATE TABLE card_comments` in every fresh-schema source and run by the tenant auto-migration). The unshipped `add_rbac.sql` / `add_change_notifications.sql` were edited in place when personal todos were removed (no `todos` table, no `todo_assigned` type); a database upgraded from a pre-release build keeps an unused `todos` table and the wider notification CHECK.
- 2.0.0 migration: `add_project_fields.sql` (the six project-field tables, then — only while `tag_groups` exists — one DO block `PROJECT_FIELDS_MIGRATION_SQL` converting each tag group into a field (`single_select` → `select`, else `multiselect`; a clashing name gets ` (tags)`, ` (tags 2)`, …), each grouped tag into an item with its sites/teams, each of their `project_tags` rows into a selection, then deleting the grouped tags, renumbering the rest and dropping `idx_tags_group`, `tags.group_id` and `tag_groups`). The tenant auto-migration runs the same statements after the teams step when `PROJECT_FIELDS_PROBE_SQL` finds a table missing or `tag_groups` still there. The conversion block is not in the fresh-schema sources (it only ever acts on an upgrade). `TAGS_UPGRADE_SQL` keeps its `group_id` block for pre-1.6 databases, guarded by `tag_groups` existing, and no longer creates `tag_groups`.
- 1.17.0 migration: `add_booking_segments.sql` (`start_date` / `end_date DATE NULL` on `phase_staff_assignments` / `subphase_staff_assignments` + the `<table>_segment_dates_check` CHECK, each added only when missing; the statements of `tenant_provisioner.BOOKING_SEGMENT_COLUMN_STATEMENTS`, also spliced into the fresh schema and run by the tenant auto-migration right after the `is_resource` step). Existing rows stay linked.
- 1.16.0 migration: `add_user_is_resource.sql` (`users.is_resource BOOLEAN NOT NULL DEFAULT TRUE`, admins back-filled FALSE, only when the column is missing; the same DO block as `tenant_provisioner.USERS_IS_RESOURCE_SQL`, part of `USERS_UPGRADE_SQL`, also run by the tenant auto-migration on every pool creation).
- 1.15.0 migration: `add_change_notifications.sql` (the notification-type CHECK widened to `assignment_changed` / `project_changed`; the same DO block as `NOTIFICATIONS_TYPE_CHECK_SQL`, idempotent, also applied by the tenant auto-migration step [above](#migrations)). Adding a type means extending `NOTIFICATION_TYPES` — the DO block's marker is its **last** entry, so a new type must go at the end or upgraded tenants keep the old CHECK (removing a middle type, as 2.0.0 did with `todo_assigned`, leaves upgraded tenants on the wider CHECK — harmless).
- 1.13.0 migration: `add_rbac.sql` (`roles`, `role_permissions`, `approval_policies`, `approval_policy_roles`, `approval_requests`, the assignment `approval_status` / `approval_request_id` columns, the widened notification types, `users.role` CHECK → FK; also applied by the tenant auto-migration, with the role/policy seed and the orphan cleanups — expired requests, orphan pending rows, stale pointers — in `run_data_migrations()`).
- 1.12.0 migration: `add_teams.sql` (`teams`, `team_members`, `project_teams`, `tag_teams`, `company_event_teams`, `equipment_teams`; every FK cascades; also applied by the tenant auto-migration via the provisioner's `TEAMS_SCHEMA_STATEMENTS`).
- 1.6.0 migration: `add_tag_groups_and_sites.sql` (`tag_groups`, `tag_sites`, the three new `tags` columns; the tenant auto-migration still applies `tag_sites` and the columns via `TAGS_UPGRADE_SQL`, no longer `tag_groups` — 2.0.0 converts and drops them).
- 1.5.0 migrations: `add_absence_types_and_event_sites.sql` (`absence_types`, `vacations.absence_type_id`, `company_event_sites`), `add_equipment_sites_and_site_closures.sql` (`equipment_sites`, `company_events.counts_as_unavailable`), plus `projects_site_fk_cascade.sql`, `card_comments_author_set_null.sql`, `cleanup_orphaned_values.sql` (all also applied automatically by the tenant auto-migration and the hook [above](#migrations)). `migrations/migrate_all_tenants.sh` now **requires** a migration file argument; the legacy `run_migration_all_tenants.sql` / `generate_tenant_migrations.sql` helpers (which created a wrong-shaped `company_events`) were removed.
- 1.4.0 migration: `add_kanban_tables.sql` (`status` + CHECK on `project_phases` / `project_subphases`, `card_comments`, `notifications`).
- `upgrade_to_v90.sql` is a **legacy** pre-1.0 catch-up script, superseded by the tenant auto-migrations; it adds nothing the models lack (`tests/test_follow_up_defaults.py` guards that).
- `setup_databases.sql` is the canonical fresh-install schema and must stay in sync with the models (see the schema-change checklist in [`CLAUDE.md`](https://github.com/vincentmakes/milestone-planner/blob/main/CLAUDE.md#backend-conventions)).
