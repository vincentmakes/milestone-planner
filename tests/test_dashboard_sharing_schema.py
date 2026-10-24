"""
Dashboard sharing schema (2.1.0) stays identical in every DDL source.

The canonical statements of the site, team and person link tables live once
in tenant_provisioner (DASHBOARD_SHARING_SCHEMA_STATEMENTS);
get_tenant_schema_sql(), setup_databases.sql, migrations/add_dashboard_sharing.sql
and the manual-setup template carry the same text after the dashboards, sites,
teams and users tables. The visibility rename ('roles' -> 'shared') is a
self-gated DO block (DASHBOARD_VISIBILITY_CHECK_SQL) in the auto-migration step
and the migration file only: the fresh sources create the new CHECK directly.
The tenant auto-migration runs its own step right after the dashboards step
(DDL only while a table is missing, never a seed; the visibility block every
time), and the ORM declares the same columns, keys and delete rules. Repo-root
files are skipped when the test tree is run outside the repository.
"""

import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import CheckConstraint, MetaData, create_engine, event, text
from sqlalchemy.orm import Session

from app.database import Base
from app.models.dashboard import (
    Dashboard,
    DashboardSite,
    DashboardTeam,
    DashboardUser,
)
from app.models.rbac import Role
from app.models.site import Site
from app.models.team import Team
from app.models.user import User
from app.services import tenant_provisioner as tp
from app.services.tenant_provisioner import (
    DASHBOARD_SHARING_INDEX_STATEMENTS,
    DASHBOARD_SHARING_PROBE_SQL,
    DASHBOARD_SHARING_SCHEMA_SQL,
    DASHBOARD_SHARING_SCHEMA_STATEMENTS,
    DASHBOARD_SHARING_TABLES,
    DASHBOARD_SITES_TABLE_SQL,
    DASHBOARD_TABLES,
    DASHBOARD_TEAMS_TABLE_SQL,
    DASHBOARD_USERS_TABLE_SQL,
    DASHBOARD_VISIBILITY_CHECK_SQL,
    DASHBOARD_WIDGET_KIND_CHECK_SQL,
    DASHBOARDS_PROBE_SQL,
    NOTIFICATIONS_TYPE_CHECK_SQL,
    PROJECT_FIELDS_PROBE_SQL,
    RBAC_NEEDS_MIGRATION_SQL,
    get_tenant_schema_sql,
)
from migrations.run_migration_master import split_sql_statements

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "add_dashboard_sharing.sql"
DASHBOARDS_MIGRATION = ROOT / "migrations" / "add_dashboards.sql"
IN_REPO = (ROOT / "setup_databases.sql").exists() and (ROOT / "Dockerfile").exists()

TABLE_SQL = {
    "dashboard_sites": DASHBOARD_SITES_TABLE_SQL,
    "dashboard_teams": DASHBOARD_TEAMS_TABLE_SQL,
    "dashboard_users": DASHBOARD_USERS_TABLE_SQL,
}
# (table, target table, target column, index)
LINKS = {
    "dashboard_sites": ("sites", "site_id", "idx_dashboard_sites_site"),
    "dashboard_teams": ("teams", "team_id", "idx_dashboard_teams_team"),
    "dashboard_users": ("users", "user_id", "idx_dashboard_users_user"),
}
MODELS = {
    "dashboard_sites": DashboardSite,
    "dashboard_teams": DashboardTeam,
    "dashboard_users": DashboardUser,
}
# Every table the sharing DDL references: they must come first.
PARENT_TABLES = ("users", "sites", "teams", "dashboards")
NEW_CHECK = "CHECK (visibility IN ('private', 'shared', 'everyone'))"
OLD_CHECK = "CHECK (visibility IN ('private', 'roles', 'everyone'))"


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


def _root_file(relative: str) -> str:
    if not IN_REPO:
        pytest.skip("repo-root files are not part of this checkout")
    return (ROOT / relative).read_text()


def _fresh_sources() -> dict[str, str]:
    """The fresh-schema sources (CREATE ... IF NOT EXISTS)."""
    return {
        "provisioner": get_tenant_schema_sql(),
        "setup_databases.sql": _root_file("setup_databases.sql"),
    }


def _template() -> str:
    return _root_file("scripts/sql/tenant_schema_template.sql")


def _as_template(statement: str) -> str:
    """The template creates a fresh database: no IF NOT EXISTS."""
    return _norm(statement).replace(" IF NOT EXISTS", "")


def _ddl_columns(table_sql: str) -> dict[str, str]:
    """``{column: rest of its definition}`` of a CREATE TABLE statement."""
    body = table_sql[table_sql.index("(") + 1 : table_sql.rindex(")")]
    columns: dict[str, str] = {}
    for line in body.splitlines():
        line = line.strip().rstrip(",")
        if not line or line.startswith(("CONSTRAINT", "CHECK", "PRIMARY KEY", "(")):
            continue
        name, _, definition = line.partition(" ")
        columns[name] = definition
    return columns


# ---------------------------------------------------------------------------
# The constants
# ---------------------------------------------------------------------------


def test_sharing_tables_lists_the_three_tables_in_creation_order():
    assert DASHBOARD_SHARING_TABLES == ("dashboard_sites", "dashboard_teams", "dashboard_users")
    assert tuple(TABLE_SQL) == DASHBOARD_SHARING_TABLES
    # Kept apart from DASHBOARD_TABLES: those gate the one-shot Overview seed.
    assert DASHBOARD_TABLES == ("dashboards", "dashboard_roles", "dashboard_widgets")
    assert not set(DASHBOARD_SHARING_TABLES) & set(DASHBOARD_TABLES)


def test_schema_statements_are_the_tables_then_the_indexes():
    assert DASHBOARD_SHARING_SCHEMA_STATEMENTS == (
        *TABLE_SQL.values(),
        *DASHBOARD_SHARING_INDEX_STATEMENTS,
    )
    for table, sql in TABLE_SQL.items():
        assert _norm(sql).startswith(f"CREATE TABLE IF NOT EXISTS {table} (")
    # One statement per entry: asyncpg executes a single statement per call.
    for statement in DASHBOARD_SHARING_SCHEMA_STATEMENTS:
        assert ";" not in statement, statement
    assert DASHBOARD_SHARING_SCHEMA_SQL == ";\n".join(DASHBOARD_SHARING_SCHEMA_STATEMENTS) + ";"


@pytest.mark.parametrize("table", DASHBOARD_SHARING_TABLES)
def test_the_columns_keys_and_index(table):
    target, column, index = LINKS[table]
    assert _ddl_columns(TABLE_SQL[table]) == {
        "dashboard_id": "INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE",
        column: f"INTEGER NOT NULL REFERENCES {target}(id) ON DELETE CASCADE",
    }
    assert f"PRIMARY KEY (dashboard_id, {column})" in _norm(TABLE_SQL[table])
    assert f"CREATE INDEX IF NOT EXISTS {index} ON {table}({column})" in (
        DASHBOARD_SHARING_INDEX_STATEMENTS
    )


def test_statements_have_no_bind_parameters():
    """SQLAlchemy text() would read ':name' tokens as binds."""
    for statement in (*DASHBOARD_SHARING_SCHEMA_STATEMENTS, DASHBOARD_VISIBILITY_CHECK_SQL):
        assert text(statement).compile().params == {}


def test_probe_lists_the_tables():
    for table in DASHBOARD_SHARING_TABLES:
        assert f"'{table}'" in DASHBOARD_SHARING_PROBE_SQL
    assert "information_schema.tables" in DASHBOARD_SHARING_PROBE_SQL
    assert "table_schema = 'public'" in DASHBOARD_SHARING_PROBE_SQL


# ---------------------------------------------------------------------------
# The visibility rename: a self-gated DO block
# ---------------------------------------------------------------------------


def test_visibility_block_is_guarded_by_the_new_value():
    sql = _norm(DASHBOARD_VISIBILITY_CHECK_SQL)
    assert "to_regclass('public.dashboards') IS NOT NULL AND NOT EXISTS (" in sql
    assert "conname = 'dashboards_visibility_check'" in sql
    assert "strpos(pg_get_constraintdef(oid), 'shared') > 0" in sql


def test_visibility_block_drops_updates_then_adds():
    sql = _norm(DASHBOARD_VISIBILITY_CHECK_SQL)
    drop = sql.index(
        "ALTER TABLE dashboards DROP CONSTRAINT IF EXISTS dashboards_visibility_check;"
    )
    update = sql.index("UPDATE dashboards SET visibility = 'shared' WHERE visibility = 'roles';")
    add = sql.index(
        f"ALTER TABLE dashboards ADD CONSTRAINT dashboards_visibility_check {NEW_CHECK};"
    )
    assert drop < update < add


def test_visibility_block_is_one_asyncpg_statement():
    stripped = DASHBOARD_VISIBILITY_CHECK_SQL.strip()
    assert stripped.startswith("DO $$") and stripped.endswith("END $$")
    assert stripped.count("$$") == 2
    assert not re.search(r"(?<![:\w]):\w", stripped)


def test_every_fresh_source_creates_the_new_check():
    sources = {
        **_fresh_sources(),
        "template": _template(),
        "add_dashboards.sql": DASHBOARDS_MIGRATION.read_text(),
        "DASHBOARDS_TABLE_SQL": tp.DASHBOARDS_TABLE_SQL,
    }
    for name, sql in sources.items():
        assert NEW_CHECK in _norm(sql), name
        assert OLD_CHECK not in _norm(sql), name


def test_the_visibility_block_is_not_in_the_fresh_sources():
    """It only ever acts on a pre-release database: upgrade paths only."""
    marker = "UPDATE dashboards SET visibility = 'shared'"
    for name, sql in {**_fresh_sources(), "template": _template()}.items():
        assert marker not in sql, name


# ---------------------------------------------------------------------------
# Every DDL source carries the same statements, after their parents
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "statement",
    DASHBOARD_SHARING_SCHEMA_STATEMENTS,
    ids=[*TABLE_SQL, *(link[2] for link in LINKS.values())],
)
def test_every_source_carries_the_canonical_statement(statement):
    sources = {**_fresh_sources(), "add_dashboard_sharing.sql": MIGRATION.read_text()}
    for name, sql in sources.items():
        assert _norm(statement) in _norm(sql), name
    assert _as_template(statement) in _norm(_template())


def test_sharing_tables_come_after_their_parents():
    sources = {**_fresh_sources(), "template": _template()}
    for name, sql in sources.items():
        normalized = _norm(sql).replace(" IF NOT EXISTS", "")
        first = normalized.index("CREATE TABLE dashboard_sites (")
        for parent in PARENT_TABLES:
            assert normalized.index(f"CREATE TABLE {parent} (") < first, (name, parent)
        assert first < normalized.index("CREATE TABLE dashboard_teams (")
        last_table = normalized.index("CREATE TABLE dashboard_users (")
        assert normalized.index("CREATE TABLE dashboard_teams (") < last_table
        for _target, _column, index in LINKS.values():
            assert normalized.index(f"CREATE INDEX {index} ") > last_table, (name, index)


def test_provisioner_schema_dollar_quoting_still_balanced():
    sql = get_tenant_schema_sql()
    assert sql.count("DO $$") == sql.count("END $$;")


# ---------------------------------------------------------------------------
# migrations/add_dashboard_sharing.sql
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def migration_statements() -> list[str]:
    return split_sql_statements(MIGRATION.read_text())


def test_migration_documents_how_to_run_it():
    sql = MIGRATION.read_text()
    assert "python migrations/run_migration.py add_dashboard_sharing" in sql
    assert "psql" in sql


def test_migration_splits_into_whole_statements(migration_statements):
    do_blocks = [s for s in migration_statements if s.lstrip().startswith("DO $$")]
    assert len(do_blocks) == 3  # visibility, grants, completion notice
    assert all(s.rstrip().endswith("END $$;") for s in do_blocks)
    for statement in migration_statements:
        if statement not in do_blocks:
            assert "$$" not in statement
    plain = [_norm(s).rstrip(";").strip() for s in migration_statements if s not in do_blocks]
    assert plain == [_norm(s) for s in DASHBOARD_SHARING_SCHEMA_STATEMENTS]
    # The schema, then the visibility block, the grants, the notice last.
    visibility, grants, notice = do_blocks
    assert migration_statements.index(visibility) == len(DASHBOARD_SHARING_SCHEMA_STATEMENTS)
    assert _norm(visibility).removesuffix(";").strip() == _norm(DASHBOARD_VISIBILITY_CHECK_SQL)
    assert "GRANT" in grants
    assert "RAISE NOTICE 'Dashboard sharing migration completed successfully'" in notice
    assert migration_statements[-1] is notice


def test_migration_grants_every_table(migration_statements):
    (grants,) = (s for s in migration_statements if "GRANT" in s)
    for table in DASHBOARD_SHARING_TABLES:
        assert f"GRANT ALL PRIVILEGES ON TABLE {table} TO %I" in grants, table
    # No serial column, hence no sequence.
    assert "SEQUENCE" not in grants


def test_migration_is_listed_in_the_readme():
    readme = _root_file("migrations/README.md")
    assert "| `add_dashboard_sharing` | tenant |" in readme
    # Alphabetical: before add_dashboards.
    assert readme.index("| `add_dashboard_sharing` |") < readme.index("| `add_dashboards` |")
    # Applied automatically too.
    auto = readme[readme.index("Some tenant migrations also run automatically") :]
    assert "`add_dashboard_sharing`" in auto.split("\n")[0]


def test_single_tenant_upgrade_checks_the_tables():
    source = (ROOT / "tests" / "test_single_tenant_upgrade.py").read_text()
    for table in DASHBOARD_SHARING_TABLES:
        assert f'"{table}",' in source, table


# ---------------------------------------------------------------------------
# Tenant auto-migration
# ---------------------------------------------------------------------------


def test_tenant_auto_migration_executes_the_constants():
    from app.services import tenant_manager

    assert tenant_manager.DASHBOARD_SHARING_SCHEMA_STATEMENTS is DASHBOARD_SHARING_SCHEMA_STATEMENTS
    assert tenant_manager.DASHBOARD_SHARING_PROBE_SQL is DASHBOARD_SHARING_PROBE_SQL
    assert tenant_manager.DASHBOARD_SHARING_TABLES is DASHBOARD_SHARING_TABLES
    assert tenant_manager.DASHBOARD_VISIBILITY_CHECK_SQL is DASHBOARD_VISIBILITY_CHECK_SQL


DASHBOARDS_PROBE = "CHECK dashboard tables"
PROBE = "CHECK dashboard sharing tables"
VISIBILITY = "dashboard visibility check"
KINDS = "dashboard widget kinds check"
WIDEN = "widen notification types"


def _conn(tables=(), fail_on: str | None = None):
    """
    A connection on which the project-fields, RBAC and dashboards probes
    answer "up to date" and the sharing step's own SQL succeeds (unless it is
    ``fail_on``); every other auto-migration step fails (and is contained by
    its own try/except). ``log`` records the statements interleaved with
    COMMIT / ROLLBACK.
    """
    log: list[str] = []

    def rows(values):
        result = MagicMock()
        result.fetchall.return_value = [(v,) for v in values]
        return result

    async def execute(clause, *args, **kwargs):
        sql = str(clause)
        if sql == PROJECT_FIELDS_PROBE_SQL:
            return rows(tp.PROJECT_FIELD_TABLES)
        if sql == RBAC_NEEDS_MIGRATION_SQL:
            result = MagicMock()
            result.scalar.return_value = False
            return result
        if sql == DASHBOARDS_PROBE_SQL:
            log.append(DASHBOARDS_PROBE)
            return rows(DASHBOARD_TABLES)
        if sql == DASHBOARD_SHARING_PROBE_SQL:
            log.append(PROBE)
            return rows(tables)
        if sql == NOTIFICATIONS_TYPE_CHECK_SQL:
            log.append(WIDEN)
            return MagicMock()
        if sql == DASHBOARD_VISIBILITY_CHECK_SQL:
            log.append(VISIBILITY)
            if fail_on == VISIBILITY:
                raise RuntimeError("check violated")
            return MagicMock()
        if sql == DASHBOARD_WIDGET_KIND_CHECK_SQL:  # the next self-gated block
            log.append(KINDS)
            return MagicMock()
        if sql in DASHBOARD_SHARING_SCHEMA_STATEMENTS:
            log.append(sql)
            if sql == fail_on:
                raise RuntimeError("statement failed")
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


def _step(log: list[str]) -> list[str]:
    """The sharing step's log: from its probe up to the widget-kinds block."""
    return log[log.index(PROBE) : log.index(KINDS)]


# What follows the sharing step: the widget-kinds block in its own
# transaction, then the notification types.
AFTER_SHARING = [KINDS, "COMMIT", WIDEN, "COMMIT"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tables",
    [(), DASHBOARD_SHARING_TABLES[:-1], DASHBOARD_SHARING_TABLES[1:]],
    ids=["pre-sharing", "partial", "partial2"],
)
async def test_auto_migration_creates_the_tables_then_fixes_the_check(tables):
    conn, log = _conn(tables=tables)

    await _run_auto_migrations(conn)

    # The tables and indexes committed, then the visibility block in its own
    # transaction -- no seed.
    assert _step(log) == [
        PROBE,
        *DASHBOARD_SHARING_SCHEMA_STATEMENTS,
        "COMMIT",
        VISIBILITY,
        "COMMIT",
    ]
    # Right after the dashboards step (the links reference dashboards),
    # before the widget-kinds block and the notification-types step.
    assert log.index(DASHBOARDS_PROBE) < log.index(PROBE) < log.index(KINDS) < log.index(WIDEN)
    assert log[log.index(KINDS) :] == AFTER_SHARING


@pytest.mark.asyncio
async def test_auto_migration_runs_only_the_check_on_an_up_to_date_tenant():
    conn, log = _conn(tables=DASHBOARD_SHARING_TABLES)

    await _run_auto_migrations(conn)

    assert log[log.index(PROBE) :] == [PROBE, "COMMIT", VISIBILITY, "COMMIT", *AFTER_SHARING]
    assert not any(s in DASHBOARD_SHARING_SCHEMA_STATEMENTS for s in log)


@pytest.mark.asyncio
async def test_a_failing_table_rolls_back_and_the_check_still_runs(caplog):
    conn, log = _conn(fail_on=DASHBOARD_TEAMS_TABLE_SQL)

    await _run_auto_migrations(conn)  # never raises

    assert _step(log) == [
        PROBE,
        DASHBOARD_SITES_TABLE_SQL,
        DASHBOARD_TEAMS_TABLE_SQL,
        "ROLLBACK",
        VISIBILITY,
        "COMMIT",
    ]
    assert log[-4:] == AFTER_SHARING  # the later steps still ran
    assert any(
        "Auto-migration (dashboard sharing) warning for acme" in r.getMessage()
        for r in caplog.records
    )


@pytest.mark.asyncio
async def test_a_failing_check_keeps_the_committed_tables(caplog):
    """The visibility ALTER fails (the pool's user does not own dashboards):
    the link tables are already committed, only the block is rolled back."""
    conn, log = _conn(fail_on=VISIBILITY)

    await _run_auto_migrations(conn)  # never raises

    assert _step(log) == [
        PROBE,
        *DASHBOARD_SHARING_SCHEMA_STATEMENTS,
        "COMMIT",
        VISIBILITY,
        "ROLLBACK",
    ]
    step = _step(log)
    assert step.count("ROLLBACK") == 1 and step[-1] == "ROLLBACK"
    assert log[-4:] == AFTER_SHARING
    messages = [r.getMessage() for r in caplog.records]
    assert any("Auto-migration (dashboard visibility) warning for acme" in m for m in messages)
    assert not any("Auto-migration (dashboard sharing) warning" in m for m in messages)


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


def _fk(column):
    (fk,) = column.foreign_keys
    return fk


def test_models_live_on_the_tenant_base():
    for table in DASHBOARD_SHARING_TABLES:
        assert table in Base.metadata.tables, table
        assert MODELS[table].__tablename__ == table


@pytest.mark.parametrize("table", DASHBOARD_SHARING_TABLES)
def test_model_matches_the_ddl(table):
    target, column, index = LINKS[table]
    model_table = MODELS[table].__table__
    assert [c.name for c in model_table.columns] == list(_ddl_columns(TABLE_SQL[table]))
    assert [c.name for c in model_table.primary_key.columns] == ["dashboard_id", column]
    assert all(not c.nullable for c in model_table.columns)
    assert _fk(model_table.c.dashboard_id).ondelete == "CASCADE"
    assert _fk(model_table.c.dashboard_id).target_fullname == "dashboards.id"
    assert _fk(model_table.c[column]).ondelete == "CASCADE"
    assert _fk(model_table.c[column]).target_fullname == f"{target}.id"
    assert {i.name for i in model_table.indexes} == {index}


def test_dashboard_relationships():
    for rel in (Dashboard.sites, Dashboard.teams, Dashboard.users):
        assert rel.property.lazy == "selectin"
        assert rel.property.passive_deletes is True
        assert "delete-orphan" in rel.property.cascade


def test_transient_objects():
    dashboard = Dashboard(name="Shared", visibility="shared")
    assert (dashboard.site_ids, dashboard.team_ids, dashboard.user_ids) == ([], [], [])
    dashboard.sites = [DashboardSite(site_id=3), DashboardSite(site_id=1)]
    dashboard.teams = [DashboardTeam(team_id=9), DashboardTeam(team_id=2)]
    dashboard.users = [DashboardUser(user_id=8), DashboardUser(user_id=5)]
    assert (dashboard.site_ids, dashboard.team_ids, dashboard.user_ids) == (
        [1, 3],
        [2, 9],
        [5, 8],
    )
    assert repr(DashboardSite(dashboard_id=2, site_id=5)) == "<DashboardSite dashboard=2 site=5>"
    assert repr(DashboardTeam(dashboard_id=2, team_id=5)) == "<DashboardTeam dashboard=2 team=5>"
    assert repr(DashboardUser(dashboard_id=2, user_id=5)) == "<DashboardUser dashboard=2 user=5>"


def test_models_package_exports_the_sharing_models():
    import app.models as models

    for name in ("DashboardSite", "DashboardTeam", "DashboardUser"):
        assert name in models.__all__
        assert getattr(models, name).__module__ == "app.models.dashboard"


@pytest.fixture
def sqlite_session():
    engine = create_engine("sqlite://")

    @event.listens_for(engine, "connect")
    def _foreign_keys(dbapi_connection, _record):
        dbapi_connection.execute("PRAGMA foreign_keys=ON")

    # The tables the links need, with the dashboard CHECKs kept (the roles key
    # CHECK uses PostgreSQL regex syntax SQLite lacks).
    metadata = MetaData()
    for table in Base.metadata.sorted_tables:
        copy = table.to_metadata(metadata)
        for constraint in [c for c in copy.constraints if isinstance(c, CheckConstraint)]:
            if "~" in str(constraint.sqltext):
                copy.constraints.discard(constraint)
    metadata.create_all(
        engine,
        tables=[
            metadata.tables[name]
            for name in (
                "roles",
                "users",
                "sites",
                "teams",
                *DASHBOARD_TABLES,
                *DASHBOARD_SHARING_TABLES,
            )
        ],
    )
    with Session(engine) as session:
        session.add(Role(id=1, key="user", name="User"))
        session.flush()
        session.add_all(
            [
                Site(id=1, name="Winterthur"),
                Site(id=2, name="Frankfurt"),
                User(id=7, email="o@x", password="x", first_name="O", last_name="W"),
                User(id=8, email="p@x", password="x", first_name="P", last_name="W"),
            ]
        )
        session.flush()
        session.add_all([Team(id=1, site_id=1, name="QA"), Team(id=2, site_id=2, name="Lab")])
        session.commit()
        yield session
    engine.dispose()


def test_the_new_check_holds_on_sqlite(sqlite_session):
    sqlite_session.add(Dashboard(name="Old", visibility="roles"))
    with pytest.raises(Exception, match="CHECK constraint failed"):
        sqlite_session.commit()
    sqlite_session.rollback()
    sqlite_session.add(Dashboard(name="New", visibility="shared"))
    sqlite_session.commit()


def _count(session, table: str) -> int:
    return session.execute(text(f"SELECT count(*) FROM {table}")).scalar()


def test_links_go_with_their_dashboard_and_their_target(sqlite_session):
    dashboard = Dashboard(name="Shared", visibility="shared", owner_id=7)
    dashboard.sites = [DashboardSite(site_id=1), DashboardSite(site_id=2)]
    dashboard.teams = [DashboardTeam(team_id=1), DashboardTeam(team_id=2)]
    dashboard.users = [DashboardUser(user_id=7), DashboardUser(user_id=8)]
    sqlite_session.add(dashboard)
    sqlite_session.commit()
    sqlite_session.expire_all()

    loaded = sqlite_session.get(Dashboard, dashboard.id)
    assert (loaded.site_ids, loaded.team_ids, loaded.user_ids) == ([1, 2], [1, 2], [7, 8])

    # A target's delete drops its link only.
    sqlite_session.execute(text("DELETE FROM teams WHERE id = 2"))
    sqlite_session.execute(text("DELETE FROM users WHERE id = 8"))
    sqlite_session.commit()
    assert sqlite_session.execute(text("SELECT team_id FROM dashboard_teams")).all() == [(1,)]
    assert sqlite_session.execute(text("SELECT user_id FROM dashboard_users")).all() == [(7,)]
    # A site's delete takes its teams along, and their links with them.
    sqlite_session.execute(text("DELETE FROM sites WHERE id = 1"))
    sqlite_session.commit()
    assert sqlite_session.execute(text("SELECT site_id FROM dashboard_sites")).all() == [(2,)]
    assert _count(sqlite_session, "dashboard_teams") == 0

    # The owner's delete keeps the dashboard and its links (owner_id SET NULL),
    # though the owner was one of its people (that link goes).
    sqlite_session.execute(text("DELETE FROM users WHERE id = 7"))
    sqlite_session.commit()
    assert sqlite_session.execute(text("SELECT owner_id FROM dashboards")).all() == [(None,)]
    assert _count(sqlite_session, "dashboard_sites") == 1

    # The dashboard's delete takes every link along.
    sqlite_session.execute(text("DELETE FROM dashboards"))
    sqlite_session.commit()
    for table in DASHBOARD_SHARING_TABLES:
        assert _count(sqlite_session, table) == 0
