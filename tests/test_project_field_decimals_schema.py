"""
``project_fields.decimals`` (a number field's decimals, 2.1.0) in every schema
source.

The upgrade lives once in tenant_provisioner (PROJECT_FIELD_DECIMALS_SQL, part
of get_tenant_schema_sql() right after the project-fields tables);
migrations/add_project_field_decimals.sql, setup_databases.sql and the
template carry the same text, and the tenant auto-migration executes the
constant after its project-fields step. It is a step of its own: the CREATE
TABLE project_fields text stays as add_project_fields.sql has it. The ORM maps
the column with the same CHECK and the site export lists it. Repo-root files
are skipped when the test tree is run outside the repository.
"""

import logging
import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.project_field import ProjectField
from app.services.tenant_provisioner import (
    PROJECT_FIELD_DECIMALS_SQL,
    PROJECT_FIELDS_TABLE_SQL,
    get_tenant_schema_sql,
)
from migrations.run_migration_master import split_sql_statements

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "add_project_field_decimals.sql"
IN_REPO = (ROOT / "setup_databases.sql").exists() and (ROOT / "Dockerfile").exists()
DEFINITION = "SMALLINT CONSTRAINT project_fields_decimals_check CHECK (decimals BETWEEN 0 AND 3)"


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


def _root_file(relative: str) -> str:
    if not IN_REPO:
        pytest.skip("repo-root files are not part of this checkout")
    return (ROOT / relative).read_text()


def _table_end(sql: str) -> int:
    """Where the CREATE TABLE project_fields statement ends."""
    match = re.search(r"CREATE TABLE (?:IF NOT EXISTS )?project_fields \(.*?\n\s*\);?", sql, re.S)
    assert match, "no CREATE TABLE project_fields"
    return match.end()


# ---------------------------------------------------------------------------
# The constant and the fresh schemas
# ---------------------------------------------------------------------------


def test_constant_adds_the_column_only_when_missing():
    sql = _norm(PROJECT_FIELD_DECIMALS_SQL)
    assert f"ALTER TABLE project_fields ADD COLUMN decimals {DEFINITION};" in sql
    assert "column_name = 'decimals'" in sql
    assert "table_name = 'project_fields'" in sql
    assert "to_regclass('public.project_fields') IS NOT NULL" in sql
    assert sql.startswith("DO $$") and sql.endswith("END $$;")


def test_the_create_table_text_is_left_alone():
    # add_project_fields.sql carries PROJECT_FIELDS_TABLE_SQL verbatim.
    assert "decimals" not in PROJECT_FIELDS_TABLE_SQL


@pytest.mark.parametrize(
    "source",
    ["provisioner", "setup_databases.sql", "scripts/sql/tenant_schema_template.sql"],
)
def test_every_fresh_source_adds_the_column_right_after_the_table(source):
    sql = get_tenant_schema_sql() if source == "provisioner" else _root_file(source)
    assert sql.count(PROJECT_FIELD_DECIMALS_SQL.strip()) == 1, source
    assert _table_end(sql) < sql.index(PROJECT_FIELD_DECIMALS_SQL.strip())


# ---------------------------------------------------------------------------
# migrations/add_project_field_decimals.sql
# ---------------------------------------------------------------------------


def test_migration_carries_the_constant_verbatim():
    assert PROJECT_FIELD_DECIMALS_SQL in MIGRATION.read_text()


def test_migration_is_the_constant_as_one_statement():
    statements = split_sql_statements(MIGRATION.read_text())
    assert len(statements) == 1
    (statement,) = statements
    assert _norm(statement).removesuffix(";").strip() == _norm(
        PROJECT_FIELD_DECIMALS_SQL
    ).removesuffix(";")


def test_migration_is_documented():
    sql = MIGRATION.read_text()
    assert "-- USAGE:" in sql
    assert "python migrations/run_migration.py add_project_field_decimals" in sql
    assert "add_project_field_decimals" in _root_file("migrations/README.md")
    assert "add_project_field_decimals" in _root_file("docs/admin-guide/database.md")
    assert "add_project_field_decimals" in _root_file("docs/developer-guide/database-schema.md")


# ---------------------------------------------------------------------------
# Tenant auto-migration
# ---------------------------------------------------------------------------


def _conn(fail: bool = False):
    """Only our statement succeeds; every other step fails (and is contained)."""
    log: list[str] = []

    async def execute(clause, *args, **kwargs):
        sql = str(clause)
        if sql == PROJECT_FIELD_DECIMALS_SQL:
            log.append("DECIMALS")
            if fail:
                raise RuntimeError("permission denied")
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


def test_tenant_auto_migration_uses_the_shared_constant():
    from app.services import tenant_manager

    assert tenant_manager.PROJECT_FIELD_DECIMALS_SQL is PROJECT_FIELD_DECIMALS_SQL


@pytest.mark.asyncio
async def test_auto_migration_runs_and_commits_it():
    conn, log = _conn()

    await _run(conn)

    assert log.count("DECIMALS") == 1
    start = log.index("DECIMALS")
    assert log[start : start + 2] == ["DECIMALS", "COMMIT"]


@pytest.mark.asyncio
async def test_auto_migration_failure_rolls_back_and_never_raises(caplog):
    conn, log = _conn(fail=True)

    with caplog.at_level(logging.WARNING):
        await _run(conn)  # never raises

    start = log.index("DECIMALS")
    assert log[start : start + 2] == ["DECIMALS", "ROLLBACK"]
    assert "project field decimals" in caplog.text


# ---------------------------------------------------------------------------
# ORM and export
# ---------------------------------------------------------------------------


def test_orm_column_is_a_nullable_small_integer_with_the_check():
    table = ProjectField.__table__
    column = table.c.decimals
    assert column.nullable is True
    assert column.type.__class__.__name__ == "SmallInteger"
    (check,) = (c for c in table.constraints if c.name == "project_fields_decimals_check")
    assert str(check.sqltext) == "decimals BETWEEN 0 AND 3"


def test_site_export_lists_the_decimals_after_the_type():
    source = (ROOT / "app" / "routers" / "export.py").read_text()
    sheet = source[source.index('"Project fields",') :]
    assert '["ID", "Name", "Type", "Decimals", "Sort order"]' in sheet
