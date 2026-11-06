"""
Audit log schema (2.4.0) stays identical in every DDL source.

The canonical statements live once in tenant_provisioner
(AUDIT_LOG_SCHEMA_STATEMENTS); get_tenant_schema_sql(), setup_databases.sql,
migrations/add_audit_log.sql and the manual-setup template carry the same
text after the users table, the tenant auto-migration executes the constants
in its own probe-gated step (it creates the table only while it is missing
and commits only then), and the ORM declares the same columns, checks,
indexes and delete rule. Repo-root files are skipped when the test tree is
run outside the repository.
"""

import logging
import re
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Integer,
    MetaData,
    String,
    Text,
    create_engine,
    event,
    text,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import Base
from app.models.audit_log import AUDIT_LOG_CATEGORIES, AUDIT_LOG_OUTCOMES, AuditLog
from app.models.rbac import Role
from app.models.user import User
from app.services import audit_log as audit_log_service
from app.services.tenant_provisioner import (
    AUDIT_LOG_INDEX_STATEMENTS,
    AUDIT_LOG_PROBE_SQL,
    AUDIT_LOG_SCHEMA_SQL,
    AUDIT_LOG_SCHEMA_STATEMENTS,
    AUDIT_LOG_TABLE,
    AUDIT_LOG_TABLE_SQL,
    DASHBOARD_WIDGET_KIND_CHECK_SQL,
    NOTIFICATIONS_TYPE_CHECK_SQL,
    get_tenant_schema_sql,
)
from migrations.run_migration_master import split_sql_statements
from tests.sqlite_support import AsyncSessionFacade
from tests.support import audit_log_step

# Route tests stub audit_log.record (an autouse fixture): the real one.
REAL_RECORD = audit_log_service.record

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "add_audit_log.sql"
IN_REPO = (ROOT / "setup_databases.sql").exists() and (ROOT / "Dockerfile").exists()

INDEX_NAMES = (
    "ix_audit_log_created_at",
    "ix_audit_log_category_created_at",
    "ix_audit_log_action",
    "ix_audit_log_actor_user_id",
    "ix_audit_log_subject_email",
    "ix_audit_log_ip",
    "ix_audit_log_project_id",
)
INDEX_COLUMNS = {
    "ix_audit_log_created_at": ["created_at"],
    "ix_audit_log_category_created_at": ["category", "created_at"],
    "ix_audit_log_action": ["action"],
    "ix_audit_log_actor_user_id": ["actor_user_id"],
    "ix_audit_log_subject_email": ["subject_email"],
    "ix_audit_log_ip": ["ip"],
    "ix_audit_log_project_id": ["project_id"],
}
COLUMNS = {
    "id": "BIGSERIAL PRIMARY KEY",
    "created_at": "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
    "category": "VARCHAR(16) NOT NULL",
    "action": "VARCHAR(100) NOT NULL",
    "outcome": "VARCHAR(16) NOT NULL DEFAULT 'success'",
    "actor_user_id": "INTEGER REFERENCES users(id) ON DELETE SET NULL",
    "actor_email": "VARCHAR(255)",
    "actor_name": "VARCHAR(255)",
    "subject_email": "VARCHAR(255)",
    "target_type": "VARCHAR(50)",
    "target_id": "VARCHAR(100)",
    "target_label": "VARCHAR(255)",
    "project_id": "INTEGER",
    "ip": "VARCHAR(45)",
    "user_agent": "VARCHAR(255)",
    "origin": "VARCHAR(20) NOT NULL DEFAULT 'web'",
    "details": "TEXT",
}
CATEGORY_CHECK = "category IN ('auth', 'admin', 'access', 'change')"
OUTCOME_CHECK = "outcome IN ('success', 'failure')"


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


def test_schema_statements_are_the_table_then_the_indexes():
    assert AUDIT_LOG_TABLE == "audit_log"
    assert AUDIT_LOG_SCHEMA_STATEMENTS == (AUDIT_LOG_TABLE_SQL, *AUDIT_LOG_INDEX_STATEMENTS)
    assert _norm(AUDIT_LOG_TABLE_SQL).startswith("CREATE TABLE IF NOT EXISTS audit_log (")
    # One statement per entry: asyncpg executes a single statement per call.
    for statement in AUDIT_LOG_SCHEMA_STATEMENTS:
        assert ";" not in statement, statement
    assert AUDIT_LOG_SCHEMA_SQL == ";\n".join(AUDIT_LOG_SCHEMA_STATEMENTS) + ";"


def test_the_columns_and_checks():
    assert _ddl_columns(AUDIT_LOG_TABLE_SQL) == COLUMNS
    normalized = _norm(AUDIT_LOG_TABLE_SQL)
    assert f"CONSTRAINT audit_log_category_check CHECK ({CATEGORY_CHECK})" in normalized
    assert f"CONSTRAINT audit_log_outcome_check CHECK ({OUTCOME_CHECK})" in normalized
    # JSON as text: never JSONB on a tenant model.
    assert "JSONB" not in normalized


def test_the_index_definitions():
    assert [_norm(s) for s in AUDIT_LOG_INDEX_STATEMENTS] == [
        f"CREATE INDEX IF NOT EXISTS {name} ON audit_log({', '.join(INDEX_COLUMNS[name])})"
        for name in INDEX_NAMES
    ]


def test_statements_have_no_bind_parameters():
    """SQLAlchemy text() would read ':name' tokens as binds."""
    for statement in (*AUDIT_LOG_SCHEMA_STATEMENTS, AUDIT_LOG_PROBE_SQL):
        assert text(statement).compile().params == {}


def test_probe_looks_up_the_table_in_pg_class():
    assert "pg_class" in AUDIT_LOG_PROBE_SQL
    assert "relname = 'audit_log'" in AUDIT_LOG_PROBE_SQL
    assert "nspname = 'public'" in AUDIT_LOG_PROBE_SQL
    assert "relkind = 'r'" in AUDIT_LOG_PROBE_SQL


def test_the_model_constants_match_the_checks():
    assert AUDIT_LOG_CATEGORIES == ("auth", "admin", "access", "change")
    assert AUDIT_LOG_OUTCOMES == ("success", "failure")
    # The service validates against the same tuples.
    assert audit_log_service.CATEGORIES is AUDIT_LOG_CATEGORIES
    assert audit_log_service.OUTCOMES is AUDIT_LOG_OUTCOMES


# ---------------------------------------------------------------------------
# Every DDL source carries the same statements, after users
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("statement", AUDIT_LOG_SCHEMA_STATEMENTS, ids=["table", *INDEX_NAMES])
def test_every_source_carries_the_canonical_statement(statement):
    sources = {**_fresh_sources(), "add_audit_log.sql": MIGRATION.read_text()}
    for name, sql in sources.items():
        assert _norm(statement) in _norm(sql), name
    assert _as_template(statement) in _norm(_template())


def test_the_table_comes_after_users_and_before_its_indexes():
    sources = {**_fresh_sources(), "template": _template()}
    for name, sql in sources.items():
        normalized = _norm(sql).replace(" IF NOT EXISTS", "")
        table = normalized.index("CREATE TABLE audit_log (")
        assert normalized.index("CREATE TABLE users (") < table, name
        for index in INDEX_NAMES:
            assert normalized.index(f"CREATE INDEX {index} ") > table, (name, index)
        # Once per source.
        assert normalized.count("CREATE TABLE audit_log (") == 1, name


def test_the_comment_names_the_constant():
    sources = {"setup_databases.sql": _root_file("setup_databases.sql"), "template": _template()}
    for name, sql in sources.items():
        before = sql[: re.search(r"CREATE TABLE (IF NOT EXISTS )?audit_log \(", sql).start()]
        assert "tenant_provisioner.AUDIT_LOG_SCHEMA_STATEMENTS" in before[-600:], name


def test_provisioner_schema_dollar_quoting_still_balanced():
    sql = get_tenant_schema_sql()
    assert sql.count("DO $$") == sql.count("END $$;")


# ---------------------------------------------------------------------------
# migrations/add_audit_log.sql and the docs
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def migration_statements() -> list[str]:
    return split_sql_statements(MIGRATION.read_text())


def test_migration_documents_how_to_run_it():
    sql = MIGRATION.read_text()
    assert "-- USAGE:" in sql
    assert "python migrations/run_migration.py add_audit_log" in sql
    assert "psql" in sql and "-f migrations/add_audit_log.sql" in sql
    assert "tenant_provisioner.AUDIT_LOG_SCHEMA_STATEMENTS" in sql


def test_migration_splits_into_whole_statements(migration_statements):
    do_blocks = [s for s in migration_statements if s.lstrip().startswith("DO $$")]
    assert len(do_blocks) == 2  # grants, completion notice
    assert all(s.rstrip().endswith("END $$;") for s in do_blocks)
    for statement in migration_statements:
        if statement not in do_blocks:
            assert "$$" not in statement
    plain = [_norm(s).rstrip(";").strip() for s in migration_statements if s not in do_blocks]
    assert plain == [_norm(s) for s in AUDIT_LOG_SCHEMA_STATEMENTS]
    # The grants follow the schema, the notice comes last.
    assert migration_statements.index(do_blocks[0]) == len(AUDIT_LOG_SCHEMA_STATEMENTS)
    assert "RAISE NOTICE 'Audit log migration completed successfully'" in do_blocks[1]
    assert migration_statements[-1] is do_blocks[1]


def test_migration_grants_the_table_and_its_sequence(migration_statements):
    (grants,) = (s for s in migration_statements if "GRANT" in s)
    assert "GRANT ALL PRIVILEGES ON TABLE audit_log TO %I" in grants
    assert "GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO %I" in grants


def test_migration_is_listed_in_the_readme():
    readme = _root_file("migrations/README.md")
    assert "| `add_audit_log` | tenant |" in readme
    # Applied automatically too.
    auto = readme[readme.index("Some tenant migrations also run automatically") :]
    assert "`add_audit_log`" in auto.split("\n")[0]


def test_migration_is_documented():
    schema = _root_file("docs/developer-guide/database-schema.md")
    assert "| `audit_log` | `AuditLog` |" in schema
    migrations = schema[schema.index("### Migrations") :]
    assert "add_audit_log.sql" in migrations
    assert "AUDIT_LOG_PROBE_SQL" in migrations
    admin = _root_file("docs/admin-guide/database.md")
    assert "| `add_audit_log` | Tenant |" in admin


def test_single_tenant_upgrade_checks_the_table():
    source = (ROOT / "tests" / "test_single_tenant_upgrade.py").read_text()
    assert '"audit_log",' in source


# ---------------------------------------------------------------------------
# Tenant auto-migration
# ---------------------------------------------------------------------------


def test_tenant_auto_migration_executes_the_constants():
    from app.services import tenant_manager

    assert tenant_manager.AUDIT_LOG_SCHEMA_STATEMENTS is AUDIT_LOG_SCHEMA_STATEMENTS
    assert tenant_manager.AUDIT_LOG_PROBE_SQL is AUDIT_LOG_PROBE_SQL
    assert tenant_manager.AUDIT_LOG_TABLE is AUDIT_LOG_TABLE


def test_the_shared_probe_helper():
    """tests/support.audit_log_step answers the probe "the table exists" for
    every other auto-migration fake, and nothing else."""
    result = audit_log_step(AUDIT_LOG_PROBE_SQL)
    assert result.fetchall() == [("audit_log",)]
    assert audit_log_step(AUDIT_LOG_TABLE_SQL) is None
    assert audit_log_step("SELECT 1") is None


PROBE = "CHECK audit_log"
KINDS = "dashboard widget kinds check"
WIDEN = "widen notification types"


def _conn(exists: bool, fail_on: str | None = None):
    """
    A connection on which only the audit-log step's own SQL succeeds, plus
    the widget-kinds block before it and the notification-types block after
    it (both self-gated, run on every pool creation); every other
    auto-migration step fails (and is contained by its own try/except).
    ``log`` records the probe, the statements and the two blocks interleaved
    with COMMIT / ROLLBACK.
    """
    log: list[str] = []

    async def execute(clause, *args, **kwargs):
        sql = str(clause)
        if sql == AUDIT_LOG_PROBE_SQL:
            log.append(PROBE)
            result = MagicMock()
            result.fetchall.return_value = [("audit_log",)] if exists else []
            return result
        if sql in AUDIT_LOG_SCHEMA_STATEMENTS:
            log.append(sql)
            if sql == fail_on:
                raise RuntimeError("permission denied for schema public")
            return MagicMock()
        if sql == DASHBOARD_WIDGET_KIND_CHECK_SQL:
            log.append(KINDS)
            return MagicMock()
        if sql == NOTIFICATIONS_TYPE_CHECK_SQL:
            log.append(WIDEN)
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
    """From the widget-kinds block (the step before ours) to the end."""
    return log[log.index(KINDS) :]


async def test_auto_migration_creates_a_missing_table():
    conn, log = _conn(exists=False)

    await _run_auto_migrations(conn)

    # After the widget-kinds block, before the notification-types step; the
    # table, its indexes, one commit.
    assert _tail(log) == [
        KINDS,
        "COMMIT",
        PROBE,
        *AUDIT_LOG_SCHEMA_STATEMENTS,
        "COMMIT",
        WIDEN,
        "COMMIT",
    ]
    assert log.count(PROBE) == 1


async def test_auto_migration_skips_an_up_to_date_tenant():
    conn, log = _conn(exists=True)

    await _run_auto_migrations(conn)

    # The probe only: no DDL, no commit of its own.
    assert _tail(log) == [KINDS, "COMMIT", PROBE, WIDEN, "COMMIT"]
    assert not any(s in AUDIT_LOG_SCHEMA_STATEMENTS for s in log)


@pytest.mark.parametrize(
    "failing", [AUDIT_LOG_TABLE_SQL, AUDIT_LOG_INDEX_STATEMENTS[-1]], ids=["table", "index"]
)
async def test_auto_migration_failure_rolls_back_and_never_raises(failing, caplog):
    conn, log = _conn(exists=False, fail_on=failing)

    with caplog.at_level(logging.WARNING):
        await _run_auto_migrations(conn)  # never raises

    ran = list(AUDIT_LOG_SCHEMA_STATEMENTS[: AUDIT_LOG_SCHEMA_STATEMENTS.index(failing) + 1])
    assert _tail(log) == [KINDS, "COMMIT", PROBE, *ran, "ROLLBACK", WIDEN, "COMMIT"]
    assert "Auto-migration (audit log) warning for acme" in caplog.text


async def test_auto_migration_probe_failure_is_contained(caplog):
    conn, log = _conn(exists=False)
    original = conn.execute.side_effect

    async def execute(clause, *args, **kwargs):
        if str(clause) == AUDIT_LOG_PROBE_SQL:
            log.append(PROBE)
            raise RuntimeError("connection reset")
        return await original(clause, *args, **kwargs)

    conn.execute = AsyncMock(side_effect=execute)
    with caplog.at_level(logging.WARNING):
        await _run_auto_migrations(conn)

    assert _tail(log) == [KINDS, "COMMIT", PROBE, "ROLLBACK", WIDEN, "COMMIT"]
    assert "Auto-migration (audit log) warning for acme" in caplog.text


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


def _fk(column):
    (fk,) = column.foreign_keys
    return fk


def test_model_lives_on_the_tenant_base():
    assert AuditLog.__tablename__ == "audit_log"
    assert Base.metadata.tables["audit_log"] is AuditLog.__table__


def test_model_columns_match_the_ddl():
    table = AuditLog.__table__
    ddl = _ddl_columns(AUDIT_LOG_TABLE_SQL)
    assert [c.name for c in table.columns] == list(ddl)
    for column in table.columns:
        definition = ddl[column.name]
        if column.primary_key:
            continue
        assert column.nullable == ("NOT NULL" not in definition), column.name
        length = re.search(r"VARCHAR\((\d+)\)", definition)
        if length:
            assert isinstance(column.type, String) and not isinstance(column.type, Text)
            assert column.type.length == int(length.group(1)), column.name
        elif definition.startswith("INTEGER"):
            assert type(column.type) is Integer, column.name
        elif definition.startswith("TEXT"):
            assert isinstance(column.type, Text), column.name
        elif definition.startswith("TIMESTAMP"):
            assert isinstance(column.type, DateTime) and not column.type.timezone
        else:  # pragma: no cover - every DDL type is handled above
            raise AssertionError(definition)
        default = re.search(r"DEFAULT (.+)$", definition)
        if default:
            assert column.server_default is not None, column.name
            assert str(column.server_default.arg) == default.group(1), column.name
        else:
            assert column.server_default is None, column.name


def test_model_primary_key_is_a_big_serial():
    column = AuditLog.__table__.c.id
    assert column.primary_key and column.autoincrement is True
    assert isinstance(column.type, BigInteger)
    # SQLite's autoincrement takes INTEGER only.
    assert isinstance(column.type._variant_mapping["sqlite"], Integer)


def test_model_python_defaults():
    table = AuditLog.__table__
    assert table.c.created_at.default.arg.__name__ == "utcnow_naive"
    assert table.c.outcome.default.arg == "success"
    assert table.c.origin.default.arg == "web"


def test_model_foreign_key_checks_and_indexes():
    table = AuditLog.__table__
    assert _fk(table.c.actor_user_id).ondelete == "SET NULL"
    assert _fk(table.c.actor_user_id).target_fullname == "users.id"
    # No foreign key on the project: the row outlives it.
    assert not table.c.project_id.foreign_keys
    checks = {c.name: str(c.sqltext) for c in table.constraints if isinstance(c, CheckConstraint)}
    assert checks == {
        "audit_log_category_check": CATEGORY_CHECK,
        "audit_log_outcome_check": OUTCOME_CHECK,
    }
    assert {i.name: [c.name for c in i.columns] for i in table.indexes} == INDEX_COLUMNS
    assert not any(i.unique for i in table.indexes)


def test_models_package_exports_the_model():
    import app.models as models

    assert "AuditLog" in models.__all__
    assert models.AuditLog is AuditLog


# ---------------------------------------------------------------------------
# The ORM on SQLite: defaults, checks, the actor's delete, a recorded row
# ---------------------------------------------------------------------------


@pytest.fixture
def sqlite_session():
    engine = create_engine("sqlite://")

    @event.listens_for(engine, "connect")
    def _foreign_keys(dbapi_connection, _record):
        dbapi_connection.execute("PRAGMA foreign_keys=ON")

    # users (and the roles its role FK references) plus audit_log; the roles
    # key CHECK (PostgreSQL regex syntax SQLite lacks) is left out, the audit
    # CHECKs are kept.
    metadata = MetaData()
    for table in Base.metadata.sorted_tables:
        copy = table.to_metadata(metadata)
        for constraint in [c for c in copy.constraints if isinstance(c, CheckConstraint)]:
            if "~" in str(constraint.sqltext):
                copy.constraints.discard(constraint)
    metadata.create_all(
        engine, tables=[metadata.tables[n] for n in ("roles", "users", "audit_log")]
    )
    with Session(engine, expire_on_commit=False) as session:
        session.add(Role(id=1, key="user", name="User"))
        session.add(User(id=7, email="ada@x", password="x", first_name="Ada", last_name="L"))
        session.commit()
        yield session
    engine.dispose()


def test_the_defaults_fill_a_minimal_row(sqlite_session):
    sqlite_session.execute(
        text("INSERT INTO audit_log (category, action) VALUES ('auth', 'auth.logout')")
    )
    sqlite_session.commit()

    row = sqlite_session.execute(
        text("SELECT id, created_at, outcome, origin, details FROM audit_log")
    ).one()
    assert row.id == 1
    assert row.created_at is not None
    assert (row.outcome, row.origin, row.details) == ("success", "web", None)


@pytest.mark.parametrize(
    "fields",
    [{"category": "security"}, {"outcome": "partial"}],
    ids=["category", "outcome"],
)
def test_the_checks_hold_on_sqlite(sqlite_session, fields):
    sqlite_session.add(AuditLog(**{"category": "auth", "action": "auth.logout", **fields}))
    with pytest.raises(IntegrityError):
        sqlite_session.commit()


def test_every_category_and_outcome_passes(sqlite_session):
    sqlite_session.add_all(
        [
            AuditLog(category=category, action=f"{category}.thing.done", outcome=outcome)
            for category in AUDIT_LOG_CATEGORIES
            for outcome in AUDIT_LOG_OUTCOMES
        ]
    )
    sqlite_session.commit()
    assert sqlite_session.execute(text("SELECT count(*) FROM audit_log")).scalar() == 8


def test_the_row_outlives_its_actor(sqlite_session):
    sqlite_session.add(AuditLog(category="auth", action="auth.logout", actor_user_id=7))
    sqlite_session.commit()

    sqlite_session.execute(text("DELETE FROM users WHERE id = 7"))
    sqlite_session.commit()

    assert sqlite_session.execute(text("SELECT actor_user_id FROM audit_log")).all() == [(None,)]


async def test_a_recorded_row_round_trips(sqlite_session):
    """The real ``record`` on a real session: the row is flushed (it has an
    id), not committed -- the caller's commit persists it."""
    db = AsyncSessionFacade(sqlite_session)
    # The actor as get_current_user hands it over (a session snapshot).
    actor = SimpleNamespace(id=7, email="ada@x", first_name="Ada", last_name="L")

    entry = await REAL_RECORD(
        db,
        None,
        action="admin.settings.updated",
        category="admin",
        actor=actor,
        target=("setting", "instance_title", "instance_title"),
        changes={"instance_title": {"old": "Milestone", "new": "R&D planner"}},
    )

    assert entry.id is not None
    assert sqlite_session.in_transaction()
    sqlite_session.rollback()
    assert sqlite_session.execute(text("SELECT count(*) FROM audit_log")).scalar() == 0

    entry = await REAL_RECORD(
        db, None, action="admin.settings.updated", category="admin", actor=actor
    )
    await db.commit()
    sqlite_session.expire_all()
    loaded = sqlite_session.get(AuditLog, entry.id)
    assert (loaded.actor_user_id, loaded.actor_email, loaded.actor_name) == (7, "ada@x", "Ada L")
    assert (loaded.origin, loaded.outcome, loaded.details) == ("system", "success", None)
