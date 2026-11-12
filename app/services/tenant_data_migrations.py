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

import json
import logging

from sqlalchemy import text

from app.services.dashboard_seed import (
    ABSORPTION_WIDGET_TITLE,
    CAPACITY_DASHBOARD_NAME,
    absorption_widget_row,
)
from app.services.tenant_provisioner import (
    ABSORPTION_EXAMPLE_MARKER_KEY,
    ABSORPTION_EXAMPLE_MARKER_SQL,
    APPROVAL_REQUESTS_ORPHAN_CLEANUP_SQL,
    CAPACITY_DASHBOARD_FIND_SQL,
    CARD_COMMENTS_AUTHOR_FK_NEEDS_FIX_SQL,
    CARD_COMMENTS_AUTHOR_FK_SQL,
    CARD_COMMENTS_ORPHAN_CLEANUP_SQL,
    CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL,
    DASHBOARD_TOUCH_SQL,
    DASHBOARD_WIDGET_LAYOUTS_SQL,
    DASHBOARD_WIDGET_SEED_SQL,
    DASHBOARD_WIDGET_TITLE_PROBE_SQL,
    PENDING_ASSIGNMENT_ORPHAN_CLEANUP_SQL,
    PROJECTS_SITE_FK_NEEDS_FIX_SQL,
    PROJECTS_SITE_FK_SQL,
    RBAC_SEED_NEEDED_SQL,
    RBAC_SEED_STATEMENTS,
    STALE_APPROVAL_POINTER_CLEANUP_SQL,
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
    # After the expiry above, so the rows of requests it just closed go too.
    *(
        ("removed", "orphaned pending booking(s)", sql)
        for sql in PENDING_ASSIGNMENT_ORPHAN_CLEANUP_SQL
    ),
    *(("cleared", "stale approval pointer(s)", sql) for sql in STALE_APPROVAL_POINTER_CLEANUP_SQL),
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


def _layout_of(text_value) -> dict:
    try:
        value = json.loads(text_value or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


async def add_absorption_example(conn) -> bool:
    """
    The absorption gauge on the built-in "Capacity and flows", once per
    instance (2.6.0). The marker row is claimed first (``INSERT ... ON
    CONFLICT DO NOTHING RETURNING``): only the process that wrote it goes on,
    so two workers starting together cannot both add the gauge (the second
    waits on the key and gets no row back). Then, in the same transaction:
    append the gauge below the existing widgets of a "Capacity and flows"
    with no owner that has no widget of that title, and bump the dashboard's
    ``updated_at``. The marker stays whether or not anything was added, so a
    later deletion is final; a failure rolls the claim back with the rest.
    Returns whether the gauge was added. Fresh installs got it from the
    seed; their first run only writes the marker.
    """
    marker = ABSORPTION_EXAMPLE_MARKER_KEY
    claimed = (
        await conn.execute(text(ABSORPTION_EXAMPLE_MARKER_SQL).bindparams(key=marker, value="1"))
    ).scalar()
    if not claimed:
        # Done before, or by another process right now.
        await conn.rollback()
        return False
    added = False
    dashboard_id = (
        await conn.execute(
            text(CAPACITY_DASHBOARD_FIND_SQL).bindparams(name=CAPACITY_DASHBOARD_NAME)
        )
    ).scalar()
    if dashboard_id:
        present = (
            await conn.execute(
                text(DASHBOARD_WIDGET_TITLE_PROBE_SQL).bindparams(
                    dashboard_id=dashboard_id, title=ABSORPTION_WIDGET_TITLE
                )
            )
        ).scalar()
        if not present:
            rows = (
                await conn.execute(
                    text(DASHBOARD_WIDGET_LAYOUTS_SQL).bindparams(dashboard_id=dashboard_id)
                )
            ).all()
            layouts = [_layout_of(layout) for layout, _sort in rows]
            next_order = max((int(sort or 0) for _layout, sort in rows), default=-1) + 1
            widget = absorption_widget_row(layouts, next_order)
            await conn.execute(
                text(DASHBOARD_WIDGET_SEED_SQL).bindparams(dashboard_id=dashboard_id, **widget)
            )
            await conn.execute(text(DASHBOARD_TOUCH_SQL).bindparams(dashboard_id=dashboard_id))
            added = True
    await conn.commit()
    return added


async def run_data_migrations(conn) -> None:
    """
    Apply the guarded FK rewrites, the RBAC seed, the orphan cleanups and
    the one-time absorption example. Never raises.
    """
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

    # After the dashboards tables and their seed (the built-in steps ran
    # before): the absorption example, once per instance (2.6.0).
    try:
        if await add_absorption_example(conn):
            logger.info("Data migration: added the absorption example on %s", db)
    except Exception as e:
        logger.warning("Data migration (absorption example) warning for %s: %s", db, e)
        await _rollback_quietly(conn)
