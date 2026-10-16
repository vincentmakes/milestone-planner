"""
Default (single-tenant) database plumbing in app/database.py.

Lazy engine / session-factory creation from settings, the request-scoped
``get_db`` (commit on success, rollback on error), the read-only variant,
``get_db_context``, init/close, and the legacy ``TenantDatabaseManager``.
No real database: ``create_async_engine`` and the session factory are faked.
"""

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app import database
from app.config import Settings


@pytest.fixture
def no_engine(monkeypatch):
    """Start every test with the module-level engine/factory unset."""
    monkeypatch.setattr(database, "_engine", None)
    monkeypatch.setattr(database, "_async_session_factory", None)


def factory_yielding(session):
    @asynccontextmanager
    async def factory():
        yield session

    return factory


def plain_request():
    return SimpleNamespace(state=SimpleNamespace())


# ---------------------------------------------------------------------------
# Engine and session factory
# ---------------------------------------------------------------------------


def test_get_engine_is_created_once_from_settings(no_engine):
    settings = Settings(
        db_host="db.internal",
        db_port=6543,
        db_name="milestone_x",
        db_user="u",
        db_password="p",
        db_pool_size=7,
        db_pool_max_overflow=3,
        db_pool_timeout=12,
        database_url=None,
    )
    engine = MagicMock()
    with (
        patch.object(database, "get_settings", return_value=settings),
        patch.object(database, "create_async_engine", return_value=engine) as create,
    ):
        assert database.get_engine() is engine
        assert database.get_engine() is engine

    create.assert_called_once()
    url = create.call_args.args[0]
    assert url.startswith("postgresql+asyncpg://") and "db.internal:6543/milestone_x" in url
    kwargs = create.call_args.kwargs
    assert kwargs["pool_size"] == 7
    assert kwargs["max_overflow"] == 3
    assert kwargs["pool_timeout"] == 12
    assert kwargs["connect_args"] == {"server_settings": {"timezone": "UTC"}}


def test_get_session_factory_is_bound_to_the_engine_and_cached(no_engine):
    engine = MagicMock()
    with (
        patch.object(database, "get_engine", return_value=engine),
        patch.object(database, "async_sessionmaker", return_value="factory") as maker,
    ):
        assert database.get_session_factory() == "factory"
        assert database.get_session_factory() == "factory"

    maker.assert_called_once()
    assert maker.call_args.kwargs["bind"] is engine
    assert maker.call_args.kwargs["expire_on_commit"] is False
    assert maker.call_args.kwargs["autoflush"] is False


# ---------------------------------------------------------------------------
# resolve_tenant_session_factory
# ---------------------------------------------------------------------------


def test_no_tenant_context_resolves_to_none():
    assert database.resolve_tenant_session_factory(plain_request()) is None
    assert database.resolve_tenant_session_factory(SimpleNamespace()) is None
    request = SimpleNamespace(state=SimpleNamespace(tenant_slug=None))
    assert database.resolve_tenant_session_factory(request) is None


def test_tenant_with_pool_resolves_to_its_factory():
    request = SimpleNamespace(state=SimpleNamespace(tenant_slug="acme"))
    with patch(
        "app.services.tenant_manager.tenant_connection_manager.get_session_factory",
        return_value="acme-factory",
    ) as lookup:
        assert database.resolve_tenant_session_factory(request) == "acme-factory"
    lookup.assert_called_once_with("acme")


def test_tenant_without_pool_is_503_never_the_default_db():
    request = SimpleNamespace(state=SimpleNamespace(tenant_slug="acme"))
    with (
        patch(
            "app.services.tenant_manager.tenant_connection_manager.get_session_factory",
            return_value=None,
        ),
        pytest.raises(HTTPException) as exc,
    ):
        database.resolve_tenant_session_factory(request)
    assert exc.value.status_code == 503


# ---------------------------------------------------------------------------
# get_db / get_db_readonly / get_db_context
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_db_commits_after_a_successful_request(mock_db_session):
    with patch.object(
        database, "get_session_factory", return_value=factory_yielding(mock_db_session)
    ):
        gen = database.get_db(plain_request())
        assert await gen.__anext__() is mock_db_session
        with pytest.raises(StopAsyncIteration):
            await gen.__anext__()

    mock_db_session.commit.assert_awaited_once()
    mock_db_session.rollback.assert_not_awaited()


@pytest.mark.asyncio
async def test_get_db_rolls_back_and_reraises_on_error(mock_db_session):
    with patch.object(
        database, "get_session_factory", return_value=factory_yielding(mock_db_session)
    ):
        gen = database.get_db(plain_request())
        await gen.__anext__()
        with pytest.raises(ValueError, match="handler failed"):
            await gen.athrow(ValueError("handler failed"))

    mock_db_session.rollback.assert_awaited_once()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_get_db_prefers_the_tenant_factory(mock_db_session):
    request = SimpleNamespace(state=SimpleNamespace(tenant_slug="acme"))
    with (
        patch(
            "app.services.tenant_manager.tenant_connection_manager.get_session_factory",
            return_value=factory_yielding(mock_db_session),
        ),
        patch.object(database, "get_session_factory", side_effect=AssertionError("default DB")),
    ):
        gen = database.get_db(request)
        assert await gen.__anext__() is mock_db_session
        await gen.aclose()


@pytest.mark.asyncio
async def test_get_db_readonly_never_commits_or_rolls_back(mock_db_session):
    with patch.object(
        database, "get_session_factory", return_value=factory_yielding(mock_db_session)
    ):
        gen = database.get_db_readonly(plain_request())
        assert await gen.__anext__() is mock_db_session
        with pytest.raises(StopAsyncIteration):
            await gen.__anext__()

    mock_db_session.commit.assert_not_awaited()
    mock_db_session.rollback.assert_not_awaited()


@pytest.mark.asyncio
async def test_get_db_context_commits_and_closes(mock_db_session):
    with patch.object(
        database, "get_session_factory", return_value=factory_yielding(mock_db_session)
    ):
        async with database.get_db_context() as session:
            assert session is mock_db_session

    mock_db_session.commit.assert_awaited_once()
    mock_db_session.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_get_db_context_rolls_back_closes_and_reraises(mock_db_session):
    with (
        patch.object(
            database, "get_session_factory", return_value=factory_yielding(mock_db_session)
        ),
        pytest.raises(RuntimeError, match="task failed"),
    ):
        async with database.get_db_context():
            raise RuntimeError("task failed")

    mock_db_session.rollback.assert_awaited_once()
    mock_db_session.commit.assert_not_awaited()
    mock_db_session.close.assert_awaited_once()


# ---------------------------------------------------------------------------
# init_db / close_db
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_init_db_runs_a_connectivity_check():
    conn = MagicMock()
    conn.run_sync = AsyncMock()

    @asynccontextmanager
    async def begin():
        yield conn

    engine = MagicMock()
    engine.begin = begin
    with patch.object(database, "get_engine", return_value=engine):
        await database.init_db()

    conn.run_sync.assert_awaited_once()


@pytest.mark.asyncio
async def test_init_db_propagates_connection_errors():
    @asynccontextmanager
    async def begin():
        raise OSError("connection refused")
        yield  # pragma: no cover

    engine = MagicMock()
    engine.begin = begin
    with patch.object(database, "get_engine", return_value=engine), pytest.raises(OSError):
        await database.init_db()


@pytest.mark.asyncio
async def test_close_db_disposes_and_resets(monkeypatch):
    engine = MagicMock()
    engine.dispose = AsyncMock()
    monkeypatch.setattr(database, "_engine", engine)
    monkeypatch.setattr(database, "_async_session_factory", "factory")

    await database.close_db()

    engine.dispose.assert_awaited_once()
    assert database._engine is None
    assert database._async_session_factory is None

    await database.close_db()  # idempotent without an engine
    engine.dispose.assert_awaited_once()


# ---------------------------------------------------------------------------
# TenantDatabaseManager (legacy per-tenant engines)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tenant_database_manager_reuses_engine_per_slug(mock_db_session):
    engines: list[MagicMock] = []

    def make_engine(url, **kwargs):
        engine = MagicMock(url=url, kwargs=kwargs)
        engine.dispose = AsyncMock()
        engines.append(engine)
        return engine

    mgr = database.TenantDatabaseManager()
    with (
        patch.object(database, "create_async_engine", side_effect=make_engine),
        patch.object(
            database,
            "async_sessionmaker",
            side_effect=lambda **kw: factory_yielding(mock_db_session),
        ),
    ):
        for _ in range(2):
            gen = mgr.get_tenant_session("postgresql+asyncpg://a/acme", "acme")
            assert await gen.__anext__() is mock_db_session
            with pytest.raises(StopAsyncIteration):
                await gen.__anext__()
        gen = mgr.get_tenant_session("postgresql+asyncpg://b/globex", "globex")
        await gen.__anext__()
        await gen.aclose()

    assert [e.url for e in engines] == [
        "postgresql+asyncpg://a/acme",
        "postgresql+asyncpg://b/globex",
    ]
    assert engines[0].kwargs["pool_size"] == 5
    assert engines[0].kwargs["pool_pre_ping"] is True
    # Two sessions ran to completion and committed; the third was closed early
    # (GeneratorExit is not an Exception: no commit, no rollback, still closed).
    assert mock_db_session.commit.await_count == 2
    mock_db_session.rollback.assert_not_awaited()
    assert mock_db_session.close.await_count == 3

    await mgr.close_tenant("acme")
    engines[0].dispose.assert_awaited_once()
    assert set(mgr._engines) == {"globex"}
    await mgr.close_tenant("unknown")  # no-op

    await mgr.close_all()
    engines[1].dispose.assert_awaited_once()
    assert mgr._engines == {} and mgr._session_factories == {}


@pytest.mark.asyncio
async def test_tenant_database_manager_rolls_back_on_error(mock_db_session):
    mgr = database.TenantDatabaseManager()
    with (
        patch.object(database, "create_async_engine", return_value=MagicMock()),
        patch.object(
            database, "async_sessionmaker", return_value=factory_yielding(mock_db_session)
        ),
    ):
        gen = mgr.get_tenant_session("postgresql+asyncpg://a/acme", "acme")
        await gen.__anext__()
        with pytest.raises(KeyError):
            await gen.athrow(KeyError("boom"))

    mock_db_session.rollback.assert_awaited_once()
    mock_db_session.commit.assert_not_awaited()
    mock_db_session.close.assert_awaited_once()
