"""
RBAC schema (1.13.0) stays identical in every DDL source.

The canonical statements live once in tenant_provisioner (RBAC_SCHEMA_STATEMENTS
for the tables, indexes and in-place upgrades; RBAC_SEED_STATEMENTS for the
system roles with their default permissions, the approval policies and the
users.role CHECK -> FK swap). get_tenant_schema_sql(), setup_databases.sql,
migrations/add_rbac.sql and the manual-setup template carry the same text,
``roles`` is created before ``users`` everywhere (users.role references
roles.key), the tenant auto-migration and the data-migration step execute the
constants, and the ORM declares the same constraints. The
notifications_type_check text is covered by test_notification_types_schema.py.
Repo-root files are skipped when the test tree is run outside the repository.
"""

import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import CheckConstraint

from app.models.assignment import (
    PhaseStaffAssignment,
    ProjectAssignment,
    SubphaseStaffAssignment,
)
from app.models.rbac import (
    ApprovalPolicy,
    ApprovalPolicyRole,
    ApprovalRequest,
    Role,
    RolePermission,
)
from app.models.settings import SSOConfig
from app.models.user import User
from app.services import tenant_data_migrations as tdm
from app.services.permissions import (
    APPROVABLE_KEYS,
    SYSTEM_ROLES,
    build_default_role_permissions_sql,
)
from app.services.tenant_provisioner import (
    APPROVAL_POLICIES_TABLE_SQL,
    APPROVAL_POLICY_ROLES_TABLE_SQL,
    APPROVAL_REQUESTS_ORPHAN_CLEANUP_SQL,
    APPROVAL_REQUESTS_TABLE_SQL,
    ASSIGNMENT_APPROVAL_COLUMN_STATEMENTS,
    ASSIGNMENT_APPROVAL_TABLES,
    NOTIFICATIONS_TYPE_CHECK_SQL,
    RBAC_INDEX_STATEMENTS,
    RBAC_NEEDS_MIGRATION_SQL,
    RBAC_SCHEMA_STATEMENTS,
    RBAC_SEED_NEEDED_SQL,
    RBAC_SEED_POLICIES_SQL,
    RBAC_SEED_ROLES_SQL,
    RBAC_SEED_STATEMENTS,
    RBAC_TABLES,
    ROLE_PERMISSIONS_TABLE_SQL,
    ROLES_TABLE_SQL,
    SSO_DEFAULT_ROLE_CHECK_DROP_SQL,
    USERS_ROLE_FK_CLAUSE,
    USERS_ROLE_FK_SQL,
    USERS_ROLE_RESET_SQL,
    get_tenant_schema_sql,
)
from migrations.run_migration_master import split_sql_statements

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "add_rbac.sql"
IN_REPO = (ROOT / "setup_databases.sql").exists() and (ROOT / "Dockerfile").exists()

TABLE_SQL = {
    "roles": ROLES_TABLE_SQL,
    "role_permissions": ROLE_PERMISSIONS_TABLE_SQL,
    "approval_policies": APPROVAL_POLICIES_TABLE_SQL,
    "approval_policy_roles": APPROVAL_POLICY_ROLES_TABLE_SQL,
    "approval_requests": APPROVAL_REQUESTS_TABLE_SQL,
}
INDEX_NAMES = (
    "idx_approval_policy_roles_role",
    "idx_approval_requests_project_status",
    "idx_approval_requests_requester_status",
    "idx_approval_requests_pending",
)
NEW_NOTIFICATION_TYPES = ("approval_requested", "approval_decided")


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
        "add_rbac.sql": MIGRATION.read_text(),
    }


def _template() -> str:
    return _root_file("scripts/sql/tenant_schema_template.sql")


def _as_template(statement: str) -> str:
    """The template creates a fresh database: no IF NOT EXISTS on CREATE."""
    return (
        _norm(statement)
        .replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE")
        .replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX")
    )


def _full_sources() -> dict[str, str]:
    """Every source that holds the whole tenant schema, normalized to template form."""
    sources = {**_sources(), "template": _template()}
    del sources["add_rbac.sql"]  # RBAC only
    return {name: _as_template(sql) for name, sql in sources.items()}


ALL_STATEMENTS = (*RBAC_SCHEMA_STATEMENTS, *RBAC_SEED_STATEMENTS)


# ---------------------------------------------------------------------------
# The constants
# ---------------------------------------------------------------------------


def test_rbac_tables_in_creation_order():
    assert RBAC_TABLES == (
        "roles",
        "role_permissions",
        "approval_policies",
        "approval_policy_roles",
        "approval_requests",
    )


def test_schema_statements_are_tables_indexes_then_upgrades():
    assert RBAC_SCHEMA_STATEMENTS == (
        *TABLE_SQL.values(),
        *RBAC_INDEX_STATEMENTS,
        *ASSIGNMENT_APPROVAL_COLUMN_STATEMENTS,
        NOTIFICATIONS_TYPE_CHECK_SQL,
        SSO_DEFAULT_ROLE_CHECK_DROP_SQL,
    )
    for table, sql in TABLE_SQL.items():
        assert _norm(sql).startswith(f"CREATE TABLE IF NOT EXISTS {table} (")
    for name, sql in zip(INDEX_NAMES, RBAC_INDEX_STATEMENTS, strict=True):
        assert _norm(sql).startswith(f"CREATE INDEX IF NOT EXISTS {name} ON ")


def test_seed_statements_order():
    # Roles (with their defaults) -> policies -> unknown roles reset -> FK.
    assert RBAC_SEED_STATEMENTS == (
        RBAC_SEED_ROLES_SQL,
        RBAC_SEED_POLICIES_SQL,
        USERS_ROLE_RESET_SQL,
        USERS_ROLE_FK_SQL,
    )
    assert RBAC_SEED_ROLES_SQL == build_default_role_permissions_sql()


@pytest.mark.parametrize("statement", ALL_STATEMENTS)
def test_one_statement_per_constant(statement):
    """asyncpg executes a single statement per call: no trailing ';', DO blocks whole."""
    stripped = statement.strip()
    assert not stripped.endswith(";")
    if stripped.startswith("DO $$"):
        assert stripped.endswith("END $$")
        assert stripped.count("$$") == 2
    else:
        assert ";" not in statement
        assert "$$" not in statement
    # SQLAlchemy text(): no ':name' binds; '::' casts are fine.
    assert not re.search(r"(?<![:\w]):\w", statement)


def test_every_foreign_key_has_an_explicit_delete_rule():
    for table, sql in TABLE_SQL.items():
        for line in (ln for ln in sql.splitlines() if "REFERENCES" in ln):
            assert "ON DELETE CASCADE" in line or "ON DELETE SET NULL" in line, (table, line)


def test_roles_key_format_and_users_fk():
    assert "CONSTRAINT roles_key_format CHECK (key ~ '^[a-z][a-z0-9_]{1,19}$')" in _norm(
        ROLES_TABLE_SQL
    )
    assert USERS_ROLE_FK_CLAUSE == (
        "CONSTRAINT users_role_fkey FOREIGN KEY (role) REFERENCES roles(key) "
        "ON UPDATE CASCADE ON DELETE RESTRICT"
    )
    fk = _norm(USERS_ROLE_FK_SQL)
    assert "ALTER TABLE users DROP CONSTRAINT users_role_check" in fk
    assert f"ALTER TABLE users ADD {USERS_ROLE_FK_CLAUSE}" in fk
    assert _norm(USERS_ROLE_RESET_SQL) == (
        "UPDATE users SET role = 'user' WHERE role NOT IN (SELECT key FROM roles)"
    )


def test_policies_seed_lists_every_approvable_action():
    sql = _norm(RBAC_SEED_POLICIES_SQL)
    assert sql.startswith("INSERT INTO approval_policies (action, pm_approves) VALUES")
    assert sql.endswith("ON CONFLICT (action) DO NOTHING")
    assert set(re.findall(r"\('([a-z_.]+)', TRUE\)", sql)) == APPROVABLE_KEYS


@pytest.mark.parametrize("table", ASSIGNMENT_APPROVAL_TABLES)
def test_assignment_columns_are_guarded_upgrades(table):
    status, request = (_norm(s) for s in ASSIGNMENT_APPROVAL_COLUMN_STATEMENTS if f"'{table}'" in s)
    assert "information_schema.columns" in status
    assert (
        f"ALTER TABLE {table} ADD COLUMN approval_status VARCHAR(10) NOT NULL DEFAULT "
        f"'approved' CONSTRAINT {table}_approval_status_check "
        "CHECK (approval_status IN ('approved', 'pending'))"
    ) in status
    assert (
        f"ALTER TABLE {table} ADD COLUMN approval_request_id INTEGER CONSTRAINT "
        f"{table}_approval_request_id_fkey REFERENCES approval_requests(id) "
        "ON DELETE SET NULL"
    ) in request


def test_sso_default_role_check_is_dropped():
    sql = _norm(SSO_DEFAULT_ROLE_CHECK_DROP_SQL)
    assert "ALTER TABLE sso_config DROP CONSTRAINT sso_config_default_role_check" in sql


# ---------------------------------------------------------------------------
# Every DDL source carries the same statements, in a valid order
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("table", RBAC_TABLES)
def test_every_source_creates_the_table(table):
    for name, sql in _sources().items():
        assert f"CREATE TABLE IF NOT EXISTS {table} (" in sql, (name, table)
    assert f"CREATE TABLE {table} (" in _template(), table


@pytest.mark.parametrize("statement", ALL_STATEMENTS)
def test_every_source_carries_the_canonical_statement(statement):
    for name, sql in _sources().items():
        assert _norm(statement) in _norm(sql), name
    assert _as_template(statement) in _norm(_template())


def test_every_source_names_the_indexes():
    for name, sql in {**_sources(), "template": _template()}.items():
        for index in INDEX_NAMES:
            assert index in sql, (name, index)


def _position(sql: str, fragment: str) -> int:
    return sql.index(_as_template(fragment))


@pytest.mark.parametrize("source", ["provisioner", "setup_databases.sql", "template"])
def test_roles_come_before_users_and_the_fk_swap_after_the_seed(source):
    sql = _full_sources()[source]
    users = sql.index("CREATE TABLE users (")
    roles = sql.index("CREATE TABLE roles (")
    role_permissions = sql.index("CREATE TABLE role_permissions (")
    seed = _position(sql, RBAC_SEED_ROLES_SQL)
    assert roles < role_permissions < seed < users
    # The users table references roles.key and has no role CHECK left.
    users_ddl = sql[users : sql.index(");", users)]
    assert USERS_ROLE_FK_CLAUSE in users_ddl
    assert "CHECK (role IN" not in users_ddl and "CHECK(role IN" not in users_ddl
    reset = _position(sql, USERS_ROLE_RESET_SQL)
    fk = _position(sql, USERS_ROLE_FK_SQL)
    assert users < reset < fk


@pytest.mark.parametrize("source", ["provisioner", "setup_databases.sql", "template"])
def test_rbac_tables_follow_their_parents_and_upgrades_follow_their_tables(source):
    sql = _full_sources()[source]

    def create(table: str) -> int:
        return sql.index(f"CREATE TABLE {table} (")

    assert create("approval_policies") < create("approval_policy_roles")
    assert create("approval_policies") < _position(sql, RBAC_SEED_POLICIES_SQL)
    for parent in ("users", "projects", "roles"):
        assert create(parent) < create("approval_requests"), parent
    for table in ASSIGNMENT_APPROVAL_TABLES:
        for statement in ASSIGNMENT_APPROVAL_COLUMN_STATEMENTS:
            if f"'{table}'" in statement:
                position = _position(sql, statement)
                assert create(table) < position, table
                assert create("approval_requests") < position, table
    assert create("notifications") < _position(sql, NOTIFICATIONS_TYPE_CHECK_SQL)
    assert create("sso_config") < _position(sql, SSO_DEFAULT_ROLE_CHECK_DROP_SQL)
    for index in RBAC_INDEX_STATEMENTS:
        table = re.search(r" ON (\w+)\(", index).group(1)
        assert create(table) < _position(sql, index), index


@pytest.mark.parametrize("source", ["provisioner", "setup_databases.sql", "template"])
def test_sso_config_has_no_default_role_check(source):
    sql = _full_sources()[source]
    start = sql.index("CREATE TABLE sso_config (")
    assert "default_role IN" not in sql[start : sql.index(");", start)]


def test_provisioner_schema_dollar_quoting_still_balanced():
    sql = get_tenant_schema_sql()
    assert sql.count("DO $$") == sql.count("END $$")


# ---------------------------------------------------------------------------
# migrations/add_rbac.sql
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def migration_statements() -> list[str]:
    return split_sql_statements(MIGRATION.read_text())


def test_migration_documents_how_to_run_it():
    sql = MIGRATION.read_text()
    assert "python migrations/run_migration.py add_rbac" in sql
    assert "psql" in sql


def test_migration_is_the_constants_then_grants_and_notice(migration_statements):
    statements = [_norm(s).removesuffix(";").strip() for s in migration_statements]
    assert statements[: len(ALL_STATEMENTS)] == [_norm(s) for s in ALL_STATEMENTS]
    grants, notice = migration_statements[len(ALL_STATEMENTS) :]
    assert grants.lstrip().startswith("DO $$") and "GRANT" in grants
    assert notice.lstrip().startswith("DO $$") and "RAISE NOTICE" in notice


def test_migration_grants_every_table_and_sequence(migration_statements):
    (grants,) = (s for s in migration_statements if "GRANT ALL" in s)
    for table in RBAC_TABLES:
        assert f"GRANT ALL PRIVILEGES ON TABLE {table} TO %I" in grants, table
    for sequence in ("roles_id_seq", "approval_requests_id_seq"):
        assert f"GRANT USAGE, SELECT ON SEQUENCE {sequence} TO %I" in grants, sequence


def test_migration_is_documented():
    assert "add_rbac" in _root_file("migrations/README.md")
    assert "add_rbac" in _root_file("docs/admin-guide/database.md")
    # The migration history moved out of CLAUDE.md into the developer guide.
    assert "add_rbac" in _root_file("docs/developer-guide/database-schema.md")


# ---------------------------------------------------------------------------
# Tenant auto-migration (schema) and data-migration step (seed + FK)
# ---------------------------------------------------------------------------


def test_tenant_auto_migration_executes_the_constants():
    from app.services import tenant_manager

    assert tenant_manager.RBAC_SCHEMA_STATEMENTS is RBAC_SCHEMA_STATEMENTS
    assert tenant_manager.RBAC_NEEDS_MIGRATION_SQL is RBAC_NEEDS_MIGRATION_SQL
    assert tdm.RBAC_SEED_STEP == (tdm.RBAC_SEED_STEP[0], RBAC_SEED_NEEDED_SQL, RBAC_SEED_STATEMENTS)


def test_needs_migration_probe_covers_the_three_triggers():
    sql = _norm(RBAC_NEEDS_MIGRATION_SQL)
    for table in RBAC_TABLES:
        assert f"'{table}'" in sql
    assert "conname = 'users_role_check'" in sql
    assert "table_name = 'project_assignments' AND column_name = 'approval_status'" in sql


def test_seed_needed_probe_covers_roles_policies_and_the_fk():
    sql = _norm(RBAC_SEED_NEEDED_SQL)
    for role in SYSTEM_ROLES:
        assert f"'{role.key}'" in sql
    for action in APPROVABLE_KEYS:
        assert f"'{action}'" in sql
    assert "conname = 'users_role_check'" in sql
    assert "conname = 'users_role_fkey'" in sql


RBAC_CHECK = "RBAC probe"


def _rbac_conn(needed: bool, fail_on: str | None = None):
    """Only the RBAC step's SQL succeeds; every other step fails (and is contained)."""
    log: list[str] = []

    async def execute(clause, *args, **kwargs):
        sql = str(clause)
        if sql == RBAC_NEEDS_MIGRATION_SQL:
            log.append(RBAC_CHECK)
            result = MagicMock()
            result.scalar.return_value = needed
            return result
        if sql in RBAC_SCHEMA_STATEMENTS:
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


def _rbac_step(log: list[str]) -> list[str]:
    start = log.index(RBAC_CHECK)
    for end in range(start, len(log)):
        if log[end] in ("COMMIT", "ROLLBACK"):
            return log[start : end + 1]
    return log[start:]


@pytest.mark.asyncio
async def test_auto_migration_creates_the_rbac_schema_in_order():
    conn, log = _rbac_conn(needed=True)

    await _run_auto_migrations(conn)

    assert _rbac_step(log) == [RBAC_CHECK, *RBAC_SCHEMA_STATEMENTS, "COMMIT"]


@pytest.mark.asyncio
async def test_auto_migration_skips_an_up_to_date_tenant():
    conn, log = _rbac_conn(needed=False)

    await _run_auto_migrations(conn)

    assert RBAC_CHECK in log
    # Only the notification-types step (its own gate) runs a shared statement.
    assert [s for s in log if s in RBAC_SCHEMA_STATEMENTS] == [NOTIFICATIONS_TYPE_CHECK_SQL]


@pytest.mark.asyncio
async def test_auto_migration_failure_rolls_back_and_never_raises():
    conn, log = _rbac_conn(needed=True, fail_on=APPROVAL_REQUESTS_TABLE_SQL)

    await _run_auto_migrations(conn)  # never raises

    assert _rbac_step(log) == [
        RBAC_CHECK,
        ROLES_TABLE_SQL,
        ROLE_PERMISSIONS_TABLE_SQL,
        APPROVAL_POLICIES_TABLE_SQL,
        APPROVAL_POLICY_ROLES_TABLE_SQL,
        APPROVAL_REQUESTS_TABLE_SQL,
        "ROLLBACK",
    ]


class _DataConn:
    """Data-migration connection: the seed probe answers ``needed``; ``fail`` raises."""

    def __init__(self, needed: bool, fail: str | None = None, expired: int = 0):
        self.needed = needed
        self.fail = fail
        self.expired = expired
        self.log: list[str] = []
        self.commit = AsyncMock(side_effect=lambda: self.log.append("COMMIT"))
        self.rollback = AsyncMock(side_effect=lambda: self.log.append("ROLLBACK"))
        self.engine = MagicMock()
        self.engine.url.database = "milestone_test"

    async def execute(self, clause):
        sql = str(clause)
        self.log.append(sql)
        if sql == self.fail:
            raise RuntimeError("boom")
        result = MagicMock()
        result.scalar.return_value = self.needed if sql == RBAC_SEED_NEEDED_SQL else False
        result.rowcount = self.expired if sql == APPROVAL_REQUESTS_ORPHAN_CLEANUP_SQL else 0
        return result

    def seed_step(self) -> list[str]:
        start = self.log.index(RBAC_SEED_NEEDED_SQL)
        return self.log[start : start + 2 + len(RBAC_SEED_STATEMENTS)]


@pytest.mark.asyncio
async def test_seed_step_runs_every_statement_in_one_transaction():
    conn = _DataConn(needed=True)

    await tdm.run_data_migrations(conn)

    assert conn.seed_step() == [RBAC_SEED_NEEDED_SQL, *RBAC_SEED_STATEMENTS, "COMMIT"]


@pytest.mark.asyncio
async def test_seed_step_is_skipped_when_nothing_is_missing():
    conn = _DataConn(needed=False)

    await tdm.run_data_migrations(conn)

    assert RBAC_SEED_NEEDED_SQL in conn.log
    assert not any(s in RBAC_SEED_STATEMENTS for s in conn.log)


@pytest.mark.asyncio
async def test_seed_step_failure_rolls_back_and_the_cleanups_still_run(caplog):
    conn = _DataConn(needed=True, fail=USERS_ROLE_FK_SQL)

    await tdm.run_data_migrations(conn)  # never raises

    start = conn.log.index(RBAC_SEED_NEEDED_SQL)
    assert conn.log[start : start + 6] == [
        RBAC_SEED_NEEDED_SQL,
        RBAC_SEED_ROLES_SQL,
        RBAC_SEED_POLICIES_SQL,
        USERS_ROLE_RESET_SQL,
        USERS_ROLE_FK_SQL,
        "ROLLBACK",
    ]
    assert APPROVAL_REQUESTS_ORPHAN_CLEANUP_SQL in conn.log
    assert "warning for milestone_test" in caplog.text


@pytest.mark.asyncio
async def test_orphaned_requests_are_expired_and_logged(caplog):
    caplog.set_level("INFO", logger=tdm.__name__)
    conn = _DataConn(needed=False, expired=3)

    await tdm.run_data_migrations(conn)

    assert "expired 3 orphaned approval request(s)" in caplog.text


def test_orphan_cleanup_expires_pending_requests_whose_target_is_gone():
    sql = _norm(APPROVAL_REQUESTS_ORPHAN_CLEANUP_SQL)
    assert sql.startswith("UPDATE approval_requests r SET status = 'expired', ")
    assert "close_reason = 'target_deleted'" in sql
    assert "WHERE r.status = 'pending'" in sql
    for table in ("project_phases", "project_subphases", *ASSIGNMENT_APPROVAL_TABLES):
        assert f"FROM {table} " in sql, table


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


def _check_constraint(model, name: str) -> CheckConstraint:
    (constraint,) = (
        c for c in model.__table__.constraints if isinstance(c, CheckConstraint) and c.name == name
    )
    return constraint


def _fk(column):
    (fk,) = column.foreign_keys
    return fk


def _assert_check(model, name: str, ddl: str) -> None:
    text = str(_check_constraint(model, name).sqltext)
    assert f"CONSTRAINT {name} CHECK ({text})" in _norm(ddl), name


def test_role_models_match_the_ddl():
    roles = Role.__table__
    assert roles.name == "roles"
    assert roles.c.key.type.length == 20 and roles.c.key.unique and not roles.c.key.nullable
    assert roles.c.name.type.length == 100 and roles.c.name.unique
    assert roles.c.is_system.nullable is False
    _assert_check(Role, "roles_key_format", ROLES_TABLE_SQL)

    rp = RolePermission.__table__
    assert rp.name == "role_permissions"
    assert [c.name for c in rp.primary_key.columns] == ["role_id", "permission"]
    assert _fk(rp.c.role_id).ondelete == "CASCADE"
    assert _fk(rp.c.role_id).target_fullname == "roles.id"
    assert rp.c.permission.type.length == 60
    _assert_check(RolePermission, "role_permissions_mode_check", ROLE_PERMISSIONS_TABLE_SQL)
    assert Role.permissions.property.cascade.delete_orphan
    assert Role.permissions.property.passive_deletes is True


def test_policy_models_match_the_ddl():
    policies = ApprovalPolicy.__table__
    assert [c.name for c in policies.primary_key.columns] == ["action"]
    assert policies.c.pm_approves.nullable is False
    junction = ApprovalPolicyRole.__table__
    assert junction.name == "approval_policy_roles"
    assert [c.name for c in junction.primary_key.columns] == ["action", "role_id"]
    assert _fk(junction.c.action).target_fullname == "approval_policies.action"
    for column in ("action", "role_id"):
        assert _fk(junction.c[column]).ondelete == "CASCADE"
    assert {i.name for i in junction.indexes} == {"idx_approval_policy_roles_role"}


def test_approval_request_model_matches_the_ddl():
    table = ApprovalRequest.__table__
    assert table.name == "approval_requests"
    assert _fk(table.c.requester_id).ondelete == "CASCADE"
    assert _fk(table.c.project_id).ondelete == "CASCADE"
    assert _fk(table.c.decided_by).ondelete == "SET NULL"
    assert _fk(table.c.superseded_by_id).ondelete == "SET NULL"
    assert _fk(table.c.superseded_by_id).target_fullname == "approval_requests.id"
    assert table.c.assignment_id.foreign_keys == set()
    for name in (
        "approval_requests_level_check",
        "approval_requests_status_check",
        "approval_requests_close_reason_check",
    ):
        _assert_check(ApprovalRequest, name, APPROVAL_REQUESTS_TABLE_SQL)
    indexes = {i.name: i for i in table.indexes}
    assert set(indexes) == {
        "idx_approval_requests_project_status",
        "idx_approval_requests_requester_status",
        "idx_approval_requests_pending",
    }
    where = indexes["idx_approval_requests_pending"].dialect_options["postgresql"]["where"]
    assert str(where) == "status = 'pending'"


def test_personal_todos_are_gone():
    # Removed in 2.0.0 (never shipped): no model, no table in any DDL source.
    import app.models as models

    assert "Todo" not in models.__all__
    for name, sql in _full_sources().items():
        assert "todos" not in sql, name
    assert "todos" not in MIGRATION.read_text()


def test_user_role_references_roles_key():
    table = User.__table__
    fk = _fk(table.c.role)
    assert fk.target_fullname == "roles.key"
    assert fk.onupdate == "CASCADE" and fk.ondelete == "RESTRICT"
    assert fk.constraint.name == "users_role_fkey"
    assert not any(isinstance(c, CheckConstraint) for c in table.constraints)
    assert not hasattr(User, "can_modify_site")


@pytest.mark.parametrize(
    "model", [ProjectAssignment, PhaseStaffAssignment, SubphaseStaffAssignment]
)
def test_assignment_models_carry_the_approval_columns(model):
    table = model.__table__
    name = table.name
    assert name in ASSIGNMENT_APPROVAL_TABLES
    assert table.c.approval_status.nullable is False
    assert table.c.approval_status.type.length == 10
    assert table.c.approval_status.server_default.arg == "approved"
    fk = _fk(table.c.approval_request_id)
    assert fk.target_fullname == "approval_requests.id"
    assert fk.ondelete == "SET NULL"
    assert fk.constraint.name == f"{name}_approval_request_id_fkey"
    statement = next(
        s for s in ASSIGNMENT_APPROVAL_COLUMN_STATEMENTS if f"'{name}'" in s and "status" in s
    )
    text = str(_check_constraint(model, f"{name}_approval_status_check").sqltext)
    assert f"CHECK ({text})" in _norm(statement)


def test_sso_config_model_has_no_default_role_check():
    names = {c.name for c in SSOConfig.__table__.constraints}
    assert "sso_config_default_role_check" not in names
    assert "sso_config_singleton" in names


def test_models_package_exports_the_rbac_models():
    import app.models as models

    expected = {
        "Role": "app.models.rbac",
        "RolePermission": "app.models.rbac",
        "ApprovalPolicy": "app.models.rbac",
        "ApprovalPolicyRole": "app.models.rbac",
        "ApprovalRequest": "app.models.rbac",
    }
    for name, module in expected.items():
        assert name in models.__all__
        assert getattr(models, name).__module__ == module


def test_transient_role_has_no_permissions():
    role = Role(key="team_lead", name="Team Lead")
    assert role.permissions == []
    assert role.permission_modes == {}
    role.permissions = [
        RolePermission(permission="projects.create", mode="allow"),
        RolePermission(permission="assignments.self_create", mode="approval"),
    ]
    assert role.permission_modes == {
        "projects.create": "allow",
        "assignments.self_create": "approval",
    }
    policy = ApprovalPolicy(action="assignments.self_create")
    assert policy.role_ids == []
    policy.roles = [Role(id=4, key="b", name="B"), Role(id=2, key="a", name="A")]
    assert policy.role_ids == [2, 4]


def test_model_helpers():
    assert repr(Role(key="user", name="User")) == "<Role user>"
    row = RolePermission(role_id=2, permission="kanban.comment", mode="allow")
    assert repr(row) == "<RolePermission 2 kanban.comment=allow>"
    policy = ApprovalPolicy(action="assignments.self_create", pm_approves=True)
    assert repr(policy) == "<ApprovalPolicy assignments.self_create pm=True>"
    request = ApprovalRequest(id=7, action="assignments.self_create", status="pending")
    assert request.is_pending
    assert repr(request) == "<ApprovalRequest 7 assignments.self_create pending>"
    request.status = "approved"
    assert not request.is_pending
