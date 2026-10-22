"""
TenantConnectionManager (app/services/tenant_manager.py) beyond the pieces
other files already pin (concurrent pool creation, the tag-groups step, the
SSO-secret step, the all-steps-fail path).

Pool lifecycle (decrypt -> URL -> engine -> SELECT 1 -> auto-migrations),
the per-slug session-factory cache, idle cleanup and close_all, and the
auto-migrations against a legacy tenant (every step applies) and a current
tenant (every guarded step is skipped), driven by a scripted fake connection.
"""

import asyncio
from contextlib import asynccontextmanager
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import tenant_manager as tm
from app.services import tenant_provisioner as tp

INFO = {
    "slug": "acme",
    "database_name": "milestone_acme",
    "database_user": "acme_user",
    "encrypted_password": "iv:tag:ct",
}


@pytest.fixture
def mgr():
    return tm.TenantConnectionManager()


def fake_engine(*, select_error: Exception | None = None):
    conn = MagicMock()
    conn.execute = AsyncMock(side_effect=select_error)

    @asynccontextmanager
    async def connect():
        yield conn

    engine = MagicMock()
    engine.connect = connect
    engine.dispose = AsyncMock()
    engine.conn = conn
    return engine


# ---------------------------------------------------------------------------
# _create_pool / get_pool_from_info / get_pool
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_pool_builds_url_tests_connection_and_migrates(mgr):
    engine = fake_engine()
    settings = SimpleNamespace(db_host="pg.internal", db_port=6432)
    with (
        patch.object(tm, "decrypt", return_value="s3cret") as decrypt,
        patch.object(tm, "get_settings", return_value=settings),
        patch.object(tm, "create_async_engine", return_value=engine) as create,
        patch.object(mgr, "_run_auto_migrations", AsyncMock()) as migrate,
    ):
        assert await mgr._create_pool(INFO) is engine

    decrypt.assert_called_once_with("iv:tag:ct")
    assert create.call_args.args[0] == (
        "postgresql+asyncpg://acme_user:s3cret@pg.internal:6432/milestone_acme"
    )
    assert create.call_args.kwargs["pool_size"] == 20
    assert create.call_args.kwargs["max_overflow"] == 10
    # Sessions run in UTC, so CURRENT_TIMESTAMP defaults match utcnow_naive().
    assert create.call_args.kwargs["connect_args"] == {"server_settings": {"timezone": "UTC"}}
    assert "SELECT 1" in str(engine.conn.execute.await_args.args[0])
    migrate.assert_awaited_once_with(engine.conn, "acme")
    engine.dispose.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_pool_wraps_decrypt_failures(mgr):
    with (
        patch.object(tm, "decrypt", side_effect=ValueError("bad tag")),
        patch.object(tm, "create_async_engine") as create,
        pytest.raises(ConnectionError, match="Failed to decrypt credentials for tenant acme"),
    ):
        await mgr._create_pool(INFO)
    create.assert_not_called()


@pytest.mark.asyncio
async def test_create_pool_disposes_the_engine_when_the_db_is_unreachable(mgr):
    engine = fake_engine(select_error=OSError("refused"))
    with (
        patch.object(tm, "decrypt", return_value="pw"),
        patch.object(tm, "get_settings", return_value=SimpleNamespace(db_host="h", db_port=1)),
        patch.object(tm, "create_async_engine", return_value=engine),
        pytest.raises(ConnectionError, match=r"tenant database acme \(milestone_acme\)"),
    ):
        await mgr._create_pool(INFO)

    engine.dispose.assert_awaited_once()


@pytest.mark.asyncio
async def test_get_pool_from_info_caches_per_slug_and_touches_timestamp(mgr):
    engine = object()
    with patch.object(mgr, "_create_pool", AsyncMock(return_value=engine)) as create:
        assert await mgr.get_pool_from_info(INFO) is engine
        first_seen = mgr._pool_timestamps["acme"]
        assert await mgr.get_pool_from_info(INFO) is engine

    create.assert_awaited_once_with(INFO)
    assert mgr._pool_timestamps["acme"] >= first_seen


@pytest.mark.asyncio
async def test_get_pool_wraps_orm_objects(mgr):
    tenant = SimpleNamespace(slug="acme", database_name="milestone_acme", database_user="acme_user")
    creds = SimpleNamespace(encrypted_password="iv:tag:ct")
    with patch.object(mgr, "get_pool_from_info", AsyncMock(return_value="engine")) as get:
        assert await mgr.get_pool(tenant, creds) == "engine"
    get.assert_awaited_once_with(INFO)


# ---------------------------------------------------------------------------
# Session factories, bind lookup, stats
# ---------------------------------------------------------------------------


def test_session_factory_requires_a_pool_and_is_cached(mgr):
    assert mgr.get_session_factory("acme") is None

    engine = MagicMock()
    mgr._pools["acme"] = engine
    with patch.object(tm, "async_sessionmaker", return_value="factory") as maker:
        assert mgr.get_session_factory("acme") == "factory"
        assert mgr.get_session_factory("acme") == "factory"
    maker.assert_called_once()
    assert maker.call_args.kwargs["bind"] is engine


def test_slug_for_bind(mgr):
    a, b = object(), object()
    mgr._pools.update({"acme": a, "globex": b})
    assert mgr.slug_for_bind(b) == "globex"
    assert mgr.slug_for_bind(object()) is None


def test_stats_count_pool_sizes_whatever_their_shape(mgr):
    callable_size = MagicMock()
    callable_size.pool.size = MagicMock(return_value=20)
    attr_size = MagicMock()
    attr_size.pool = SimpleNamespace(size=5)
    broken = MagicMock()
    broken.pool.size = MagicMock(side_effect=RuntimeError("disposed"))
    no_size = MagicMock()
    no_size.pool = SimpleNamespace()
    mgr._pools.update({"a": callable_size, "b": attr_size, "c": broken, "d": no_size})

    assert mgr.get_stats() == {
        "active_pools": 4,
        "pool_slugs": ["a", "b", "c", "d"],
        "total_connections": 25,
    }


# ---------------------------------------------------------------------------
# Idle cleanup / close
# ---------------------------------------------------------------------------


def add_pool(mgr, slug, idle_seconds):
    engine = MagicMock()
    engine.dispose = AsyncMock()
    mgr._pools[slug] = engine
    mgr._session_factories[slug] = "factory"
    mgr._pool_timestamps[slug] = tm.utcnow_naive() - timedelta(seconds=idle_seconds)
    return engine


@pytest.mark.asyncio
async def test_cleanup_closes_only_pools_idle_longer_than_the_limit(mgr):
    idle = add_pool(mgr, "idle", mgr.max_idle_time + 60)
    busy = add_pool(mgr, "busy", 10)

    await mgr._cleanup_idle_pools()

    idle.dispose.assert_awaited_once()
    busy.dispose.assert_not_awaited()
    assert set(mgr._pools) == {"busy"}
    assert "idle" not in mgr._session_factories and "idle" not in mgr._pool_timestamps


@pytest.mark.asyncio
async def test_close_pool_of_unknown_slug_clears_leftover_bookkeeping(mgr):
    mgr._pool_timestamps["ghost"] = tm.utcnow_naive()
    mgr._session_factories["ghost"] = "factory"
    await mgr._close_pool("ghost")
    assert "ghost" not in mgr._pool_timestamps and "ghost" not in mgr._session_factories


@pytest.mark.asyncio
async def test_cleanup_loop_sleeps_then_cleans(mgr):
    calls: list[str] = []

    async def fake_sleep(seconds):
        calls.append(f"sleep {seconds}")
        if len(calls) > 2:
            raise asyncio.CancelledError

    async def fake_cleanup():
        calls.append("cleanup")

    with (
        patch.object(tm, "asyncio", SimpleNamespace(sleep=fake_sleep)),
        patch.object(mgr, "_cleanup_idle_pools", fake_cleanup),
        pytest.raises(asyncio.CancelledError),
    ):
        await mgr._cleanup_loop()

    assert calls == [f"sleep {mgr.cleanup_interval}", "cleanup", f"sleep {mgr.cleanup_interval}"]


@pytest.mark.asyncio
async def test_start_cleanup_task_is_idempotent_and_close_all_cancels_it(mgr):
    a = add_pool(mgr, "a", 0)
    b = add_pool(mgr, "b", 0)

    mgr.start_cleanup_task()
    task = mgr._cleanup_task
    mgr.start_cleanup_task()  # still running: not replaced
    assert mgr._cleanup_task is task
    await asyncio.sleep(0)  # let the loop reach its first sleep

    await mgr.close_all()

    assert task.cancelled()
    a.dispose.assert_awaited_once()
    b.dispose.assert_awaited_once()
    assert mgr._pools == {}


@pytest.mark.asyncio
async def test_close_all_without_a_cleanup_task(mgr):
    engine = add_pool(mgr, "a", 0)
    await mgr.close_all()
    engine.dispose.assert_awaited_once()


# ---------------------------------------------------------------------------
# _run_auto_migrations against a scripted connection
# ---------------------------------------------------------------------------


ALL_KNOWN_NAMES = [
    "tags",
    "project_tags",
    "tag_groups",
    "tag_sites",
    "group_id",
    "all_sites",
    "sort_order",
    "staff_notes",
    "project_phases",
    "project_subphases",
    *tp.TEAM_TABLES,
]


class ScriptedConn:
    """
    Answers the auto-migration probes as a ``legacy`` tenant (nothing exists,
    a legacy ``notes`` table is present) or a ``current`` one (everything
    exists). Records every statement plus COMMIT / ROLLBACK markers.
    """

    def __init__(self, state: str, notes_has_type: bool = True):
        self.state = state
        self.notes_has_type = notes_has_type
        self.log: list[str] = []
        self.commit = AsyncMock(side_effect=lambda: self.log.append("COMMIT"))
        self.rollback = AsyncMock(side_effect=lambda: self.log.append("ROLLBACK"))

    async def execute(self, clause, params=None):
        sql = str(clause)
        self.log.append(sql)
        legacy = self.state == "legacy"
        result = MagicMock()
        result.rowcount = 0
        result.scalar.return_value = None
        result.fetchone.return_value = None if legacy else (1,)
        result.fetchall.return_value = [] if legacy else [(n,) for n in ALL_KNOWN_NAMES]

        if "column_name = 'colors_projects'" in sql:
            result.fetchone.return_value = ("colors_projects",) if legacy else None
        elif "'staff_notes', 'notes'" in sql and legacy:
            result.fetchall.return_value = [("notes",)]
        elif "table_name = 'notes' AND column_name = 'type'" in sql:
            result.fetchone.return_value = (1,) if self.notes_has_type else None
        elif sql in (tp.EQUIPMENT_SITE_FK_NEEDS_FIX_SQL, tp.RBAC_NEEDS_MIGRATION_SQL):
            result.scalar.return_value = legacy
        elif sql == tp.COMPANY_EVENT_SITES_BACKFILL_SQL:
            result.rowcount = 3 if legacy else 0
        elif sql == tp.EQUIPMENT_SITES_BACKFILL_SQL:
            result.rowcount = 2 if legacy else 0
        return result

    def ran(self, fragment: str) -> bool:
        return any(fragment in s for s in self.log)


async def run_migrations(conn):
    with (
        patch.object(tm, "encrypt_tenant_sso_secret", AsyncMock()) as secret,
        patch("app.services.tenant_data_migrations.run_data_migrations", AsyncMock()) as data,
    ):
        await tm.TenantConnectionManager()._run_auto_migrations(conn, "acme")
    secret.assert_awaited_once_with(conn, "acme")
    data.assert_awaited_once_with(conn)


LEGACY_CHANGES = [
    "ALTER TABLE users ADD COLUMN is_system",
    "UPDATE users SET is_system = 1",
    "CREATE TABLE IF NOT EXISTS tags",
    "CREATE TABLE IF NOT EXISTS project_tags",
    "idx_project_tags_tag",
    tp.TAG_GROUPS_TABLE_SQL,
    tp.TAG_SITES_TABLE_SQL,
    *tp.TAG_GROUPS_DROP_COLORS_STATEMENTS,
    "CREATE TABLE IF NOT EXISTS equipment_blocks",
    "idx_equipment_blocks_dates",
    "ALTER TABLE company_events ADD COLUMN IF NOT EXISTS color",
    "CREATE TABLE IF NOT EXISTS staff_notes",
    "DROP TABLE notes",
    "ALTER TABLE project_phases ADD COLUMN IF NOT EXISTS status",
    "ALTER TABLE project_subphases ADD COLUMN IF NOT EXISTS status",
    "project_subphases_status_check",
    "UPDATE project_phases SET status = CASE",
    "CREATE TABLE IF NOT EXISTS card_comments",
    "CREATE TABLE IF NOT EXISTS notifications",
    "idx_notifications_user_unread",
    "CREATE TABLE IF NOT EXISTS absence_types",
    tp.ABSENCE_TYPES_SEED_SQL,
    "ALTER TABLE vacations ADD COLUMN IF NOT EXISTS absence_type_id",
    "CREATE TABLE IF NOT EXISTS company_event_sites",
    tp.EQUIPMENT_SITE_FK_SQL,
    "CREATE TABLE IF NOT EXISTS equipment_sites",
    tp.COMPANY_EVENTS_CLOSURE_COLUMN_SQL,
    *tp.TEAMS_SCHEMA_STATEMENTS,
    # The notification-types widening runs on every pool creation (own gate).
    *(s for s in tp.RBAC_SCHEMA_STATEMENTS if s != tp.NOTIFICATIONS_TYPE_CHECK_SQL),
]


@pytest.mark.asyncio
async def test_legacy_tenant_gets_every_step():
    conn = ScriptedConn("legacy")
    await run_migrations(conn)

    for fragment in LEGACY_CHANGES:
        assert conn.ran(fragment), fragment
    # Legacy notes rows are copied (with their type) before the old table goes.
    copy = next(i for i, s in enumerate(conn.log) if "INSERT INTO staff_notes" in s)
    assert "COALESCE(type, 'general')" in conn.log[copy]
    assert copy < conn.log.index("DROP TABLE notes")
    assert "ROLLBACK" not in conn.log
    assert conn.ran(tp.USERS_IS_RESOURCE_SQL)
    # One commit per step (card status: one per table), 21 in all.
    assert conn.log.count("COMMIT") == 21


@pytest.mark.asyncio
async def test_legacy_notes_without_a_type_column_are_copied_as_general():
    conn = ScriptedConn("legacy", notes_has_type=False)
    await run_migrations(conn)

    (copy,) = (s for s in conn.log if "INSERT INTO staff_notes" in s)
    assert "type" not in copy.split("SELECT")[0]
    assert conn.ran("DROP TABLE notes")


@pytest.mark.asyncio
async def test_current_tenant_only_probes_and_runs_the_idempotent_backfills():
    conn = ScriptedConn("current")
    await run_migrations(conn)

    for fragment in LEGACY_CHANGES:
        assert not conn.ran(fragment), fragment
    # The junction back-fills and FK fix-ups run unconditionally (idempotent SQL).
    assert conn.ran(tp.COMPANY_EVENT_SITES_BACKFILL_SQL)
    assert conn.ran(tp.COMPANY_EVENTS_SITE_NULLABLE_SQL)
    assert conn.ran(tp.COMPANY_EVENTS_SITE_FK_SQL)
    assert conn.ran(tp.EQUIPMENT_SITES_BACKFILL_SQL)
    assert conn.ran(tp.NOTIFICATIONS_TYPE_CHECK_SQL)
    # users.is_resource: its DO block is its own gate, so it always runs.
    assert conn.ran(tp.USERS_IS_RESOURCE_SQL)
    assert "ROLLBACK" not in conn.log
    # Only the two always-run back-fill steps, the users.is_resource step and
    # the notification-types step.
    assert conn.log.count("COMMIT") == 4


@pytest.mark.asyncio
async def test_one_failing_step_does_not_stop_the_others():
    conn = ScriptedConn("legacy")
    original = conn.execute

    async def execute(clause, params=None):
        if "CREATE TABLE IF NOT EXISTS absence_types" in str(clause):
            conn.log.append(str(clause))
            raise RuntimeError("permission denied")
        return await original(clause, params)

    conn.execute = execute
    await run_migrations(conn)

    assert "ROLLBACK" in conn.log  # the absence_types step was rolled back
    assert not conn.ran(tp.ABSENCE_TYPES_SEED_SQL)
    # ...and the later steps still ran.
    assert conn.ran("ALTER TABLE vacations ADD COLUMN IF NOT EXISTS absence_type_id")
    assert conn.ran(tp.COMPANY_EVENTS_CLOSURE_COLUMN_SQL)
