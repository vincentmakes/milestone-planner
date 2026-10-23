"""
Project comment threads (2.0.0) in every schema source.

``card_comments.entity_type`` gains ``'project'``: a project carries its own
thread (the thread of its project-level bookings). The CHECK text is
``tenant_provisioner.CARD_COMMENTS_ENTITY_TYPE_CHECK`` (built from the model's
``COMMENT_ENTITY_TYPES``) in the ORM and the four CREATE TABLE sources; the
widening of an existing table is ``PROJECT_COMMENTS_CHECK_SQL``, carried
verbatim by the provisioner schema (re-applied to existing databases),
setup_databases.sql, the manual-setup template and
migrations/add_project_comments.sql, and run by the tenant auto-migration on
every pool creation. The orphan cleanup is unchanged (a project thread goes
with its project through the project_id FK cascade). Repo-root files are
skipped when the test tree is run outside the repository.
"""

import logging
import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import CheckConstraint

from app.models.card_comment import COMMENT_ENTITY_TYPES, CardComment
from app.services.tenant_provisioner import (
    CARD_COMMENTS_ENTITY_TYPE_CHECK,
    CARD_COMMENTS_ORPHAN_CLEANUP_SQL,
    PROJECT_COMMENTS_CHECK_SQL,
    get_tenant_schema_sql,
)
from migrations.run_migration_master import split_sql_statements

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "add_project_comments.sql"
IN_REPO = (ROOT / "setup_databases.sql").exists() and (ROOT / "Dockerfile").exists()
FULL_CHECK = "entity_type IN ('phase', 'subphase', 'project')"
OLD_CHECK = "entity_type IN ('phase', 'subphase'))"


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


# ---------------------------------------------------------------------------
# The constants
# ---------------------------------------------------------------------------


def test_comment_entity_types():
    assert COMMENT_ENTITY_TYPES == ("phase", "subphase", "project")
    assert CARD_COMMENTS_ENTITY_TYPE_CHECK == FULL_CHECK


def test_orm_check_lists_project():
    (check,) = (
        c
        for c in CardComment.__table__.constraints
        if isinstance(c, CheckConstraint) and c.name == "card_comments_entity_type_check"
    )
    assert str(check.sqltext) == FULL_CHECK


def test_widening_is_guarded_by_project_and_one_statement():
    sql = _norm(PROJECT_COMMENTS_CHECK_SQL)
    assert "strpos(pg_get_constraintdef(oid), 'project') > 0" in sql
    assert "conname = 'card_comments_entity_type_check'" in sql
    assert "to_regclass('public.card_comments') IS NOT NULL" in sql
    assert (
        "ALTER TABLE card_comments DROP CONSTRAINT IF EXISTS card_comments_entity_type_check"
    ) in sql
    assert (
        "ALTER TABLE card_comments ADD CONSTRAINT card_comments_entity_type_check "
        f"CHECK ({FULL_CHECK})"
    ) in sql
    stripped = PROJECT_COMMENTS_CHECK_SQL.strip()
    assert stripped.startswith("DO $$") and stripped.endswith("END $$")
    assert stripped.count("$$") == 2
    assert not re.search(r"(?<![:\w]):\w", stripped)  # no bind-parameter look-alikes


def test_orphan_cleanup_leaves_project_threads_alone():
    # A project thread cannot outlive its project (FK cascade on project_id).
    assert "'project'" not in CARD_COMMENTS_ORPHAN_CLEANUP_SQL


# ---------------------------------------------------------------------------
# Every source
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("source", ["provisioner", "setup_databases.sql", "template"])
def test_every_create_table_lists_project(source):
    sql = _sources()[source]
    match = re.search(r"CREATE TABLE (?:IF NOT EXISTS )?card_comments \(", sql)
    assert match
    body = _norm(sql[match.end() : sql.index(");", match.end())]).replace("CHECK(", "CHECK (")
    assert f"CHECK ({FULL_CHECK}" in body, source


@pytest.mark.parametrize("source", ["provisioner", "setup_databases.sql", "template"])
def test_every_source_carries_the_widening_after_the_table(source):
    normalized = _norm(_sources()[source])
    create = re.search(r"CREATE TABLE (?:IF NOT EXISTS )?card_comments \(", normalized)
    assert create
    assert create.start() < normalized.index(_norm(PROJECT_COMMENTS_CHECK_SQL)), source
    assert OLD_CHECK not in normalized.replace("CHECK(", "CHECK ("), source


def test_tenant_manager_create_lists_project():
    from app.services import tenant_manager

    text = _norm(Path(tenant_manager.__file__).read_text())
    assert f"CONSTRAINT card_comments_entity_type_check CHECK ({FULL_CHECK})" in text
    assert OLD_CHECK not in text


def test_provisioner_schema_dollar_quoting_still_balanced():
    assert get_tenant_schema_sql().count("$$") % 2 == 0


# ---------------------------------------------------------------------------
# migrations/add_project_comments.sql
# ---------------------------------------------------------------------------


def test_migration_is_the_constant_as_one_statement():
    statements = split_sql_statements(MIGRATION.read_text())
    assert len(statements) == 1
    (statement,) = statements
    assert _norm(statement).removesuffix(";").strip() == _norm(PROJECT_COMMENTS_CHECK_SQL)


def test_migration_documents_how_to_run_it():
    sql = MIGRATION.read_text()
    assert "-- USAGE:" in sql
    assert "python migrations/run_migration.py add_project_comments" in sql
    assert "psql" in sql
    readme = _root_file("migrations/README.md")
    assert "| `add_project_comments` | tenant |" in readme


# ---------------------------------------------------------------------------
# Tenant auto-migration
# ---------------------------------------------------------------------------


def _conn(fail: bool = False):
    """Only our statement succeeds; every other step fails (and is contained)."""
    log: list[str] = []

    async def execute(clause, *args, **kwargs):
        sql = str(clause)
        if sql == PROJECT_COMMENTS_CHECK_SQL:
            log.append("WIDEN")
            if fail:
                raise RuntimeError("permission denied")
            return MagicMock()
        if "table_name = 'card_comments'" in sql:
            log.append("card_comments probe")
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

    assert tenant_manager.PROJECT_COMMENTS_CHECK_SQL is PROJECT_COMMENTS_CHECK_SQL


@pytest.mark.asyncio
async def test_auto_migration_widens_right_after_the_card_comments_step():
    conn, log = _conn()

    await _run(conn)

    start = log.index("WIDEN")
    assert log[start : start + 2] == ["WIDEN", "COMMIT"]
    assert log.index("card_comments probe") < start
    assert log.count("WIDEN") == 1


@pytest.mark.asyncio
async def test_auto_migration_failure_rolls_back_and_never_raises(caplog):
    conn, log = _conn(fail=True)

    with caplog.at_level(logging.WARNING):
        await _run(conn)  # never raises

    start = log.index("WIDEN")
    assert log[start : start + 2] == ["WIDEN", "ROLLBACK"]
    assert "Auto-migration (project comments) warning for acme" in caplog.text
