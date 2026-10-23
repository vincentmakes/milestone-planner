"""
Single-tenant upgrade path.

A single-tenant install never creates a tenant pool, so the per-tenant
auto-migrations used to never run there, and get_tenant_schema_sql() (re-run
by AUTO_INIT_DB) only had CREATE TABLE IF NOT EXISTS for the Kanban card
tables -- a pre-1.4 database never got `status` and every GET /projects/{id}
500'd. These tests pin both halves of the fix: the schema carries guarded
in-place upgrades, and the single-tenant lifespan runs the auto-migrations.
"""

import re
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.tenant_provisioner import get_tenant_schema_sql


@pytest.fixture(scope="module")
def schema_sql() -> str:
    return get_tenant_schema_sql()


def _normalized(sql: str) -> str:
    return re.sub(r"\s+", " ", sql)


@pytest.mark.parametrize("table", ["project_phases", "project_subphases"])
def test_schema_adds_card_status_to_existing_tables(schema_sql, table):
    sql = _normalized(schema_sql)
    assert f"ALTER TABLE {table} ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'todo'" in sql
    # Back-filled from completion in the same guarded branch.
    assert f"UPDATE {table} SET status = CASE" in sql
    assert f"ALTER TABLE {table} ADD CONSTRAINT {table}_status_check" in sql


@pytest.mark.parametrize(
    ("table", "column"),
    [
        ("users", "max_capacity"),
        ("users", "is_system"),
        ("users", "updated_at"),
        ("bank_holidays", "end_date"),
        ("bank_holidays", "year"),
        ("company_events", "color"),
        ("company_events", "counts_as_unavailable"),
        ("vacations", "absence_type_id"),
        ("custom_columns", "site_id"),
        ("custom_columns", "display_order"),
        ("custom_columns", "width"),
        ("tags", "group_id"),
        ("tags", "sort_order"),
        ("tags", "all_sites"),
        ("project_assignments", "approval_status"),
        ("project_assignments", "approval_request_id"),
        ("phase_staff_assignments", "approval_status"),
        ("phase_staff_assignments", "approval_request_id"),
        ("subphase_staff_assignments", "approval_status"),
        ("subphase_staff_assignments", "approval_request_id"),
    ],
)
def test_schema_upgrades_every_column_added_after_first_release(schema_sql, table, column):
    """Each column the auto-migration / migrations/*.sql ever added is upgraded in place."""
    sql = _normalized(schema_sql)
    assert re.search(rf"ALTER TABLE {table}\s+ADD COLUMN {column}\b", sql), (table, column)


def test_schema_column_upgrades_are_guarded(schema_sql):
    """Every in-place ADD COLUMN sits in a DO block guarded on information_schema."""
    blocks = re.findall(r"DO \$\$(.*?)END \$\$;", schema_sql, flags=re.S)
    add_column_blocks = [b for b in blocks if "ADD COLUMN" in b]
    assert add_column_blocks
    for block in add_column_blocks:
        assert "information_schema.columns" in block, block


def test_schema_creates_tables_added_by_auto_migrations(schema_sql):
    for table in (
        "tags",
        "project_tags",
        "equipment_blocks",
        "staff_notes",
        "card_comments",
        "notifications",
        "absence_types",
        "company_event_sites",
        "equipment_sites",
        "tag_sites",
        "teams",
        "team_members",
        "project_teams",
        "tag_teams",
        "company_event_teams",
        "equipment_teams",
        "roles",
        "role_permissions",
        "approval_policies",
        "approval_policy_roles",
        "approval_requests",
        "project_fields",
        "project_field_options",
        "project_field_option_sites",
        "project_field_option_teams",
        "project_field_values",
        "project_field_selections",
    ):
        assert f"CREATE TABLE IF NOT EXISTS {table} (" in schema_sql, table


def test_schema_no_longer_creates_tag_groups(schema_sql):
    """Tag groups became project fields in 2.0.0; the tags.group_id upgrade
    block remains but only runs while a tag_groups table exists."""
    assert "CREATE TABLE IF NOT EXISTS tag_groups" not in schema_sql
    blocks = re.findall(r"DO \$\$(.*?)END \$\$;", schema_sql, flags=re.S)
    (group_block,) = (b for b in blocks if "ADD COLUMN group_id" in b)
    assert "to_regclass('public.tag_groups') IS NOT NULL" in group_block


def test_schema_migrates_legacy_notes_table(schema_sql):
    assert "to_regclass('public.notes') IS NOT NULL" in schema_sql
    assert "DROP TABLE notes;" in schema_sql


def test_schema_dollar_quoting_is_balanced(schema_sql):
    assert schema_sql.count("DO $$") == schema_sql.count("END $$;")


def test_status_upgrade_runs_before_its_first_use(schema_sql):
    """The ALTER must follow the CREATE TABLE it upgrades."""
    create = schema_sql.index("CREATE TABLE IF NOT EXISTS project_subphases (")
    alter = schema_sql.index("ALTER TABLE project_subphases ADD COLUMN status")
    assert create < alter


# ---------------------------------------------------------
# Lifespan: single-tenant startup runs the auto-migrations
# ---------------------------------------------------------


def _settings(multi_tenant: bool):
    settings = MagicMock()
    settings.multi_tenant = multi_tenant
    settings.debug = False
    settings.https_proxy = None
    settings.http_proxy = None
    settings.proxy_pac_url = None
    return settings


@asynccontextmanager
async def _patched_startup(multi_tenant: bool, auto_migrate: AsyncMock):
    engine = object()
    master = MagicMock()
    master.init_db = AsyncMock()
    master.verify_admin_exists = AsyncMock()
    master.close = AsyncMock()
    tenant_mgr = MagicMock()
    tenant_mgr.close_all = AsyncMock()
    with (
        patch("app.main.get_settings", return_value=_settings(multi_tenant)),
        patch("app.main.init_db", new=AsyncMock()),
        patch("app.main.close_db", new=AsyncMock()),
        patch("app.services.master_db.master_db", master),
        patch("app.database.get_engine", return_value=engine),
        patch("app.services.tenant_manager.run_single_tenant_auto_migrations", new=auto_migrate),
        patch("app.services.tenant_manager.tenant_connection_manager", tenant_mgr),
    ):
        yield engine


@pytest.mark.asyncio
async def test_single_tenant_lifespan_runs_auto_migrations():
    from app.main import lifespan

    auto_migrate = AsyncMock()
    async with _patched_startup(False, auto_migrate) as engine:
        async with lifespan(MagicMock()):
            pass

    auto_migrate.assert_awaited_once_with(engine)


@pytest.mark.asyncio
async def test_single_tenant_auto_migration_failure_does_not_block_startup():
    from app.main import lifespan

    auto_migrate = AsyncMock(side_effect=RuntimeError("boom"))
    started = False
    async with _patched_startup(False, auto_migrate):
        async with lifespan(MagicMock()):
            started = True

    assert started
    auto_migrate.assert_awaited_once()


@pytest.mark.asyncio
async def test_multi_tenant_lifespan_leaves_auto_migrations_to_tenant_pools():
    from app.main import lifespan

    auto_migrate = AsyncMock()
    async with _patched_startup(True, auto_migrate):
        async with lifespan(MagicMock()):
            pass

    auto_migrate.assert_not_awaited()


@pytest.mark.asyncio
async def test_run_single_tenant_auto_migrations_uses_the_engine_connection():
    from app.services import tenant_manager

    conn = MagicMock()

    @asynccontextmanager
    async def connect():
        yield conn

    engine = MagicMock()
    engine.connect = connect

    with patch.object(
        tenant_manager.tenant_connection_manager, "_run_auto_migrations", new=AsyncMock()
    ) as run:
        await tenant_manager.run_single_tenant_auto_migrations(engine)

    run.assert_awaited_once_with(conn, "single-tenant")
