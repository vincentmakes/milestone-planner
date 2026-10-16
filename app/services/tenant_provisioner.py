"""
Tenant Database Provisioner.

Handles creating and managing tenant PostgreSQL databases.
Schema matches Node.js application exactly.
"""

import logging
import re
from typing import Any

import asyncpg

from app.config import get_settings
from app.services.encryption import generate_password, hash_password

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


def _add_column_if_missing(table: str, column: str, definition: str, backfill: str = "") -> str:
    """
    Idempotent ``ADD COLUMN`` for upgrading a database created by an older
    release, as a guarded DO block (an already-migrated database does not take
    the ALTER TABLE lock again). ``backfill`` runs once, in the same branch,
    right after the column is created -- never on a fresh database. Only ever
    called with literal identifiers from this module.
    """
    return f"""
    DO $$
    BEGIN
        IF to_regclass('public.{table}') IS NOT NULL AND NOT EXISTS (
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

# users.max_capacity (part-time staff), users.is_system (protected admin: the
# first admin becomes the system user, as add_is_system_column.sql /
# the auto-migration do), users.updated_at.
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


# Tag groups and site-scoped tags (add_tag_groups_and_sites.sql). The tables
# are created by the schema / auto-migration; these upgrade a pre-existing
# tags table in place (tag_groups must exist first: group_id references it).
TAG_GROUPS_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS tag_groups (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      single_select BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )"""

TAG_SITES_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS tag_sites (
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      PRIMARY KEY (tag_id, site_id)
    )"""

TAGS_GROUP_INDEX_SQL = "CREATE INDEX IF NOT EXISTS idx_tags_group ON tags(group_id)"
TAG_SITES_SITE_INDEX_SQL = "CREATE INDEX IF NOT EXISTS idx_tag_sites_site ON tag_sites(site_id)"

# One guarded DO block per column (the auto-migration runs them one at a time:
# asyncpg executes a single statement per call).
TAGS_UPGRADE_STATEMENTS: tuple[str, ...] = (
    _add_column_if_missing(
        "tags", "group_id", "INTEGER REFERENCES tag_groups(id) ON DELETE SET NULL"
    ),
    _add_column_if_missing("tags", "all_sites", "BOOLEAN NOT NULL DEFAULT TRUE"),
    _add_column_if_missing("tags", "sort_order", "INTEGER NOT NULL DEFAULT 0"),
)
TAGS_UPGRADE_SQL = "".join(TAGS_UPGRADE_STATEMENTS)

# Pre-release 1.6.0 builds had a tag_groups.colors_projects flag (one group coloured the
# project bars); colouring is now a per-user Gantt preference. Idempotent drop.
TAG_GROUPS_DROP_COLORS_STATEMENTS: tuple[str, ...] = (
    "DROP INDEX IF EXISTS idx_tag_groups_colors_projects",
    "ALTER TABLE tag_groups DROP COLUMN IF EXISTS colors_projects",
)


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

    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      job_title TEXT,
      role TEXT DEFAULT 'user' NOT NULL CHECK(role IN ('admin', 'superuser', 'user')),
      max_capacity INTEGER DEFAULT 100 NOT NULL,
      sso_provider TEXT,
      sso_id TEXT,
      active INTEGER DEFAULT 1 NOT NULL,
      is_system INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Upgrade of a users table that predates part-time capacity / the
    -- protected system admin.
    """
        + USERS_UPGRADE_SQL
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Subphase staff assignments
    CREATE TABLE IF NOT EXISTS subphase_staff_assignments (
      id SERIAL PRIMARY KEY,
      subphase_id INTEGER NOT NULL REFERENCES project_subphases(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      allocation INTEGER DEFAULT 100,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
      default_role TEXT DEFAULT 'user' CHECK(default_role IN ('superuser', 'user')),
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
      type VARCHAR(30) NOT NULL CHECK(type IN ('assigned', 'comment', 'mention', 'status_change')),
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

    -- Tag groups (a single-select group allows one of its tags per project)
    """
        + TAG_GROUPS_TABLE_SQL
        + """;

    -- Tags (tenant-wide, assignable to projects; all_sites = false restricts a
    -- tag to the sites in tag_sites)
    CREATE TABLE IF NOT EXISTS tags (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
      group_id INTEGER REFERENCES tag_groups(id) ON DELETE SET NULL,
      all_sites BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Upgrade of a tags table from before tag groups / site-scoped tags.
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
    CREATE INDEX IF NOT EXISTS idx_tags_group ON tags(group_id);
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
    # User input - use parameterized queries
    await conn.execute(
        "INSERT INTO users (email, password, first_name, last_name, job_title, role, is_system) "
        "VALUES ($1, $2, 'Admin', 'User', 'Administrator', 'admin', 1) "
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
) -> dict[str, Any]:
    """
    Provision a new tenant database.

    Creates:
    1. PostgreSQL user
    2. PostgreSQL database
    3. Schema tables
    4. Seed data (predefined phases, default site, admin user)

    Returns dict with admin credentials.
    """
    conn = None
    tenant_conn = None

    try:
        conn = await get_admin_connection()

        # Generate admin password if not provided
        if not admin_password:
            admin_password = generate_password(16)

        admin_password_hash = hash_password(admin_password)

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


async def reset_tenant_admin_password(
    database_name: str,
    database_user: str,
    database_password: str,
    admin_email: str,
    new_password: str | None = None,
) -> dict[str, str]:
    """
    Reset a tenant admin user's password.

    Returns dict with the new password.
    """
    settings = get_settings()

    # Generate new password if not provided
    if not new_password:
        new_password = generate_password(16)

    password_hash = hash_password(new_password)

    # Connect to tenant database
    conn = await asyncpg.connect(
        host=settings.db_host,
        port=settings.db_port,
        user=database_user,
        password=database_password,
        database=database_name,
    )

    try:
        # Update password (parameterized)
        result = await conn.execute(
            "UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE email = $2",
            password_hash,
            admin_email,
        )

        if result == "UPDATE 0":
            raise ValueError(f"Admin user not found: {admin_email}")

        logger.info("Reset password for %s in %s", admin_email, database_name)

    finally:
        await conn.close()

    return {
        "admin_email": admin_email,
        "admin_password": new_password,
    }


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
