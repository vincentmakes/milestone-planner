"""
Tenant Connection Manager.

Manages database connection pools for tenant databases.
Each tenant has their own PostgreSQL database with isolated data.
"""

import asyncio
import logging
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import get_settings
from app.models.tenant import Tenant, TenantCredentials
from app.services.encryption import decrypt
from app.services.tenant_provisioner import (
    ABSENCE_TYPES_SEED_SQL,
    COMPANY_EVENT_SITES_BACKFILL_SQL,
    COMPANY_EVENTS_CLOSURE_COLUMN_SQL,
    COMPANY_EVENTS_SITE_FK_SQL,
    COMPANY_EVENTS_SITE_NULLABLE_SQL,
    EQUIPMENT_SITE_FK_NEEDS_FIX_SQL,
    EQUIPMENT_SITE_FK_SQL,
    EQUIPMENT_SITES_BACKFILL_SQL,
    NOTIFICATIONS_TYPE_CHECK_SQL,
    RBAC_NEEDS_MIGRATION_SQL,
    RBAC_SCHEMA_STATEMENTS,
    TAG_GROUPS_DROP_COLORS_STATEMENTS,
    TAG_GROUPS_TABLE_SQL,
    TAG_SITES_SITE_INDEX_SQL,
    TAG_SITES_TABLE_SQL,
    TAGS_GROUP_INDEX_SQL,
    TAGS_UPGRADE_STATEMENTS,
    TEAM_TABLES,
    TEAMS_SCHEMA_STATEMENTS,
)
from app.utils import utcnow_naive

logger = logging.getLogger(__name__)


async def _rollback_quietly(conn) -> None:
    """Clear a failed auto-migration transaction so later steps can still run."""
    try:
        await conn.rollback()
    except Exception as e:  # pragma: no cover - best effort
        logger.debug("Auto-migration rollback failed: %s", e)


async def encrypt_tenant_sso_secret(conn, slug: str) -> bool:
    """
    Encrypt a plaintext ``sso_config.client_secret`` in place.

    Idempotent: an empty or already-encrypted value is left alone. Returns True
    when a row was rewritten. Never raises (logged as a warning).
    """
    from app.services.encryption import encrypt
    from app.services.sso import is_encrypted_secret

    try:
        exists = (await conn.execute(text("SELECT to_regclass('public.sso_config')"))).scalar()
        if not exists:
            return False
        stored = (
            await conn.execute(text("SELECT client_secret FROM sso_config WHERE id = 1"))
        ).scalar()
        if not stored or is_encrypted_secret(stored):
            return False
        await conn.execute(
            text(
                "UPDATE sso_config SET client_secret = :new WHERE id = 1 AND client_secret = :old"
            ),
            {"new": encrypt(stored), "old": stored},
        )
        await conn.commit()
        logger.info("Auto-migration: Encrypted the SSO client secret at rest on tenant %s", slug)
        return True
    except Exception as e:
        logger.warning("Auto-migration (sso_config secret) warning for %s: %s", slug, e)
        await _rollback_quietly(conn)
        return False


class TenantConnectionManager:
    """
    Manages connection pools for tenant databases.

    Features:
    - Lazy pool creation (pools created on first access)
    - Automatic cleanup of idle pools
    - Connection testing before returning pools
    """

    def __init__(self):
        self._pools: dict[str, AsyncEngine] = {}
        self._pool_timestamps: dict[str, datetime] = {}
        self._session_factories: dict[str, async_sessionmaker] = {}
        self._cleanup_task: asyncio.Task | None = None
        # One lock per slug around pool creation, so concurrent first requests
        # for a cold tenant build one engine (and run the auto-migrations once)
        # instead of racing and leaking the losers' engines.
        self._pool_locks: dict[str, asyncio.Lock] = {}

        # Configuration
        self.max_idle_time = 15 * 60  # 15 minutes
        self.cleanup_interval = 5 * 60  # 5 minutes

    def start_cleanup_task(self):
        """Start the background cleanup task."""
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def _cleanup_loop(self):
        """Periodically clean up idle connection pools."""
        while True:
            await asyncio.sleep(self.cleanup_interval)
            await self._cleanup_idle_pools()

    async def _cleanup_idle_pools(self):
        """Remove connection pools that have been idle too long."""
        now = utcnow_naive()
        to_remove = []

        for slug, timestamp in self._pool_timestamps.items():
            idle_seconds = (now - timestamp).total_seconds()
            if idle_seconds > self.max_idle_time:
                to_remove.append(slug)

        for slug in to_remove:
            await self._close_pool(slug)
            logger.info("Closed idle tenant pool: %s", slug)

    async def _close_pool(self, slug: str):
        """Close a specific tenant's connection pool."""
        if slug in self._pools:
            engine = self._pools.pop(slug)
            await engine.dispose()

        self._pool_timestamps.pop(slug, None)
        self._session_factories.pop(slug, None)

    async def _run_auto_migrations(self, conn, slug: str):
        """
        Run automatic migrations for tenant databases.

        This ensures schema changes are applied without manual intervention.
        """
        try:
            # Check if is_system column exists
            result = await conn.execute(
                text("""
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'users' AND column_name = 'is_system'
            """)
            )
            if not result.fetchone():
                logger.info("Auto-migration: Adding is_system column to tenant %s...", slug)
                await conn.execute(text("ALTER TABLE users ADD COLUMN is_system INTEGER DEFAULT 0"))
                # Mark first admin as system user
                await conn.execute(
                    text("""
                    UPDATE users SET is_system = 1
                    WHERE id = (SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1)
                """)
                )
                await conn.commit()
                logger.info("Auto-migration: Added is_system column to tenant %s", slug)
        except Exception as e:
            logger.warning("Auto-migration warning for %s: %s", slug, e)
            # Don't fail if migration has issues - continue with connection

        # Tags / project_tags tables (added in the project-tags feature).
        # Idempotent CREATE IF NOT EXISTS so this is safe to run on every boot.
        try:
            tables_check = await conn.execute(
                text("""
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name IN ('tags', 'project_tags')
            """)
            )
            existing = {row[0] for row in tables_check.fetchall()}
            if "tags" not in existing or "project_tags" not in existing:
                logger.info("Auto-migration: Creating tags tables on tenant %s...", slug)
                await conn.execute(
                    text("""
                    CREATE TABLE IF NOT EXISTS tags (
                        id SERIAL PRIMARY KEY,
                        name VARCHAR(100) NOT NULL UNIQUE,
                        color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                )
                await conn.execute(
                    text("""
                    CREATE TABLE IF NOT EXISTS project_tags (
                        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (project_id, tag_id)
                    )
                """)
                )
                await conn.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS idx_project_tags_project ON project_tags(project_id)"
                    )
                )
                await conn.execute(
                    text("CREATE INDEX IF NOT EXISTS idx_project_tags_tag ON project_tags(tag_id)")
                )
                await conn.commit()
                logger.info("Auto-migration: Created tags tables on tenant %s", slug)
        except Exception as e:
            logger.warning("Auto-migration (tags) warning for %s: %s", slug, e)

        # Tag groups + site-scoped tags: tag_groups / tag_sites tables and the
        # tags.group_id / all_sites / sort_order columns. Every statement is
        # idempotent (guarded inside the SQL), so this converges on any state.
        try:
            tables_check = await conn.execute(
                text("""
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name IN ('tag_groups', 'tag_sites')
            """)
            )
            existing = {row[0] for row in tables_check.fetchall()}
            columns_check = await conn.execute(
                text("""
                SELECT column_name FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'tags'
                  AND column_name IN ('group_id', 'all_sites', 'sort_order')
            """)
            )
            columns = {row[0] for row in columns_check.fetchall()}
            if len(existing) < 2 or len(columns) < 3:
                logger.info("Auto-migration: Adding tag groups / tag sites on tenant %s...", slug)
                await conn.execute(text(TAG_GROUPS_TABLE_SQL))
                for statement in TAGS_UPGRADE_STATEMENTS:
                    await conn.execute(text(statement))
                await conn.execute(text(TAG_SITES_TABLE_SQL))
                await conn.execute(text(TAGS_GROUP_INDEX_SQL))
                await conn.execute(text(TAG_SITES_SITE_INDEX_SQL))
                await conn.commit()
                logger.info("Auto-migration: Added tag groups / tag sites on tenant %s", slug)
        except Exception as e:
            logger.warning("Auto-migration (tag groups) warning for %s: %s", slug, e)
            await _rollback_quietly(conn)

        # Pre-release 1.6.0 builds carried tag_groups.colors_projects; colouring is now a
        # per-user Gantt preference, so drop the column and its partial index if present.
        try:
            colors_check = await conn.execute(
                text("""
                SELECT column_name FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'tag_groups'
                  AND column_name = 'colors_projects'
            """)
            )
            if colors_check.fetchone() is not None:
                logger.info(
                    "Auto-migration: Dropping tag_groups.colors_projects on tenant %s...", slug
                )
                for statement in TAG_GROUPS_DROP_COLORS_STATEMENTS:
                    await conn.execute(text(statement))
                await conn.commit()
                logger.info("Auto-migration: Dropped tag_groups.colors_projects on tenant %s", slug)
        except Exception as e:
            logger.warning("Auto-migration (tag group colours) warning for %s: %s", slug, e)
            await _rollback_quietly(conn)

        # equipment_blocks table (added in the equipment maintenance feature).
        # Old tenants provisioned before this feature lack the table entirely.
        try:
            result = await conn.execute(
                text("""
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'equipment_blocks'
            """)
            )
            if not result.fetchone():
                logger.info("Auto-migration: Creating equipment_blocks table on tenant %s...", slug)
                await conn.execute(
                    text("""
                    CREATE TABLE IF NOT EXISTS equipment_blocks (
                        id SERIAL PRIMARY KEY,
                        equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
                        start_date DATE NOT NULL,
                        end_date DATE NOT NULL,
                        reason VARCHAR(50) NOT NULL DEFAULT 'maintenance',
                        description VARCHAR(200) NOT NULL DEFAULT 'Maintenance',
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                )
                await conn.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS idx_equipment_blocks_equipment_id "
                        "ON equipment_blocks(equipment_id)"
                    )
                )
                await conn.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS idx_equipment_blocks_dates "
                        "ON equipment_blocks(start_date, end_date)"
                    )
                )
                await conn.commit()
                logger.info("Auto-migration: Created equipment_blocks table on tenant %s", slug)
        except Exception as e:
            logger.warning("Auto-migration (equipment_blocks) warning for %s: %s", slug, e)

        # company_events.color column (added when event color picker was introduced).
        # Old tenants have the company_events table but no color column.
        try:
            result = await conn.execute(
                text("""
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'company_events' AND column_name = 'color'
            """)
            )
            if not result.fetchone():
                logger.info(
                    "Auto-migration: Adding color column to company_events on tenant %s...", slug
                )
                await conn.execute(
                    text("ALTER TABLE company_events ADD COLUMN IF NOT EXISTS color VARCHAR(20)")
                )
                await conn.commit()
                logger.info(
                    "Auto-migration: Added color column to company_events on tenant %s", slug
                )
        except Exception as e:
            logger.warning("Auto-migration (company_events.color) warning for %s: %s", slug, e)

        # staff_notes table (the Note model's table). Historic install paths
        # created a legacy "notes" table instead, which the app never read or
        # wrote. Create staff_notes, copy any legacy rows, drop the old table.
        try:
            result = await conn.execute(
                text("""
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name IN ('staff_notes', 'notes')
            """)
            )
            existing = {row[0] for row in result.fetchall()}
            if "staff_notes" not in existing or "notes" in existing:
                logger.info("Auto-migration: Creating staff_notes table on tenant %s...", slug)
                await conn.execute(
                    text("""
                    CREATE TABLE IF NOT EXISTS staff_notes (
                        id SERIAL PRIMARY KEY,
                        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
                        staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                        date DATE NOT NULL,
                        text TEXT NOT NULL,
                        type VARCHAR(50) NOT NULL DEFAULT 'general',
                        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                )
                await conn.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS idx_staff_notes_site_date "
                        "ON staff_notes(site_id, date)"
                    )
                )
                if "notes" in existing:
                    has_type = await conn.execute(
                        text("""
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = 'notes' AND column_name = 'type'
                    """)
                    )
                    if has_type.fetchone():
                        await conn.execute(
                            text("""
                            INSERT INTO staff_notes (site_id, staff_id, date, text, type, created_at)
                            SELECT site_id, staff_id, date, text,
                                   COALESCE(type, 'general'),
                                   COALESCE(created_at, CURRENT_TIMESTAMP)
                            FROM notes WHERE site_id IS NOT NULL
                        """)
                        )
                    else:
                        await conn.execute(
                            text("""
                            INSERT INTO staff_notes (site_id, staff_id, date, text, created_at)
                            SELECT site_id, staff_id, date, text,
                                   COALESCE(created_at, CURRENT_TIMESTAMP)
                            FROM notes WHERE site_id IS NOT NULL
                        """)
                        )
                    await conn.execute(text("DROP TABLE notes"))
                await conn.commit()
                logger.info("Auto-migration: Created staff_notes table on tenant %s", slug)
        except Exception as e:
            logger.warning("Auto-migration (staff_notes) warning for %s: %s", slug, e)

        # Kanban status column on the two card tables (added with the Kanban board).
        # Backfilled from `completion` so existing plans land in sensible columns.
        try:
            status_check = await conn.execute(
                text("""
                SELECT table_name FROM information_schema.columns
                WHERE table_schema = 'public' AND column_name = 'status'
                  AND table_name IN ('project_phases', 'project_subphases')
            """)
            )
            have_status = {row[0] for row in status_check.fetchall()}
            for table in ("project_phases", "project_subphases"):
                if table in have_status:
                    continue
                logger.info("Auto-migration: Adding %s.status on tenant %s...", table, slug)
                await conn.execute(
                    text(
                        f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS "  # noqa: S608
                        "status VARCHAR(20) NOT NULL DEFAULT 'todo'"
                    )
                )
                await conn.execute(
                    text(f"""
                    DO $$
                    BEGIN
                        IF NOT EXISTS (
                            SELECT 1 FROM pg_constraint WHERE conname = '{table}_status_check'
                        ) THEN
                            ALTER TABLE {table} ADD CONSTRAINT {table}_status_check
                            CHECK (status IN ('todo', 'in_progress', 'blocked', 'done'));
                        END IF;
                    END $$;
                """)
                )
                await conn.execute(
                    text(f"""
                    UPDATE {table} SET status = CASE
                        WHEN completion IS NULL OR completion <= 0 THEN 'todo'
                        WHEN completion >= 100 THEN 'done'
                        ELSE 'in_progress'
                    END
                    WHERE status = 'todo'
                """)  # noqa: S608
                )
                await conn.commit()
                logger.info("Auto-migration: Added %s.status on tenant %s", table, slug)
        except Exception as e:
            logger.warning("Auto-migration (card status) warning for %s: %s", slug, e)

        # Kanban card comments table.
        try:
            comments_check = await conn.execute(
                text("""
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'card_comments'
            """)
            )
            if not comments_check.fetchone():
                logger.info("Auto-migration: Creating card_comments on tenant %s...", slug)
                await conn.execute(
                    text("""
                    CREATE TABLE IF NOT EXISTS card_comments (
                        id SERIAL PRIMARY KEY,
                        entity_type VARCHAR(20) NOT NULL,
                        entity_id INTEGER NOT NULL,
                        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                        author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                        body TEXT NOT NULL,
                        mentioned_user_ids TEXT,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
                        CONSTRAINT card_comments_entity_type_check
                            CHECK (entity_type IN ('phase', 'subphase'))
                    )
                """)
                )
                await conn.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS idx_card_comments_entity "
                        "ON card_comments(entity_type, entity_id)"
                    )
                )
                await conn.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS idx_card_comments_project "
                        "ON card_comments(project_id)"
                    )
                )
                await conn.commit()
                logger.info("Auto-migration: Created card_comments on tenant %s", slug)
        except Exception as e:
            logger.warning("Auto-migration (card_comments) warning for %s: %s", slug, e)

        # In-app notifications table.
        try:
            notif_check = await conn.execute(
                text("""
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'notifications'
            """)
            )
            if not notif_check.fetchone():
                logger.info("Auto-migration: Creating notifications on tenant %s...", slug)
                await conn.execute(
                    text("""
                    CREATE TABLE IF NOT EXISTS notifications (
                        id SERIAL PRIMARY KEY,
                        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        type VARCHAR(30) NOT NULL,
                        actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                        entity_type VARCHAR(20),
                        entity_id INTEGER,
                        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
                        title VARCHAR(200) NOT NULL,
                        body TEXT,
                        read_at TIMESTAMP,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
                        CONSTRAINT notifications_type_check
                            CHECK (type IN ('assigned', 'comment', 'mention', 'status_change',
                                            'approval_requested', 'approval_decided',
                                            'todo_assigned', 'assignment_changed',
                                            'project_changed'))
                    )
                """)
                )
                await conn.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS idx_notifications_user_unread "
                        "ON notifications(user_id, created_at DESC) WHERE read_at IS NULL"
                    )
                )
                await conn.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS idx_notifications_user_created "
                        "ON notifications(user_id, created_at DESC)"
                    )
                )
                await conn.commit()
                logger.info("Auto-migration: Created notifications on tenant %s", slug)
        except Exception as e:
            logger.warning("Auto-migration (notifications) warning for %s: %s", slug, e)

        # Absence types (Holidays, Home Office, ...). Mirrors
        # migrations/add_absence_types_and_event_sites.sql. Seeded on creation.
        try:
            result = await conn.execute(
                text("""
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'absence_types'
            """)
            )
            if not result.fetchone():
                logger.info("Auto-migration: Creating absence_types on tenant %s...", slug)
                await conn.execute(
                    text("""
                    CREATE TABLE IF NOT EXISTS absence_types (
                        id SERIAL PRIMARY KEY,
                        name VARCHAR(100) NOT NULL UNIQUE,
                        color VARCHAR(7) NOT NULL DEFAULT '#8b5cf6',
                        counts_as_unavailable BOOLEAN NOT NULL DEFAULT TRUE,
                        sort_order INTEGER NOT NULL DEFAULT 0,
                        is_active BOOLEAN NOT NULL DEFAULT TRUE,
                        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                )
                await conn.execute(text(ABSENCE_TYPES_SEED_SQL))
                await conn.commit()
                logger.info("Auto-migration: Created absence_types on tenant %s", slug)
        except Exception as e:
            logger.warning("Auto-migration (absence_types) warning for %s: %s", slug, e)
            await _rollback_quietly(conn)

        # vacations.absence_type_id. Existing rows are filed under "Holidays"
        # once, when the column is created; NULL afterwards means "unavailable".
        try:
            result = await conn.execute(
                text("""
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'vacations'
                  AND column_name = 'absence_type_id'
            """)
            )
            if not result.fetchone():
                logger.info(
                    "Auto-migration: Adding vacations.absence_type_id on tenant %s...", slug
                )
                await conn.execute(
                    text(
                        "ALTER TABLE vacations ADD COLUMN IF NOT EXISTS absence_type_id INTEGER "
                        "REFERENCES absence_types(id) ON DELETE SET NULL"
                    )
                )
                await conn.execute(
                    text("""
                    UPDATE vacations
                    SET absence_type_id = (SELECT id FROM absence_types WHERE name = 'Holidays')
                    WHERE absence_type_id IS NULL
                """)
                )
                await conn.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS idx_vacations_absence_type "
                        "ON vacations(absence_type_id)"
                    )
                )
                await conn.commit()
                logger.info("Auto-migration: Added vacations.absence_type_id on tenant %s", slug)
        except Exception as e:
            logger.warning("Auto-migration (vacations.absence_type_id) warning for %s: %s", slug, e)
            await _rollback_quietly(conn)

        # Multi-site company events: company_event_sites junction, back-filled
        # from the legacy company_events.site_id, which becomes nullable and
        # stops cascading (deleting one site must not delete shared events).
        # Every step is idempotent and runs regardless of whether the junction
        # table already existed, so a half-applied upgrade (e.g. the table
        # created by a newer schema run without the back-fill) still converges.
        try:
            result = await conn.execute(
                text("""
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'company_event_sites'
            """)
            )
            if not result.fetchone():
                logger.info("Auto-migration: Creating company_event_sites on tenant %s...", slug)
                await conn.execute(
                    text("""
                    CREATE TABLE IF NOT EXISTS company_event_sites (
                        event_id INTEGER NOT NULL REFERENCES company_events(id) ON DELETE CASCADE,
                        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
                        PRIMARY KEY (event_id, site_id)
                    )
                """)
                )
                await conn.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS idx_company_event_sites_site "
                        "ON company_event_sites(site_id)"
                    )
                )
            backfill = await conn.execute(text(COMPANY_EVENT_SITES_BACKFILL_SQL))
            await conn.execute(text(COMPANY_EVENTS_SITE_NULLABLE_SQL))
            await conn.execute(text(COMPANY_EVENTS_SITE_FK_SQL))
            await conn.commit()
            if backfill.rowcount:
                logger.info(
                    "Auto-migration: Linked %s company event(s) to their site on tenant %s",
                    backfill.rowcount,
                    slug,
                )
        except Exception as e:
            logger.warning("Auto-migration (company_event_sites) warning for %s: %s", slug, e)
            await _rollback_quietly(conn)

        # equipment.site_id FK must be ON DELETE SET NULL: deleting a site
        # relies on it to keep shared equipment (no ORM cascade). Runs before
        # the equipment_sites back-fill, which it may clean dangling ids for.
        try:
            needs_fix = (await conn.execute(text(EQUIPMENT_SITE_FK_NEEDS_FIX_SQL))).scalar()
            if needs_fix:
                logger.info(
                    "Auto-migration: Setting equipment.site_id FK to ON DELETE SET NULL "
                    "on tenant %s...",
                    slug,
                )
                await conn.execute(text(EQUIPMENT_SITE_FK_SQL))
                await conn.commit()
                logger.info(
                    "Auto-migration: equipment.site_id FK is now ON DELETE SET NULL on tenant %s",
                    slug,
                )
        except Exception as e:
            logger.warning("Auto-migration (equipment.site_id FK) warning for %s: %s", slug, e)
            await _rollback_quietly(conn)

        # Multi-site equipment: equipment_sites junction, back-filled from the
        # legacy equipment.site_id. The back-fill runs regardless of whether
        # the table already existed (same reasoning as company_event_sites).
        try:
            result = await conn.execute(
                text("""
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'equipment_sites'
            """)
            )
            if not result.fetchone():
                logger.info("Auto-migration: Creating equipment_sites on tenant %s...", slug)
                await conn.execute(
                    text("""
                    CREATE TABLE IF NOT EXISTS equipment_sites (
                        equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
                        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
                        PRIMARY KEY (equipment_id, site_id)
                    )
                """)
                )
                await conn.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS idx_equipment_sites_site "
                        "ON equipment_sites(site_id)"
                    )
                )
            backfill = await conn.execute(text(EQUIPMENT_SITES_BACKFILL_SQL))
            await conn.commit()
            if backfill.rowcount:
                logger.info(
                    "Auto-migration: Linked %s equipment item(s) to their site on tenant %s",
                    backfill.rowcount,
                    slug,
                )
        except Exception as e:
            logger.warning("Auto-migration (equipment_sites) warning for %s: %s", slug, e)
            await _rollback_quietly(conn)

        # company_events.counts_as_unavailable (site closures). Guarded inside
        # the SQL, so this only logs on the tenants it actually changes.
        try:
            result = await conn.execute(
                text("""
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'company_events'
                  AND column_name = 'counts_as_unavailable'
            """)
            )
            if not result.fetchone():
                logger.info(
                    "Auto-migration: Adding counts_as_unavailable to company_events on tenant %s...",
                    slug,
                )
                await conn.execute(text(COMPANY_EVENTS_CLOSURE_COLUMN_SQL))
                await conn.commit()
                logger.info(
                    "Auto-migration: Added company_events.counts_as_unavailable on tenant %s", slug
                )
        except Exception as e:
            logger.warning(
                "Auto-migration (company_events.counts_as_unavailable) warning for %s: %s", slug, e
            )
            await _rollback_quietly(conn)

        # Teams (1.12.0): teams + the five junction tables and their indexes
        # (add_teams.sql). Idempotent; one statement per execute (asyncpg).
        try:
            tables_check = await conn.execute(
                text("""
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_name IN ('teams', 'team_members', 'project_teams', 'tag_teams',
                                     'company_event_teams', 'equipment_teams')
            """)
            )
            existing = {row[0] for row in tables_check.fetchall()}
            if not existing.issuperset(TEAM_TABLES):
                logger.info("Auto-migration: Creating teams tables on tenant %s...", slug)
                for statement in TEAMS_SCHEMA_STATEMENTS:
                    await conn.execute(text(statement))
                await conn.commit()
                logger.info("Auto-migration: Created teams tables on tenant %s", slug)
        except Exception as e:
            logger.warning("Auto-migration (teams) warning for %s: %s", slug, e)
            await _rollback_quietly(conn)

        # RBAC (1.13.0): roles, role_permissions, approval policies / requests,
        # todos, the assignment approval columns, the widened notification
        # types (add_rbac.sql). The seed (system roles + defaults, policies)
        # and the users.role CHECK -> FK swap follow in the data migrations
        # (tenant_data_migrations.RBAC_SEED_STEP). One statement per execute.
        try:
            needed = (await conn.execute(text(RBAC_NEEDS_MIGRATION_SQL))).scalar()
            if needed:
                logger.info("Auto-migration: Creating RBAC tables on tenant %s...", slug)
                for statement in RBAC_SCHEMA_STATEMENTS:
                    await conn.execute(text(statement))
                await conn.commit()
                logger.info("Auto-migration: Created RBAC tables on tenant %s", slug)
        except Exception as e:
            logger.warning("Auto-migration (rbac) warning for %s: %s", slug, e)
            await _rollback_quietly(conn)

        # Notification types (add_change_notifications.sql). Runs on every pool
        # creation: the DO block is its own gate (it replaces the CHECK only
        # when the newest type is missing), and the RBAC probe above skips
        # 1.13 / 1.14 tenants whose constraint predates the newest types.
        try:
            await conn.execute(text(NOTIFICATIONS_TYPE_CHECK_SQL))
            await conn.commit()
        except Exception as e:
            logger.warning("Auto-migration (notification types) warning for %s: %s", slug, e)
            await _rollback_quietly(conn)

        # Tenant-level SSO client secret encrypted at rest. The key is only
        # available in-process, so this cannot be a SQL migration.
        await encrypt_tenant_sso_secret(conn, slug)

        # Data/schema migrations kept in their own module (see
        # app/services/tenant_data_migrations.py). Last, and isolated: a failure
        # there must not undo the steps above.
        try:
            from app.services.tenant_data_migrations import run_data_migrations

            await run_data_migrations(conn)
        except Exception as e:
            logger.warning("Auto-migration (data migrations) warning for %s: %s", slug, e)
            await _rollback_quietly(conn)

    async def get_pool(self, tenant: Tenant, credentials: TenantCredentials) -> AsyncEngine:
        """
        Get or create a connection pool for a tenant (ORM-object variant).

        Thin wrapper over :meth:`get_pool_from_info`.
        """
        return await self.get_pool_from_info(
            {
                "slug": tenant.slug,
                "database_name": tenant.database_name,
                "database_user": tenant.database_user,
                "encrypted_password": credentials.encrypted_password,
            }
        )

    async def get_pool_from_info(self, tenant_info: dict[str, Any]) -> AsyncEngine:
        """
        Get or create a connection pool for a tenant using dict info.

        This version accepts a dict instead of ORM objects to avoid
        detached session issues when caching tenant data.

        Args:
            tenant_info: Dict with slug, database_name, database_user, encrypted_password

        Returns:
            AsyncEngine for the tenant's database
        """
        slug = tenant_info["slug"]

        # Update access timestamp
        self._pool_timestamps[slug] = utcnow_naive()

        # Fast path: existing pool, no lock needed
        if slug in self._pools:
            return self._pools[slug]

        lock = self._pool_locks.setdefault(slug, asyncio.Lock())
        async with lock:
            # Another request may have built it while we waited.
            if slug in self._pools:
                return self._pools[slug]
            engine = await self._create_pool(tenant_info)
            self._pools[slug] = engine
            self._pool_timestamps[slug] = utcnow_naive()
            return engine

    async def _create_pool(self, tenant_info: dict[str, Any]) -> AsyncEngine:
        """Build, test and auto-migrate a new engine for a tenant."""
        slug = tenant_info["slug"]

        # Decrypt password
        try:
            password = decrypt(tenant_info["encrypted_password"])
        except Exception as e:
            raise ConnectionError(f"Failed to decrypt credentials for tenant {slug}: {e}") from e

        # Build connection URL
        settings = get_settings()
        host = settings.db_host
        port = settings.db_port

        url = (
            f"postgresql+asyncpg://{tenant_info['database_user']}:{password}"
            f"@{host}:{port}/{tenant_info['database_name']}"
        )

        logger.info(
            "Connecting to tenant DB: %s as %s@%s:%s",
            tenant_info["database_name"],
            tenant_info["database_user"],
            host,
            port,
        )

        # Create engine
        engine = create_async_engine(
            url,
            echo=False,  # Disable SQL logging
            pool_size=20,
            max_overflow=10,
            pool_timeout=30,
            # Like the default engine: TIMESTAMP columns hold UTC, so
            # CURRENT_TIMESTAMP defaults must be UTC too (app/schemas/base.py).
            connect_args={"server_settings": {"timezone": "UTC"}},
        )

        # Test connection and run auto-migrations
        try:
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
                await self._run_auto_migrations(conn, slug)

            logger.info("Tenant pool created: %s", slug)
        except Exception as e:
            await engine.dispose()
            raise ConnectionError(
                f"Failed to connect to tenant database {slug} ({tenant_info['database_name']}): {e}"
            ) from e

        return engine

    def slug_for_bind(self, bind: Any) -> str | None:
        """Return the slug whose pool is ``bind`` (an AsyncEngine), if any."""
        for slug, engine in self._pools.items():
            if engine is bind:
                return slug
        return None

    def get_session_factory(self, slug: str) -> async_sessionmaker | None:
        """Get session factory for a tenant."""
        if slug not in self._pools:
            return None

        if slug not in self._session_factories:
            self._session_factories[slug] = async_sessionmaker(
                bind=self._pools[slug],
                class_=AsyncSession,
                expire_on_commit=False,
                autoflush=False,
            )

        return self._session_factories[slug]

    def get_stats(self) -> dict[str, Any]:
        """Get connection pool statistics."""

        def _pool_size(engine: AsyncEngine) -> int:
            # SQLAlchemy's QueuePool.size is a method, not an attribute.
            size = getattr(engine.pool, "size", 0)
            try:
                return int(size() if callable(size) else size)
            except Exception:
                return 0

        return {
            "active_pools": len(self._pools),
            "pool_slugs": list(self._pools.keys()),
            "total_connections": sum(_pool_size(engine) for engine in self._pools.values()),
        }

    async def close_all(self):
        """Close all connection pools."""
        for slug in list(self._pools.keys()):
            await self._close_pool(slug)

        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass


# Global instance
tenant_connection_manager = TenantConnectionManager()


async def run_single_tenant_auto_migrations(engine: AsyncEngine, label: str = "single-tenant"):
    """
    Apply the per-tenant auto-migrations to the single-tenant database.

    In multi-tenant mode they run when a tenant's pool is first created
    (get_pool / get_pool_from_info). Single-tenant mode never creates a tenant
    pool, so without this an upgraded single-tenant install would only get
    the in-place upgrades of get_tenant_schema_sql() -- and those only when
    AUTO_INIT_DB re-applies the schema. Same idempotent steps, same engine
    the app uses for requests.
    """
    async with engine.connect() as conn:
        await tenant_connection_manager._run_auto_migrations(conn, label)
