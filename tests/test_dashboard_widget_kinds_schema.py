"""
Dashboard widget kinds (2.3.0): nine kinds, one CHECK, one widening block.

The kinds live once in the model (``DASHBOARD_WIDGET_KINDS``); the schema's
``WidgetKind`` Literal, the provisioner's ``DASHBOARD_WIDGET_KIND_CHECK`` (spliced
into ``DASHBOARD_WIDGETS_TABLE_SQL``), setup_databases.sql, the manual-setup
template and migrations/add_dashboards.sql spell the same CHECK. A database
created from the pre-release 2.3.0 branch carries the five-kind CHECK: a
self-gated DO block (``DASHBOARD_WIDGET_KIND_CHECK_SQL``) widens it, in the
tenant auto-migration (its own try, right after the visibility block, on every
pool creation) and in migrations/add_dashboard_widget_kinds.sql only -- never in
a fresh source. Repo-root files are skipped when the test tree is run outside
the repository.
"""

import logging
import re
from pathlib import Path
from typing import get_args
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import text

from app.models.dashboard import DASHBOARD_WIDGET_KINDS, DashboardWidget
from app.schemas.dashboard import WidgetKind
from app.services import tenant_provisioner as tp
from app.services.tenant_provisioner import (
    DASHBOARD_SHARING_PROBE_SQL,
    DASHBOARD_SHARING_TABLES,
    DASHBOARD_TABLES,
    DASHBOARD_VISIBILITY_CHECK_SQL,
    DASHBOARD_WIDGET_KIND_CHECK,
    DASHBOARD_WIDGET_KIND_CHECK_SQL,
    DASHBOARD_WIDGETS_TABLE_SQL,
    DASHBOARDS_PROBE_SQL,
    NOTIFICATIONS_TYPE_CHECK_SQL,
    PROJECT_FIELDS_PROBE_SQL,
    RBAC_NEEDS_MIGRATION_SQL,
    get_tenant_schema_sql,
)
from migrations.run_migration_master import split_sql_statements
from tests.support import audit_log_step

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "add_dashboard_widget_kinds.sql"
DASHBOARDS_MIGRATION = ROOT / "migrations" / "add_dashboards.sql"
IN_REPO = (ROOT / "setup_databases.sql").exists() and (ROOT / "Dockerfile").exists()

KINDS = ("kpi", "bar", "line", "pie", "table", "gauge", "heatmap", "treemap", "sankey")
NEW_CHECK = "CHECK (kind IN ('kpi', 'bar', 'line', 'pie', 'table', 'gauge', 'heatmap', 'treemap', 'sankey'))"
OLD_CHECK = "CHECK (kind IN ('kpi', 'bar', 'line', 'pie', 'table'))"


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


def _root_file(relative: str) -> str:
    if not IN_REPO:
        pytest.skip("repo-root files are not part of this checkout")
    return (ROOT / relative).read_text()


def _fresh_sources() -> dict[str, str]:
    """The fresh-schema sources (provisioner, setup_databases.sql, template)."""
    return {
        "provisioner": get_tenant_schema_sql(),
        "setup_databases.sql": _root_file("setup_databases.sql"),
        "template": _root_file("scripts/sql/tenant_schema_template.sql"),
    }


# ---------------------------------------------------------------------------
# The kinds and the CHECK text
# ---------------------------------------------------------------------------


def test_the_nine_kinds_in_order():
    assert DASHBOARD_WIDGET_KINDS == KINDS
    # The newest kind last: the widening block's gate looks for it.
    assert DASHBOARD_WIDGET_KINDS[-1] == "sankey"


def test_the_schema_literal_spells_the_model_tuple():
    assert get_args(WidgetKind) == DASHBOARD_WIDGET_KINDS


def test_the_check_is_derived_from_the_tuple():
    assert DASHBOARD_WIDGET_KIND_CHECK == (
        "kind IN ('kpi', 'bar', 'line', 'pie', 'table', 'gauge', 'heatmap', 'treemap', 'sankey')"
    )
    assert f"CHECK ({DASHBOARD_WIDGET_KIND_CHECK})" == NEW_CHECK
    # The table statement carries it (no literal of its own).
    assert f"CONSTRAINT dashboard_widgets_kind_check {NEW_CHECK}" in _norm(
        DASHBOARD_WIDGETS_TABLE_SQL
    )
    # The ORM spells the same text.
    checks = {c.name: str(c.sqltext) for c in DashboardWidget.__table__.constraints if c.name}
    assert checks["dashboard_widgets_kind_check"] == DASHBOARD_WIDGET_KIND_CHECK


def test_the_longest_kind_fits_the_column():
    assert max(len(k) for k in DASHBOARD_WIDGET_KINDS) <= 12
    assert "kind VARCHAR(12) NOT NULL" in _norm(DASHBOARD_WIDGETS_TABLE_SQL)
    assert DashboardWidget.__table__.c.kind.type.length == 12


def test_every_fresh_source_and_add_dashboards_create_the_nine_kinds():
    sources = {
        **_fresh_sources(),
        "add_dashboards.sql": DASHBOARDS_MIGRATION.read_text(),
        "DASHBOARD_WIDGETS_TABLE_SQL": DASHBOARD_WIDGETS_TABLE_SQL,
    }
    for name, sql in sources.items():
        assert NEW_CHECK in _norm(sql), name
        assert OLD_CHECK not in _norm(sql), name


# ---------------------------------------------------------------------------
# The widening: a self-gated DO block
# ---------------------------------------------------------------------------


def test_kind_block_is_guarded_by_the_newest_kind():
    sql = _norm(DASHBOARD_WIDGET_KIND_CHECK_SQL)
    assert "to_regclass('public.dashboard_widgets') IS NOT NULL AND NOT EXISTS (" in sql
    assert "conrelid = to_regclass('public.dashboard_widgets')" in sql
    assert "conname = 'dashboard_widgets_kind_check'" in sql
    assert "strpos(pg_get_constraintdef(oid), 'sankey') > 0" in sql


def test_kind_block_drops_then_adds_and_changes_no_row():
    sql = _norm(DASHBOARD_WIDGET_KIND_CHECK_SQL)
    drop = sql.index(
        "ALTER TABLE dashboard_widgets DROP CONSTRAINT IF EXISTS dashboard_widgets_kind_check;"
    )
    add = sql.index(
        f"ALTER TABLE dashboard_widgets ADD CONSTRAINT dashboard_widgets_kind_check {NEW_CHECK};"
    )
    assert drop < add
    assert "UPDATE" not in sql and "DELETE" not in sql


def test_kind_block_is_one_asyncpg_statement():
    stripped = DASHBOARD_WIDGET_KIND_CHECK_SQL.strip()
    assert stripped.startswith("DO $$") and stripped.endswith("END $$")
    assert stripped.count("$$") == 2
    assert not re.search(r"(?<![:\w]):\w", stripped)
    assert text(DASHBOARD_WIDGET_KIND_CHECK_SQL).compile().params == {}


def test_the_kind_block_is_not_in_the_fresh_sources():
    """It only ever acts on a pre-release database: upgrade paths only."""
    marker = "ALTER TABLE dashboard_widgets DROP CONSTRAINT"
    for name, sql in _fresh_sources().items():
        assert marker not in sql, name
    assert marker not in DASHBOARDS_MIGRATION.read_text()


# ---------------------------------------------------------------------------
# migrations/add_dashboard_widget_kinds.sql
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def migration_statements() -> list[str]:
    return split_sql_statements(MIGRATION.read_text())


def test_migration_documents_how_to_run_it():
    sql = MIGRATION.read_text()
    assert "python migrations/run_migration.py add_dashboard_widget_kinds" in sql
    assert "psql" in sql
    assert "pre-release 2.3.0" in sql


def test_migration_splits_into_the_block_and_a_notice(migration_statements):
    assert len(migration_statements) == 2
    block, notice = migration_statements
    assert all(s.lstrip().startswith("DO $$") for s in migration_statements)
    assert all(s.rstrip().endswith("END $$;") for s in migration_statements)
    assert _norm(block).removesuffix(";").strip() == _norm(DASHBOARD_WIDGET_KIND_CHECK_SQL)
    assert "RAISE NOTICE 'Dashboard widget kinds migration completed successfully'" in notice
    assert "GRANT" not in MIGRATION.read_text()


def test_migration_is_listed_in_the_readme():
    readme = _root_file("migrations/README.md")
    assert "| `add_dashboard_widget_kinds` | tenant |" in readme
    # Alphabetical: after add_dashboard_sharing, before add_dashboards.
    assert (
        readme.index("| `add_dashboard_sharing` |")
        < readme.index("| `add_dashboard_widget_kinds` |")
        < readme.index("| `add_dashboards` |")
    )
    # Applied automatically too.
    auto = readme[readme.index("Some tenant migrations also run automatically") :]
    assert "`add_dashboard_widget_kinds`" in auto.split("\n")[0]


def test_the_admin_guide_names_the_nine_kinds_and_the_migration():
    guide = _root_file("docs/admin-guide/database.md")
    assert "| `add_dashboard_widget_kinds` | Tenant |" in guide
    assert "python migrations/run_migration.py add_dashboard_widget_kinds" in guide
    kinds = " / ".join(f"`{k}`" for k in DASHBOARD_WIDGET_KINDS)
    assert f"kind {kinds} (CHECK `dashboard_widgets_kind_check`)" in guide


# ---------------------------------------------------------------------------
# Tenant auto-migration
# ---------------------------------------------------------------------------


def test_tenant_manager_executes_the_same_constant():
    from app.services import tenant_manager

    assert tenant_manager.DASHBOARD_WIDGET_KIND_CHECK_SQL is DASHBOARD_WIDGET_KIND_CHECK_SQL


VISIBILITY = "dashboard visibility check"
KINDS_STEP = "dashboard widget kinds check"
WIDEN = "widen notification types"


def _conn(fail_on: str | None = None):
    """
    A connection on which the project-fields, RBAC, dashboards and sharing
    probes answer "up to date"; the visibility, widget-kinds and
    notification-types blocks succeed (unless named by ``fail_on``); every
    other auto-migration step fails (and is contained by its own try/except).
    ``log`` records the three blocks interleaved with COMMIT / ROLLBACK.
    """
    log: list[str] = []

    def rows(values):
        result = MagicMock()
        result.fetchall.return_value = [(v,) for v in values]
        return result

    async def execute(clause, *args, **kwargs):
        sql = str(clause)
        if (probe := audit_log_step(sql)) is not None:  # the audit-log step: up to date
            return probe
        if sql == PROJECT_FIELDS_PROBE_SQL:
            return rows(tp.PROJECT_FIELD_TABLES)
        if sql == RBAC_NEEDS_MIGRATION_SQL:
            result = MagicMock()
            result.scalar.return_value = False
            return result
        if sql == DASHBOARDS_PROBE_SQL:
            return rows(DASHBOARD_TABLES)
        if sql == DASHBOARD_SHARING_PROBE_SQL:
            return rows(DASHBOARD_SHARING_TABLES)
        labels = {
            DASHBOARD_VISIBILITY_CHECK_SQL: VISIBILITY,
            DASHBOARD_WIDGET_KIND_CHECK_SQL: KINDS_STEP,
            NOTIFICATIONS_TYPE_CHECK_SQL: WIDEN,
        }
        if sql in labels:
            log.append(labels[sql])
            if labels[sql] == fail_on:
                raise RuntimeError("must be owner of table dashboard_widgets")
            return MagicMock()
        raise RuntimeError("another step")

    conn = MagicMock()
    conn.execute = AsyncMock(side_effect=execute)
    conn.commit = AsyncMock(side_effect=lambda: log.append("COMMIT"))
    conn.rollback = AsyncMock(side_effect=lambda: log.append("ROLLBACK"))
    return conn, log


async def _run_auto_migrations(conn) -> None:
    from app.services import tenant_manager

    with (
        patch.object(tenant_manager, "encrypt_tenant_sso_secret", AsyncMock()),
        patch("app.services.tenant_data_migrations.run_data_migrations", AsyncMock()),
    ):
        await tenant_manager.TenantConnectionManager()._run_auto_migrations(conn, "acme")


def _tail(log: list[str]) -> list[str]:
    return log[log.index(VISIBILITY) :]


@pytest.mark.asyncio
async def test_auto_migration_runs_the_block_after_visibility_before_notifications():
    conn, log = _conn()

    await _run_auto_migrations(conn)

    # Its own transaction, between the visibility block and the
    # notification-types block.
    assert _tail(log) == [VISIBILITY, "COMMIT", KINDS_STEP, "COMMIT", WIDEN, "COMMIT"]
    assert log.count(KINDS_STEP) == 1


@pytest.mark.asyncio
async def test_a_failing_kind_block_is_an_error_and_rolls_back_only_itself(caplog):
    conn, log = _conn(fail_on=KINDS_STEP)

    with caplog.at_level(logging.WARNING):
        await _run_auto_migrations(conn)  # never raises

    assert _tail(log) == [VISIBILITY, "COMMIT", KINDS_STEP, "ROLLBACK", WIDEN, "COMMIT"]
    (record,) = (r for r in caplog.records if "dashboard widget kinds" in r.getMessage())
    assert record.levelname == "ERROR"
    message = record.getMessage()
    assert "Auto-migration (dashboard widget kinds) failed for acme" in message
    assert "must be owner of table dashboard_widgets" in message
    assert "migrations/add_dashboard_widget_kinds.sql" in message
    # The other blocks report nothing.
    assert not any("dashboard visibility" in r.getMessage() for r in caplog.records)
    assert not any("notification types" in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_a_failing_visibility_block_still_runs_the_kind_block():
    conn, log = _conn(fail_on=VISIBILITY)

    await _run_auto_migrations(conn)

    assert _tail(log) == [VISIBILITY, "ROLLBACK", KINDS_STEP, "COMMIT", WIDEN, "COMMIT"]
