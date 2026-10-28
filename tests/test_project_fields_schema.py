"""
Project fields schema (2.0.0) stays identical in every DDL source.

The canonical statements live once in tenant_provisioner
(PROJECT_FIELDS_SCHEMA_STATEMENTS, PROJECT_FIELDS_MIGRATION_SQL);
get_tenant_schema_sql(), setup_databases.sql, migrations/add_project_fields.sql
and the manual-setup template carry the same table text after the teams
tables, no fresh source creates tag_groups or tags.group_id any more, the
tenant auto-migration executes the constants (schema, then the tag-group
conversion) after the teams step, and the ORM declares the same delete rules.
Repo-root files are skipped when the test tree is run outside the repository.
"""

import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import text

from app.database import Base
from app.models.project import Project
from app.models.project_field import (
    DROPDOWN_FIELD_TYPES,
    PROJECT_FIELD_TYPES,
    ProjectField,
    ProjectFieldOption,
    ProjectFieldOptionSite,
    ProjectFieldOptionTeam,
    ProjectFieldSelection,
    ProjectFieldValue,
)
from app.services import tenant_provisioner as tp
from app.services.tenant_provisioner import (
    NOTIFICATIONS_TYPE_CHECK_SQL,
    PROJECT_FIELD_DECIMALS_SQL,
    PROJECT_FIELD_OPTION_SITES_TABLE_SQL,
    PROJECT_FIELD_OPTION_TEAMS_TABLE_SQL,
    PROJECT_FIELD_OPTIONS_TABLE_SQL,
    PROJECT_FIELD_SELECTIONS_TABLE_SQL,
    PROJECT_FIELD_TABLES,
    PROJECT_FIELD_VALUES_TABLE_SQL,
    PROJECT_FIELDS_INDEX_STATEMENTS,
    PROJECT_FIELDS_MIGRATION_SQL,
    PROJECT_FIELDS_PROBE_SQL,
    PROJECT_FIELDS_SCHEMA_SQL,
    PROJECT_FIELDS_SCHEMA_STATEMENTS,
    PROJECT_FIELDS_TABLE_SQL,
    RBAC_NEEDS_MIGRATION_SQL,
    TAGS_UPGRADE_SQL,
    TAGS_UPGRADE_STATEMENTS,
    TEAMS_SCHEMA_STATEMENTS,
    get_tenant_schema_sql,
)
from migrations.run_migration_master import split_sql_statements

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "add_project_fields.sql"
IN_REPO = (ROOT / "setup_databases.sql").exists() and (ROOT / "Dockerfile").exists()

TABLE_SQL = {
    "project_fields": PROJECT_FIELDS_TABLE_SQL,
    "project_field_options": PROJECT_FIELD_OPTIONS_TABLE_SQL,
    "project_field_option_sites": PROJECT_FIELD_OPTION_SITES_TABLE_SQL,
    "project_field_option_teams": PROJECT_FIELD_OPTION_TEAMS_TABLE_SQL,
    "project_field_values": PROJECT_FIELD_VALUES_TABLE_SQL,
    "project_field_selections": PROJECT_FIELD_SELECTIONS_TABLE_SQL,
}
INDEX_NAMES = (
    "idx_project_field_option_sites_site",
    "idx_project_field_option_teams_team",
    "idx_project_field_values_project",
    "idx_project_field_selections_option",
)
# Every table the project-fields DDL references: they must come first.
PARENT_TABLES = ("sites", "projects", "teams", "equipment_teams")


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


def _create_tables(sql: str) -> list[str]:
    """Every CREATE TABLE statement of ``sql``, normalised."""
    return re.findall(r"CREATE TABLE [^;]*?\);", _norm(sql))


# ---------------------------------------------------------------------------
# The constants
# ---------------------------------------------------------------------------


def test_project_field_tables_lists_the_six_tables_in_creation_order():
    assert PROJECT_FIELD_TABLES == tuple(TABLE_SQL)


def test_schema_statements_are_the_tables_then_the_indexes():
    assert PROJECT_FIELDS_SCHEMA_STATEMENTS == (
        *TABLE_SQL.values(),
        *PROJECT_FIELDS_INDEX_STATEMENTS,
    )
    for table, sql in TABLE_SQL.items():
        assert _norm(sql).startswith(f"CREATE TABLE IF NOT EXISTS {table} (")
    for name, sql in zip(INDEX_NAMES, PROJECT_FIELDS_INDEX_STATEMENTS, strict=True):
        assert _norm(sql).startswith(f"CREATE INDEX IF NOT EXISTS {name} ON ")
    # One statement per entry: asyncpg executes a single statement per call.
    for statement in PROJECT_FIELDS_SCHEMA_STATEMENTS:
        assert ";" not in statement, statement
    assert PROJECT_FIELDS_SCHEMA_SQL == ";\n".join(PROJECT_FIELDS_SCHEMA_STATEMENTS) + ";"


@pytest.mark.parametrize("table", list(TABLE_SQL)[1:])
def test_every_foreign_key_cascades(table):
    references = [ln for ln in TABLE_SQL[table].splitlines() if "REFERENCES" in ln]
    assert references, table
    for line in references:
        assert "ON DELETE CASCADE" in line, line


def test_the_type_check_and_unique_constraints():
    fields = _norm(PROJECT_FIELDS_TABLE_SQL)
    assert "name VARCHAR(100) NOT NULL UNIQUE" in fields
    assert "field_type VARCHAR(20) NOT NULL" in fields
    assert (
        "CONSTRAINT project_fields_type_check CHECK "
        "(field_type IN ('text', 'number', 'toggle', 'select', 'multiselect'))"
    ) in fields
    options = _norm(PROJECT_FIELD_OPTIONS_TABLE_SQL)
    assert "color VARCHAR(7) NOT NULL DEFAULT '#6366f1'" in options
    assert "all_sites BOOLEAN NOT NULL DEFAULT TRUE" in options
    assert "CONSTRAINT project_field_options_field_name_unique UNIQUE (field_id, name)" in options
    values = _norm(PROJECT_FIELD_VALUES_TABLE_SQL)
    assert "value_text TEXT, value_number DOUBLE PRECISION, value_bool BOOLEAN" in values
    assert (
        "CONSTRAINT project_field_values_field_project_unique UNIQUE (field_id, project_id)"
        in values
    )
    assert "PRIMARY KEY (project_id, option_id)" in _norm(PROJECT_FIELD_SELECTIONS_TABLE_SQL)


def test_the_field_types_match_the_check():
    assert PROJECT_FIELD_TYPES == ("text", "number", "toggle", "select", "multiselect")
    assert DROPDOWN_FIELD_TYPES == {"select", "multiselect"}
    for field_type in PROJECT_FIELD_TYPES:
        assert f"'{field_type}'" in PROJECT_FIELDS_TABLE_SQL


# ---------------------------------------------------------------------------
# Every DDL source carries the same statements, after the teams tables
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "statement", PROJECT_FIELDS_SCHEMA_STATEMENTS, ids=[*TABLE_SQL, *INDEX_NAMES]
)
def test_every_source_carries_the_canonical_statement(statement):
    sources = {**_fresh_sources(), "add_project_fields.sql": MIGRATION.read_text()}
    for name, sql in sources.items():
        assert _norm(statement) in _norm(sql), name
    assert _as_template(statement) in _norm(_template())


def test_project_field_tables_come_after_their_parents():
    sources = {**_fresh_sources(), "template": _template()}
    for name, sql in sources.items():
        normalized = _norm(sql).replace(" IF NOT EXISTS", "")
        first = normalized.index("CREATE TABLE project_fields (")
        for parent in PARENT_TABLES:
            assert normalized.index(f"CREATE TABLE {parent} (") < first, (name, parent)
        # Indexes follow the tables they index.
        last_table = normalized.index("CREATE TABLE project_field_selections (")
        for index in INDEX_NAMES:
            assert normalized.index(f"CREATE INDEX {index} ") > last_table, (name, index)


def test_no_fresh_source_creates_tag_groups_or_tags_group_id():
    sources = {**_fresh_sources(), "template": _template()}
    for name, sql in sources.items():
        for create in _create_tables(sql):
            assert "tag_groups" not in create, (name, create[:60])
            assert not re.search(r"\bgroup_id\b", create), (name, create[:60])
        assert "idx_tags_group" not in sql, name


def test_fresh_sources_do_not_carry_the_conversion():
    """The conversion only ever has something to do on an upgraded database."""
    for name, sql in {**_fresh_sources(), "template": _template()}.items():
        assert "DROP TABLE tag_groups" not in sql, name


def test_the_tags_group_id_upgrade_runs_only_while_tag_groups_exists():
    (block,) = (s for s in TAGS_UPGRADE_STATEMENTS if "ADD COLUMN group_id" in s)
    assert "to_regclass('public.tag_groups') IS NOT NULL" in block
    assert "information_schema.columns" in block
    assert block in TAGS_UPGRADE_SQL
    # The other columns are unconditional (no tag_groups reference).
    for statement in TAGS_UPGRADE_STATEMENTS:
        if statement is not block:
            assert "tag_groups" not in statement


def test_provisioner_schema_dollar_quoting_still_balanced():
    sql = get_tenant_schema_sql()
    assert sql.count("DO $$") == sql.count("END $$;")


# ---------------------------------------------------------------------------
# The tag-group conversion
# ---------------------------------------------------------------------------


def test_conversion_is_one_guarded_do_block():
    sql = _norm(PROJECT_FIELDS_MIGRATION_SQL)
    assert sql.startswith("DO $$")
    assert sql.endswith("END $$")
    assert sql.count("$$") == 2
    # Works only while tag_groups exists (a fresh 2.0.0 or converted database: no-op).
    assert "IF to_regclass('public.tag_groups') IS NOT NULL THEN" in sql


def test_conversion_maps_groups_tags_links_and_projects():
    sql = _norm(PROJECT_FIELDS_MIGRATION_SQL)
    # A field per group, in group order: single-select -> select, else multiselect.
    assert (
        "SELECT id, name, single_select, sort_order FROM tag_groups ORDER BY sort_order, id" in sql
    )
    assert "CASE WHEN grp.single_select THEN 'select' ELSE 'multiselect' END" in sql
    # A clashing name (case-insensitive) gets " (tags)" appended, within 100 chars.
    assert "WHERE lower(name) = lower(candidate)" in sql
    assert "' (tags)'" in sql
    assert "left(grp.name, 100 - length(suffix)) || suffix" in sql
    # An item per tag (name, colour, scope, order) with its site and team links.
    assert "INSERT INTO project_field_options (field_id, name, color, all_sites, sort_order)" in sql
    assert "SELECT new_option_id, site_id FROM tag_sites WHERE tag_id = grouped_tag.id" in sql
    assert "SELECT new_option_id, team_id FROM tag_teams WHERE tag_id = grouped_tag.id" in sql
    # A selection per project that carried the tag.
    assert "INSERT INTO project_field_selections (project_id, option_id, assigned_at)" in sql
    assert "FROM project_tags WHERE tag_id = grouped_tag.id" in sql


def test_conversion_then_drops_the_groups_in_order():
    sql = _norm(PROJECT_FIELDS_MIGRATION_SQL)
    steps = [
        "INSERT INTO project_fields",
        "DELETE FROM tags WHERE group_id IS NOT NULL",
        "row_number() OVER (ORDER BY sort_order, name) - 1",
        "DROP INDEX IF EXISTS idx_tags_group",
        "ALTER TABLE tags DROP COLUMN IF EXISTS group_id",
        "DROP TABLE tag_groups",
    ]
    positions = [sql.index(step) for step in steps]
    assert positions == sorted(positions)


def test_conversion_has_no_bind_parameters():
    """SQLAlchemy text() would read ':name' tokens as binds; ':=' is fine."""
    assert text(PROJECT_FIELDS_MIGRATION_SQL).compile().params == {}
    for statement in PROJECT_FIELDS_SCHEMA_STATEMENTS:
        assert text(statement).compile().params == {}


def test_probe_lists_the_tables_and_tag_groups():
    for table in (*PROJECT_FIELD_TABLES, "tag_groups"):
        assert f"'{table}'" in PROJECT_FIELDS_PROBE_SQL
    assert "information_schema.tables" in PROJECT_FIELDS_PROBE_SQL


# ---------------------------------------------------------------------------
# migrations/add_project_fields.sql
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def migration_statements() -> list[str]:
    return split_sql_statements(MIGRATION.read_text())


def test_migration_documents_how_to_run_it():
    sql = MIGRATION.read_text()
    assert "python migrations/run_migration.py add_project_fields" in sql
    assert "psql" in sql


def test_migration_splits_into_whole_statements(migration_statements):
    do_blocks = [s for s in migration_statements if s.lstrip().startswith("DO $$")]
    assert len(do_blocks) == 3  # the conversion, grants, completion notice
    assert all(s.rstrip().endswith("END $$;") for s in do_blocks)
    for statement in migration_statements:
        if statement not in do_blocks:
            assert "$$" not in statement
    plain = [_norm(s).rstrip(";").strip() for s in migration_statements if s not in do_blocks]
    assert plain == [_norm(s) for s in PROJECT_FIELDS_SCHEMA_STATEMENTS]


def test_migration_carries_the_conversion_verbatim(migration_statements):
    conversion = next(s for s in migration_statements if "DROP TABLE tag_groups" in s)
    assert _norm(conversion).rstrip(";") == _norm(PROJECT_FIELDS_MIGRATION_SQL)
    # The schema first: the conversion inserts into the new tables.
    assert migration_statements.index(conversion) == len(PROJECT_FIELDS_SCHEMA_STATEMENTS)


def test_migration_grants_every_table_and_the_sequences(migration_statements):
    (grants,) = (s for s in migration_statements if "GRANT" in s)
    for table in PROJECT_FIELD_TABLES:
        assert f"GRANT ALL PRIVILEGES ON TABLE {table} TO %I" in grants, table
    for sequence in (
        "project_fields_id_seq",
        "project_field_options_id_seq",
        "project_field_values_id_seq",
    ):
        assert f"GRANT USAGE, SELECT ON SEQUENCE {sequence} TO %I" in grants


def test_migration_is_listed_in_the_readme():
    readme = _root_file("migrations/README.md")
    assert "`add_project_fields`" in readme
    # Applied automatically too.
    auto = readme[readme.index("Some tenant migrations also run automatically") :]
    assert "`add_project_fields`" in auto.split("\n")[0]


# ---------------------------------------------------------------------------
# Tenant auto-migration
# ---------------------------------------------------------------------------


def test_tenant_auto_migration_executes_the_constants():
    from app.services import tenant_manager

    assert tenant_manager.PROJECT_FIELDS_SCHEMA_STATEMENTS is PROJECT_FIELDS_SCHEMA_STATEMENTS
    assert tenant_manager.PROJECT_FIELDS_MIGRATION_SQL is PROJECT_FIELDS_MIGRATION_SQL
    assert tenant_manager.PROJECT_FIELD_TABLES is PROJECT_FIELD_TABLES


PROBE = "CHECK project field tables"
TEAMS_CHECK = "CHECK team tables"
WIDEN = "widen notification types"
DECIMALS = "project field decimals"


def _conn(tables=(), fail_on: str | None = None):
    """
    A connection on which only the teams probe and the project-fields step's
    own SQL succeed; every other auto-migration step fails (and is contained by
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
        if "'teams', 'team_members'" in sql:
            log.append(TEAMS_CHECK)
            return rows(tp.TEAM_TABLES)  # teams up to date: the step is skipped
        if sql == PROJECT_FIELDS_PROBE_SQL:
            log.append(PROBE)
            return rows(tables)
        if sql == RBAC_NEEDS_MIGRATION_SQL:
            result = MagicMock()
            result.scalar.return_value = False
            return result
        if sql == NOTIFICATIONS_TYPE_CHECK_SQL:
            log.append(WIDEN)
            return MagicMock()
        if sql == PROJECT_FIELD_DECIMALS_SQL:  # the decimals column step, its own gate
            log.append(DECIMALS)
            return MagicMock()
        if sql in PROJECT_FIELDS_SCHEMA_STATEMENTS or sql == PROJECT_FIELDS_MIGRATION_SQL:
            log.append(sql)
            if sql == fail_on:
                raise RuntimeError("statement failed")
            return MagicMock()
        if sql in TEAMS_SCHEMA_STATEMENTS:
            log.append(sql)
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
    start = log.index(PROBE)
    for end in range(start, len(log)):
        if log[end] in ("COMMIT", "ROLLBACK"):
            return log[start : end + 1]
    return log[start:]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tables",
    [(), ("tag_groups",), (*PROJECT_FIELD_TABLES, "tag_groups"), PROJECT_FIELD_TABLES[:-1]],
    ids=["1.17", "1.17-with-groups", "tables-but-groups-left", "partial"],
)
async def test_auto_migration_creates_the_schema_then_converts(tables):
    conn, log = _conn(tables=tables)

    await _run_auto_migrations(conn)

    assert _step(log) == [
        PROBE,
        *PROJECT_FIELDS_SCHEMA_STATEMENTS,
        PROJECT_FIELDS_MIGRATION_SQL,
        "COMMIT",
    ]
    # After the teams step (option_teams references teams), before the
    # notification-types step.
    assert log.index(TEAMS_CHECK) < log.index(PROBE) < log.index(WIDEN)


@pytest.mark.asyncio
async def test_auto_migration_skips_a_converted_tenant():
    conn, log = _conn(tables=PROJECT_FIELD_TABLES)  # every table, no tag_groups

    await _run_auto_migrations(conn)

    # Only the decimals column step (its own gate) between the probe and the
    # notification types.
    assert log[log.index(PROBE) :] == [PROBE, DECIMALS, "COMMIT", WIDEN, "COMMIT"]
    assert PROJECT_FIELDS_MIGRATION_SQL not in log


@pytest.mark.asyncio
async def test_auto_migration_failure_rolls_back_and_never_raises():
    conn, log = _conn(fail_on=PROJECT_FIELDS_MIGRATION_SQL)

    await _run_auto_migrations(conn)  # never raises

    assert _step(log) == [
        PROBE,
        *PROJECT_FIELDS_SCHEMA_STATEMENTS,
        PROJECT_FIELDS_MIGRATION_SQL,
        "ROLLBACK",
    ]
    assert log[-4:] == [DECIMALS, "COMMIT", WIDEN, "COMMIT"]  # the later steps still ran


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


def _fk(column):
    (fk,) = column.foreign_keys
    return fk


def test_models_live_on_the_tenant_base():
    for table in PROJECT_FIELD_TABLES:
        assert table in Base.metadata.tables, table
    assert "tag_groups" not in Base.metadata.tables


def test_field_model_matches_the_ddl():
    table = ProjectField.__table__
    assert table.c.name.type.length == 100
    assert table.c.name.unique is True
    assert table.c.field_type.type.length == 20
    assert {c.name for c in table.constraints} >= {"project_fields_type_check"}
    assert ProjectField.options.property.lazy == "selectin"
    assert ProjectField.options.property.passive_deletes is True
    assert "delete-orphan" in ProjectField.options.property.cascade


def test_option_model_matches_the_ddl():
    table = ProjectFieldOption.__table__
    assert _fk(table.c.field_id).ondelete == "CASCADE"
    assert _fk(table.c.field_id).target_fullname == "project_fields.id"
    assert table.c.color.type.length == 7
    assert "project_field_options_field_name_unique" in {c.name for c in table.constraints}
    for rel in (ProjectFieldOption.sites, ProjectFieldOption.teams):
        assert rel.property.lazy == "selectin"
        assert rel.property.passive_deletes is True


@pytest.mark.parametrize(
    ("model", "table", "columns", "index"),
    [
        (
            ProjectFieldOptionSite,
            "project_field_option_sites",
            ("option_id", "site_id"),
            "idx_project_field_option_sites_site",
        ),
        (
            ProjectFieldOptionTeam,
            "project_field_option_teams",
            ("option_id", "team_id"),
            "idx_project_field_option_teams_team",
        ),
        (
            ProjectFieldSelection,
            "project_field_selections",
            ("project_id", "option_id"),
            "idx_project_field_selections_option",
        ),
    ],
)
def test_junction_models_cascade(model, table, columns, index):
    assert model.__table__.name == table
    assert [c.name for c in model.__table__.primary_key.columns] == list(columns)
    for column in columns:
        assert _fk(model.__table__.c[column]).ondelete == "CASCADE", (table, column)
    assert {i.name for i in model.__table__.indexes} == {index}


def test_value_model_matches_the_ddl():
    table = ProjectFieldValue.__table__
    for column in ("field_id", "project_id"):
        assert _fk(table.c[column]).ondelete == "CASCADE"
    assert "project_field_values_field_project_unique" in {c.name for c in table.constraints}
    assert {i.name for i in table.indexes} == {"idx_project_field_values_project"}
    assert {c: table.c[c].nullable for c in ("value_text", "value_number", "value_bool")} == {
        "value_text": True,
        "value_number": True,
        "value_bool": True,
    }


def test_project_loads_its_values_and_items():
    for rel in (Project.field_values, Project.field_selections):
        assert rel.property.lazy == "selectin"
        assert rel.property.passive_deletes is True
    assert Project.field_selections.property.secondary.name == "project_field_selections"


def test_transient_objects():
    option = ProjectFieldOption(name="Internal")
    assert option.site_ids == [] and option.team_ids == []
    assert ProjectField(name="Area", field_type="multiselect").is_dropdown is True
    assert ProjectField(name="Budget", field_type="number").is_dropdown is False
    assert Project().field_values == [] and Project().field_selections == []
    assert repr(ProjectField(name="Area", field_type="multiselect")) == (
        "<ProjectField Area (multiselect)>"
    )
    assert repr(option) == "<ProjectFieldOption Internal>"
    assert repr(ProjectFieldValue(field_id=5, project_id=7)) == (
        "<ProjectFieldValue field=5 project=7>"
    )


def test_models_package_exports_the_project_field_models():
    import app.models as models

    for name in (
        "ProjectField",
        "ProjectFieldOption",
        "ProjectFieldOptionSite",
        "ProjectFieldOptionTeam",
        "ProjectFieldValue",
        "ProjectFieldSelection",
    ):
        assert name in models.__all__
        assert getattr(models, name).__module__ == "app.models.project_field"
    assert "TagGroup" not in models.__all__
