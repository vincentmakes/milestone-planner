"""
Per-tenant data/schema migrations run from the tenant auto-migration step.

Called by ``TenantConnectionManager._run_auto_migrations`` (and therefore also
by ``run_single_tenant_auto_migrations``) after the built-in steps, with the
same SQLAlchemy ``AsyncConnection``. Every step is idempotent, runs in its own
transaction and never raises: a failing step is logged, rolled back and the
next one still runs, exactly like the built-in auto-migration steps.

The SQL lives in ``app.services.tenant_provisioner`` so the fresh-install
schema, ``setup_databases.sql`` and the ``migrations/*.sql`` files share it.
"""

import logging

from sqlalchemy import text

from app.services.tenant_provisioner import (
    APPROVAL_REQUESTS_ORPHAN_CLEANUP_SQL,
    CARD_COMMENTS_AUTHOR_FK_NEEDS_FIX_SQL,
    CARD_COMMENTS_AUTHOR_FK_SQL,
    CARD_COMMENTS_ORPHAN_CLEANUP_SQL,
    CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL,
    PROJECTS_SITE_FK_NEEDS_FIX_SQL,
    PROJECTS_SITE_FK_SQL,
    RBAC_SEED_NEEDED_SQL,
    RBAC_SEED_STATEMENTS,
)

logger = logging.getLogger(__name__)

# (label, "needs fix?" query, fix) -- the fix only runs (and logs) when needed.
FK_STEPS: tuple[tuple[str, str, str], ...] = (
    (
        "projects.site_id FK -> ON DELETE CASCADE",
        PROJECTS_SITE_FK_NEEDS_FIX_SQL,
        PROJECTS_SITE_FK_SQL,
    ),
    (
        "card_comments.author_id -> nullable, ON DELETE SET NULL",
        CARD_COMMENTS_AUTHOR_FK_NEEDS_FIX_SQL,
        CARD_COMMENTS_AUTHOR_FK_SQL,
    ),
)

# (label, "needed?" query, statements) -- RBAC (1.13.0), after the tables
# the auto-migration creates: the system roles with their default permissions
# (only for a role row created now, so an admin's edits are never re-seeded),
# one approval policy per approvable action, unknown role values reset to
# 'user', then users.role's CHECK replaced by the FK to roles.key. All
# statements in one transaction: the FK never lands without the roles.
RBAC_SEED_STEP: tuple[str, str, tuple[str, ...]] = (
    "RBAC system roles, approval policies, users.role FK",
    RBAC_SEED_NEEDED_SQL,
    RBAC_SEED_STATEMENTS,
)

# (verb, label, statement) -- rowcount is logged when something changed.
CLEANUP_STEPS: tuple[tuple[str, str, str], ...] = (
    ("removed", "orphaned custom-column value(s)", CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL),
    ("removed", "orphaned card comment(s)", CARD_COMMENTS_ORPHAN_CLEANUP_SQL),
    ("expired", "orphaned approval request(s)", APPROVAL_REQUESTS_ORPHAN_CLEANUP_SQL),
)


def _label(conn) -> str:
    """The database name, for log lines (the caller does not pass the slug)."""
    try:
        return str(conn.engine.url.database)
    except Exception:  # pragma: no cover - logging only
        return "tenant"


async def _rollback_quietly(conn) -> None:
    try:
        await conn.rollback()
    except Exception as e:  # pragma: no cover - best effort
        logger.debug("Data-migration rollback failed: %s", e)


async def run_data_migrations(conn) -> None:
    """Apply the guarded FK rewrites, the RBAC seed and the orphan cleanups. Never raises."""
    db = _label(conn)

    for label, needs_fix_sql, fix_sql in FK_STEPS:
        try:
            needs_fix = (await conn.execute(text(needs_fix_sql))).scalar()
            if needs_fix:
                logger.info("Data migration: %s on %s...", label, db)
                await conn.execute(text(fix_sql))
                await conn.commit()
                logger.info("Data migration: %s done on %s", label, db)
        except Exception as e:
            logger.warning("Data migration (%s) warning for %s: %s", label, db, e)
            await _rollback_quietly(conn)

    label, needed_sql, statements = RBAC_SEED_STEP
    try:
        if (await conn.execute(text(needed_sql))).scalar():
            logger.info("Data migration: %s on %s...", label, db)
            for statement in statements:
                await conn.execute(text(statement))
            await conn.commit()
            logger.info("Data migration: %s done on %s", label, db)
    except Exception as e:
        logger.warning("Data migration (%s) warning for %s: %s", label, db, e)
        await _rollback_quietly(conn)

    for verb, label, cleanup_sql in CLEANUP_STEPS:
        try:
            result = await conn.execute(text(cleanup_sql))
            await conn.commit()
            changed = getattr(result, "rowcount", 0) or 0
            if changed:
                logger.info("Data migration: %s %s %s on %s", verb, changed, label, db)
        except Exception as e:
            logger.warning("Data migration (%s) warning for %s: %s", label, db, e)
            await _rollback_quietly(conn)
