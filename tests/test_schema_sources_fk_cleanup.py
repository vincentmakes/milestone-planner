"""
Schema sources for the B2-8 / B2-12 / B2-14 / B2-20 changes stay in sync.

- projects.site_id is ON DELETE CASCADE (deleting a site deletes its projects,
  as the ORM always did) in the model and every schema source, with a guarded
  FK rewrite for existing databases.
- card_comments.author_id is nullable, ON DELETE SET NULL (a deleted user's
  comments stay), same sources, same recipe.
- Orphaned custom-column values / card comments are cleaned by the same
  statements everywhere.
- The manual-setup template matches the model column widths and carries the
  assignment indexes GET /projects/{id} filters on.

The guarded SQL lives once in tenant_provisioner; setup_databases.sql inlines
it and the migration files are rendered from it, so the tests compare
whitespace-normalised text. Repo-root files (setup_databases.sql, the
template, the entrypoint) are skipped when the test tree is run outside the
repository (e.g. a scratch copy of app/ + tests/ only).
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest
from sqlalchemy import ForeignKey

from app.models.card_comment import CardComment
from app.models.project import Project
from app.services.tenant_provisioner import (
    CARD_COMMENTS_AUTHOR_FK_SQL,
    CARD_COMMENTS_ORPHAN_CLEANUP_SQL,
    CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL,
    PROJECTS_SITE_FK_SQL,
    get_tenant_schema_sql,
)
from migrations.run_migration_master import split_sql_statements

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


# A full checkout (CI, a developer clone) -- not a copy of app/ + tests/ only.
IN_REPO = (ROOT / "setup_databases.sql").exists() and (ROOT / "Dockerfile").exists()


def _root_file(relative: str) -> str:
    if not IN_REPO:
        pytest.skip("repo-root files are not part of this checkout")
    return (ROOT / relative).read_text()


def _table_block(sql: str, table: str) -> str:
    match = re.search(rf"CREATE TABLE (?:IF NOT EXISTS )?{table} \((.*?)\n\s*\);", sql, flags=re.S)
    assert match, f"no CREATE TABLE {table}"
    return match.group(1)


def _column_line(block: str, column: str) -> str:
    for line in block.splitlines():
        if line.strip().startswith(f"{column} "):
            return line.strip()
    raise AssertionError(f"no column {column}")


GUARDED = {
    "PROJECTS_SITE_FK_SQL": PROJECTS_SITE_FK_SQL,
    "CARD_COMMENTS_AUTHOR_FK_SQL": CARD_COMMENTS_AUTHOR_FK_SQL,
    "CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL": CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL,
    "CARD_COMMENTS_ORPHAN_CLEANUP_SQL": CARD_COMMENTS_ORPHAN_CLEANUP_SQL,
}

MIGRATION_FOR = {
    "PROJECTS_SITE_FK_SQL": "projects_site_fk_cascade.sql",
    "CARD_COMMENTS_AUTHOR_FK_SQL": "card_comments_author_set_null.sql",
    "CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL": "cleanup_orphaned_values.sql",
    "CARD_COMMENTS_ORPHAN_CLEANUP_SQL": "cleanup_orphaned_values.sql",
}


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


def _fk(column) -> ForeignKey:
    (fk,) = column.foreign_keys
    return fk


def test_project_site_fk_cascades_in_the_model():
    assert _fk(Project.__table__.c.site_id).ondelete == "CASCADE"


def test_card_comment_author_is_nullable_set_null_in_the_model():
    column = CardComment.__table__.c.author_id
    assert column.nullable is True
    assert _fk(column).ondelete == "SET NULL"


# ---------------------------------------------------------------------------
# Provisioner schema (fresh + upgrade chain)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def schema_sql() -> str:
    return get_tenant_schema_sql()


def test_provisioner_creates_the_new_delete_rules(schema_sql):
    projects = _table_block(schema_sql, "projects")
    assert "REFERENCES sites(id) ON DELETE CASCADE" in _column_line(projects, "site_id")
    author = _column_line(_table_block(schema_sql, "card_comments"), "author_id")
    assert "NOT NULL" not in author
    assert "ON DELETE SET NULL" in author


@pytest.mark.parametrize("name", list(GUARDED))
def test_provisioner_upgrade_chain_carries_the_guarded_sql(schema_sql, name):
    assert _norm(GUARDED[name]) in _norm(schema_sql)


def test_provisioner_upgrades_run_after_their_tables(schema_sql):
    sql = _norm(schema_sql)
    assert sql.index("CREATE TABLE IF NOT EXISTS projects") < sql.index(_norm(PROJECTS_SITE_FK_SQL))
    for name in ("CARD_COMMENTS_AUTHOR_FK_SQL", "CARD_COMMENTS_ORPHAN_CLEANUP_SQL"):
        assert sql.index("CREATE TABLE IF NOT EXISTS card_comments") < sql.index(
            _norm(GUARDED[name])
        )
    assert sql.index("CREATE TABLE IF NOT EXISTS custom_column_values") < sql.index(
        _norm(CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL)
    )


def test_provisioner_schema_dollar_quoting_still_balanced(schema_sql):
    assert schema_sql.count("$$") % 2 == 0


def test_guarded_fk_rewrites_follow_the_equipment_recipe():
    """Drop every FK with another delete rule, re-add only when none is left."""
    projects = _norm(PROJECTS_SITE_FK_SQL)
    assert "c.confdeltype <> 'c'" in projects
    assert "DROP CONSTRAINT %I" in projects
    assert "ON DELETE CASCADE" in projects
    # Dangling ids are cleared, never deleted.
    assert "UPDATE projects SET site_id = NULL" in projects
    assert "DELETE" not in projects.replace("ON DELETE", "")

    comments = _norm(CARD_COMMENTS_AUTHOR_FK_SQL)
    assert "to_regclass('public.card_comments') IS NULL THEN RETURN" in comments
    assert "ALTER COLUMN author_id DROP NOT NULL" in comments
    assert "c.confdeltype <> 'n'" in comments
    assert "ON DELETE SET NULL" in comments


def test_orphan_cleanup_covers_every_entity_type():
    values = _norm(CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL)
    for entity, table in (
        ("project", "projects"),
        ("phase", "project_phases"),
        ("subphase", "project_subphases"),
    ):
        assert f"v.entity_type = '{entity}'" in values
        assert f"FROM {table} " in values
    comments = _norm(CARD_COMMENTS_ORPHAN_CLEANUP_SQL)
    assert "cc.entity_type = 'phase'" in comments
    assert "cc.entity_type = 'subphase'" in comments
    # Plain statements: the schema chain / migration files add the separator.
    assert not CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL.strip().endswith(";")
    assert not CARD_COMMENTS_ORPHAN_CLEANUP_SQL.strip().endswith(";")


# ---------------------------------------------------------------------------
# Migration files
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", list(GUARDED))
def test_migration_file_is_the_shared_sql(name):
    text = (MIGRATIONS / MIGRATION_FOR[name]).read_text()
    assert _norm(GUARDED[name]) in _norm(text)


@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        ("projects_site_fk_cascade.sql", 1),
        ("card_comments_author_set_null.sql", 1),
        ("cleanup_orphaned_values.sql", 2),
    ],
)
def test_migration_files_split_cleanly(filename, expected):
    statements = split_sql_statements((MIGRATIONS / filename).read_text())
    assert len(statements) == expected, statements
    for statement in statements:
        assert statement.count("$$") % 2 == 0
        assert statement.rstrip().endswith(";")
        assert not statement.lstrip().startswith("--")


def test_kanban_migration_creates_comments_that_outlive_their_author():
    block = _table_block((MIGRATIONS / "add_kanban_tables.sql").read_text(), "card_comments")
    author = _column_line(block, "author_id")
    assert "NOT NULL" not in author and "ON DELETE SET NULL" in author


def test_tenant_auto_migration_creates_comments_that_outlive_their_author():
    """tenant_manager's card_comments CREATE agrees with the other sources."""
    import app.services.tenant_manager as tenant_manager

    source = Path(tenant_manager.__file__).read_text()
    match = re.search(r"CREATE TABLE IF NOT EXISTS card_comments \((.*?)\n\s*\)\s*\n", source, re.S)
    assert match, "no card_comments CREATE in tenant_manager"
    author = _column_line(match.group(1), "author_id")
    assert "NOT NULL" not in author and "ON DELETE SET NULL" in author


def test_legacy_all_tenant_helpers_are_gone():
    """B2-11: they embedded a wrong-shaped company_events table."""
    assert not (MIGRATIONS / "run_migration_all_tenants.sql").exists()
    assert not (MIGRATIONS / "generate_tenant_migrations.sql").exists()
    script = (MIGRATIONS / "migrate_all_tenants.sh").read_text()
    assert "CREATE TABLE" not in script
    assert "ON_ERROR_STOP=1" in script


def test_migrate_all_tenants_requires_a_file(tmp_path):
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash not available")
    script = MIGRATIONS / "migrate_all_tenants.sh"
    no_arg = subprocess.run([bash, str(script)], capture_output=True, text=True, timeout=30)
    assert no_arg.returncode == 2
    assert "Usage" in no_arg.stderr
    missing = subprocess.run(
        [bash, str(script), str(tmp_path / "nope.sql")],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert missing.returncode == 2
    assert "not found" in missing.stderr


# ---------------------------------------------------------------------------
# setup_databases.sql + template (repo root)
# ---------------------------------------------------------------------------


def test_setup_databases_fresh_tables_and_upgrade_section():
    sql = _root_file("setup_databases.sql")
    projects = _table_block(sql, "projects")
    assert "ON DELETE CASCADE" in _column_line(projects, "site_id")
    author = _column_line(_table_block(sql, "card_comments"), "author_id")
    assert "NOT NULL" not in author and "ON DELETE SET NULL" in author
    normalized = _norm(sql)
    for name, guarded in GUARDED.items():
        assert _norm(guarded) in normalized, name
    for index in (
        "ON phase_staff_assignments(project_id)",
        "ON subphase_staff_assignments(project_id)",
    ):
        assert index in sql


def test_setup_databases_upgrade_section_splits_cleanly():
    statements = split_sql_statements(_root_file("setup_databases.sql"))
    joined = [_norm(s) for s in statements]
    for name, guarded in GUARDED.items():
        expected = _norm(guarded).rstrip(";")
        assert any(s.rstrip(";").strip() == expected for s in joined), name


def test_template_matches_the_models():
    sql = _root_file("scripts/sql/tenant_schema_template.sql")
    projects = _table_block(sql, "projects")
    assert "ON DELETE CASCADE" in _column_line(projects, "site_id")
    assert "VARCHAR(200)" in _column_line(projects, "sales_pm")
    assert "VARCHAR(200)" in _column_line(_table_block(sql, "project_subphases"), "name")
    author = _column_line(_table_block(sql, "card_comments"), "author_id")
    assert "NOT NULL" not in author and "ON DELETE SET NULL" in author
    assert "ON phase_staff_assignments(project_id)" in sql
    assert "ON subphase_staff_assignments(project_id)" in sql


# ---------------------------------------------------------------------------
# docker-entrypoint.sh (B2-26) and the mpxj pin (B2-27)
# ---------------------------------------------------------------------------


def _fake_python(bin_dir: Path, init_exit: int) -> None:
    """A `python` that passes the DB socket check and exits ``init_exit`` for init_db."""
    fake = bin_dir / "python"
    fake.write_text(
        f'#!/bin/sh\ncase "$*" in *app.scripts.init_db*) exit {init_exit};; esac\nexit 0\n'
    )
    fake.chmod(0o755)


@pytest.mark.parametrize("init_exit", [0, 3])
def test_entrypoint_refuses_to_start_when_init_db_fails(tmp_path, init_exit):
    if not IN_REPO:
        pytest.skip("docker-entrypoint.sh is not part of this checkout")
    entrypoint = ROOT / "docker-entrypoint.sh"
    sh = shutil.which("sh")
    if sh is None:
        pytest.skip("sh not available")
    _fake_python(tmp_path, init_exit)
    env = {
        "PATH": f"{tmp_path}:/usr/bin:/bin",
        "AUTO_INIT_DB": "true",
        "DB_WAIT_ATTEMPTS": "1",
    }
    result = subprocess.run(
        [sh, str(entrypoint), "echo", "APP-STARTED"],
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    if init_exit == 0:
        assert result.returncode == 0
        assert "APP-STARTED" in result.stdout
    else:
        assert result.returncode == init_exit
        assert "APP-STARTED" not in result.stdout
        assert "Not starting the app" in result.stderr


def test_mpxj_is_pinned():
    requirements = _root_file("requirements.txt")
    lines = [ln.split("#")[0].strip() for ln in requirements.splitlines()]
    (mpxj,) = [ln for ln in lines if ln.startswith("mpxj")]
    assert re.fullmatch(r"mpxj==\d+\.\d+\.\d+", mpxj), mpxj
