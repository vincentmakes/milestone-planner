"""
``users.is_resource`` ("Bookable as a resource", 1.16.0) in every schema source.

The upgrade lives once in tenant_provisioner (USERS_IS_RESOURCE_SQL, part of
USERS_UPGRADE_SQL); migrations/add_user_is_resource.sql carries the same text
and the tenant auto-migration executes the constant. The three CREATE TABLE
users texts declare the column, the ORM maps it, the provisioned admin is not
bookable and the site export lists it. Repo-root files are skipped when the
test tree is run outside the repository.
"""

import logging
import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.user import User
from app.services import tenant_provisioner
from app.services.tenant_provisioner import (
    USERS_IS_RESOURCE_SQL,
    USERS_UPGRADE_SQL,
    get_tenant_schema_sql,
)
from migrations.run_migration_master import split_sql_statements

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "add_user_is_resource.sql"
IN_REPO = (ROOT / "setup_databases.sql").exists() and (ROOT / "Dockerfile").exists()
COLUMN = "is_resource BOOLEAN NOT NULL DEFAULT TRUE,"


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


def _root_file(relative: str) -> str:
    if not IN_REPO:
        pytest.skip("repo-root files are not part of this checkout")
    return (ROOT / relative).read_text()


def _users_table(sql: str) -> str:
    """The body of the (first) CREATE TABLE users statement."""
    match = re.search(r"CREATE TABLE (?:IF NOT EXISTS )?users \((.*?)\n\s*\);", sql, re.S)
    assert match, "no CREATE TABLE users"
    return match.group(1)


# ---------------------------------------------------------------------------
# The constant
# ---------------------------------------------------------------------------


def test_constant_adds_the_column_and_back_fills_the_admins():
    sql = _norm(USERS_IS_RESOURCE_SQL)
    assert "ALTER TABLE users ADD COLUMN is_resource BOOLEAN NOT NULL DEFAULT TRUE;" in sql
    assert "UPDATE users SET is_resource = FALSE WHERE role = 'admin';" in sql
    # Guarded: only when the column is missing (the back-fill runs once).
    assert "column_name = 'is_resource'" in sql
    assert sql.startswith("DO $$") and sql.endswith("END $$;")


def test_constant_is_part_of_the_users_upgrade():
    assert USERS_IS_RESOURCE_SQL in USERS_UPGRADE_SQL
    assert USERS_UPGRADE_SQL.endswith(USERS_IS_RESOURCE_SQL)
    assert USERS_IS_RESOURCE_SQL in get_tenant_schema_sql()


# ---------------------------------------------------------------------------
# CREATE TABLE users
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "source",
    ["provisioner", "setup_databases.sql", "scripts/sql/tenant_schema_template.sql"],
)
def test_every_create_table_declares_the_column(source):
    sql = get_tenant_schema_sql() if source == "provisioner" else _root_file(source)
    body = _norm(_users_table(sql))
    assert COLUMN in body
    # Right after active, like the ORM.
    assert f"active INTEGER DEFAULT 1 NOT NULL, {COLUMN}" in body


def test_fresh_schema_creates_the_column_before_the_upgrade_runs():
    sql = get_tenant_schema_sql()
    assert sql.index(COLUMN) < sql.index(USERS_IS_RESOURCE_SQL)


# ---------------------------------------------------------------------------
# migrations/add_user_is_resource.sql
# ---------------------------------------------------------------------------


def test_migration_carries_the_constant_verbatim():
    assert USERS_IS_RESOURCE_SQL in MIGRATION.read_text()


def test_migration_is_the_constant_as_one_statement():
    statements = split_sql_statements(MIGRATION.read_text())
    assert len(statements) == 1
    (statement,) = statements
    assert _norm(statement).startswith("DO $$")
    assert _norm(statement).removesuffix(";").strip() == _norm(USERS_IS_RESOURCE_SQL).removesuffix(
        ";"
    )


def test_migration_documents_how_to_run_it():
    sql = MIGRATION.read_text()
    assert "-- USAGE:" in sql
    assert "python migrations/run_migration.py add_user_is_resource" in sql
    assert "add_user_is_resource" in _root_file("migrations/README.md")


# ---------------------------------------------------------------------------
# Tenant auto-migration
# ---------------------------------------------------------------------------


def _conn(fail: bool = False):
    """Only our statement succeeds; every other step fails (and is contained)."""
    log: list[str] = []

    async def execute(clause, *args, **kwargs):
        sql = str(clause)
        if sql == USERS_IS_RESOURCE_SQL:
            log.append("IS_RESOURCE")
            if fail:
                raise RuntimeError("permission denied")
            return MagicMock()
        if "column_name = 'is_system'" in sql:
            log.append("is_system probe")
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


def test_tenant_auto_migration_uses_the_shared_constant():
    from app.services import tenant_manager

    assert tenant_manager.USERS_IS_RESOURCE_SQL is USERS_IS_RESOURCE_SQL


@pytest.mark.asyncio
async def test_auto_migration_runs_it_right_after_the_is_system_step():
    conn, log = _conn()

    await _run(conn)

    assert log.count("IS_RESOURCE") == 1
    start = log.index("IS_RESOURCE")
    assert log[start : start + 2] == ["IS_RESOURCE", "COMMIT"]
    assert log.index("is_system probe") < start


@pytest.mark.asyncio
async def test_auto_migration_failure_rolls_back_and_never_raises(caplog):
    conn, log = _conn(fail=True)

    with caplog.at_level(logging.WARNING):
        await _run(conn)  # never raises

    start = log.index("IS_RESOURCE")
    assert log[start : start + 2] == ["IS_RESOURCE", "ROLLBACK"]
    assert "users.is_resource" in caplog.text


# ---------------------------------------------------------------------------
# ORM, seeds, export
# ---------------------------------------------------------------------------


def test_orm_column_defaults_to_true():
    column = User.__table__.c.is_resource
    assert column.nullable is False
    assert column.default is not None and column.default.arg is True


@pytest.mark.asyncio
async def test_provisioned_admin_is_not_bookable():
    conn = MagicMock()
    conn.execute = AsyncMock()

    await tenant_provisioner.run_seed_data(conn, "admin@acme.test", "hash")

    (insert,) = (
        c.args[0] for c in conn.execute.await_args_list if "INSERT INTO users" in c.args[0]
    )
    columns = insert.split("(", 1)[1].split(")", 1)[0]
    values = insert.split("VALUES (", 1)[1].split(")", 1)[0]
    pairs = dict(
        zip(
            [c.strip() for c in columns.split(",")],
            [v.strip() for v in values.split(",")],
            strict=True,
        )
    )
    assert pairs["role"] == "'admin'"
    assert pairs["is_resource"] == "FALSE"


def test_demo_people_are_bookable_except_the_admin():
    from datetime import date

    from app.scripts.demo_data import build_demo

    demo = build_demo(date(2026, 10, 22))
    by_role = {u["email"]: (u["role"], u["is_resource"]) for u in demo.users}
    assert by_role[demo.admin_email] == ("admin", False)
    assert all(bookable for role, bookable in by_role.values() if role != "admin")


def test_site_export_lists_bookable_after_active():
    source = (ROOT / "app" / "routers" / "export.py").read_text()
    users_sheet = source[source.index('"Users",') :]
    assert '"Active",\n            "Bookable",' in users_sheet
    assert "_yes_no(u.is_resource)" in users_sheet
