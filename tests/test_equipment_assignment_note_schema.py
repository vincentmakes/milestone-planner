"""
``equipment_assignments.note`` (the optional note of an equipment booking,
2.0.0) in every schema source.

The upgrade lives once in tenant_provisioner (EQUIPMENT_ASSIGNMENTS_NOTE_SQL,
part of get_tenant_schema_sql()); migrations/add_equipment_assignment_note.sql
carries the same text and the tenant auto-migration executes the constant.
The three CREATE TABLE equipment_assignments texts declare the column,
setup_databases.sql upgrades an existing table, the ORM maps it and the site
export lists it. Repo-root files are skipped when the test tree is run
outside the repository.
"""

import logging
import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.equipment import EquipmentAssignment
from app.services.tenant_provisioner import EQUIPMENT_ASSIGNMENTS_NOTE_SQL, get_tenant_schema_sql
from migrations.run_migration_master import split_sql_statements

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "add_equipment_assignment_note.sql"
IN_REPO = (ROOT / "setup_databases.sql").exists() and (ROOT / "Dockerfile").exists()
COLUMN = "note TEXT,"


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


def _root_file(relative: str) -> str:
    if not IN_REPO:
        pytest.skip("repo-root files are not part of this checkout")
    return (ROOT / relative).read_text()


def _table(sql: str) -> str:
    """The body of the CREATE TABLE equipment_assignments statement."""
    match = re.search(
        r"CREATE TABLE (?:IF NOT EXISTS )?equipment_assignments \((.*?)\n\s*\);", sql, re.S
    )
    assert match, "no CREATE TABLE equipment_assignments"
    return match.group(1)


# ---------------------------------------------------------------------------
# The constant and the fresh schemas
# ---------------------------------------------------------------------------


def test_constant_adds_the_column_only_when_missing():
    sql = _norm(EQUIPMENT_ASSIGNMENTS_NOTE_SQL)
    assert "ALTER TABLE equipment_assignments ADD COLUMN note TEXT;" in sql
    assert "column_name = 'note'" in sql
    assert "table_name = 'equipment_assignments'" in sql
    assert sql.startswith("DO $$") and sql.endswith("END $$;")


@pytest.mark.parametrize(
    "source",
    ["provisioner", "setup_databases.sql", "scripts/sql/tenant_schema_template.sql"],
)
def test_every_create_table_declares_the_column(source):
    sql = get_tenant_schema_sql() if source == "provisioner" else _root_file(source)
    body = _norm(_table(sql))
    # Right after end_date, like the ORM.
    assert f"end_date DATE NOT NULL, {COLUMN}" in body


def test_fresh_schema_creates_the_column_before_the_upgrade_runs():
    sql = get_tenant_schema_sql()
    assert EQUIPMENT_ASSIGNMENTS_NOTE_SQL in sql
    assert sql.index(_table(sql)) < sql.index(EQUIPMENT_ASSIGNMENTS_NOTE_SQL)


def test_setup_databases_upgrades_an_existing_table():
    sql = _root_file("setup_databases.sql")
    assert "ALTER TABLE IF EXISTS equipment_assignments ADD COLUMN IF NOT EXISTS note TEXT;" in sql


# ---------------------------------------------------------------------------
# migrations/add_equipment_assignment_note.sql
# ---------------------------------------------------------------------------


def test_migration_carries_the_constant_verbatim():
    assert EQUIPMENT_ASSIGNMENTS_NOTE_SQL in MIGRATION.read_text()


def test_migration_is_the_constant_as_one_statement():
    statements = split_sql_statements(MIGRATION.read_text())
    assert len(statements) == 1
    (statement,) = statements
    assert _norm(statement).removesuffix(";").strip() == _norm(
        EQUIPMENT_ASSIGNMENTS_NOTE_SQL
    ).removesuffix(";")


def test_migration_is_documented():
    sql = MIGRATION.read_text()
    assert "-- USAGE:" in sql
    assert "python migrations/run_migration.py add_equipment_assignment_note" in sql
    assert "add_equipment_assignment_note" in _root_file("migrations/README.md")
    assert "add_equipment_assignment_note" in _root_file("docs/admin-guide/database.md")
    assert "add_equipment_assignment_note" in _root_file("docs/developer-guide/database-schema.md")


# ---------------------------------------------------------------------------
# Tenant auto-migration
# ---------------------------------------------------------------------------


def _conn(fail: bool = False):
    """Only our statement succeeds; every other step fails (and is contained)."""
    log: list[str] = []

    async def execute(clause, *args, **kwargs):
        sql = str(clause)
        if sql == EQUIPMENT_ASSIGNMENTS_NOTE_SQL:
            log.append("NOTE")
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

    assert tenant_manager.EQUIPMENT_ASSIGNMENTS_NOTE_SQL is EQUIPMENT_ASSIGNMENTS_NOTE_SQL


@pytest.mark.asyncio
async def test_auto_migration_runs_and_commits_it():
    conn, log = _conn()

    await _run(conn)

    assert log.count("NOTE") == 1
    start = log.index("NOTE")
    assert log[start : start + 2] == ["NOTE", "COMMIT"]


@pytest.mark.asyncio
async def test_auto_migration_failure_rolls_back_and_never_raises(caplog):
    conn, log = _conn(fail=True)

    with caplog.at_level(logging.WARNING):
        await _run(conn)  # never raises

    start = log.index("NOTE")
    assert log[start : start + 2] == ["NOTE", "ROLLBACK"]
    assert "equipment booking note" in caplog.text


# ---------------------------------------------------------------------------
# ORM and export
# ---------------------------------------------------------------------------


def test_orm_column_is_nullable():
    column = EquipmentAssignment.__table__.c.note
    assert column.nullable is True


def test_site_export_lists_the_note_before_created_at():
    source = (ROOT / "app" / "routers" / "export.py").read_text()
    sheet = source[source.index('"Equipment assignments",') :]
    assert '"End date",\n            "Note",\n            "Created at",' in sheet
