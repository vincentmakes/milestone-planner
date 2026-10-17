"""
Master database manager (app/services/master_db.py).

Engine/session-factory laziness, connection retry with backoff, the
idempotent auto-migrations (driven by a recording fake connection that
answers the ``information_schema`` probes), session commit/rollback,
``verify_admin_exists`` and the ``get_master_db`` dependency.
"""

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.tenant import AdminUser
from app.services import master_db as mdb_module
from app.services.encryption import verify_password
from app.services.master_db import MasterDatabase
from tests.support import scalar_result


class RecordingConn:
    """Fake AsyncConnection: records each SQL string, answers EXISTS probes."""

    def __init__(self, exists: bool = False, fail_on: str | None = None):
        self.exists = exists
        self.fail_on = fail_on
        self.statements: list[str] = []

    async def execute(self, statement, params=None):
        sql = str(statement)
        self.statements.append(sql)
        if self.fail_on and self.fail_on in sql:
            raise RuntimeError(f"failed on {self.fail_on}")
        result = MagicMock()
        result.scalar.return_value = self.exists
        return result

    def ran(self, fragment: str) -> bool:
        return any(fragment in s for s in self.statements)


class FakeEngine:
    def __init__(self, conns: list[RecordingConn], connect_errors: int = 0):
        self._conns = list(conns)
        self.connect_errors = connect_errors
        self.connect_attempts = 0
        self.dispose = AsyncMock()

    @asynccontextmanager
    async def connect(self):
        self.connect_attempts += 1
        if self.connect_attempts <= self.connect_errors:
            raise OSError("connection refused")
        yield RecordingConn(exists=True)

    @asynccontextmanager
    async def begin(self):
        yield self._conns.pop(0)


def manager_with(engine) -> MasterDatabase:
    mdb = MasterDatabase()
    mdb._engine = engine
    return mdb


# ---------------------------------------------------------------------------
# Lazy engine / session factory
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("master_url", "expected"),
    [
        ("postgresql+asyncpg://m:p@master:5432/milestone_master", "milestone_master"),
        (None, "milestone_dev"),  # single-tenant: falls back to the main database
    ],
)
def test_engine_is_created_once_from_the_right_url(master_url, expected):
    settings = SimpleNamespace(
        master_async_database_url=master_url,
        async_database_url="postgresql+asyncpg://u:p@db:5432/milestone_dev",
    )
    mdb = MasterDatabase()
    with (
        patch.object(mdb_module, "get_settings", return_value=settings),
        patch.object(mdb_module, "create_async_engine", return_value="engine") as create,
    ):
        assert mdb.engine == "engine"
        assert mdb.engine == "engine"

    create.assert_called_once()
    assert create.call_args.args[0].endswith(expected)
    assert create.call_args.kwargs["pool_pre_ping"] is True
    assert create.call_args.kwargs["connect_args"] == {"server_settings": {"timezone": "UTC"}}


def test_session_factory_is_bound_and_cached():
    mdb = manager_with("engine")
    with patch.object(mdb_module, "async_sessionmaker", return_value="factory") as maker:
        assert mdb.session_factory == "factory"
        assert mdb.session_factory == "factory"
    maker.assert_called_once()
    assert maker.call_args.kwargs["bind"] == "engine"


# ---------------------------------------------------------------------------
# init_db
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_init_db_verifies_connection_migrates_once():
    mdb = manager_with(FakeEngine([]))
    with patch.object(mdb, "_apply_pending_migrations", AsyncMock()) as migrate:
        await mdb.init_db()
        await mdb.init_db()  # already initialized: no second round

    migrate.assert_awaited_once()
    assert mdb._initialized is True
    assert mdb._engine.connect_attempts == 1


@pytest.mark.asyncio
async def test_init_db_retries_with_exponential_backoff():
    engine = FakeEngine([], connect_errors=2)
    mdb = manager_with(engine)
    sleep = AsyncMock()
    with (
        patch.object(mdb_module, "asyncio", SimpleNamespace(sleep=sleep)),
        patch.object(mdb, "_apply_pending_migrations", AsyncMock()),
    ):
        await mdb.init_db()

    assert engine.connect_attempts == 3
    assert [c.args[0] for c in sleep.await_args_list] == [2, 4]
    assert mdb._initialized is True


@pytest.mark.asyncio
async def test_init_db_gives_up_after_five_attempts():
    engine = FakeEngine([], connect_errors=99)
    mdb = manager_with(engine)
    sleep = AsyncMock()
    with (
        patch.object(mdb_module, "asyncio", SimpleNamespace(sleep=sleep)),
        patch.object(mdb, "_apply_pending_migrations", AsyncMock()) as migrate,
        pytest.raises(OSError),
    ):
        await mdb.init_db()

    assert engine.connect_attempts == 5
    assert [c.args[0] for c in sleep.await_args_list] == [2, 4, 8, 16]
    migrate.assert_not_awaited()
    assert mdb._initialized is False


# ---------------------------------------------------------------------------
# _apply_pending_migrations
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_migrations_on_an_old_master_create_everything():
    core, optional = RecordingConn(), RecordingConn(exists=False)
    await manager_with(FakeEngine([core, optional]))._apply_pending_migrations()

    assert core.ran('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
    assert core.ran("CREATE TABLE IF NOT EXISTS admin_users")
    assert core.ran("CREATE TABLE IF NOT EXISTS admin_sessions")
    assert core.ran("idx_admin_sessions_expired")
    for fragment in (
        "CREATE TABLE organizations",
        "idx_organizations_slug",
        "CREATE TABLE organization_sso_config",
        "ALTER TABLE tenants ADD COLUMN organization_id",
        "idx_tenants_organization_id",
        "ALTER TABLE tenants ADD COLUMN required_group_ids",
        "ALTER TABLE tenants ADD COLUMN group_membership_mode",
        "ALTER TABLE admin_users ADD COLUMN must_change_password",
    ):
        assert optional.ran(fragment), fragment


@pytest.mark.asyncio
async def test_migrations_on_a_current_master_only_probe():
    core, optional = RecordingConn(), RecordingConn(exists=True)
    await manager_with(FakeEngine([core, optional]))._apply_pending_migrations()

    assert len(optional.statements) == 6  # six EXISTS probes, nothing else
    assert all("SELECT EXISTS" in s for s in optional.statements)
    assert not optional.ran("CREATE TABLE") and not optional.ran("ALTER TABLE")


@pytest.mark.asyncio
async def test_optional_migration_failure_is_logged_not_raised():
    core = RecordingConn()
    optional = RecordingConn(exists=False, fail_on="CREATE TABLE organization_sso_config")
    await manager_with(FakeEngine([core, optional]))._apply_pending_migrations()

    assert optional.ran("CREATE TABLE organizations")
    assert not optional.ran("ALTER TABLE tenants")  # stopped at the failure


@pytest.mark.asyncio
async def test_core_table_failure_is_fatal():
    core = RecordingConn(fail_on="admin_sessions")
    with pytest.raises(RuntimeError):
        await manager_with(FakeEngine([core, RecordingConn()]))._apply_pending_migrations()


# ---------------------------------------------------------------------------
# close / session / get_master_db
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_close_disposes_and_resets_state():
    engine = FakeEngine([])
    mdb = manager_with(engine)
    mdb._session_factory = "factory"
    mdb._initialized = True

    await mdb.close()

    engine.dispose.assert_awaited_once()
    assert (mdb._engine, mdb._session_factory, mdb._initialized) == (None, None, False)
    await mdb.close()  # no engine: no-op
    engine.dispose.assert_awaited_once()


def session_factory_yielding(session):
    @asynccontextmanager
    async def factory():
        yield session

    return factory


@pytest.mark.asyncio
async def test_session_commits_on_success(mock_db_session):
    mdb = MasterDatabase()
    mdb._session_factory = session_factory_yielding(mock_db_session)

    async with mdb.session() as s:
        assert s is mock_db_session

    mock_db_session.commit.assert_awaited_once()
    mock_db_session.rollback.assert_not_awaited()


@pytest.mark.asyncio
async def test_session_rolls_back_and_reraises(mock_db_session):
    mdb = MasterDatabase()
    mdb._session_factory = session_factory_yielding(mock_db_session)

    with pytest.raises(ValueError):
        async with mdb.session():
            raise ValueError("bad write")

    mock_db_session.rollback.assert_awaited_once()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_get_master_db_yields_a_session_that_rolls_back_on_error(mock_db_session):
    mdb = MasterDatabase()
    mdb._session_factory = session_factory_yielding(mock_db_session)
    with patch.object(mdb_module, "master_db", mdb):
        gen = mdb_module.get_master_db()
        assert await gen.__anext__() is mock_db_session
        with pytest.raises(LookupError):
            await gen.athrow(LookupError("route failed"))

    mock_db_session.rollback.assert_awaited_once()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_get_master_db_commits_after_success(mock_db_session):
    mdb = MasterDatabase()
    mdb._session_factory = session_factory_yielding(mock_db_session)
    with patch.object(mdb_module, "master_db", mdb):
        gen = mdb_module.get_master_db()
        await gen.__anext__()
        with pytest.raises(StopAsyncIteration):
            await gen.__anext__()

    mock_db_session.commit.assert_awaited_once()


# ---------------------------------------------------------------------------
# verify_admin_exists
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_first_start_creates_a_superadmin_that_must_change_password(mock_db_session):
    mock_db_session.execute.return_value = scalar_result(0)
    mdb = MasterDatabase()
    mdb._session_factory = session_factory_yielding(mock_db_session)

    with patch("app.services.encryption.generate_password", return_value="Gen3rated-Pass!"):
        await mdb.verify_admin_exists()

    mock_db_session.add.assert_called_once()
    admin = mock_db_session.add.call_args.args[0]
    assert isinstance(admin, AdminUser)
    assert admin.email == "admin@milestone.local"
    assert admin.role == "superadmin"
    assert admin.active == 1
    assert admin.must_change_password == 1
    assert admin.password_hash != "Gen3rated-Pass!"
    assert verify_password("Gen3rated-Pass!", admin.password_hash)
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_existing_admins_are_left_alone(mock_db_session):
    mock_db_session.execute.return_value = scalar_result(2)
    mdb = MasterDatabase()
    mdb._session_factory = session_factory_yielding(mock_db_session)

    await mdb.verify_admin_exists()

    mock_db_session.add.assert_not_called()
