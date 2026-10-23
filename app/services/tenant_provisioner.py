"""
Tenant Database Provisioner.

Handles creating and managing tenant PostgreSQL databases.
Schema matches Node.js application exactly.
"""

import logging
import re
from datetime import date
from typing import Any

import asyncpg

from app.config import get_settings
from app.scripts.demo_data import build_demo
from app.services.demo_seed import insert_demo_data
from app.services.encryption import generate_password, hash_user_password
from app.services.permissions import (
    APPROVABLE_KEYS,
    PERMISSIONS,
    SYSTEM_ROLES,
    build_default_role_permissions_sql,
)

logger = logging.getLogger(__name__)

# Default absence types, inserted only into an EMPTY absence_types table so a
# type an admin deleted is never re-created. Keep in sync with
# app.models.absence_type.DEFAULT_ABSENCE_TYPES (guarded by a test).
ABSENCE_TYPES_SEED_SQL = """
    INSERT INTO absence_types (name, color, counts_as_unavailable, sort_order)
    SELECT v.name, v.color, v.counts_as_unavailable, v.sort_order
    FROM (VALUES
      ('Holidays', '#8b5cf6', TRUE, 0),
      ('Home Office', '#0ea5e9', FALSE, 1),
      ('Illness', '#ef4444', TRUE, 2),
      ('Business Trip', '#f59e0b', TRUE, 3),
      ('Training', '#10b981', TRUE, 4)
    ) AS v(name, color, counts_as_unavailable, sort_order)
    WHERE NOT EXISTS (SELECT 1 FROM absence_types)
"""

# Re-point the legacy company_events.site_id FK from CASCADE to SET NULL:
# with multi-site events, deleting one site must not delete an event that is
# still linked to other sites. Idempotent; used by the tenant auto-migration.
COMPANY_EVENTS_SITE_FK_SQL = """
    DO $$
    DECLARE
        fk_name TEXT;
    BEGIN
        FOR fk_name IN
            SELECT c.conname
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.conrelid = to_regclass('public.company_events')
              AND c.contype = 'f'
              AND a.attname = 'site_id'
              AND c.confdeltype <> 'n'
        LOOP
            EXECUTE format('ALTER TABLE company_events DROP CONSTRAINT %I', fk_name);
        END LOOP;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.conrelid = to_regclass('public.company_events')
              AND c.contype = 'f'
              AND a.attname = 'site_id'
        ) THEN
            ALTER TABLE company_events ADD CONSTRAINT company_events_site_id_fkey
                FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;
        END IF;
    END $$;
"""


# Link every event that has no site link yet to its legacy company_events.site_id.
# Idempotent and safe to run on every upgrade: the app keeps site_id equal to
# one of the event's linked sites (and deletes events left without any site),
# so only events from before multi-site events -- or ones a crashed upgrade
# left behind -- are touched.
COMPANY_EVENT_SITES_BACKFILL_SQL = """
    INSERT INTO company_event_sites (event_id, site_id)
    SELECT e.id, e.site_id
    FROM company_events e
    WHERE e.site_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM company_event_sites s WHERE s.event_id = e.id)
    ON CONFLICT DO NOTHING
"""

# company_events.site_id became a nullable legacy column. Guarded so an
# already-migrated database does not take the ALTER TABLE lock again.
COMPANY_EVENTS_SITE_NULLABLE_SQL = """
    DO $$
    BEGIN
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'company_events'
              AND column_name = 'site_id' AND is_nullable = 'NO'
        ) THEN
            ALTER TABLE company_events ALTER COLUMN site_id DROP NOT NULL;
        END IF;
    END $$;
"""

# Make sure the legacy equipment.site_id FK is ON DELETE SET NULL. Deleting a
# site relies on it (Site.equipment is passive_deletes, no ORM cascade): shared
# equipment must survive losing one of its sites. Every schema source declares
# SET NULL, but an old tenant might carry a different delete rule -- or no FK.
# Same shape as COMPANY_EVENTS_SITE_FK_SQL: any site_id FK with another rule is
# dropped (whatever its name), and the SET NULL one is (re-)added if missing.
# site_id values pointing at a deleted site are cleared first, as SET NULL
# would have done, so adding the constraint cannot fail on them. Idempotent.
EQUIPMENT_SITE_FK_SQL = """
    DO $$
    DECLARE
        fk_name TEXT;
    BEGIN
        FOR fk_name IN
            SELECT c.conname
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.conrelid = to_regclass('public.equipment')
              AND c.contype = 'f'
              AND a.attname = 'site_id'
              AND c.confdeltype <> 'n'
        LOOP
            EXECUTE format('ALTER TABLE equipment DROP CONSTRAINT %I', fk_name);
        END LOOP;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.conrelid = to_regclass('public.equipment')
              AND c.contype = 'f'
              AND a.attname = 'site_id'
        ) THEN
            UPDATE equipment SET site_id = NULL
            WHERE site_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = equipment.site_id);
            ALTER TABLE equipment ADD CONSTRAINT equipment_site_id_fkey
                FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;
        END IF;
    END $$;
"""

# Whether EQUIPMENT_SITE_FK_SQL has anything to do: true when equipment.site_id
# has an FK with a delete rule other than SET NULL, or no FK at all. Lets the
# tenant auto-migration log only on the tenants it actually changes.
EQUIPMENT_SITE_FK_NEEDS_FIX_SQL = """
    SELECT
        EXISTS (
            SELECT 1
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.conrelid = to_regclass('public.equipment')
              AND c.contype = 'f'
              AND a.attname = 'site_id'
              AND c.confdeltype <> 'n'
        )
        OR NOT EXISTS (
            SELECT 1
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.conrelid = to_regclass('public.equipment')
              AND c.contype = 'f'
              AND a.attname = 'site_id'
        )
"""

# Link every piece of equipment that has no site link yet to its legacy
# equipment.site_id. Idempotent and safe to run on every upgrade, for the same
# reason as COMPANY_EVENT_SITES_BACKFILL_SQL: the app keeps site_id equal to one
# of the equipment's linked sites and deletes equipment left without any.
EQUIPMENT_SITES_BACKFILL_SQL = """
    INSERT INTO equipment_sites (equipment_id, site_id)
    SELECT e.id, e.site_id
    FROM equipment e
    WHERE e.site_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM equipment_sites s WHERE s.equipment_id = e.id)
    ON CONFLICT DO NOTHING
"""

# --- Delete rules that must match the ORM (guarded FK rewrites) -----------
# Same recipe as EQUIPMENT_SITE_FK_SQL: any FK on the column with another
# delete rule is dropped (whatever its name), and the wanted one is
# (re-)added if missing -- after clearing values that point at a deleted row,
# so adding the constraint cannot fail on them. Idempotent; a no-op when the
# FK is already right. Shared by get_tenant_schema_sql(), setup_databases.sql
# (inlined), the migrations/*.sql files and app.services.tenant_data_migrations.

# projects.site_id -> ON DELETE CASCADE. Deleting a site deletes its projects
# (Site.projects is cascade="all, delete-orphan" in the ORM, and the docs say
# so); the old SET NULL rule made a raw delete -- or a crash mid-flush --
# leave site-less projects nobody can see. Dangling ids (only possible on a
# database without any FK) are cleared rather than deleted: losing data is
# never the right default of an upgrade.
PROJECTS_SITE_FK_SQL = """
    DO $$
    DECLARE
        fk_name TEXT;
    BEGIN
        FOR fk_name IN
            SELECT c.conname
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.conrelid = to_regclass('public.projects')
              AND c.contype = 'f'
              AND a.attname = 'site_id'
              AND c.confdeltype <> 'c'
        LOOP
            EXECUTE format('ALTER TABLE projects DROP CONSTRAINT %I', fk_name);
        END LOOP;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.conrelid = to_regclass('public.projects')
              AND c.contype = 'f'
              AND a.attname = 'site_id'
        ) THEN
            UPDATE projects SET site_id = NULL
            WHERE site_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = projects.site_id);
            ALTER TABLE projects ADD CONSTRAINT projects_site_id_fkey
                FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;
        END IF;
    END $$;
"""

# Whether PROJECTS_SITE_FK_SQL has anything to do (logging only).
PROJECTS_SITE_FK_NEEDS_FIX_SQL = """
    SELECT
        EXISTS (
            SELECT 1
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.conrelid = to_regclass('public.projects')
              AND c.contype = 'f'
              AND a.attname = 'site_id'
              AND c.confdeltype <> 'c'
        )
        OR NOT EXISTS (
            SELECT 1
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.conrelid = to_regclass('public.projects')
              AND c.contype = 'f'
              AND a.attname = 'site_id'
        )
"""

# card_comments.author_id -> nullable, ON DELETE SET NULL. Deleting a user
# used to delete every comment they ever wrote from every thread; now the
# comment stays and is shown as written by a deleted user (author_name null),
# like notifications.actor_id. Skipped when card_comments does not exist yet.
CARD_COMMENTS_AUTHOR_FK_SQL = """
    DO $$
    DECLARE
        fk_name TEXT;
    BEGIN
        IF to_regclass('public.card_comments') IS NULL THEN
            RETURN;
        END IF;

        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'card_comments'
              AND column_name = 'author_id' AND is_nullable = 'NO'
        ) THEN
            ALTER TABLE card_comments ALTER COLUMN author_id DROP NOT NULL;
        END IF;

        FOR fk_name IN
            SELECT c.conname
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.conrelid = to_regclass('public.card_comments')
              AND c.contype = 'f'
              AND a.attname = 'author_id'
              AND c.confdeltype <> 'n'
        LOOP
            EXECUTE format('ALTER TABLE card_comments DROP CONSTRAINT %I', fk_name);
        END LOOP;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.conrelid = to_regclass('public.card_comments')
              AND c.contype = 'f'
              AND a.attname = 'author_id'
        ) THEN
            UPDATE card_comments SET author_id = NULL
            WHERE author_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = card_comments.author_id);
            ALTER TABLE card_comments ADD CONSTRAINT card_comments_author_id_fkey
                FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL;
        END IF;
    END $$;
"""

# Whether CARD_COMMENTS_AUTHOR_FK_SQL has anything to do (logging only).
CARD_COMMENTS_AUTHOR_FK_NEEDS_FIX_SQL = """
    SELECT
        to_regclass('public.card_comments') IS NOT NULL
        AND (
            EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'card_comments'
                  AND column_name = 'author_id' AND is_nullable = 'NO'
            )
            OR EXISTS (
                SELECT 1
                FROM pg_constraint c
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
                WHERE c.conrelid = to_regclass('public.card_comments')
                  AND c.contype = 'f'
                  AND a.attname = 'author_id'
                  AND c.confdeltype <> 'n'
            )
            OR NOT EXISTS (
                SELECT 1
                FROM pg_constraint c
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
                WHERE c.conrelid = to_regclass('public.card_comments')
                  AND c.contype = 'f'
                  AND a.attname = 'author_id'
            )
        )
"""

# --- Orphan cleanup of polymorphic rows ------------------------------------
# custom_column_values and card_comments point at their project/phase/subphase
# through a polymorphic (entity_type, entity_id) pair with no FK, so nothing
# cascades from the entity. Deletes used to leave them behind (and every
# client downloaded the dead values on each load); the delete handlers now
# remove them, and these statements clear what older releases left. Plain
# statements (no trailing semicolon), idempotent, no-ops on a clean database.
CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL = """
    DELETE FROM custom_column_values v
    WHERE (v.entity_type = 'project'
           AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = v.entity_id))
       OR (v.entity_type = 'phase'
           AND NOT EXISTS (SELECT 1 FROM project_phases ph WHERE ph.id = v.entity_id))
       OR (v.entity_type = 'subphase'
           AND NOT EXISTS (SELECT 1 FROM project_subphases sp WHERE sp.id = v.entity_id))
"""

CARD_COMMENTS_ORPHAN_CLEANUP_SQL = """
    DELETE FROM card_comments cc
    WHERE (cc.entity_type = 'phase'
           AND NOT EXISTS (SELECT 1 FROM project_phases ph WHERE ph.id = cc.entity_id))
       OR (cc.entity_type = 'subphase'
           AND NOT EXISTS (SELECT 1 FROM project_subphases sp WHERE sp.id = cc.entity_id))
"""

# company_events.counts_as_unavailable (site closures) for databases created
# before it. Guarded so an already-migrated database does not take the ALTER
# TABLE lock again.
COMPANY_EVENTS_CLOSURE_COLUMN_SQL = """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'company_events'
              AND column_name = 'counts_as_unavailable'
        ) THEN
            ALTER TABLE company_events
                ADD COLUMN counts_as_unavailable BOOLEAN NOT NULL DEFAULT FALSE;
        END IF;
    END $$;
"""

# vacations.absence_type_id for databases created before absence types.
# Existing absences are filed under "Holidays" once, in the same guarded branch
# that creates the column -- exactly what the migration / tenant auto-migration
# do. (Single-tenant AUTO_INIT_DB runs this schema BEFORE the app's startup
# auto-migration, which then sees the column and skips its own back-fill, so
# the back-fill has to live here too.) Never runs on a fresh database, where
# CREATE TABLE already has the column.
VACATIONS_ABSENCE_TYPE_COLUMN_SQL = """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'vacations'
              AND column_name = 'absence_type_id'
        ) THEN
            ALTER TABLE vacations ADD COLUMN absence_type_id INTEGER
                REFERENCES absence_types(id) ON DELETE SET NULL;
            UPDATE vacations
            SET absence_type_id = (SELECT id FROM absence_types WHERE name = 'Holidays')
            WHERE absence_type_id IS NULL;
        END IF;
    END $$;
"""


def _add_column_if_missing(
    table: str, column: str, definition: str, backfill: str = "", requires: str | None = None
) -> str:
    """
    Idempotent ``ADD COLUMN`` for upgrading a database created by an older
    release, as a guarded DO block (an already-migrated database does not take
    the ALTER TABLE lock again). ``backfill`` runs once, in the same branch,
    right after the column is created -- never on a fresh database.
    ``requires`` names a table the column's definition references: without it
    the block does nothing. Only ever called with literal identifiers from this
    module.
    """
    required = f"to_regclass('public.{requires}') IS NOT NULL AND " if requires else ""
    return f"""
    DO $$
    BEGIN
        IF to_regclass('public.{table}') IS NOT NULL AND {required}NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = '{table}'
              AND column_name = '{column}'
        ) THEN
            ALTER TABLE {table} ADD COLUMN {column} {definition};
            {backfill}
        END IF;
    END $$;
"""


# --- In-place upgrades for databases created by older releases -------------
# get_tenant_schema_sql() is re-applied to existing databases (init_db with
# AUTO_INIT_DB, also in single-tenant mode), and CREATE TABLE IF NOT EXISTS
# never adds a column to an existing table. Every column the tenant
# auto-migration (tenant_manager._run_auto_migrations) or a migrations/*.sql
# file has ever added therefore needs an equivalent here. All no-ops on a
# fresh database.

# users.is_resource (1.16.0): the person may be booked on projects and appears
# in the Staff panel. Existing administrators are back-filled FALSE, everyone
# else keeps the column default TRUE, so an upgrade changes nobody's
# bookability. Shared by USERS_UPGRADE_SQL, migrations/add_user_is_resource.sql
# and the tenant auto-migration (tenant_manager._run_auto_migrations).
USERS_IS_RESOURCE_SQL = _add_column_if_missing(
    "users",
    "is_resource",
    "BOOLEAN NOT NULL DEFAULT TRUE",
    "UPDATE users SET is_resource = FALSE WHERE role = 'admin';",
)

# users.max_capacity (part-time staff), users.is_system (protected admin: the
# first admin becomes the system user, as add_is_system_column.sql /
# the auto-migration do), users.updated_at, users.is_resource.
USERS_UPGRADE_SQL = (
    _add_column_if_missing(
        "users",
        "max_capacity",
        "INTEGER DEFAULT 100",
        "UPDATE users SET max_capacity = 100 WHERE max_capacity IS NULL;\n"
        "            ALTER TABLE users ALTER COLUMN max_capacity SET NOT NULL;",
    )
    + _add_column_if_missing(
        "users",
        "is_system",
        "INTEGER DEFAULT 0",
        "UPDATE users SET is_system = 1 WHERE id = "
        "(SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1);",
    )
    + _add_column_if_missing("users", "updated_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP")
    + USERS_IS_RESOURCE_SQL
)

# bank_holidays.end_date (multi-day holidays) and bank_holidays.year (back-
# filled from date; idx_bank_holidays_year further down needs it).
BANK_HOLIDAYS_UPGRADE_SQL = _add_column_if_missing(
    "bank_holidays", "end_date", "DATE"
) + _add_column_if_missing(
    "bank_holidays",
    "year",
    "INTEGER",
    "UPDATE bank_holidays SET year = EXTRACT(YEAR FROM date) WHERE year IS NULL;\n"
    "            ALTER TABLE bank_holidays ALTER COLUMN year SET NOT NULL;",
)

# company_events.color (event colour picker).
COMPANY_EVENTS_COLOR_COLUMN_SQL = _add_column_if_missing("company_events", "color", "VARCHAR(20)")


def _card_status_upgrade_sql(table: str) -> str:
    """Kanban ``status`` on a card table, back-filled from ``completion`` once
    (same mapping as card_status.status_from_completion and
    add_kanban_tables.sql), plus its CHECK constraint."""
    return (
        _add_column_if_missing(
            table,
            "status",
            "VARCHAR(20) NOT NULL DEFAULT 'todo'",
            f"""UPDATE {table} SET status = CASE
                WHEN completion IS NULL OR completion <= 0 THEN 'todo'
                WHEN completion >= 100 THEN 'done'
                ELSE 'in_progress'
            END;""",
        )
        + f"""
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.{table}'::regclass AND conname = '{table}_status_check'
        ) THEN
            ALTER TABLE {table} ADD CONSTRAINT {table}_status_check
                CHECK (status IN ('todo', 'in_progress', 'blocked', 'done'));
        END IF;
    END $$;
"""
    )


# project_phases.status / project_subphases.status (Kanban board, 1.4).
CARD_STATUS_UPGRADE_SQL = _card_status_upgrade_sql("project_phases") + _card_status_upgrade_sql(
    "project_subphases"
)

# Legacy "notes" table from historic install paths: rows are copied into
# staff_notes (the Note model's table) and the old table is dropped, as
# migrations/add_staff_notes.sql and the auto-migration do. plpgsql plans a
# statement only when it first runs, so the branch for the absent `type`
# column is never parsed against the wrong table shape. A legacy table of an
# unexpected shape is left alone with a WARNING (the inner block is its own
# subtransaction) instead of aborting the whole schema run.
STAFF_NOTES_LEGACY_UPGRADE_SQL = """
    DO $$
    BEGIN
        IF to_regclass('public.notes') IS NOT NULL THEN
          BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'notes' AND column_name = 'type'
            ) THEN
                INSERT INTO staff_notes (site_id, staff_id, date, text, type, created_at)
                SELECT site_id, staff_id, date, text,
                       COALESCE(type, 'general'), COALESCE(created_at, CURRENT_TIMESTAMP)
                FROM notes WHERE site_id IS NOT NULL;
            ELSE
                INSERT INTO staff_notes (site_id, staff_id, date, text, created_at)
                SELECT site_id, staff_id, date, text, COALESCE(created_at, CURRENT_TIMESTAMP)
                FROM notes WHERE site_id IS NOT NULL;
            END IF;
            DROP TABLE notes;
          EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'legacy notes table not migrated to staff_notes: %', SQLERRM;
          END;
        END IF;
    END $$;
"""

# custom_columns / custom_column_values columns added after the first
# custom-columns release (add_custom_columns.sql). idx_custom_columns_site
# further down needs site_id.
CUSTOM_COLUMNS_UPGRADE_SQL = (
    _add_column_if_missing(
        "custom_columns", "site_id", "INTEGER REFERENCES sites(id) ON DELETE CASCADE"
    )
    + _add_column_if_missing("custom_columns", "display_order", "INTEGER NOT NULL DEFAULT 0")
    + _add_column_if_missing("custom_columns", "width", "INTEGER NOT NULL DEFAULT 120")
    + _add_column_if_missing(
        "custom_columns", "created_at", "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP"
    )
    + _add_column_if_missing(
        "custom_columns", "updated_at", "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP"
    )
    + _add_column_if_missing(
        "custom_column_values", "created_at", "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP"
    )
    + _add_column_if_missing(
        "custom_column_values", "updated_at", "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP"
    )
)


# Site-scoped tags (add_tag_groups_and_sites.sql, 1.6.0). The table is created
# by the schema / auto-migration; TAGS_UPGRADE_STATEMENTS upgrade a
# pre-existing tags table in place. The tag groups of that release became
# project fields in 2.0.0 (PROJECT_FIELDS_MIGRATION_SQL converts and drops them).
TAG_SITES_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS tag_sites (
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      PRIMARY KEY (tag_id, site_id)
    )"""

# Teams (add_teams.sql, 1.12.0): a team belongs to one site; users are members,
# and projects / tags / company events / equipment can be linked to teams. Every
# FK cascades, so deleting a site removes its teams and all their links. One
# statement per constant: the auto-migration executes them one at a time
# (asyncpg runs a single statement per call); setup_databases.sql, the template
# and migrations/add_teams.sql carry the same text.
TEAMS_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      color VARCHAR(7),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT teams_site_name_unique UNIQUE (site_id, name)
    )"""

TEAM_MEMBERS_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS team_members (
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (team_id, user_id)
    )"""

PROJECT_TEAMS_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS project_teams (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      PRIMARY KEY (project_id, team_id)
    )"""

TAG_TEAMS_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS tag_teams (
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      PRIMARY KEY (tag_id, team_id)
    )"""

COMPANY_EVENT_TEAMS_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS company_event_teams (
      event_id INTEGER NOT NULL REFERENCES company_events(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, team_id)
    )"""

EQUIPMENT_TEAMS_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS equipment_teams (
      equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      PRIMARY KEY (equipment_id, team_id)
    )"""

TEAMS_INDEX_STATEMENTS: tuple[str, ...] = (
    "CREATE INDEX IF NOT EXISTS idx_teams_site ON teams(site_id)",
    "CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_project_teams_team ON project_teams(team_id)",
    "CREATE INDEX IF NOT EXISTS idx_tag_teams_team ON tag_teams(team_id)",
    "CREATE INDEX IF NOT EXISTS idx_company_event_teams_team ON company_event_teams(team_id)",
    "CREATE INDEX IF NOT EXISTS idx_equipment_teams_team ON equipment_teams(team_id)",
)

TEAMS_SCHEMA_STATEMENTS: tuple[str, ...] = (
    TEAMS_TABLE_SQL,
    TEAM_MEMBERS_TABLE_SQL,
    PROJECT_TEAMS_TABLE_SQL,
    TAG_TEAMS_TABLE_SQL,
    COMPANY_EVENT_TEAMS_TABLE_SQL,
    EQUIPMENT_TEAMS_TABLE_SQL,
    *TEAMS_INDEX_STATEMENTS,
)

TEAM_TABLES: tuple[str, ...] = (
    "teams",
    "team_members",
    "project_teams",
    "tag_teams",
    "company_event_teams",
    "equipment_teams",
)

TEAMS_SCHEMA_SQL = ";\n".join(TEAMS_SCHEMA_STATEMENTS) + ";"

# --- Project fields (add_project_fields.sql, 2.0.0) -------------------------
# Instance-wide custom fields on projects: text, number, toggle, select and
# multiselect. Dropdown items carry the tag scoping rules (all_sites + sites,
# teams per site). project_field_option_teams references teams, so the block
# follows the teams tables in every DDL source. Every FK cascades. One
# statement per constant: the auto-migration executes them one at a time
# (asyncpg runs a single statement per call); setup_databases.sql, the template
# and migrations/add_project_fields.sql carry the same text
# (tests/test_project_fields_schema.py).
PROJECT_FIELDS_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS project_fields (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      field_type VARCHAR(20) NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT project_fields_type_check
        CHECK (field_type IN ('text', 'number', 'toggle', 'select', 'multiselect'))
    )"""

PROJECT_FIELD_OPTIONS_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS project_field_options (
      id SERIAL PRIMARY KEY,
      field_id INTEGER NOT NULL REFERENCES project_fields(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
      all_sites BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT project_field_options_field_name_unique UNIQUE (field_id, name)
    )"""

PROJECT_FIELD_OPTION_SITES_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS project_field_option_sites (
      option_id INTEGER NOT NULL REFERENCES project_field_options(id) ON DELETE CASCADE,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      PRIMARY KEY (option_id, site_id)
    )"""

PROJECT_FIELD_OPTION_TEAMS_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS project_field_option_teams (
      option_id INTEGER NOT NULL REFERENCES project_field_options(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      PRIMARY KEY (option_id, team_id)
    )"""

PROJECT_FIELD_VALUES_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS project_field_values (
      id SERIAL PRIMARY KEY,
      field_id INTEGER NOT NULL REFERENCES project_fields(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      value_text TEXT,
      value_number DOUBLE PRECISION,
      value_bool BOOLEAN,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT project_field_values_field_project_unique UNIQUE (field_id, project_id)
    )"""

PROJECT_FIELD_SELECTIONS_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS project_field_selections (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      option_id INTEGER NOT NULL REFERENCES project_field_options(id) ON DELETE CASCADE,
      assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (project_id, option_id)
    )"""

PROJECT_FIELDS_INDEX_STATEMENTS: tuple[str, ...] = (
    "CREATE INDEX IF NOT EXISTS idx_project_field_option_sites_site "
    "ON project_field_option_sites(site_id)",
    "CREATE INDEX IF NOT EXISTS idx_project_field_option_teams_team "
    "ON project_field_option_teams(team_id)",
    "CREATE INDEX IF NOT EXISTS idx_project_field_values_project "
    "ON project_field_values(project_id)",
    "CREATE INDEX IF NOT EXISTS idx_project_field_selections_option "
    "ON project_field_selections(option_id)",
)

PROJECT_FIELDS_SCHEMA_STATEMENTS: tuple[str, ...] = (
    PROJECT_FIELDS_TABLE_SQL,
    PROJECT_FIELD_OPTIONS_TABLE_SQL,
    PROJECT_FIELD_OPTION_SITES_TABLE_SQL,
    PROJECT_FIELD_OPTION_TEAMS_TABLE_SQL,
    PROJECT_FIELD_VALUES_TABLE_SQL,
    PROJECT_FIELD_SELECTIONS_TABLE_SQL,
    *PROJECT_FIELDS_INDEX_STATEMENTS,
)

PROJECT_FIELD_TABLES: tuple[str, ...] = (
    "project_fields",
    "project_field_options",
    "project_field_option_sites",
    "project_field_option_teams",
    "project_field_values",
    "project_field_selections",
)

PROJECT_FIELDS_SCHEMA_SQL = ";\n".join(PROJECT_FIELDS_SCHEMA_STATEMENTS) + ";"

# The one-off conversion of tag groups into dropdown fields (2.0.0), after the
# tables above exist. Its own gate: it works only while tag_groups exists, so
# it is a no-op on a fresh 2.0.0 database and on a converted one. Per group
# (in group order): a field ('select' for a single-select group, else
# 'multiselect', same sort_order; " (tags)" appended while the name clashes
# with an existing field, case-insensitively), an item per tag of the group
# (name, colour, sort_order, all_sites) with the tag's site and team links,
# and a selection per project carrying the tag. Then the grouped tags are
# deleted (their project_tags / tag_sites / tag_teams rows cascade), the
# remaining tags renumbered 0..n-1 by (sort_order, name), and tags.group_id
# and tag_groups dropped. One transaction: a failure leaves the database as it
# was. No ':name' tokens (SQLAlchemy text() would read them as binds).
PROJECT_FIELDS_MIGRATION_SQL = """
    DO $$
    DECLARE
        grp RECORD;
        grouped_tag RECORD;
        new_field_id INTEGER;
        new_option_id INTEGER;
        candidate TEXT;
        suffix TEXT;
        attempt INTEGER;
    BEGIN
        IF to_regclass('public.tag_groups') IS NOT NULL THEN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'tags'
                  AND column_name = 'group_id'
            ) THEN
                FOR grp IN
                    SELECT id, name, single_select, sort_order FROM tag_groups
                    ORDER BY sort_order, id
                LOOP
                    candidate := grp.name;
                    attempt := 1;
                    WHILE EXISTS (
                        SELECT 1 FROM project_fields WHERE lower(name) = lower(candidate)
                    ) LOOP
                        suffix := CASE WHEN attempt = 1 THEN ' (tags)'
                                       ELSE ' (tags ' || attempt || ')' END;
                        candidate := left(grp.name, 100 - length(suffix)) || suffix;
                        attempt := attempt + 1;
                    END LOOP;

                    INSERT INTO project_fields (name, field_type, sort_order)
                    VALUES (
                        candidate,
                        CASE WHEN grp.single_select THEN 'select' ELSE 'multiselect' END,
                        grp.sort_order
                    )
                    RETURNING id INTO new_field_id;

                    FOR grouped_tag IN
                        SELECT id, name, color, all_sites, sort_order FROM tags
                        WHERE group_id = grp.id
                        ORDER BY sort_order, name
                    LOOP
                        INSERT INTO project_field_options
                            (field_id, name, color, all_sites, sort_order)
                        VALUES (
                            new_field_id, grouped_tag.name, grouped_tag.color,
                            grouped_tag.all_sites, grouped_tag.sort_order
                        )
                        RETURNING id INTO new_option_id;

                        INSERT INTO project_field_option_sites (option_id, site_id)
                        SELECT new_option_id, site_id FROM tag_sites
                        WHERE tag_id = grouped_tag.id;

                        INSERT INTO project_field_option_teams (option_id, team_id)
                        SELECT new_option_id, team_id FROM tag_teams
                        WHERE tag_id = grouped_tag.id;

                        INSERT INTO project_field_selections (project_id, option_id, assigned_at)
                        SELECT project_id, new_option_id, COALESCE(assigned_at, CURRENT_TIMESTAMP)
                        FROM project_tags
                        WHERE tag_id = grouped_tag.id;
                    END LOOP;
                END LOOP;

                DELETE FROM tags WHERE group_id IS NOT NULL;

                UPDATE tags SET sort_order = ranked.position
                FROM (
                    SELECT id, row_number() OVER (ORDER BY sort_order, name) - 1 AS position
                    FROM tags
                ) AS ranked
                WHERE tags.id = ranked.id AND tags.sort_order <> ranked.position;

                DROP INDEX IF EXISTS idx_tags_group;
                ALTER TABLE tags DROP COLUMN IF EXISTS group_id;
            END IF;

            DROP TABLE tag_groups;
        END IF;
    END $$"""

# Probe of the project-fields auto-migration step: the step runs while a
# table is missing or tag_groups still exists.
PROJECT_FIELDS_PROBE_SQL = (
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' "
    "AND table_name IN (" + ", ".join(f"'{t}'" for t in (*PROJECT_FIELD_TABLES, "tag_groups")) + ")"
)

TAG_SITES_SITE_INDEX_SQL = "CREATE INDEX IF NOT EXISTS idx_tag_sites_site ON tag_sites(site_id)"

# One guarded DO block per column (the auto-migration runs them one at a time:
# asyncpg executes a single statement per call). The group_id block is kept for
# a database that still has tag_groups (it runs only while that table exists,
# so never on a fresh 2.0.0 schema); the project-fields migration converts the
# groups and drops the column right after.
TAGS_UPGRADE_STATEMENTS: tuple[str, ...] = (
    _add_column_if_missing(
        "tags",
        "group_id",
        "INTEGER REFERENCES tag_groups(id) ON DELETE SET NULL",
        requires="tag_groups",
    ),
    _add_column_if_missing("tags", "all_sites", "BOOLEAN NOT NULL DEFAULT TRUE"),
    _add_column_if_missing("tags", "sort_order", "INTEGER NOT NULL DEFAULT 0"),
)
TAGS_UPGRADE_SQL = "".join(TAGS_UPGRADE_STATEMENTS)

# --- RBAC: roles, permissions, approvals, todos (add_rbac.sql, 1.13.0) -----
# users.role holds a role key and references roles.key, so `roles` (with its
# seeded system roles) is created BEFORE `users` in every DDL source. One
# statement per constant: the tenant auto-migration and the data-migration
# step execute them one at a time (asyncpg runs a single statement per call);
# get_tenant_schema_sql(), setup_databases.sql, the template and
# migrations/add_rbac.sql carry the same text
# (tests/test_rbac_schema_sources.py). DO blocks carry no trailing ';'.
ROLES_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS roles (
      id SERIAL PRIMARY KEY,
      key VARCHAR(20) NOT NULL UNIQUE,
      name VARCHAR(100) NOT NULL UNIQUE,
      description TEXT,
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT roles_key_format CHECK (key ~ '^[a-z][a-z0-9_]{1,19}$')
    )"""

ROLE_PERMISSIONS_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission VARCHAR(60) NOT NULL,
      mode VARCHAR(10) NOT NULL DEFAULT 'allow',
      PRIMARY KEY (role_id, permission),
      CONSTRAINT role_permissions_mode_check CHECK (mode IN ('allow', 'approval'))
    )"""

APPROVAL_POLICIES_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS approval_policies (
      action VARCHAR(60) PRIMARY KEY,
      pm_approves BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )"""

APPROVAL_POLICY_ROLES_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS approval_policy_roles (
      action VARCHAR(60) NOT NULL REFERENCES approval_policies(action) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (action, role_id)
    )"""

# assignment_id: a row of project_assignments / phase_staff_assignments /
# subphase_staff_assignments (by level), hence no FK.
APPROVAL_REQUESTS_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS approval_requests (
      id SERIAL PRIMARY KEY,
      requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action VARCHAR(60) NOT NULL,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      level VARCHAR(10) NOT NULL,
      target_id INTEGER NOT NULL,
      assignment_id INTEGER,
      requested TEXT,
      previous TEXT,
      note TEXT,
      status VARCHAR(12) NOT NULL DEFAULT 'pending',
      close_reason VARCHAR(20),
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      decided_at TIMESTAMP,
      decision_note TEXT,
      superseded_by_id INTEGER REFERENCES approval_requests(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT approval_requests_level_check CHECK (level IN ('project', 'phase', 'subphase')),
      CONSTRAINT approval_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'superseded', 'expired')),
      CONSTRAINT approval_requests_close_reason_check CHECK (close_reason IN ('target_deleted', 'requester_inactive', 'permission_lost', 'overtaken', 'duplicate'))
    )"""

TODOS_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      notes TEXT,
      due_date DATE,
      assignee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status VARCHAR(10) NOT NULL DEFAULT 'open',
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      entity_type VARCHAR(20),
      entity_id INTEGER,
      completed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT todos_status_check CHECK (status IN ('open', 'done', 'cancelled')),
      CONSTRAINT todos_entity_type_check CHECK (entity_type IN ('phase', 'subphase'))
    )"""

RBAC_INDEX_STATEMENTS: tuple[str, ...] = (
    "CREATE INDEX IF NOT EXISTS idx_approval_policy_roles_role ON approval_policy_roles(role_id)",
    "CREATE INDEX IF NOT EXISTS idx_approval_requests_project_status "
    "ON approval_requests(project_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_approval_requests_requester_status "
    "ON approval_requests(requester_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_approval_requests_pending "
    "ON approval_requests(status) WHERE status = 'pending'",
    "CREATE INDEX IF NOT EXISTS idx_todos_assignee_status ON todos(assignee_id, status)",
)

# Pending self-bookings are real assignment rows: approval_status = 'pending'
# until approved; approval_request_id points at the open request (a pending
# create, change or removal). Guarded ADD COLUMNs (two per table), after
# approval_requests exists.
ASSIGNMENT_APPROVAL_TABLES: tuple[str, ...] = (
    "project_assignments",
    "phase_staff_assignments",
    "subphase_staff_assignments",
)


def _statement(sql: str) -> str:
    """A DO block as a single statement: no surrounding blanks, no trailing ';'."""
    return sql.strip().removesuffix(";")


ASSIGNMENT_APPROVAL_COLUMN_STATEMENTS: tuple[str, ...] = tuple(
    _statement(sql)
    for table in ASSIGNMENT_APPROVAL_TABLES
    for sql in (
        _add_column_if_missing(
            table,
            "approval_status",
            "VARCHAR(10) NOT NULL DEFAULT 'approved' "
            f"CONSTRAINT {table}_approval_status_check "
            "CHECK (approval_status IN ('approved', 'pending'))",
        ),
        _add_column_if_missing(
            table,
            "approval_request_id",
            f"INTEGER CONSTRAINT {table}_approval_request_id_fkey "
            "REFERENCES approval_requests(id) ON DELETE SET NULL",
        ),
    )
)

# Unlinked booking segments (1.17.0): a phase / subphase staff booking may
# carry its own dates (a segment that moves within its card); both NULL =
# linked, the booking follows the card. Guarded ADD COLUMNs plus the
# both-or-neither CHECK, added when missing (add_booking_segments.sql, the
# tenant auto-migration and the fresh schema share these statements).
BOOKING_SEGMENT_TABLES: tuple[str, ...] = (
    "phase_staff_assignments",
    "subphase_staff_assignments",
)

BOOKING_SEGMENT_DATES_CHECK = "((start_date IS NULL) = (end_date IS NULL))"


def _segment_dates_check_if_missing(table: str) -> str:
    """Guarded ``ADD CONSTRAINT <table>_segment_dates_check`` (literal identifiers only)."""
    return f"""
    DO $$
    BEGIN
        IF to_regclass('public.{table}') IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = to_regclass('public.{table}')
              AND conname = '{table}_segment_dates_check'
        ) THEN
            ALTER TABLE {table} ADD CONSTRAINT {table}_segment_dates_check
                CHECK {BOOKING_SEGMENT_DATES_CHECK};
        END IF;
    END $$"""


BOOKING_SEGMENT_COLUMN_STATEMENTS: tuple[str, ...] = tuple(
    _statement(sql)
    for table in BOOKING_SEGMENT_TABLES
    for sql in (
        _add_column_if_missing(table, "start_date", "DATE"),
        _add_column_if_missing(table, "end_date", "DATE"),
        _segment_dates_check_if_missing(table),
    )
)

# The notification types, in the order every DDL source spells them. The
# CHECK text derived from it appears in seven places (the ORM, the four
# CREATE TABLE notifications sources, the tenant auto-migration and the
# widening below). Append new types at the end: the widening's marker is the
# last one.
NOTIFICATION_TYPES: tuple[str, ...] = (
    "assigned",
    "comment",
    "mention",
    "status_change",
    "approval_requested",
    "approval_decided",
    "todo_assigned",
    "assignment_changed",
    "project_changed",
)

NOTIFICATIONS_TYPE_CHECK = "type IN (" + ", ".join(f"'{t}'" for t in NOTIFICATION_TYPES) + ")"

# Widen notifications_type_check on an existing table. Skipped when the
# constraint already allows the newest type, so a migrated table is not
# re-validated on every run (and the step can run on every pool creation).
NOTIFICATIONS_TYPE_CHECK_SQL = f"""
    DO $$
    BEGIN
        IF to_regclass('public.notifications') IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = to_regclass('public.notifications')
              AND conname = 'notifications_type_check'
              AND strpos(pg_get_constraintdef(oid), '{NOTIFICATION_TYPES[-1]}') > 0
        ) THEN
            ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
            ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
                CHECK ({NOTIFICATIONS_TYPE_CHECK});
        END IF;
    END $$"""

# sso_config.default_role becomes a role key (validated in code): drop the
# superuser|user CHECK.
SSO_DEFAULT_ROLE_CHECK_DROP_SQL = """
    DO $$
    BEGIN
        IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = to_regclass('public.sso_config')
              AND conname = 'sso_config_default_role_check'
        ) THEN
            ALTER TABLE sso_config DROP CONSTRAINT sso_config_default_role_check;
        END IF;
    END $$"""

RBAC_SCHEMA_STATEMENTS: tuple[str, ...] = (
    ROLES_TABLE_SQL,
    ROLE_PERMISSIONS_TABLE_SQL,
    APPROVAL_POLICIES_TABLE_SQL,
    APPROVAL_POLICY_ROLES_TABLE_SQL,
    APPROVAL_REQUESTS_TABLE_SQL,
    TODOS_TABLE_SQL,
    *RBAC_INDEX_STATEMENTS,
    *ASSIGNMENT_APPROVAL_COLUMN_STATEMENTS,
    NOTIFICATIONS_TYPE_CHECK_SQL,
    SSO_DEFAULT_ROLE_CHECK_DROP_SQL,
)

RBAC_TABLES: tuple[str, ...] = (
    "roles",
    "role_permissions",
    "approval_policies",
    "approval_policy_roles",
    "approval_requests",
    "todos",
)

# --- RBAC seed (run after the tables; order matters) ------------------------
# 1. The system roles with their default permissions -- defaults only for a
#    role row created by the same statement, so an admin's edits are never
#    re-seeded (see permissions.build_default_role_permissions_sql).
RBAC_SEED_ROLES_SQL = build_default_role_permissions_sql()

# 2. One policy per approvable action: the project manager approves, no roles.
RBAC_SEED_POLICIES_SQL = (
    """
    INSERT INTO approval_policies (action, pm_approves) VALUES
"""
    + ",\n".join(f"      ('{p.key}', TRUE)" for p in PERMISSIONS if p.approvable)
    + """
    ON CONFLICT (action) DO NOTHING"""
)

# 3. Any role value without a roles row falls back to 'user' (cannot happen
#    under the old CHECK; defensive before the FK is added).
USERS_ROLE_RESET_SQL = """
    UPDATE users SET role = 'user' WHERE role NOT IN (SELECT key FROM roles)"""

# 4. users.role: CHECK (admin|superuser|user) -> FK to roles.key.
USERS_ROLE_FK_CLAUSE = (
    "CONSTRAINT users_role_fkey FOREIGN KEY (role) REFERENCES roles(key) "
    "ON UPDATE CASCADE ON DELETE RESTRICT"
)

USERS_ROLE_FK_SQL = f"""
    DO $$
    BEGIN
        IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = to_regclass('public.users') AND conname = 'users_role_check'
        ) THEN
            ALTER TABLE users DROP CONSTRAINT users_role_check;
        END IF;
        IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = to_regclass('public.users') AND conname = 'users_role_fkey'
        ) THEN
            ALTER TABLE users ADD {USERS_ROLE_FK_CLAUSE};
        END IF;
    END $$"""

RBAC_SEED_STATEMENTS: tuple[str, ...] = (
    RBAC_SEED_ROLES_SQL,
    RBAC_SEED_POLICIES_SQL,
    USERS_ROLE_RESET_SQL,
    USERS_ROLE_FK_SQL,
)

_SYSTEM_ROLE_LIST = ", ".join(f"'{r.key}'" for r in SYSTEM_ROLES)
_APPROVABLE_LIST = ", ".join(f"'{p.key}'" for p in PERMISSIONS if p.approvable)
_RBAC_TABLE_LIST = ", ".join(f"'{t}'" for t in RBAC_TABLES)

# Tenant auto-migration trigger: an RBAC table is missing, the old role CHECK
# is still there, or the assignment approval columns are missing.
RBAC_NEEDS_MIGRATION_SQL = f"""
    SELECT
        (SELECT count(*) FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name IN ({_RBAC_TABLE_LIST})) < {len(RBAC_TABLES)}
        OR EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = to_regclass('public.users') AND conname = 'users_role_check'
        )
        OR NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'project_assignments' AND column_name = 'approval_status'
        )"""

# Data-migration trigger for the seed: a system role or an approval policy is
# missing, or users.role is not yet the FK.
RBAC_SEED_NEEDED_SQL = f"""
    SELECT
        (SELECT count(*) FROM roles WHERE key IN ({_SYSTEM_ROLE_LIST})) < {len(SYSTEM_ROLES)}
        OR (SELECT count(*) FROM approval_policies
            WHERE action IN ({_APPROVABLE_LIST})) < {len(APPROVABLE_KEYS)}
        OR EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = to_regclass('public.users') AND conname = 'users_role_check'
        )
        OR NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = to_regclass('public.users') AND conname = 'users_role_fkey'
        )"""

# Pending approval requests whose card or assignment row no longer exists are
# closed as expired (target_deleted). Run by the tenant data migrations.
APPROVAL_REQUESTS_ORPHAN_CLEANUP_SQL = """
    UPDATE approval_requests r
    SET status = 'expired', close_reason = 'target_deleted', updated_at = CURRENT_TIMESTAMP
    WHERE r.status = 'pending'
      AND ((r.level = 'phase'
            AND NOT EXISTS (SELECT 1 FROM project_phases ph WHERE ph.id = r.target_id))
        OR (r.level = 'subphase'
            AND NOT EXISTS (SELECT 1 FROM project_subphases sp WHERE sp.id = r.target_id))
        OR (r.level = 'project' AND r.assignment_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM project_assignments a WHERE a.id = r.assignment_id))
        OR (r.level = 'phase' AND r.assignment_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM phase_staff_assignments a WHERE a.id = r.assignment_id))
        OR (r.level = 'subphase' AND r.assignment_id IS NOT NULL
            AND NOT EXISTS (
                SELECT 1 FROM subphase_staff_assignments a WHERE a.id = r.assignment_id)))"""


# After that expiry: a pending-create row whose request is no longer pending
# (closed, or gone) is removed, and an approved row stops pointing at a closed
# request. One statement per assignment table; run by the tenant data
# migrations (a data step: not part of the fresh-install DDL).
PENDING_ASSIGNMENT_ORPHAN_CLEANUP_SQL: tuple[str, ...] = tuple(
    f"""
    DELETE FROM {table} a
    WHERE a.approval_status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM approval_requests r
                      WHERE r.id = a.approval_request_id AND r.status = 'pending')"""
    for table in ASSIGNMENT_APPROVAL_TABLES
)
STALE_APPROVAL_POINTER_CLEANUP_SQL: tuple[str, ...] = tuple(
    f"""
    UPDATE {table} a SET approval_request_id = NULL
    WHERE a.approval_status = 'approved' AND a.approval_request_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM approval_requests r
                      WHERE r.id = a.approval_request_id AND r.status = 'pending')"""
    for table in ASSIGNMENT_APPROVAL_TABLES
)


def _sql_block(*statements: str) -> str:
    """Statements joined for a multi-statement script (each terminated by ';')."""
    return "".join(f"{statement};\n" for statement in statements)


def _validate_identifier(name: str) -> str:
    """Validate a SQL identifier (database name, username) to prevent injection."""
    if not re.match(r"^[a-zA-Z0-9_-]+$", name):
        raise ValueError(f"Invalid SQL identifier: {name!r}")
    if len(name) > 63:
        raise ValueError(f"SQL identifier too long (max 63): {name!r}")
    return name


def _escape_literal(value: str) -> str:
    """Escape a string for use as a SQL literal (single-quoted value)."""
    return value.replace("'", "''")


async def _reassign_public_schema_owner(conn: asyncpg.Connection, new_owner: str) -> None:
    """
    Reassign ownership of every object in the public schema to ``new_owner``.

    Used when re-provisioning a tenant database whose existing objects belong
    to a different role: CREATE INDEX / ALTER on those objects would otherwise
    fail with "must be owner of table ...". The connection must be a
    superuser or a member of both the current owner role and ``new_owner``.
    """
    _validate_identifier(new_owner)

    # Tables, views, materialized views, sequences, foreign tables.
    # Cast relkind to text because asyncpg returns PostgreSQL's internal
    # "char" type as raw bytes, which would never match str dict keys.
    # The name is quoted server-side (quote_ident) so a relation name with an
    # embedded double quote cannot break out of the identifier.
    rows = await conn.fetch(
        """
        SELECT quote_ident(c.relname) AS relname_quoted, c.relkind::text AS relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'v', 'm', 'S', 'f')
        """
    )
    relkind_to_keyword = {
        "r": "TABLE",
        "v": "VIEW",
        "m": "MATERIALIZED VIEW",
        "S": "SEQUENCE",
        "f": "FOREIGN TABLE",
    }
    for row in rows:
        keyword = relkind_to_keyword[row["relkind"]]
        await conn.execute(f'ALTER {keyword} public.{row["relname_quoted"]} OWNER TO "{new_owner}"')

    # Schema itself — make the tenant user able to create objects in public.
    # On managed Postgres (Azure Database / RDS / Cloud SQL) the public schema
    # of a freshly created database is owned by the platform admin role, and
    # since PostgreSQL 15 the PUBLIC pseudo-role no longer has CREATE on it —
    # so the tenant user cannot create its tables and provisioning fails with
    # "permission denied for schema public". Grant CREATE/USAGE explicitly and
    # (best-effort) hand ownership to the tenant user. Both statements require
    # the admin connection to own the public schema or be a superuser.
    try:
        await conn.execute(f'GRANT ALL ON SCHEMA public TO "{new_owner}"')
    except Exception as e:
        logger.warning("Could not grant public schema privileges to %s: %s", new_owner, e)
    try:
        await conn.execute(f'ALTER SCHEMA public OWNER TO "{new_owner}"')
    except Exception as e:
        logger.warning("Could not change public schema owner: %s", e)


async def get_admin_connection() -> asyncpg.Connection:
    """
    Get a connection using PostgreSQL admin credentials.

    Uses pg_admin_user/pg_admin_password or falls back to main DB credentials.
    """
    settings = get_settings()

    host = settings.db_host
    port = settings.db_port
    user = settings.pg_admin_user or settings.db_user
    password = settings.pg_admin_password or settings.db_password
    database = "postgres"  # Connect to default database for admin operations

    logger.info("Admin connection: user=%s, host=%s:%s, database=%s", user, host, port, database)

    return await asyncpg.connect(
        host=host,
        port=port,
        user=user,
        password=password,
        database=database,
    )


def get_tenant_schema_sql() -> str:
    """
    Get the SQL schema for tenant databases.

    This matches the Node.js schema exactly for compatibility. It is also
    re-applied to EXISTING databases (init_db with AUTO_INIT_DB, including
    single-tenant mode, which has no tenant auto-migration), so every statement
    must be idempotent and succeed on a database created by an older release:
    columns and constraints added since are upgraded in place here.
    """
    return (
        """
    -- Settings table (key-value store for app settings)
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Predefined phases for project creation
    CREATE TABLE IF NOT EXISTS predefined_phases (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Sites table
    CREATE TABLE IF NOT EXISTS sites (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      location TEXT,
      city TEXT,
      country_code TEXT,
      region_code TEXT,
      timezone TEXT DEFAULT 'Europe/Zurich',
      last_holiday_fetch TIMESTAMP,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Bank holidays table
    CREATE TABLE IF NOT EXISTS bank_holidays (
      id SERIAL PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      end_date DATE,
      name TEXT NOT NULL,
      is_custom INTEGER DEFAULT 0,
      year INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(site_id, date, name)
    );

    -- Upgrade of a database that predates multi-day / per-year holidays.
    """
        + BANK_HOLIDAYS_UPGRADE_SQL
        + """

    -- Company events table (similar to holidays but don't affect working days,
    -- unless counts_as_unavailable marks the event as a site closure).
    -- An event can apply to several sites (company_event_sites); site_id is a
    -- legacy column holding the first linked site.
    CREATE TABLE IF NOT EXISTS company_events (
      id SERIAL PRIMARY KEY,
      site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
      date DATE NOT NULL,
      end_date DATE,
      name TEXT NOT NULL,
      color VARCHAR(20),
      counts_as_unavailable BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Company event <-> site links (many-to-many)
    CREATE TABLE IF NOT EXISTS company_event_sites (
      event_id INTEGER NOT NULL REFERENCES company_events(id) ON DELETE CASCADE,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, site_id)
    );

    -- Upgrade of a database that predates event colours, multi-site events or
    -- site closures (no-ops on a fresh one): colour added, legacy site_id
    -- nullable, its FK SET NULL, closure flag added, links back-filled.
    """
        + COMPANY_EVENTS_COLOR_COLUMN_SQL
        + COMPANY_EVENTS_SITE_NULLABLE_SQL
        + COMPANY_EVENTS_SITE_FK_SQL
        + COMPANY_EVENTS_CLOSURE_COLUMN_SQL
        + COMPANY_EVENT_SITES_BACKFILL_SQL
        + """;

    -- Roles (users.role references roles.key, so before users), their
    -- permission rows, and the system roles with their default permissions.
    """
        + _sql_block(ROLES_TABLE_SQL, ROLE_PERMISSIONS_TABLE_SQL, RBAC_SEED_ROLES_SQL)
        + """
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      job_title TEXT,
      role TEXT DEFAULT 'user' NOT NULL,
      max_capacity INTEGER DEFAULT 100 NOT NULL,
      sso_provider TEXT,
      sso_id TEXT,
      active INTEGER DEFAULT 1 NOT NULL,
      is_resource BOOLEAN NOT NULL DEFAULT TRUE,
      is_system INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT users_role_fkey FOREIGN KEY (role) REFERENCES roles(key) ON UPDATE CASCADE ON DELETE RESTRICT
    );

    -- Upgrade of a users table that predates part-time capacity / the
    -- protected system admin.
    """
        + USERS_UPGRADE_SQL
        + """
    -- Upgrade of a users table from before roles: unknown role values fall
    -- back to 'user', then the role CHECK becomes the FK to roles.key.
    """
        + _sql_block(USERS_ROLE_RESET_SQL, USERS_ROLE_FK_SQL)
        + """

    -- User-Site junction table
    CREATE TABLE IF NOT EXISTS user_sites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, site_id)
    );

    -- Equipment table. Equipment can be shared by several sites
    -- (equipment_sites); site_id is a legacy column holding the first linked site.
    CREATE TABLE IF NOT EXISTS equipment (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT,
      site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
      description TEXT,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Equipment <-> site links (many-to-many)
    CREATE TABLE IF NOT EXISTS equipment_sites (
      equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      PRIMARY KEY (equipment_id, site_id)
    );

    -- Upgrade of a database that predates multi-site equipment (no-ops on a
    -- fresh one): legacy site_id FK made SET NULL, links back-filled from it.
    """
        + EQUIPMENT_SITE_FK_SQL
        + EQUIPMENT_SITES_BACKFILL_SQL
        + """;

    -- Projects table
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
      customer TEXT,
      pm_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      sales_pm TEXT,
      confirmed INTEGER DEFAULT 0,
      volume REAL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      notes TEXT,
      archived INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Upgrade of a projects table whose site_id FK predates ON DELETE CASCADE
    -- (deleting a site deletes its projects, as the ORM does).
    """
        + PROJECTS_SITE_FK_SQL
        + """

    -- Project phases table
    CREATE TABLE IF NOT EXISTS project_phases (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      is_milestone INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      completion INTEGER,
      status VARCHAR(20) NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'blocked', 'done')),
      dependencies TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Project subphases table
    CREATE TABLE IF NOT EXISTS project_subphases (
      id SERIAL PRIMARY KEY,
      parent_id INTEGER NOT NULL,
      parent_type TEXT NOT NULL DEFAULT 'phase' CHECK(parent_type IN ('phase', 'subphase')),
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      is_milestone INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      depth INTEGER DEFAULT 1,
      completion INTEGER,
      status VARCHAR(20) NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'blocked', 'done')),
      dependencies TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Upgrade of card tables that predate the Kanban board: status added and
    -- back-filled from completion, CHECK constraint added.
    """
        + CARD_STATUS_UPGRADE_SQL
        + """

    -- Project staff assignments (project-level)
    CREATE TABLE IF NOT EXISTS project_assignments (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      allocation INTEGER DEFAULT 100,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Phase staff assignments
    CREATE TABLE IF NOT EXISTS phase_staff_assignments (
      id SERIAL PRIMARY KEY,
      phase_id INTEGER NOT NULL REFERENCES project_phases(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      allocation INTEGER DEFAULT 100,
      start_date DATE,
      end_date DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT phase_staff_assignments_segment_dates_check
        CHECK ((start_date IS NULL) = (end_date IS NULL))
    );

    -- Subphase staff assignments
    CREATE TABLE IF NOT EXISTS subphase_staff_assignments (
      id SERIAL PRIMARY KEY,
      subphase_id INTEGER NOT NULL REFERENCES project_subphases(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      allocation INTEGER DEFAULT 100,
      start_date DATE,
      end_date DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT subphase_staff_assignments_segment_dates_check
        CHECK ((start_date IS NULL) = (end_date IS NULL))
    );

    -- Equipment assignments
    CREATE TABLE IF NOT EXISTS equipment_assignments (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Staff notes (pinned to a site/date; matches the Note model's staff_notes table)
    CREATE TABLE IF NOT EXISTS staff_notes (
      id SERIAL PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      date DATE NOT NULL,
      text TEXT NOT NULL,
      type VARCHAR(50) NOT NULL DEFAULT 'general',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Upgrade of a database that still has the legacy "notes" table.
    """
        + STAFF_NOTES_LEGACY_UPGRADE_SQL
        + """

    -- Absence types (Holidays, Home Office, ...; global, admin-managed)
    CREATE TABLE IF NOT EXISTS absence_types (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      color VARCHAR(7) NOT NULL DEFAULT '#8b5cf6',
      counts_as_unavailable BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Default absence types (only into an empty table). Part of the schema
    -- rather than run_seed_data so every schema consumer (provisioner,
    -- init_db, seed_demo) gets them.
    """
        + ABSENCE_TYPES_SEED_SQL
        + """;

    -- Vacations/time off
    CREATE TABLE IF NOT EXISTS vacations (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      description TEXT DEFAULT 'Vacation' NOT NULL,
      absence_type_id INTEGER REFERENCES absence_types(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Upgrade of a database that predates absence types (before its index).
    """
        + VACATIONS_ABSENCE_TYPE_COLUMN_SQL
        + """

    -- Equipment blocks (maintenance / defect / calibration unavailability)
    CREATE TABLE IF NOT EXISTS equipment_blocks (
      id SERIAL PRIMARY KEY,
      equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      reason VARCHAR(50) DEFAULT 'maintenance' NOT NULL,
      description VARCHAR(200) DEFAULT 'Maintenance' NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Session storage for express-session (Node.js format)
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expired BIGINT NOT NULL
    );

    -- SSO Configuration
    CREATE TABLE IF NOT EXISTS sso_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER DEFAULT 0,
      tenant_id TEXT,
      client_id TEXT,
      client_secret TEXT,
      redirect_uri TEXT,
      auto_create_users INTEGER DEFAULT 0,
      default_role TEXT DEFAULT 'user',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Custom columns (user-defined properties for projects/phases/subphases)
    CREATE TABLE IF NOT EXISTS custom_columns (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      column_type VARCHAR(20) NOT NULL DEFAULT 'text' CHECK(column_type IN ('text', 'boolean', 'list')),
      list_options TEXT,
      site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
      display_order INTEGER NOT NULL DEFAULT 0,
      width INTEGER NOT NULL DEFAULT 120,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Custom column values
    CREATE TABLE IF NOT EXISTS custom_column_values (
      id SERIAL PRIMARY KEY,
      custom_column_id INTEGER NOT NULL REFERENCES custom_columns(id) ON DELETE CASCADE,
      entity_type VARCHAR(20) NOT NULL CHECK(entity_type IN ('project', 'phase', 'subphase')),
      entity_id INTEGER NOT NULL,
      value TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(custom_column_id, entity_type, entity_id)
    );

    -- Upgrade of custom-column tables from the first custom-columns release.
    """
        + CUSTOM_COLUMNS_UPGRADE_SQL
        + """

    -- Kanban card comments (a card is a leaf phase/subphase)
    CREATE TABLE IF NOT EXISTS card_comments (
      id SERIAL PRIMARY KEY,
      entity_type VARCHAR(20) NOT NULL CHECK(entity_type IN ('phase', 'subphase')),
      entity_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      mentioned_user_ids TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );

    -- Upgrade of card_comments from before comments outlived their author
    -- (author_id nullable, ON DELETE SET NULL), then removal of comments and
    -- custom-column values left behind by deleted projects/phases/subphases.
    """
        + CARD_COMMENTS_AUTHOR_FK_SQL
        + CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL
        + ";"
        + CARD_COMMENTS_ORPHAN_CLEANUP_SQL
        + """;

    -- In-app notifications (one row per recipient)
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(30) NOT NULL CHECK("""
        + NOTIFICATIONS_TYPE_CHECK
        + """),
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      entity_type VARCHAR(20),
      entity_id INTEGER,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      title VARCHAR(200) NOT NULL,
      body TEXT,
      read_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );

    -- Skills (global, shared across all sites)
    CREATE TABLE IF NOT EXISTS skills (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      description TEXT,
      color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- User skills (many-to-many)
    CREATE TABLE IF NOT EXISTS user_skills (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      proficiency INTEGER NOT NULL DEFAULT 3 CHECK(proficiency >= 1 AND proficiency <= 5),
      assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, skill_id)
    );

    -- Tags (tenant-wide, assignable to projects; all_sites = false restricts a
    -- tag to the sites in tag_sites)
    CREATE TABLE IF NOT EXISTS tags (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
      all_sites BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Upgrade of a tags table from before site-scoped tags.
    """
        + TAGS_UPGRADE_SQL
        + """

    -- Tag <-> site links (consulted only when tags.all_sites is false)
    """
        + TAG_SITES_TABLE_SQL
        + """;

    -- Project tags (many-to-many)
    CREATE TABLE IF NOT EXISTS project_tags (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (project_id, tag_id)
    );

    -- Teams (per site) and their links to users, projects, tags, company
    -- events and equipment, with their indexes
    """
        + TEAMS_SCHEMA_SQL
        + """

    -- Project fields (custom fields on projects), their dropdown items with
    -- the items' site and team links, the values and the chosen items, with
    -- their indexes
    """
        + PROJECT_FIELDS_SCHEMA_SQL
        + """

    -- Approval policies (seeded: the project manager approves), approval
    -- requests, todos, the assignment approval columns, the booking segment
    -- columns (no-ops here: CREATE TABLE has them), the widened
    -- notification types, the SSO default-role CHECK dropped, and indexes.
    """
        + _sql_block(
            APPROVAL_POLICIES_TABLE_SQL,
            APPROVAL_POLICY_ROLES_TABLE_SQL,
            RBAC_SEED_POLICIES_SQL,
            APPROVAL_REQUESTS_TABLE_SQL,
            TODOS_TABLE_SQL,
            *ASSIGNMENT_APPROVAL_COLUMN_STATEMENTS,
            *BOOKING_SEGMENT_COLUMN_STATEMENTS,
            NOTIFICATIONS_TYPE_CHECK_SQL,
            SSO_DEFAULT_ROLE_CHECK_DROP_SQL,
            *RBAC_INDEX_STATEMENTS,
        )
        + """

    -- Project presence (tracking active viewers for realtime collaboration)
    CREATE TABLE IF NOT EXISTS project_presence (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      activity TEXT DEFAULT 'viewing' NOT NULL,
      last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_presence_unique ON project_presence(project_id, user_id);

    -- Create indexes
    CREATE INDEX IF NOT EXISTS idx_bank_holidays_site ON bank_holidays(site_id);
    CREATE INDEX IF NOT EXISTS idx_bank_holidays_date ON bank_holidays(date);
    CREATE INDEX IF NOT EXISTS idx_bank_holidays_year ON bank_holidays(site_id, year);
    CREATE INDEX IF NOT EXISTS idx_company_events_site_date ON company_events(site_id, date);
    CREATE INDEX IF NOT EXISTS idx_company_event_sites_site ON company_event_sites(site_id);
    CREATE INDEX IF NOT EXISTS idx_equipment_sites_site ON equipment_sites(site_id);
    CREATE INDEX IF NOT EXISTS idx_staff_notes_site_date ON staff_notes(site_id, date);
    CREATE INDEX IF NOT EXISTS idx_equipment_blocks_equipment_id ON equipment_blocks(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_equipment_blocks_dates ON equipment_blocks(start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
    CREATE INDEX IF NOT EXISTS idx_projects_site ON projects(site_id);
    CREATE INDEX IF NOT EXISTS idx_project_phases_project ON project_phases(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_subphases_project ON project_subphases(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_subphases_parent ON project_subphases(parent_id, parent_type);
    CREATE INDEX IF NOT EXISTS idx_card_comments_entity ON card_comments(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_card_comments_project ON card_comments(project_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_assignments_project ON project_assignments(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_assignments_staff ON project_assignments(staff_id);
    CREATE INDEX IF NOT EXISTS idx_phase_staff_assignments_phase ON phase_staff_assignments(phase_id);
    CREATE INDEX IF NOT EXISTS idx_phase_staff_assignments_project ON phase_staff_assignments(project_id);
    CREATE INDEX IF NOT EXISTS idx_phase_staff_assignments_staff ON phase_staff_assignments(staff_id);
    CREATE INDEX IF NOT EXISTS idx_subphase_staff_assignments_subphase ON subphase_staff_assignments(subphase_id);
    CREATE INDEX IF NOT EXISTS idx_subphase_staff_assignments_project ON subphase_staff_assignments(project_id);
    CREATE INDEX IF NOT EXISTS idx_subphase_staff_assignments_staff ON subphase_staff_assignments(staff_id);
    CREATE INDEX IF NOT EXISTS idx_equipment_assignments_project ON equipment_assignments(project_id);
    CREATE INDEX IF NOT EXISTS idx_equipment_assignments_equip ON equipment_assignments(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_vacations_staff ON vacations(staff_id);
    CREATE INDEX IF NOT EXISTS idx_vacations_dates ON vacations(start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_vacations_absence_type ON vacations(absence_type_id);
    CREATE INDEX IF NOT EXISTS idx_custom_columns_site ON custom_columns(site_id);
    CREATE INDEX IF NOT EXISTS idx_custom_column_values_column ON custom_column_values(custom_column_id);
    CREATE INDEX IF NOT EXISTS idx_custom_column_values_entity ON custom_column_values(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_user_skills_user ON user_skills(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_skills_skill ON user_skills(skill_id);
    CREATE INDEX IF NOT EXISTS idx_project_tags_project ON project_tags(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_tags_tag ON project_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_tag_sites_site ON tag_sites(site_id);
    CREATE INDEX IF NOT EXISTS idx_project_presence_project ON project_presence(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_presence_user ON project_presence(user_id);
    CREATE INDEX IF NOT EXISTS idx_project_presence_last_seen ON project_presence(last_seen_at);
    """
    )


async def run_seed_data(conn: asyncpg.Connection, admin_email: str, admin_password_hash: str):
    """Seed initial data for a new tenant using parameterized queries."""
    # Static seed data (no user input)
    await conn.execute("""
    INSERT INTO sso_config (id, enabled) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
    """)
    await conn.execute("""
    INSERT INTO predefined_phases (name, sort_order, is_active) VALUES
      ('Preparation', 0, 1),
      ('Analytics', 1, 1),
      ('Trial', 2, 1),
      ('Cleaning', 3, 1),
      ('Report', 4, 1)
    ON CONFLICT (name) DO NOTHING;
    """)
    await conn.execute("""
    INSERT INTO skills (name, description, color) VALUES
      ('Project Management', 'Experience in managing projects and teams', '#3b82f6'),
      ('Data Analysis', 'Statistical analysis and data interpretation', '#8b5cf6'),
      ('Laboratory Work', 'Hands-on laboratory experience', '#10b981'),
      ('Technical Writing', 'Documentation and report writing', '#f59e0b'),
      ('Quality Control', 'QC procedures and compliance', '#ef4444'),
      ('R&D', 'Research and development experience', '#06b6d4')
    ON CONFLICT (name) DO NOTHING;
    """)
    await conn.execute("""
    INSERT INTO sites (name, location, city, country_code, region_code)
    VALUES ('Main Site', 'Default', 'Default', 'US', 'US')
    ON CONFLICT (name) DO NOTHING;
    """)
    # Roles before users (users.role references roles.key). Normally already
    # done by get_tenant_schema_sql(); idempotent, and a role created earlier
    # keeps its (possibly edited) permissions.
    for statement in (RBAC_SEED_ROLES_SQL, RBAC_SEED_POLICIES_SQL):
        await conn.execute(statement)
    # User input - use parameterized queries
    await conn.execute(
        "INSERT INTO users "
        "(email, password, first_name, last_name, job_title, role, is_system, is_resource) "
        "VALUES ($1, $2, 'Admin', 'User', 'Administrator', 'admin', 1, FALSE) "
        "ON CONFLICT (email) DO NOTHING",
        admin_email,
        admin_password_hash,
    )
    await conn.execute(
        "INSERT INTO user_sites (user_id, site_id) "
        "SELECT u.id, s.id FROM users u, sites s "
        "WHERE u.email = $1 AND s.name = 'Main Site' "
        "ON CONFLICT DO NOTHING",
        admin_email,
    )


async def provision_tenant_database(
    tenant_id: str,
    database_name: str,
    database_user: str,
    database_password: str,
    admin_email: str,
    admin_password: str | None = None,
    seed_demo_data: bool = False,
    instance_title: str | None = None,
) -> dict[str, Any]:
    """
    Provision a new tenant database.

    Creates:
    1. PostgreSQL user
    2. PostgreSQL database
    3. Schema tables
    4. Seed data (predefined phases, default site, admin user) — or, with
       ``seed_demo_data``, the demo data set (app/scripts/demo_data.py) with
       ``admin_email`` as its system admin and ``instance_title`` as the
       workspace name; the default "Main Site" is not created then.

    Returns dict with admin credentials.
    """
    conn = None
    tenant_conn = None

    # Generate admin password if not provided. The tenant admin is a tenant
    # user, so bcrypt (PasswordTooLongError over 72 bytes, before any change).
    if not admin_password:
        admin_password = generate_password(16)

    admin_password_hash = hash_user_password(admin_password)

    try:
        conn = await get_admin_connection()

        logger.info("Provisioning tenant database: %s", database_name)

        # Validate identifiers to prevent SQL injection
        _validate_identifier(database_user)
        _validate_identifier(database_name)
        safe_password = _escape_literal(database_password)

        # Create database user
        try:
            await conn.execute(f"CREATE USER \"{database_user}\" WITH PASSWORD '{safe_password}'")
            logger.info("  Created user: %s", database_user)
        except asyncpg.DuplicateObjectError:
            # User exists, update password
            await conn.execute(f"ALTER USER \"{database_user}\" WITH PASSWORD '{safe_password}'")
            logger.info("  Updated password for existing user: %s", database_user)
        except Exception as e:
            logger.exception("  Error creating user: %s", e)
            raise

        # Grant the tenant role to the provisioning admin so that, on managed
        # Postgres (Azure / RDS / Cloud SQL) where the admin is not a superuser,
        # it can create a database OWNED by that role. Without membership,
        # "CREATE DATABASE ... OWNER <role>" fails with
        # 'must be able to SET ROLE "<role>"'. A CREATEROLE admin may grant
        # membership in any non-superuser role. Harmless if already a superuser.
        try:
            await conn.execute(f'GRANT "{database_user}" TO CURRENT_USER')
            logger.info("  Granted %s to provisioning admin", database_user)
        except Exception as e:
            logger.warning("  Could not grant tenant role to admin (continuing): %s", e)

        # Create database
        try:
            await conn.execute(f'CREATE DATABASE "{database_name}" OWNER "{database_user}"')
            logger.info("  Created database: %s", database_name)
        except asyncpg.DuplicateDatabaseError:
            logger.info("  Database already exists: %s", database_name)
        except Exception as e:
            logger.exception("  Error creating database: %s", e)
            raise

        # Grant privileges
        try:
            await conn.execute(
                f'GRANT ALL PRIVILEGES ON DATABASE "{database_name}" TO "{database_user}"'
            )
        except Exception as e:
            logger.exception("  Error granting privileges: %s", e)
            raise

        # Make sure the tenant user owns the database itself (in case the DB
        # pre-existed and was owned by some other role).
        try:
            await conn.execute(f'ALTER DATABASE "{database_name}" OWNER TO "{database_user}"')
        except Exception as e:
            logger.warning("  Could not set database owner (continuing): %s", e)

        await conn.close()
        conn = None

        # When re-provisioning an existing tenant database, objects (tables,
        # sequences, indexes) may be owned by a different role than the
        # current tenant user. CREATE INDEX IF NOT EXISTS / ALTER will then
        # fail with "must be owner of table ...". Reassign ownership of all
        # objects in the public schema to the tenant user using the admin
        # connection before we run the schema as the tenant user.
        settings = get_settings()
        pg_admin_user = settings.pg_admin_user or settings.db_user
        pg_admin_password = settings.pg_admin_password or settings.db_password
        try:
            ownership_conn = await asyncpg.connect(
                host=settings.db_host,
                port=settings.db_port,
                user=pg_admin_user,
                password=pg_admin_password,
                database=database_name,
            )
            try:
                await _reassign_public_schema_owner(ownership_conn, database_user)
                logger.info("  Reassigned public schema object ownership to %s", database_user)
            finally:
                await ownership_conn.close()
        except Exception as e:
            logger.warning("  Could not reassign object ownership (continuing): %s", e)

        # Connect to the new database to create schema
        logger.info("  Connecting to new database as %s...", database_user)
        tenant_conn = await asyncpg.connect(
            host=settings.db_host,
            port=settings.db_port,
            user=database_user,
            password=database_password,
            database=database_name,
        )

        # Create schema
        logger.info("  Creating schema tables...")
        schema_sql = get_tenant_schema_sql()
        await tenant_conn.execute(schema_sql)
        logger.info("  Created schema tables")

        # Seed data
        if seed_demo_data:
            logger.info("  Seeding demo data...")
            demo = build_demo(
                date.today(),
                admin_email=admin_email,
                instance_title=instance_title or "Demo Instance",
            )
            await insert_demo_data(tenant_conn, demo, admin_password_hash=admin_password_hash)
            logger.info("  Seeded demo data")
        else:
            logger.info("  Seeding initial data...")
            await run_seed_data(tenant_conn, admin_email, admin_password_hash)
            logger.info("  Seeded initial data")

        await tenant_conn.close()
        tenant_conn = None

        logger.info("Tenant database provisioned successfully: %s", database_name)

        return {
            "database_name": database_name,
            "database_user": database_user,
            "admin_email": admin_email,
            "admin_password": admin_password,
            "seed_demo_data": seed_demo_data,
        }

    except Exception as e:
        logger.exception("PROVISIONING ERROR: %s", e)
        raise
    finally:
        if conn:
            await conn.close()
        if tenant_conn:
            await tenant_conn.close()


async def drop_tenant_database(
    database_name: str,
    database_user: str,
) -> bool:
    """
    Drop a tenant database and user.

    WARNING: This permanently deletes all tenant data!
    """
    conn = await get_admin_connection()

    try:
        _validate_identifier(database_name)
        _validate_identifier(database_user)

        # Terminate any active connections (parameterized)
        await conn.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
            database_name,
        )

        # Drop database
        await conn.execute(f'DROP DATABASE IF EXISTS "{database_name}"')
        logger.info("Dropped database: %s", database_name)

        # Drop user
        await conn.execute(f'DROP USER IF EXISTS "{database_user}"')
        logger.info("Dropped user: %s", database_user)

        return True

    finally:
        await conn.close()


async def test_tenant_connection(
    database_name: str,
    database_user: str,
    database_password: str,
) -> bool:
    """
    Test if we can connect to a tenant database.

    Returns True if connection succeeds.
    """
    settings = get_settings()

    try:
        conn = await asyncpg.connect(
            host=settings.db_host,
            port=settings.db_port,
            user=database_user,
            password=database_password,
            database=database_name,
        )
        await conn.execute("SELECT 1")
        await conn.close()
        return True
    except Exception as e:
        logger.error("Connection test failed: %s", e)
        return False


async def check_tenant_database(
    database_name: str,
    database_user: str,
    database_password: str,
) -> dict[str, Any]:
    """
    Check tenant database status and health.

    Returns dict with:
    - exists: bool - database exists
    - accessible: bool - can connect with credentials
    - tables: list - list of tables in database
    - user_count: int - number of users
    - project_count: int - number of projects
    """
    settings = get_settings()
    admin_conn = None
    tenant_conn = None

    result = {
        "exists": False,
        "accessible": False,
        "tables": [],
        "user_count": 0,
        "project_count": 0,
        "error": None,
    }

    try:
        # Check if database exists using admin connection
        admin_conn = await get_admin_connection()
        db_check = await admin_conn.fetchval(
            "SELECT 1 FROM pg_database WHERE datname = $1", database_name
        )
        result["exists"] = db_check is not None

        if not result["exists"]:
            result["error"] = "Database does not exist"
            return result

    except Exception as e:
        result["error"] = f"Admin connection failed: {e}"
        return result
    finally:
        if admin_conn:
            await admin_conn.close()

    try:
        # Try to connect with tenant credentials
        tenant_conn = await asyncpg.connect(
            host=settings.db_host,
            port=settings.db_port,
            user=database_user,
            password=database_password,
            database=database_name,
        )
        result["accessible"] = True

        # Get table list
        tables = await tenant_conn.fetch("""
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name
        """)
        table_list: list[str] = [t["table_name"] for t in tables]
        result["tables"] = table_list

        # Get counts if tables exist
        if "users" in table_list:
            result["user_count"] = await tenant_conn.fetchval("SELECT COUNT(*) FROM users")

        if "projects" in table_list:
            result["project_count"] = await tenant_conn.fetchval("SELECT COUNT(*) FROM projects")

    except Exception as e:
        result["error"] = f"Tenant connection failed: {e}"
    finally:
        if tenant_conn:
            await tenant_conn.close()

    return result
