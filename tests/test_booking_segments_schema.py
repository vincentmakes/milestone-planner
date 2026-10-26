"""
Unlinked booking segments (1.17.0) in every schema source.

phase_staff_assignments / subphase_staff_assignments gain nullable
``start_date`` / ``end_date`` (both NULL = linked, the booking follows its
card) and a both-or-neither CHECK. The guarded upgrade lives once in
tenant_provisioner (BOOKING_SEGMENT_COLUMN_STATEMENTS); the fresh schema,
setup_databases.sql, the manual-setup template and
migrations/add_booking_segments.sql carry the same text, the three CREATE
TABLE texts declare the columns and the CHECK, the tenant auto-migration
executes the constant, the ORM maps the columns, the site export lists them
and the demo gives Charlie two segments. Repo-root files are skipped when the
test tree is run outside the repository.
"""

import logging
import re
from datetime import date
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import CheckConstraint

from app.models.assignment import PhaseStaffAssignment, SubphaseStaffAssignment
from app.services.booking_segments import segments_overlap
from app.services.tenant_provisioner import (
    BOOKING_SEGMENT_COLUMN_STATEMENTS,
    BOOKING_SEGMENT_DATES_CHECK,
    BOOKING_SEGMENT_TABLES,
    get_tenant_schema_sql,
)
from migrations.run_migration_master import split_sql_statements

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "add_booking_segments.sql"
IN_REPO = (ROOT / "setup_databases.sql").exists() and (ROOT / "Dockerfile").exists()
CHECK_TEXT = "CHECK ((start_date IS NULL) = (end_date IS NULL))"


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


def _root_file(relative: str) -> str:
    if not IN_REPO:
        pytest.skip("repo-root files are not part of this checkout")
    return (ROOT / relative).read_text()


def _sources() -> dict[str, str]:
    return {
        "provisioner": get_tenant_schema_sql(),
        "setup_databases.sql": _root_file("setup_databases.sql"),
        "template": _root_file("scripts/sql/tenant_schema_template.sql"),
    }


def _create_table(sql: str, table: str) -> str:
    """The body of the CREATE TABLE statement of `table`."""
    match = re.search(rf"CREATE TABLE (?:IF NOT EXISTS )?{table} \((.*?)\n\s*\);", sql, re.S)
    assert match, f"no CREATE TABLE {table}"
    return _norm(match.group(1))


# ---------------------------------------------------------------------------
# The constant
# ---------------------------------------------------------------------------


def test_tables_are_the_card_booking_tables():
    assert BOOKING_SEGMENT_TABLES == ("phase_staff_assignments", "subphase_staff_assignments")
    assert BOOKING_SEGMENT_DATES_CHECK == "((start_date IS NULL) = (end_date IS NULL))"


@pytest.mark.parametrize("table", BOOKING_SEGMENT_TABLES)
def test_constant_adds_both_columns_and_the_check_per_table(table):
    start, end, check = (
        _norm(s) for s in BOOKING_SEGMENT_COLUMN_STATEMENTS if f"'public.{table}'" in s
    )
    assert f"ALTER TABLE {table} ADD COLUMN start_date DATE;" in start
    assert "column_name = 'start_date'" in start
    assert f"ALTER TABLE {table} ADD COLUMN end_date DATE;" in end
    assert "column_name = 'end_date'" in end
    # The CHECK is added only when missing (by name), after both columns.
    assert f"conname = '{table}_segment_dates_check'" in check
    assert f"ALTER TABLE {table} ADD CONSTRAINT {table}_segment_dates_check {CHECK_TEXT};" in check


@pytest.mark.parametrize("statement", BOOKING_SEGMENT_COLUMN_STATEMENTS)
def test_one_statement_per_constant(statement):
    """asyncpg executes a single statement per call: no trailing ';', DO blocks whole."""
    stripped = statement.strip()
    assert stripped.startswith("DO $$") and stripped.endswith("END $$")
    assert stripped.count("$$") == 2
    assert not re.search(r"(?<![:\w]):\w", statement)  # no SQLAlchemy binds


# ---------------------------------------------------------------------------
# CREATE TABLE texts and the guarded upgrades in every source
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("source", ["provisioner", "setup_databases.sql", "template"])
@pytest.mark.parametrize("table", BOOKING_SEGMENT_TABLES)
def test_every_create_table_declares_the_columns_and_the_check(source, table):
    body = _create_table(_sources()[source], table)
    assert "start_date DATE," in body
    assert "end_date DATE," in body
    assert f"CONSTRAINT {table}_segment_dates_check {CHECK_TEXT}" in body
    # Nullable: a linked booking has no own dates.
    assert "start_date DATE NOT NULL" not in body and "end_date DATE NOT NULL" not in body


@pytest.mark.parametrize("source", ["provisioner", "setup_databases.sql", "template"])
def test_every_source_carries_the_guarded_upgrade_after_the_tables(source):
    sql = _sources()[source]
    normalized = _norm(sql)
    for statement in BOOKING_SEGMENT_COLUMN_STATEMENTS:
        assert _norm(statement) in normalized, source
    for table in BOOKING_SEGMENT_TABLES:
        create = re.search(rf"CREATE TABLE (?:IF NOT EXISTS )?{table} \(", normalized)
        assert create
        for statement in (s for s in BOOKING_SEGMENT_COLUMN_STATEMENTS if f"'public.{table}'" in s):
            assert create.start() < normalized.index(_norm(statement)), (source, table)


def test_provisioner_schema_dollar_quoting_still_balanced():
    assert get_tenant_schema_sql().count("$$") % 2 == 0


# ---------------------------------------------------------------------------
# migrations/add_booking_segments.sql
# ---------------------------------------------------------------------------


def test_migration_is_the_constant_statement_by_statement():
    statements = split_sql_statements(MIGRATION.read_text())
    assert [_norm(s).removesuffix(";").strip() for s in statements] == [
        _norm(s) for s in BOOKING_SEGMENT_COLUMN_STATEMENTS
    ]


def test_migration_documents_how_to_run_it():
    sql = MIGRATION.read_text()
    assert "-- USAGE:" in sql
    assert "python migrations/run_migration.py add_booking_segments" in sql
    readme = _root_file("migrations/README.md")
    assert "| `add_booking_segments` | tenant |" in readme
    assert (
        "`add_user_is_resource`, `add_booking_segments`, `add_equipment_assignment_note` and "
        "`add_project_comments` via"
    ) in readme


# ---------------------------------------------------------------------------
# Tenant auto-migration
# ---------------------------------------------------------------------------


def _conn(fail: bool = False):
    """Only our statements succeed; every other step fails (and is contained)."""
    log: list[str] = []

    async def execute(clause, *args, **kwargs):
        sql = str(clause)
        if sql in BOOKING_SEGMENT_COLUMN_STATEMENTS:
            log.append(f"SEGMENT {BOOKING_SEGMENT_COLUMN_STATEMENTS.index(sql)}")
            if fail:
                raise RuntimeError("permission denied")
            return MagicMock()
        if "column_name = 'is_resource'" in sql:
            log.append("is_resource")
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

    assert tenant_manager.BOOKING_SEGMENT_COLUMN_STATEMENTS is BOOKING_SEGMENT_COLUMN_STATEMENTS


@pytest.mark.asyncio
async def test_auto_migration_runs_every_statement_then_commits_after_is_resource():
    conn, log = _conn()

    await _run(conn)

    count = len(BOOKING_SEGMENT_COLUMN_STATEMENTS)
    start = log.index("SEGMENT 0")
    assert log[start : start + count + 1] == [f"SEGMENT {i}" for i in range(count)] + ["COMMIT"]
    assert log.index("is_resource") < start


@pytest.mark.asyncio
async def test_auto_migration_failure_rolls_back_and_never_raises(caplog):
    conn, log = _conn(fail=True)

    with caplog.at_level(logging.WARNING):
        await _run(conn)  # never raises

    start = log.index("SEGMENT 0")
    assert log[start : start + 2] == ["SEGMENT 0", "ROLLBACK"]
    assert "booking segments" in caplog.text


# ---------------------------------------------------------------------------
# ORM, export, demo
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("model", [PhaseStaffAssignment, SubphaseStaffAssignment])
def test_orm_columns_are_nullable_with_the_check(model):
    table = model.__table__
    assert table.c.start_date.nullable is True
    assert table.c.end_date.nullable is True
    checks = {c.name: str(c.sqltext) for c in table.constraints if isinstance(c, CheckConstraint)}
    assert checks[f"{table.name}_segment_dates_check"] == BOOKING_SEGMENT_DATES_CHECK


def test_site_export_lists_start_end_linked_after_the_allocation():
    source = (ROOT / "app" / "routers" / "export.py").read_text()
    for sheet in ('"Phase assignments",', '"Subphase assignments",'):
        headers = source[source.index(sheet) :]
        assert (
            '"Allocation %",\n            "Start",\n            "End",\n            "Linked",'
            in (headers[: headers.index("],")])
        )


def _charlie_segments(demo):
    from app.scripts.demo_data import BIOPROCESS, CHARLIE

    return [
        a
        for a in demo.phase_assignments
        if (a["project"], a["phase"], a["staff"]) == (BIOPROCESS, "Analytics", CHARLIE)
    ]


@pytest.mark.parametrize("today", [date(2026, 10, 22), date(2027, 3, 1)])
def test_demo_gives_charlie_two_segments_inside_the_analytics_phase(today):
    from app.scripts.demo_data import BIOPROCESS, build_demo

    demo = build_demo(today)
    phase = next(p for p in demo.phases if (p["project"], p["type"]) == (BIOPROCESS, "Analytics"))
    first, second = _charlie_segments(demo)
    for segment in (first, second):
        assert phase["start_date"] <= segment["start_date"] <= segment["end_date"]
        assert segment["end_date"] <= phase["end_date"]
        assert segment["allocation"] == 100  # his rotation allocation, kept
    assert (first["end_date"] - first["start_date"]).days == 2  # days 1-3
    assert (first["start_date"] - phase["start_date"]).days == 0
    assert (second["start_date"] - phase["start_date"]).days == 7  # days 8-10
    assert (second["end_date"] - phase["start_date"]).days == 9
    assert not segments_overlap(
        first["start_date"], first["end_date"], second["start_date"], second["end_date"]
    )
    # Every other demo booking stays linked.
    others = [a for a in demo.phase_assignments if a not in (first, second)]
    assert all("start_date" not in a for a in others + demo.subphase_assignments)


async def test_demo_seed_inserts_the_segments_with_a_null_safe_start_key():
    from app.scripts.demo_data import build_demo
    from app.services import demo_seed
    from tests.test_seed_demo import RecordingConn

    conn = RecordingConn()
    demo = build_demo(date(2026, 10, 22))
    await demo_seed.insert_demo_data(conn, demo)

    first, second = _charlie_segments(demo)
    rows = [
        (sql, args)
        for sql, args in conn.inserts("phase_staff_assignments")
        if "'pending'" not in sql
    ]
    assert len(rows) == len(demo.phase_assignments)
    dated = [(sql, args) for sql, args in rows if "start_date, end_date) SELECT" in sql]
    assert [args[4:6] for _, args in dated] == [
        (first["start_date"], first["end_date"]),
        (second["start_date"], second["end_date"]),
    ]
    for sql, args in rows:
        # Natural key: (phase, staff, start) -- NULL-safe for linked rows.
        assert "start_date IS NOT DISTINCT FROM" in sql
        assert args[-1] in (None, first["start_date"], second["start_date"])
    linked = [args for sql, args in rows if "start_date, end_date) SELECT" not in sql]
    assert all(args[-1] is None for args in linked)
