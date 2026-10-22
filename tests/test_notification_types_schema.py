"""
The notification types stay identical in every DDL source.

``tenant_provisioner.NOTIFICATION_TYPES`` is the one list; the CHECK text
derived from it (``NOTIFICATIONS_TYPE_CHECK``) appears in seven places (the
ORM, setup_databases.sql, the provisioner schema, the manual-setup template,
migrations/add_kanban_tables.sql, the tenant auto-migration's inline CREATE and
the widening ``NOTIFICATIONS_TYPE_CHECK_SQL``). The widening is guarded by the
newest type, carried verbatim by add_rbac.sql and add_change_notifications.sql,
and executed on every tenant pool creation (it is its own gate), so 1.13 / 1.14
tenants that the RBAC probe skips still gain the 1.15 types.
Repo-root files are skipped when the test tree is run outside the repository.
"""

import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import CheckConstraint

from app.models.notification import Notification
from app.services.tenant_provisioner import (
    NOTIFICATION_TYPES,
    NOTIFICATIONS_TYPE_CHECK,
    NOTIFICATIONS_TYPE_CHECK_SQL,
    RBAC_NEEDS_MIGRATION_SQL,
    RBAC_SCHEMA_STATEMENTS,
    get_tenant_schema_sql,
)
from migrations.run_migration_master import split_sql_statements

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "add_change_notifications.sql"
IN_REPO = (ROOT / "setup_databases.sql").exists() and (ROOT / "Dockerfile").exists()

FULL_LIST = (
    "type IN ('assigned', 'comment', 'mention', 'status_change', "
    "'approval_requested', 'approval_decided', 'todo_assigned', "
    "'assignment_changed', 'project_changed')"
)
# The 1.13 / 1.14 text: the list ending at todo_assigned.
OLD_TAIL = "'todo_assigned')"


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


def _root_file(relative: str) -> str:
    if not IN_REPO:
        pytest.skip("repo-root files are not part of this checkout")
    return (ROOT / relative).read_text()


# ---------------------------------------------------------------------------
# The constants
# ---------------------------------------------------------------------------


def test_notification_types_list():
    assert NOTIFICATION_TYPES == (
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
    assert NOTIFICATIONS_TYPE_CHECK == FULL_LIST


def test_widening_is_guarded_by_the_newest_type():
    sql = _norm(NOTIFICATIONS_TYPE_CHECK_SQL)
    assert "ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check" in sql
    assert (
        "ALTER TABLE notifications ADD CONSTRAINT notifications_type_check "
        f"CHECK ({NOTIFICATIONS_TYPE_CHECK})"
    ) in sql
    # Guarded on the last type: a 1.14 constraint (which already contains
    # 'todo_assigned') must still be widened.
    assert "strpos(pg_get_constraintdef(oid), 'project_changed') > 0" in sql
    assert "'todo_assigned') > 0" not in sql
    assert NOTIFICATION_TYPES[-1] == "project_changed"


def test_widening_is_one_asyncpg_statement():
    stripped = NOTIFICATIONS_TYPE_CHECK_SQL.strip()
    assert stripped.startswith("DO $$") and stripped.endswith("END $$")
    assert stripped.count("$$") == 2
    assert not re.search(r"(?<![:\w]):\w", stripped)


# ---------------------------------------------------------------------------
# One text in seven places
# ---------------------------------------------------------------------------


def _check_constraint(model, name: str) -> CheckConstraint:
    (constraint,) = (
        c for c in model.__table__.constraints if isinstance(c, CheckConstraint) and c.name == name
    )
    return constraint


def _places() -> dict[str, str]:
    from app.services import tenant_manager

    return {
        "ORM": str(_check_constraint(Notification, "notifications_type_check").sqltext),
        "setup_databases.sql": _root_file("setup_databases.sql"),
        "provisioner": get_tenant_schema_sql(),
        "template": _root_file("scripts/sql/tenant_schema_template.sql"),
        "add_kanban_tables.sql": _root_file("migrations/add_kanban_tables.sql"),
        "tenant_manager": Path(tenant_manager.__file__).read_text(),
        "NOTIFICATIONS_TYPE_CHECK_SQL": NOTIFICATIONS_TYPE_CHECK_SQL,
    }


def test_full_list_in_every_place():
    for name, text in _places().items():
        normalized = _norm(text).replace("CHECK(", "CHECK (")
        assert FULL_LIST in normalized, name
        assert OLD_TAIL not in normalized, name  # the 1.14 text is gone
        assert "'mention', 'status_change'))" not in normalized, name  # the 1.4 text


def test_widening_sources_carry_the_constant_verbatim():
    for name in ("setup_databases.sql", "scripts/sql/tenant_schema_template.sql"):
        assert _norm(NOTIFICATIONS_TYPE_CHECK_SQL) in _norm(_root_file(name)), name
    assert _norm(NOTIFICATIONS_TYPE_CHECK_SQL) in _norm(
        (ROOT / "migrations" / "add_rbac.sql").read_text()
    )
    assert _norm(NOTIFICATIONS_TYPE_CHECK_SQL) in _norm(get_tenant_schema_sql())


# ---------------------------------------------------------------------------
# migrations/add_change_notifications.sql
# ---------------------------------------------------------------------------


def test_migration_is_the_constant_as_one_statement():
    statements = split_sql_statements(MIGRATION.read_text())
    assert len(statements) == 1
    (statement,) = statements
    assert _norm(statement).removesuffix(";").strip() == _norm(NOTIFICATIONS_TYPE_CHECK_SQL)


def test_migration_documents_how_to_run_it():
    sql = MIGRATION.read_text()
    assert "python migrations/run_migration.py add_change_notifications" in sql
    assert "psql" in sql
    assert "add_change_notifications" in _root_file("migrations/README.md")


# ---------------------------------------------------------------------------
# Tenant auto-migration
# ---------------------------------------------------------------------------


def _conn(rbac_needed: bool, fail_widening: bool = False):
    """Answers the RBAC probe; every other step except ours fails (and is contained)."""
    log: list[str] = []

    async def execute(clause, *args, **kwargs):
        sql = str(clause)
        if sql == RBAC_NEEDS_MIGRATION_SQL:
            log.append("RBAC probe")
            result = MagicMock()
            result.scalar.return_value = rbac_needed
            return result
        if sql == NOTIFICATIONS_TYPE_CHECK_SQL:
            log.append("WIDEN")
            if fail_widening:
                raise RuntimeError("constraint violated")
            return MagicMock()
        if sql in RBAC_SCHEMA_STATEMENTS:
            log.append("RBAC statement")
            return MagicMock()
        raise RuntimeError("another step")

    conn = MagicMock()
    conn.execute = AsyncMock(side_effect=execute)
    conn.commit = AsyncMock(side_effect=lambda: log.append("COMMIT"))
    conn.rollback = AsyncMock(side_effect=lambda: log.append("ROLLBACK"))
    return conn, log


async def _run(conn) -> None:
    from app.services import tenant_manager

    with (
        patch.object(tenant_manager, "encrypt_tenant_sso_secret", AsyncMock()),
        patch("app.services.tenant_data_migrations.run_data_migrations", AsyncMock()),
    ):
        await tenant_manager.TenantConnectionManager()._run_auto_migrations(conn, "acme")


@pytest.mark.asyncio
async def test_auto_migration_widens_an_up_to_date_rbac_tenant():
    conn, log = _conn(rbac_needed=False)

    await _run(conn)

    assert "RBAC statement" not in log
    start = log.index("RBAC probe")
    assert log[start:] == ["RBAC probe", "WIDEN", "COMMIT"]


@pytest.mark.asyncio
async def test_auto_migration_widens_after_the_rbac_step():
    conn, log = _conn(rbac_needed=True)

    await _run(conn)

    tail = log[log.index("RBAC probe") :]
    # The RBAC step runs NOTIFICATIONS_TYPE_CHECK_SQL itself too; the
    # dedicated step follows its commit and is a no-op in the database.
    assert tail[-3:] == ["COMMIT", "WIDEN", "COMMIT"]


@pytest.mark.asyncio
async def test_auto_migration_widening_failure_rolls_back_and_never_raises(caplog):
    conn, log = _conn(rbac_needed=False, fail_widening=True)

    await _run(conn)  # never raises

    assert log[log.index("RBAC probe") :] == ["RBAC probe", "WIDEN", "ROLLBACK"]
    assert "Auto-migration (notification types) warning for acme" in caplog.text
