"""
Dashboards schema (2.1.0) stays identical in every DDL source.

The canonical statements live once in tenant_provisioner
(DASHBOARDS_SCHEMA_STATEMENTS); get_tenant_schema_sql(), setup_databases.sql,
migrations/add_dashboards.sql and the manual-setup template carry the same
text after the users and roles tables, the tenant auto-migration executes the
constants after the RBAC step (dashboard_roles references roles), and the ORM
declares the same columns, checks, indexes and delete rules. Repo-root files
are skipped when the test tree is run outside the repository.
"""

import json
import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import CheckConstraint, MetaData, create_engine, event, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import Base
from app.models.dashboard import (
    DASHBOARD_VISIBILITIES,
    DASHBOARD_WIDGET_KINDS,
    Dashboard,
    DashboardRole,
    DashboardWidget,
)
from app.models.rbac import Role
from app.models.user import User
from app.services import tenant_provisioner as tp
from app.services.dashboard_seed import WIDGET_KEYS, base_dashboard_rows
from app.services.tenant_provisioner import (
    DASHBOARD_NAMED_SEED_PG_SQL,
    DASHBOARD_NAMED_SEED_SQL,
    DASHBOARD_PERMISSION_BACKFILL,
    DASHBOARD_PERMISSION_BACKFILL_PG_SQL,
    DASHBOARD_PERMISSION_BACKFILL_SQL,
    DASHBOARD_ROLES_TABLE_SQL,
    DASHBOARD_SEED_PG_SQL,
    DASHBOARD_SEED_SQL,
    DASHBOARD_SHARING_PROBE_SQL,
    DASHBOARD_SHARING_TABLES,
    DASHBOARD_TABLES,
    DASHBOARD_VISIBILITY_CHECK_SQL,
    DASHBOARD_WIDGET_KIND_CHECK_SQL,
    DASHBOARD_WIDGET_SEED_PG_SQL,
    DASHBOARD_WIDGET_SEED_SQL,
    DASHBOARD_WIDGETS_TABLE_SQL,
    DASHBOARDS_INDEX_STATEMENTS,
    DASHBOARDS_PROBE_SQL,
    DASHBOARDS_SCHEMA_SQL,
    DASHBOARDS_SCHEMA_STATEMENTS,
    DASHBOARDS_TABLE_SQL,
    NOTIFICATIONS_TYPE_CHECK_SQL,
    PROJECT_FIELDS_PROBE_SQL,
    RBAC_NEEDS_MIGRATION_SQL,
    dashboard_seed_params,
    dashboard_seed_pg_statement,
    dashboard_seed_statement,
    get_tenant_schema_sql,
)
from app.utils import utcnow_naive
from migrations.run_migration_master import split_sql_statements

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "add_dashboards.sql"
IN_REPO = (ROOT / "setup_databases.sql").exists() and (ROOT / "Dockerfile").exists()

TABLE_SQL = {
    "dashboards": DASHBOARDS_TABLE_SQL,
    "dashboard_roles": DASHBOARD_ROLES_TABLE_SQL,
    "dashboard_widgets": DASHBOARD_WIDGETS_TABLE_SQL,
}
INDEX_NAMES = (
    "dashboards_one_default",
    "idx_dashboard_roles_role",
    "idx_dashboard_widgets_dashboard",
)
MODELS = {
    "dashboards": Dashboard,
    "dashboard_roles": DashboardRole,
    "dashboard_widgets": DashboardWidget,
}
# Every table the dashboards DDL references: they must come first.
PARENT_TABLES = ("users", "roles")


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


def test_dashboard_tables_lists_the_three_tables_in_creation_order():
    assert DASHBOARD_TABLES == ("dashboards", "dashboard_roles", "dashboard_widgets")
    assert tuple(TABLE_SQL) == DASHBOARD_TABLES


def test_schema_statements_are_the_tables_then_the_indexes():
    assert DASHBOARDS_SCHEMA_STATEMENTS == (*TABLE_SQL.values(), *DASHBOARDS_INDEX_STATEMENTS)
    for table, sql in TABLE_SQL.items():
        assert _norm(sql).startswith(f"CREATE TABLE IF NOT EXISTS {table} (")
    # The one-default index first: the seed's ON CONFLICT names it.
    assert _norm(DASHBOARDS_INDEX_STATEMENTS[0]) == (
        "CREATE UNIQUE INDEX IF NOT EXISTS dashboards_one_default "
        "ON dashboards(is_default) WHERE is_default"
    )
    for name, sql in zip(INDEX_NAMES[1:], DASHBOARDS_INDEX_STATEMENTS[1:], strict=True):
        assert _norm(sql).startswith(f"CREATE INDEX IF NOT EXISTS {name} ON ")
    # One statement per entry: asyncpg executes a single statement per call.
    for statement in DASHBOARDS_SCHEMA_STATEMENTS:
        assert ";" not in statement, statement
    assert DASHBOARDS_SCHEMA_SQL == ";\n".join(DASHBOARDS_SCHEMA_STATEMENTS) + ";"


def test_the_index_definitions():
    assert _norm(DASHBOARDS_INDEX_STATEMENTS[1]) == (
        "CREATE INDEX IF NOT EXISTS idx_dashboard_roles_role ON dashboard_roles(role_id)"
    )
    assert _norm(DASHBOARDS_INDEX_STATEMENTS[2]) == (
        "CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_dashboard "
        "ON dashboard_widgets(dashboard_id)"
    )


def test_the_foreign_keys():
    dashboards = _ddl_columns(DASHBOARDS_TABLE_SQL)
    # A dashboard outlives its owner (NULL = admin-owned).
    assert dashboards["owner_id"] == "INTEGER REFERENCES users(id) ON DELETE SET NULL"
    roles = _ddl_columns(DASHBOARD_ROLES_TABLE_SQL)
    assert roles["dashboard_id"] == ("INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE")
    assert roles["role_id"] == "INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE"
    assert "PRIMARY KEY (dashboard_id, role_id)" in _norm(DASHBOARD_ROLES_TABLE_SQL)
    widgets = _ddl_columns(DASHBOARD_WIDGETS_TABLE_SQL)
    assert widgets["dashboard_id"] == (
        "INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE"
    )


def test_the_columns_and_checks():
    assert _ddl_columns(DASHBOARDS_TABLE_SQL) == {
        "id": "SERIAL PRIMARY KEY",
        "name": "VARCHAR(100) NOT NULL",
        "description": "TEXT",
        "owner_id": "INTEGER REFERENCES users(id) ON DELETE SET NULL",
        "visibility": "VARCHAR(10) NOT NULL",
        "is_default": "BOOLEAN NOT NULL DEFAULT FALSE",
        "created_at": "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
        "updated_at": "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
    }
    assert (
        "CONSTRAINT dashboards_visibility_check "
        "CHECK (visibility IN ('private', 'shared', 'everyone'))"
    ) in _norm(DASHBOARDS_TABLE_SQL)
    assert _ddl_columns(DASHBOARD_WIDGETS_TABLE_SQL) == {
        "id": "SERIAL PRIMARY KEY",
        "dashboard_id": "INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE",
        "kind": "VARCHAR(12) NOT NULL",
        "title": "VARCHAR(120) NOT NULL",
        "query": "TEXT NOT NULL",
        "options": "TEXT NOT NULL DEFAULT '{}'",
        "layout": "TEXT NOT NULL",
        "sort_order": "INTEGER NOT NULL DEFAULT 0",
    }
    assert (
        "CONSTRAINT dashboard_widgets_kind_check "
        "CHECK (kind IN ('kpi', 'bar', 'line', 'pie', 'table', "
        "'gauge', 'heatmap', 'treemap', 'sankey'))"
    ) in _norm(DASHBOARD_WIDGETS_TABLE_SQL)


def test_the_model_constants_match_the_checks():
    assert DASHBOARD_VISIBILITIES == ("private", "shared", "everyone")
    assert DASHBOARD_WIDGET_KINDS == (
        "kpi",
        "bar",
        "line",
        "pie",
        "table",
        "gauge",
        "heatmap",
        "treemap",
        "sankey",
    )


def test_statements_have_no_bind_parameters():
    """SQLAlchemy text() would read ':name' tokens as binds."""
    for statement in DASHBOARDS_SCHEMA_STATEMENTS:
        assert text(statement).compile().params == {}


def test_probe_lists_the_tables():
    for table in DASHBOARD_TABLES:
        assert f"'{table}'" in DASHBOARDS_PROBE_SQL
    assert "information_schema.tables" in DASHBOARDS_PROBE_SQL
    assert "table_schema = 'public'" in DASHBOARDS_PROBE_SQL


# ---------------------------------------------------------------------------
# Every DDL source carries the same statements, after users and roles
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("statement", DASHBOARDS_SCHEMA_STATEMENTS, ids=[*TABLE_SQL, *INDEX_NAMES])
def test_every_source_carries_the_canonical_statement(statement):
    sources = {**_fresh_sources(), "add_dashboards.sql": MIGRATION.read_text()}
    for name, sql in sources.items():
        assert _norm(statement) in _norm(sql), name
    assert _as_template(statement) in _norm(_template())


def test_dashboard_tables_come_after_users_and_roles():
    sources = {**_fresh_sources(), "template": _template()}
    for name, sql in sources.items():
        normalized = _norm(sql).replace(" IF NOT EXISTS", "")
        first = normalized.index("CREATE TABLE dashboards (")
        for parent in PARENT_TABLES:
            assert normalized.index(f"CREATE TABLE {parent} (") < first, (name, parent)
        # Each table follows the one it references, indexes follow the tables.
        assert first < normalized.index("CREATE TABLE dashboard_roles (")
        last_table = normalized.index("CREATE TABLE dashboard_widgets (")
        assert normalized.index("CREATE TABLE dashboard_roles (") < last_table
        assert normalized.index("CREATE UNIQUE INDEX dashboards_one_default ") > first
        for index in INDEX_NAMES[1:]:
            assert normalized.index(f"CREATE INDEX {index} ") > last_table, (name, index)


def test_provisioner_schema_dollar_quoting_still_balanced():
    sql = get_tenant_schema_sql()
    assert sql.count("DO $$") == sql.count("END $$;")


# ---------------------------------------------------------------------------
# migrations/add_dashboards.sql
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def migration_statements() -> list[str]:
    return split_sql_statements(MIGRATION.read_text())


def test_migration_documents_how_to_run_it():
    sql = MIGRATION.read_text()
    assert "python migrations/run_migration.py add_dashboards" in sql
    assert "psql" in sql
    # It says where the base dashboard and the grants come from.
    assert "Overview" in sql and "views.dashboards" in sql and "dashboards.manage" in sql


def test_migration_splits_into_whole_statements(migration_statements):
    do_blocks = [s for s in migration_statements if s.lstrip().startswith("DO $$")]
    assert len(do_blocks) == 2  # grants, completion notice
    assert all(s.rstrip().endswith("END $$;") for s in do_blocks)
    for statement in migration_statements:
        if statement not in do_blocks:
            assert "$$" not in statement
    plain = [_norm(s).rstrip(";").strip() for s in migration_statements if s not in do_blocks]
    assert plain == [_norm(s) for s in DASHBOARDS_SCHEMA_STATEMENTS]
    # The grants follow the schema, the notice comes last.
    assert migration_statements.index(do_blocks[0]) == len(DASHBOARDS_SCHEMA_STATEMENTS)
    assert "RAISE NOTICE 'Dashboards migration completed successfully'" in do_blocks[1]
    assert migration_statements[-1] is do_blocks[1]


def test_migration_grants_every_table_and_the_sequences(migration_statements):
    (grants,) = (s for s in migration_statements if "GRANT" in s)
    for table in DASHBOARD_TABLES:
        assert f"GRANT ALL PRIVILEGES ON TABLE {table} TO %I" in grants, table
    for sequence in ("dashboards_id_seq", "dashboard_widgets_id_seq"):
        assert f"GRANT USAGE, SELECT ON SEQUENCE {sequence} TO %I" in grants
    # dashboard_roles has no serial column, hence no sequence.
    assert "dashboard_roles_id_seq" not in grants


def test_migration_is_listed_in_the_readme():
    readme = _root_file("migrations/README.md")
    assert "| `add_dashboards` | tenant |" in readme
    # Applied automatically too.
    auto = readme[readme.index("Some tenant migrations also run automatically") :]
    assert "`add_dashboards`" in auto.split("\n")[0]


def test_single_tenant_upgrade_checks_the_tables():
    source = (ROOT / "tests" / "test_single_tenant_upgrade.py").read_text()
    for table in DASHBOARD_TABLES:
        assert f'"{table}",' in source, table


# ---------------------------------------------------------------------------
# Tenant auto-migration
# ---------------------------------------------------------------------------


def test_tenant_auto_migration_executes_the_constants():
    from app.services import tenant_manager

    assert tenant_manager.DASHBOARDS_SCHEMA_STATEMENTS is DASHBOARDS_SCHEMA_STATEMENTS
    assert tenant_manager.DASHBOARDS_PROBE_SQL is DASHBOARDS_PROBE_SQL
    assert tenant_manager.DASHBOARD_TABLES is DASHBOARD_TABLES


PROBE = "CHECK dashboard tables"
FIELDS_PROBE = "CHECK project field tables"
RBAC_PROBE = "CHECK rbac"
WIDEN = "widen notification types"
SHARING_PROBE = "CHECK dashboard sharing tables"
VISIBILITY = "dashboard visibility check"
KINDS = "dashboard widget kinds check"
SEED = "INSERT dashboard"
NAMED = "INSERT named dashboard"
WIDGET = "INSERT widget"
GRANT = "INSERT role permission"
NEW_ID = 77
NAMED_ID = 78


def _conn(
    tables=(),
    fail_on: str | None = None,
    dashboard_id: int | None = NEW_ID,
    named_id: int | None = NAMED_ID,
):
    """
    A connection on which the project-fields, RBAC and dashboard-sharing
    probes answer "up to date" (the sharing step's self-gated visibility
    block succeeds) and the dashboards step's own SQL succeeds; every other
    auto-migration step fails (and is contained by its own try/except).
    ``log`` records the statements interleaved with COMMIT / ROLLBACK, the
    seed inserts as SEED (the Overview) / NAMED ("Capacity and flows") /
    WIDGET / GRANT; ``params`` their bound values. ``dashboard_id`` /
    ``named_id`` are what the two dashboard inserts return (None = it exists).
    """
    log: list[str] = []
    params: dict[str, list[dict]] = {SEED: [], NAMED: [], WIDGET: [], GRANT: []}

    def rows(values):
        result = MagicMock()
        result.fetchall.return_value = [(v,) for v in values]
        return result

    async def execute(clause, *args, **kwargs):
        sql = str(clause)
        if sql == PROJECT_FIELDS_PROBE_SQL:
            log.append(FIELDS_PROBE)
            return rows(tp.PROJECT_FIELD_TABLES)
        if sql == RBAC_NEEDS_MIGRATION_SQL:
            log.append(RBAC_PROBE)
            result = MagicMock()
            result.scalar.return_value = False
            return result
        if sql == DASHBOARDS_PROBE_SQL:
            log.append(PROBE)
            return rows(tables)
        if sql == DASHBOARD_SHARING_PROBE_SQL:
            log.append(SHARING_PROBE)
            return rows(DASHBOARD_SHARING_TABLES)
        if sql == DASHBOARD_VISIBILITY_CHECK_SQL:
            log.append(VISIBILITY)
            return MagicMock()
        if sql == DASHBOARD_WIDGET_KIND_CHECK_SQL:
            log.append(KINDS)
            return MagicMock()
        if sql == NOTIFICATIONS_TYPE_CHECK_SQL:
            log.append(WIDEN)
            return MagicMock()
        seeds = {
            DASHBOARD_SEED_SQL: SEED,
            DASHBOARD_NAMED_SEED_SQL: NAMED,
            DASHBOARD_WIDGET_SEED_SQL: WIDGET,
            DASHBOARD_PERMISSION_BACKFILL_SQL: GRANT,
        }
        if sql in seeds:
            label = seeds[sql]
            log.append(label)
            params[label].append(clause.compile().params)
            if label == fail_on:
                raise RuntimeError("seed failed")
            result = MagicMock()
            result.scalar.return_value = named_id if label == NAMED else dashboard_id
            return result
        if sql in DASHBOARDS_SCHEMA_STATEMENTS:
            log.append(sql)
            if sql == fail_on:
                raise RuntimeError("statement failed")
            return MagicMock()
        raise RuntimeError("another step")

    conn = MagicMock()
    conn.execute = AsyncMock(side_effect=execute)
    conn.commit = AsyncMock(side_effect=lambda: log.append("COMMIT"))
    conn.rollback = AsyncMock(side_effect=lambda: log.append("ROLLBACK"))
    conn.params = params
    return conn, log


async def _run_auto_migrations(conn) -> None:
    from app.services import tenant_manager

    with (
        patch.object(tenant_manager, "encrypt_tenant_sso_secret", AsyncMock()),
        patch("app.services.tenant_data_migrations.run_data_migrations", AsyncMock()),
    ):
        await tenant_manager.TenantConnectionManager()._run_auto_migrations(conn, "acme")


def _step(log: list[str]) -> list[str]:
    start = log.index(PROBE)
    for end in range(start, len(log)):
        if log[end] in ("COMMIT", "ROLLBACK"):
            return log[start : end + 1]
    return log[start:]


# The dashboard-sharing step on an up-to-date tenant: the probe and its
# commit, then the self-gated visibility block and its own commit, then the
# self-gated widget-kinds block and its own commit.
SHARING_STEP_UP_TO_DATE = [SHARING_PROBE, "COMMIT", VISIBILITY, "COMMIT", KINDS, "COMMIT"]
(_, BASE_WIDGETS), (_, CAPACITY_WIDGETS) = base_dashboard_rows()
FULL_STEP = [
    PROBE,
    *DASHBOARDS_SCHEMA_STATEMENTS,
    SEED,
    *[WIDGET] * len(BASE_WIDGETS),
    NAMED,
    *[WIDGET] * len(CAPACITY_WIDGETS),
    *[GRANT] * 3,
    "COMMIT",
]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tables", [(), DASHBOARD_TABLES[:-1], DASHBOARD_TABLES[1:]], ids=["2.0", "partial", "partial2"]
)
async def test_auto_migration_creates_the_schema_then_seeds(tables):
    conn, log = _conn(tables=tables)

    await _run_auto_migrations(conn)

    # Schema (the one-default index before the seed), the Overview with its
    # eight widgets, "Capacity and flows" with its three, the three grants,
    # one commit.
    assert (len(BASE_WIDGETS), len(CAPACITY_WIDGETS)) == (8, 3)
    assert _step(log) == FULL_STEP
    # After the project-fields and RBAC steps (dashboard_roles references
    # roles), before the sharing step and the notification-types step.
    assert log.index(FIELDS_PROBE) < log.index(RBAC_PROBE) < log.index(PROBE)
    assert log.index(PROBE) < log.index(SHARING_PROBE) < log.index(WIDEN)


@pytest.mark.asyncio
async def test_auto_migration_seed_binds_the_base_dashboards():
    conn, _ = _conn()

    before = utcnow_naive()
    await _run_auto_migrations(conn)

    (overview_rows, _), (capacity_rows, _) = base_dashboard_rows()
    (dashboard,) = conn.params[SEED]
    assert {k: dashboard[k] for k in overview_rows} == overview_rows
    assert dashboard["created_at"] == dashboard["updated_at"]
    assert dashboard["created_at"].tzinfo is None and dashboard["created_at"] >= before
    # "Capacity and flows" keyed by its name (bound twice, as two parameters).
    (named,) = conn.params[NAMED]
    assert {k: named[k] for k in capacity_rows} == capacity_rows
    assert named["existing_name"] == "Capacity and flows"
    assert named["created_at"] == dashboard["created_at"]
    # Every widget of both, on their new ids, JSON as text binds.
    assert conn.params[WIDGET] == [
        *({"dashboard_id": NEW_ID, **w} for w in BASE_WIDGETS),
        *({"dashboard_id": NAMED_ID, **w} for w in CAPACITY_WIDGETS),
    ]
    # The one-shot grants: superuser + user see dashboards, superuser manages.
    assert [(g["role"], g["permission"]) for g in conn.params[GRANT]] == [
        ("superuser", "views.dashboards"),
        ("user", "views.dashboards"),
        ("superuser", "dashboards.manage"),
    ]
    assert all(g["existing_permission"] == g["permission"] for g in conn.params[GRANT])


@pytest.mark.asyncio
async def test_auto_migration_writes_no_widget_when_a_default_exists():
    """ON CONFLICT ... DO NOTHING returned no id: a concurrent creation won.
    "Capacity and flows" is still seeded."""
    conn, log = _conn(dashboard_id=None)

    await _run_auto_migrations(conn)

    assert _step(log) == [
        PROBE,
        *DASHBOARDS_SCHEMA_STATEMENTS,
        SEED,
        NAMED,
        *[WIDGET] * len(CAPACITY_WIDGETS),
        *[GRANT] * 3,
        "COMMIT",
    ]
    assert {w["dashboard_id"] for w in conn.params[WIDGET]} == {NAMED_ID}


@pytest.mark.asyncio
async def test_auto_migration_writes_no_widget_of_an_existing_named_dashboard():
    """WHERE NOT EXISTS returned no id: a dashboard of that name exists."""
    conn, log = _conn(named_id=None)

    await _run_auto_migrations(conn)

    assert _step(log) == [
        PROBE,
        *DASHBOARDS_SCHEMA_STATEMENTS,
        SEED,
        *[WIDGET] * len(BASE_WIDGETS),
        NAMED,
        *[GRANT] * 3,
        "COMMIT",
    ]
    assert {w["dashboard_id"] for w in conn.params[WIDGET]} == {NEW_ID}


@pytest.mark.asyncio
async def test_auto_migration_skips_an_up_to_date_tenant():
    conn, log = _conn(tables=DASHBOARD_TABLES)

    await _run_auto_migrations(conn)

    # Nothing between the probe and the next step: no schema, no seed, no
    # grant (an admin's later removal of the Overview or a key stays).
    assert log[log.index(PROBE) :] == [
        PROBE,
        *SHARING_STEP_UP_TO_DATE,
        WIDEN,
        "COMMIT",
    ]
    assert not any(s in DASHBOARDS_SCHEMA_STATEMENTS for s in log)
    assert conn.params == {SEED: [], NAMED: [], WIDGET: [], GRANT: []}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failing", "ran"),
    [
        (DASHBOARD_WIDGETS_TABLE_SQL, [*DASHBOARDS_SCHEMA_STATEMENTS[:3]]),
        (SEED, [*DASHBOARDS_SCHEMA_STATEMENTS, SEED]),
        (NAMED, [*DASHBOARDS_SCHEMA_STATEMENTS, SEED, *[WIDGET] * 8, NAMED]),
        (
            GRANT,
            [*DASHBOARDS_SCHEMA_STATEMENTS, SEED, *[WIDGET] * 8, NAMED, *[WIDGET] * 3, GRANT],
        ),
    ],
    ids=["schema", "seed", "named", "grant"],
)
async def test_auto_migration_failure_rolls_back_and_never_raises(failing, ran):
    conn, log = _conn(fail_on=failing)

    await _run_auto_migrations(conn)  # never raises

    assert _step(log) == [PROBE, *ran, "ROLLBACK"]
    # The later steps still ran.
    tail = [*SHARING_STEP_UP_TO_DATE, WIDEN, "COMMIT"]
    assert log[-len(tail) :] == tail


def test_seed_sql_binds_every_column():
    assert text(DASHBOARD_SEED_SQL).compile().params.keys() == {
        "name",
        "description",
        "visibility",
        "is_default",
        "created_at",
        "updated_at",
    }
    assert DASHBOARD_SEED_SQL.endswith(
        "ON CONFLICT (is_default) WHERE is_default DO NOTHING RETURNING id"
    )
    assert set(text(DASHBOARD_NAMED_SEED_SQL).compile().params) == {
        "name",
        "description",
        "visibility",
        "is_default",
        "created_at",
        "updated_at",
        "existing_name",
    }
    assert DASHBOARD_NAMED_SEED_SQL.startswith("INSERT INTO dashboards (")
    assert DASHBOARD_NAMED_SEED_SQL.endswith(
        " WHERE NOT EXISTS (SELECT 1 FROM dashboards WHERE name = :existing_name) RETURNING id"
    )
    assert set(text(DASHBOARD_WIDGET_SEED_SQL).compile().params) == {
        "dashboard_id",
        *WIDGET_KEYS,
    }
    assert set(text(DASHBOARD_PERMISSION_BACKFILL_SQL).compile().params) == {
        "permission",
        "role",
        "existing_permission",
    }


def test_asyncpg_seed_sql_uses_each_placeholder_once():
    for sql, count in (
        (DASHBOARD_SEED_PG_SQL, 6),
        (DASHBOARD_NAMED_SEED_PG_SQL, 7),
        (DASHBOARD_WIDGET_SEED_PG_SQL, 7),
        (DASHBOARD_PERMISSION_BACKFILL_PG_SQL, 3),
    ):
        used = re.findall(r"\$(\d+)", sql)
        assert sorted(used, key=int) == [str(i) for i in range(1, count + 1)], sql
        assert ":" not in sql.replace("::", ""), sql
    assert DASHBOARD_SEED_PG_SQL.endswith(
        "ON CONFLICT (is_default) WHERE is_default DO NOTHING RETURNING id"
    )
    assert DASHBOARD_NAMED_SEED_PG_SQL.endswith(
        " WHERE NOT EXISTS (SELECT 1 FROM dashboards WHERE name = $7) RETURNING id"
    )


def test_each_base_dashboard_picks_its_insert():
    """The Overview goes through the one-default index, any other by name."""
    (overview, _), (capacity, _) = dashboard_seed_params()
    assert dashboard_seed_statement(overview) == (DASHBOARD_SEED_SQL, overview)
    assert dashboard_seed_statement(capacity) == (
        DASHBOARD_NAMED_SEED_SQL,
        {**capacity, "existing_name": "Capacity and flows"},
    )
    sql, args = dashboard_seed_pg_statement(overview)
    assert (sql, len(args), args[0]) == (DASHBOARD_SEED_PG_SQL, 6, "Overview")
    sql, args = dashboard_seed_pg_statement(capacity)
    assert sql == DASHBOARD_NAMED_SEED_PG_SQL
    assert args == [*(capacity[c] for c in tp.DASHBOARD_SEED_COLUMNS), "Capacity and flows"]


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


def _fk(column):
    (fk,) = column.foreign_keys
    return fk


def test_models_live_on_the_tenant_base():
    for table in DASHBOARD_TABLES:
        assert table in Base.metadata.tables, table
        assert MODELS[table].__tablename__ == table


@pytest.mark.parametrize("table", DASHBOARD_TABLES)
def test_model_columns_match_the_ddl(table):
    model_table = MODELS[table].__table__
    ddl = _ddl_columns(TABLE_SQL[table])
    assert [c.name for c in model_table.columns] == list(ddl)
    for column in model_table.columns:
        definition = ddl[column.name]
        if column.primary_key and table != "dashboard_roles":
            continue
        assert column.nullable == ("NOT NULL" not in definition and not column.primary_key), (
            table,
            column.name,
        )
        length = re.search(r"VARCHAR\((\d+)\)", definition)
        if length:
            assert column.type.length == int(length.group(1)), (table, column.name)


def test_dashboard_model_matches_the_ddl():
    table = Dashboard.__table__
    assert _fk(table.c.owner_id).ondelete == "SET NULL"
    assert _fk(table.c.owner_id).target_fullname == "users.id"
    checks = {c.name: str(c.sqltext) for c in table.constraints if c.name}
    assert checks["dashboards_visibility_check"] == (
        "visibility IN ('private', 'shared', 'everyone')"
    )
    (index,) = table.indexes
    assert index.name == "dashboards_one_default"
    assert index.unique is True
    assert [c.name for c in index.columns] == ["is_default"]
    # Both dialects: PostgreSQL in production, SQLite in the SQLite-backed tests.
    assert str(index.dialect_options["postgresql"]["where"]) == "is_default"
    assert str(index.dialect_options["sqlite"]["where"]) == "is_default"
    for rel in (
        Dashboard.widgets,
        Dashboard.roles,
        Dashboard.sites,
        Dashboard.teams,
        Dashboard.users,
    ):
        assert rel.property.lazy == "selectin"
        assert rel.property.passive_deletes is True
        assert "delete-orphan" in rel.property.cascade
    assert [str(c) for c in Dashboard.widgets.property.order_by] == [
        "dashboard_widgets.sort_order",
        "dashboard_widgets.id",
    ]


def test_role_link_model_cascades():
    table = DashboardRole.__table__
    assert [c.name for c in table.primary_key.columns] == ["dashboard_id", "role_id"]
    assert _fk(table.c.dashboard_id).ondelete == "CASCADE"
    assert _fk(table.c.dashboard_id).target_fullname == "dashboards.id"
    assert _fk(table.c.role_id).ondelete == "CASCADE"
    assert _fk(table.c.role_id).target_fullname == "roles.id"
    assert {i.name for i in table.indexes} == {"idx_dashboard_roles_role"}


def test_widget_model_matches_the_ddl():
    table = DashboardWidget.__table__
    assert _fk(table.c.dashboard_id).ondelete == "CASCADE"
    assert _fk(table.c.dashboard_id).target_fullname == "dashboards.id"
    checks = {c.name: str(c.sqltext) for c in table.constraints if c.name}
    assert checks["dashboard_widgets_kind_check"] == (
        "kind IN ('kpi', 'bar', 'line', 'pie', 'table', 'gauge', 'heatmap', 'treemap', 'sankey')"
    )
    assert {i.name for i in table.indexes} == {"idx_dashboard_widgets_dashboard"}
    assert table.c.options.server_default.arg == "{}"


def test_transient_objects():
    dashboard = Dashboard(name="Overview", visibility="everyone")
    assert dashboard.widgets == [] and dashboard.roles == [] and dashboard.role_ids == []
    dashboard.roles = [DashboardRole(role_id=3), DashboardRole(role_id=1)]
    assert dashboard.role_ids == [1, 3]
    assert repr(dashboard) == "<Dashboard Overview (everyone)>"
    assert repr(DashboardRole(dashboard_id=2, role_id=5)) == "<DashboardRole dashboard=2 role=5>"
    assert repr(DashboardWidget(title="People booked", kind="kpi")) == (
        "<DashboardWidget People booked (kpi)>"
    )


def test_models_package_exports_the_dashboard_models():
    import app.models as models

    for name in ("Dashboard", "DashboardRole", "DashboardWidget"):
        assert name in models.__all__
        assert getattr(models, name).__module__ == "app.models.dashboard"


# ---------------------------------------------------------------------------
# The ORM on SQLite: one default, cascades
# ---------------------------------------------------------------------------


@pytest.fixture
def sqlite_session():
    engine = create_engine("sqlite://")

    @event.listens_for(engine, "connect")
    def _foreign_keys(dbapi_connection, _record):
        dbapi_connection.execute("PRAGMA foreign_keys=ON")

    # Every tenant table is copied so the foreign keys resolve; the roles key
    # CHECK (PostgreSQL regex syntax SQLite lacks) is left out, the dashboard
    # CHECKs are kept.
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
                "role_permissions",
                "users",
                "sites",
                "teams",
                *DASHBOARD_TABLES,
                *DASHBOARD_SHARING_TABLES,
            )
        ],
    )
    with Session(engine) as session:
        session.add_all(
            [
                Role(id=1, key="user", name="User"),
                Role(id=2, key="lead", name="Lead"),
                User(id=7, email="o@x", password="x", first_name="O", last_name="W"),
            ]
        )
        session.commit()
        yield session
    engine.dispose()


def test_the_checks_hold_on_sqlite(sqlite_session):
    sqlite_session.add(Dashboard(name="Bad", visibility="public"))
    with pytest.raises(IntegrityError):
        sqlite_session.commit()
    sqlite_session.rollback()
    dashboard = Dashboard(name="Ok", visibility="private")
    dashboard.widgets = [DashboardWidget(kind="radar", title="X", query="{}", layout="{}")]
    sqlite_session.add(dashboard)
    with pytest.raises(IntegrityError):
        sqlite_session.commit()
    sqlite_session.rollback()
    # Every kind of the tuple passes, the four 2.1.0 chart kinds included.
    dashboard = Dashboard(name="Every kind", visibility="private")
    dashboard.widgets = [
        DashboardWidget(kind=kind, title=kind, query="{}", layout="{}", sort_order=i)
        for i, kind in enumerate(DASHBOARD_WIDGET_KINDS)
    ]
    sqlite_session.add(dashboard)
    sqlite_session.commit()


def test_only_one_default_dashboard(sqlite_session):
    sqlite_session.add_all(
        [
            Dashboard(name="Overview", visibility="everyone", is_default=True),
            Dashboard(name="Mine", visibility="private", owner_id=7),
            Dashboard(name="Also mine", visibility="private", owner_id=7),
        ]
    )
    sqlite_session.commit()
    sqlite_session.add(Dashboard(name="Second default", visibility="everyone", is_default=True))
    with pytest.raises(IntegrityError):
        sqlite_session.commit()


def test_widgets_and_role_links_go_with_their_dashboard_and_role(sqlite_session):
    dashboard = Dashboard(name="Team", visibility="shared", owner_id=7)
    dashboard.roles = [DashboardRole(role_id=1), DashboardRole(role_id=2)]
    dashboard.widgets = [
        DashboardWidget(kind="bar", title="B", query="{}", layout="{}", sort_order=1),
        DashboardWidget(kind="kpi", title="A", query="{}", layout="{}", sort_order=0),
    ]
    sqlite_session.add(dashboard)
    sqlite_session.commit()
    sqlite_session.expire_all()

    loaded = sqlite_session.get(Dashboard, dashboard.id)
    assert [w.title for w in loaded.widgets] == ["A", "B"]  # sort_order, id
    assert loaded.widgets[0].options == "{}"
    assert loaded.role_ids == [1, 2]

    # A role delete drops its links only.
    sqlite_session.execute(text("DELETE FROM roles WHERE id = 2"))
    sqlite_session.commit()
    assert sqlite_session.execute(text("SELECT role_id FROM dashboard_roles")).all() == [(1,)]

    # The owner's delete keeps the dashboard (owner_id SET NULL).
    sqlite_session.execute(text("DELETE FROM users WHERE id = 7"))
    sqlite_session.commit()
    assert sqlite_session.execute(text("SELECT owner_id FROM dashboards")).all() == [(None,)]

    # The dashboard's delete takes its widgets and role links along.
    sqlite_session.execute(text("DELETE FROM dashboards"))
    sqlite_session.commit()
    for table in ("dashboard_widgets", "dashboard_roles"):
        assert sqlite_session.execute(text(f"SELECT count(*) FROM {table}")).scalar() == 0


def test_the_seed_sql_runs_once_on_sqlite(sqlite_session):
    """The auto-migration's SQLAlchemy seed texts, executed for real: the
    first inserts return the new ids, a second run hits dashboards_one_default
    and the name guard and returns nothing."""

    def seed() -> list[int | None]:
        ids = []
        for dashboard, widgets in dashboard_seed_params():
            sql, binds = dashboard_seed_statement(dashboard)
            dashboard_id = sqlite_session.execute(text(sql).bindparams(**binds)).scalar()
            if dashboard_id is not None:
                for widget in widgets:
                    sqlite_session.execute(
                        text(DASHBOARD_WIDGET_SEED_SQL).bindparams(
                            dashboard_id=dashboard_id, **widget
                        )
                    )
            ids.append(dashboard_id)
        sqlite_session.commit()
        return ids

    overview_id, capacity_id = seed()
    assert None not in (overview_id, capacity_id) and overview_id != capacity_id
    assert seed() == [None, None]
    assert sqlite_session.execute(text("SELECT count(*) FROM dashboards")).scalar() == 2
    assert sqlite_session.execute(text("SELECT count(*) FROM dashboard_widgets")).scalar() == 11

    (_, overview_widgets), (_, capacity_widgets) = dashboard_seed_params()
    loaded = sqlite_session.get(Dashboard, overview_id)
    assert (loaded.name, loaded.visibility, loaded.is_default, loaded.owner_id) == (
        "Overview",
        "everyone",
        True,
        None,
    )
    assert [w.title for w in loaded.widgets] == [w["title"] for w in overview_widgets]
    assert json.loads(loaded.widgets[1].options) == {"kpi_bucket": True}
    loaded = sqlite_session.get(Dashboard, capacity_id)
    assert (loaded.name, loaded.visibility, loaded.is_default, loaded.owner_id) == (
        "Capacity and flows",
        "everyone",
        False,
        None,
    )
    assert [w.kind for w in loaded.widgets] == ["heatmap", "treemap", "sankey"]
    assert [w.title for w in loaded.widgets] == [w["title"] for w in capacity_widgets]


def test_the_named_seed_skips_an_existing_name(sqlite_session):
    """The name guard looks at the name only: any dashboard already called
    "Capacity and flows" (say, built by hand) stops the seed."""
    (_, _), (capacity, _) = dashboard_seed_params()
    sql, binds = dashboard_seed_statement(capacity)
    sqlite_session.add(Dashboard(name="Capacity and flows", visibility="private"))
    sqlite_session.commit()
    assert sqlite_session.execute(text(sql).bindparams(**binds)).scalar() is None
    assert sqlite_session.execute(text("SELECT count(*) FROM dashboards")).scalar() == 1


def test_the_backfill_sql_grants_only_what_is_missing_on_sqlite(sqlite_session):
    sqlite_session.add(Role(id=3, key="superuser", name="Superuser"))
    # The user role already holds views.dashboards (say, in approval mode by a
    # hand edit): left alone. No admin row: nothing for admin.
    sqlite_session.execute(
        text(
            "INSERT INTO role_permissions (role_id, permission, mode) "
            "VALUES (1, 'views.dashboards', 'approval')"
        )
    )
    sqlite_session.commit()

    def grant():
        for role, permission in DASHBOARD_PERMISSION_BACKFILL:
            sqlite_session.execute(
                text(DASHBOARD_PERMISSION_BACKFILL_SQL).bindparams(
                    permission=permission, role=role, existing_permission=permission
                )
            )
        sqlite_session.commit()

    grant()
    grant()  # idempotent

    rows = sqlite_session.execute(
        text("SELECT role_id, permission, mode FROM role_permissions ORDER BY role_id, permission")
    ).all()
    assert rows == [
        (1, "views.dashboards", "approval"),
        (3, "dashboards.manage", "allow"),
        (3, "views.dashboards", "allow"),
    ]
