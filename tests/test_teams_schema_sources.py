"""
Teams schema (1.12.0) stays identical in every DDL source.

The canonical statements live once in tenant_provisioner (TEAMS_SCHEMA_STATEMENTS);
get_tenant_schema_sql(), setup_databases.sql, migrations/add_teams.sql and the
manual-setup template carry the same text, the tenant auto-migration executes
the constants, and the ORM declares the same delete rules. Repo-root files are
skipped when the test tree is run outside the repository.
"""

import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.equipment import Equipment
from app.models.project import Project
from app.models.site import CompanyEvent
from app.models.tag import Tag
from app.models.team import (
    CompanyEventTeam,
    EquipmentTeam,
    ProjectTeam,
    TagTeam,
    Team,
    TeamMember,
)
from app.models.user import User
from app.services.tenant_provisioner import (
    COMPANY_EVENT_TEAMS_TABLE_SQL,
    EQUIPMENT_TEAMS_TABLE_SQL,
    NOTIFICATIONS_TYPE_CHECK_SQL,
    PROJECT_TEAMS_TABLE_SQL,
    RBAC_NEEDS_MIGRATION_SQL,
    TAG_TEAMS_TABLE_SQL,
    TEAM_MEMBERS_TABLE_SQL,
    TEAM_TABLES,
    TEAMS_INDEX_STATEMENTS,
    TEAMS_SCHEMA_SQL,
    TEAMS_SCHEMA_STATEMENTS,
    TEAMS_TABLE_SQL,
    get_tenant_schema_sql,
)
from migrations.run_migration_master import split_sql_statements

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "add_teams.sql"
IN_REPO = (ROOT / "setup_databases.sql").exists() and (ROOT / "Dockerfile").exists()

TABLE_SQL = {
    "teams": TEAMS_TABLE_SQL,
    "team_members": TEAM_MEMBERS_TABLE_SQL,
    "project_teams": PROJECT_TEAMS_TABLE_SQL,
    "tag_teams": TAG_TEAMS_TABLE_SQL,
    "company_event_teams": COMPANY_EVENT_TEAMS_TABLE_SQL,
    "equipment_teams": EQUIPMENT_TEAMS_TABLE_SQL,
}
INDEX_NAMES = (
    "idx_teams_site",
    "idx_team_members_user",
    "idx_project_teams_team",
    "idx_tag_teams_team",
    "idx_company_event_teams_team",
    "idx_equipment_teams_team",
)
# Every table the teams DDL references, plus the junctions it sits next to.
PARENT_TABLES = (
    "sites",
    "users",
    "projects",
    "tags",
    "equipment",
    "company_events",
    "project_tags",
    "company_event_sites",
)


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


def _root_file(relative: str) -> str:
    if not IN_REPO:
        pytest.skip("repo-root files are not part of this checkout")
    return (ROOT / relative).read_text()


def _sources() -> dict[str, str]:
    """The idempotent sources: CREATE ... IF NOT EXISTS, same text as the constants."""
    return {
        "provisioner": get_tenant_schema_sql(),
        "setup_databases.sql": _root_file("setup_databases.sql"),
        "add_teams.sql": MIGRATION.read_text(),
    }


def _template() -> str:
    return _root_file("scripts/sql/tenant_schema_template.sql")


def _as_template(statement: str) -> str:
    """The template creates a fresh database: no IF NOT EXISTS."""
    return _norm(statement).replace(" IF NOT EXISTS", "")


# ---------------------------------------------------------------------------
# The constants
# ---------------------------------------------------------------------------


def test_team_tables_lists_the_six_tables_in_creation_order():
    assert TEAM_TABLES == (
        "teams",
        "team_members",
        "project_teams",
        "tag_teams",
        "company_event_teams",
        "equipment_teams",
    )


def test_schema_statements_are_the_tables_then_the_indexes():
    assert TEAMS_SCHEMA_STATEMENTS == (*TABLE_SQL.values(), *TEAMS_INDEX_STATEMENTS)
    assert len(TEAMS_INDEX_STATEMENTS) == 6
    for table, sql in TABLE_SQL.items():
        assert _norm(sql).startswith(f"CREATE TABLE IF NOT EXISTS {table} (")
    for name, sql in zip(INDEX_NAMES, TEAMS_INDEX_STATEMENTS, strict=True):
        assert _norm(sql).startswith(f"CREATE INDEX IF NOT EXISTS {name} ON ")
    # One statement per entry: asyncpg executes a single statement per call.
    for statement in TEAMS_SCHEMA_STATEMENTS:
        assert ";" not in statement, statement
    assert TEAMS_SCHEMA_SQL == ";\n".join(TEAMS_SCHEMA_STATEMENTS) + ";"


@pytest.mark.parametrize("table", list(TABLE_SQL))
def test_every_foreign_key_cascades(table):
    references = [ln for ln in TABLE_SQL[table].splitlines() if "REFERENCES" in ln]
    assert references, table
    for line in references:
        assert "ON DELETE CASCADE" in line, line


def test_team_names_are_unique_per_site():
    assert "CONSTRAINT teams_site_name_unique UNIQUE (site_id, name)" in _norm(TEAMS_TABLE_SQL)


# ---------------------------------------------------------------------------
# Every DDL source carries the same statements
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("table", TEAM_TABLES)
def test_every_source_creates_the_table(table):
    for name, sql in _sources().items():
        assert f"CREATE TABLE IF NOT EXISTS {table} (" in sql, (name, table)
    assert f"CREATE TABLE {table} (" in _template(), table


@pytest.mark.parametrize("statement", TEAMS_SCHEMA_STATEMENTS, ids=[*TABLE_SQL, *INDEX_NAMES])
def test_every_source_carries_the_canonical_statement(statement):
    for name, sql in _sources().items():
        assert _norm(statement) in _norm(sql), name
    assert _as_template(statement) in _norm(_template())


def test_every_source_names_the_constraint_and_the_indexes():
    sources = {**_sources(), "template": _template()}
    for name, sql in sources.items():
        assert "teams_site_name_unique" in sql, name
        for index in INDEX_NAMES:
            assert index in sql, (name, index)


def test_teams_tables_come_after_their_parents():
    sources = {**_sources(), "template": _template()}
    del sources["add_teams.sql"]  # creates the teams tables only
    for name, sql in sources.items():
        normalized = _norm(sql).replace(" IF NOT EXISTS", "")
        teams = normalized.index("CREATE TABLE teams (")
        for parent in PARENT_TABLES:
            assert normalized.index(f"CREATE TABLE {parent} (") < teams, (name, parent)
        # Indexes follow the tables they index.
        last_table = normalized.index("CREATE TABLE equipment_teams (")
        for index in INDEX_NAMES:
            assert normalized.index(f"CREATE INDEX {index} ") > last_table, (name, index)


def test_provisioner_schema_dollar_quoting_still_balanced():
    sql = get_tenant_schema_sql()
    assert sql.count("DO $$") == sql.count("END $$;")


# ---------------------------------------------------------------------------
# migrations/add_teams.sql
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def migration_statements() -> list[str]:
    return split_sql_statements(MIGRATION.read_text())


def test_migration_documents_how_to_run_it():
    sql = MIGRATION.read_text()
    assert "python migrations/run_migration.py add_teams" in sql
    assert "psql" in sql


def test_migration_splits_into_whole_statements(migration_statements):
    do_blocks = [s for s in migration_statements if s.lstrip().startswith("DO $$")]
    assert len(do_blocks) == 2  # grants, completion notice
    assert all(s.rstrip().endswith("END $$;") for s in do_blocks)
    for statement in migration_statements:
        if statement not in do_blocks:
            assert "$$" not in statement
    plain = [_norm(s).rstrip(";").strip() for s in migration_statements if s not in do_blocks]
    assert plain == [_norm(s) for s in TEAMS_SCHEMA_STATEMENTS]


def test_migration_grants_every_table_and_the_sequence(migration_statements):
    (grants,) = (s for s in migration_statements if "GRANT" in s)
    for table in TEAM_TABLES:
        assert f"GRANT ALL PRIVILEGES ON TABLE {table} TO %I" in grants, table
    assert "GRANT USAGE, SELECT ON SEQUENCE teams_id_seq TO %I" in grants


def test_migration_is_documented():
    readme = _root_file("migrations/README.md")
    assert "add_teams" in readme
    assert "add_teams" in _root_file("docs/admin-guide/database.md")
    assert "add_teams" in _root_file("CLAUDE.md")


# ---------------------------------------------------------------------------
# Tenant auto-migration
# ---------------------------------------------------------------------------


def test_tenant_auto_migration_executes_the_constants():
    from app.services import tenant_manager

    source = Path(tenant_manager.__file__).read_text()
    assert "TEAMS_SCHEMA_STATEMENTS" in source
    assert "TEAM_TABLES" in source
    assert tenant_manager.TEAMS_SCHEMA_STATEMENTS is TEAMS_SCHEMA_STATEMENTS
    assert tenant_manager.TEAM_TABLES is TEAM_TABLES


TEAMS_CHECK = "CHECK team tables"
WIDEN = "widen notification types"


def _teams_conn(tables=(), fail_on: str | None = None):
    """
    A connection on which only the teams step's own SQL succeeds; every other
    auto-migration step fails (and is contained by its own try/except). ``log``
    records the teams step's statements interleaved with COMMIT / ROLLBACK.
    """
    log: list[str] = []

    async def execute(clause, *args, **kwargs):
        sql = str(clause)
        if "'teams', 'team_members'" in sql:
            log.append(TEAMS_CHECK)
            result = MagicMock()
            result.fetchall.return_value = [(t,) for t in tables]
            return result
        if sql == RBAC_NEEDS_MIGRATION_SQL:  # the later RBAC step: nothing to do
            result = MagicMock()
            result.scalar.return_value = False
            return result
        if sql == NOTIFICATIONS_TYPE_CHECK_SQL:  # the later step that always runs
            log.append(WIDEN)
            return MagicMock()
        if sql in TEAMS_SCHEMA_STATEMENTS:
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


def _teams_step(log: list[str]) -> list[str]:
    start = log.index(TEAMS_CHECK)
    for end in range(start, len(log)):
        if log[end] in ("COMMIT", "ROLLBACK"):
            return log[start : end + 1]
    return log[start:]


@pytest.mark.asyncio
@pytest.mark.parametrize("tables", [(), TEAM_TABLES[:-1]], ids=["legacy", "partial"])
async def test_auto_migration_creates_the_teams_schema_in_order(tables):
    conn, log = _teams_conn(tables=tables)

    await _run_auto_migrations(conn)

    assert _teams_step(log) == [TEAMS_CHECK, *TEAMS_SCHEMA_STATEMENTS, "COMMIT"]


@pytest.mark.asyncio
async def test_auto_migration_skips_an_up_to_date_tenant():
    conn, log = _teams_conn(tables=TEAM_TABLES)

    await _run_auto_migrations(conn)

    # Nothing between the probe and the notification-types step's commit.
    assert log[log.index(TEAMS_CHECK) :] == [TEAMS_CHECK, WIDEN, "COMMIT"]
    assert not any(s in TEAMS_SCHEMA_STATEMENTS for s in log)


@pytest.mark.asyncio
async def test_auto_migration_failure_rolls_back_and_never_raises():
    conn, log = _teams_conn(fail_on=PROJECT_TEAMS_TABLE_SQL)

    await _run_auto_migrations(conn)  # never raises

    assert _teams_step(log) == [
        TEAMS_CHECK,
        TEAMS_TABLE_SQL,
        TEAM_MEMBERS_TABLE_SQL,
        PROJECT_TEAMS_TABLE_SQL,
        "ROLLBACK",
    ]


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


def _fk(column):
    (fk,) = column.foreign_keys
    return fk


JUNCTIONS = [
    (TeamMember, "team_members", ("team_id", "user_id")),
    (ProjectTeam, "project_teams", ("project_id", "team_id")),
    (TagTeam, "tag_teams", ("tag_id", "team_id")),
    (CompanyEventTeam, "company_event_teams", ("event_id", "team_id")),
    (EquipmentTeam, "equipment_teams", ("equipment_id", "team_id")),
]


def test_team_model_matches_the_ddl():
    table = Team.__table__
    assert table.name == "teams"
    assert _fk(table.c.site_id).ondelete == "CASCADE"
    assert _fk(table.c.site_id).target_fullname == "sites.id"
    assert table.c.site_id.nullable is False
    assert table.c.name.type.length == 100
    assert table.c.color.type.length == 7
    assert table.c.description.nullable is True
    assert table.c.active.nullable is False
    constraints = {c.name for c in table.constraints}
    assert "teams_site_name_unique" in constraints
    assert {i.name for i in table.indexes} == {"idx_teams_site"}


@pytest.mark.parametrize(("model", "table", "columns"), JUNCTIONS)
def test_junction_models_cascade(model, table, columns):
    assert model.__table__.name == table
    assert [c.name for c in model.__table__.primary_key.columns] == list(columns)
    for column in columns:
        assert _fk(model.__table__.c[column]).ondelete == "CASCADE", (table, column)
    expected_index = "idx_team_members_user" if table == "team_members" else f"idx_{table}_team"
    assert {i.name for i in model.__table__.indexes} == {expected_index}


def test_team_members_relationship_is_not_eager():
    assert Team.members.property.lazy == "select"
    assert Team.members.property.back_populates == "teams"
    assert User.teams.property.back_populates == "members"


@pytest.mark.parametrize("model", [User, Project, Tag, Equipment, CompanyEvent])
def test_teams_relationship_is_preloaded(model):
    prop = model.teams.property
    assert prop.lazy == "selectin"
    assert prop.passive_deletes is True


def test_transient_objects_have_no_teams():
    team = Team(site_id=1, name="Analytics")
    assert team.member_ids == []
    assert Team(site_id=1, name="On", active=True).is_active is True
    assert Team(site_id=1, name="Old", active=False).is_active is False
    assert Project().team_ids == []
    assert Tag(name="x").team_ids == []
    assert Equipment(name="x").team_ids == []
    assert CompanyEvent(name="x").team_ids == []
    assert User(email="a@b.c").team_ids == []


def test_team_ids_are_sorted():
    teams = [Team(id=3, site_id=1, name="c"), Team(id=1, site_id=1, name="a")]
    project = Project()
    project.teams = teams
    assert project.team_ids == [1, 3]
    team = Team(site_id=1, name="t")
    team.members = [User(id=9), User(id=2)]
    assert team.member_ids == [2, 9]


def test_models_package_exports_the_team_models():
    import app.models as models

    for name in (
        "Team",
        "TeamMember",
        "ProjectTeam",
        "TagTeam",
        "CompanyEventTeam",
        "EquipmentTeam",
    ):
        assert name in models.__all__
        assert getattr(models, name).__module__ == "app.models.team"
