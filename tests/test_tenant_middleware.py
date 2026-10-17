"""
TenantMiddleware (app/middleware/tenant.py), driven as a raw ASGI app.

``/t/{slug}/...`` is resolved through a 60 s cache into ``scope["state"]``
(a plain dict) and the path is rewritten before routing; unknown, inactive
and unreachable tenants get 404 / 403 / 503 without reaching the app.
WebSocket scopes pass through untouched (the WS handler resolves the tenant).
"""

import json
from contextlib import asynccontextmanager
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.middleware import tenant as tenant_mw

INFO = {
    "id": "uuid-1",
    "name": "Acme",
    "slug": "acme",
    "status": "active",
    "database_name": "milestone_acme",
    "database_user": "acme_user",
    "encrypted_password": "iv:tag:ct",
}


@pytest.fixture(autouse=True)
def empty_cache():
    tenant_mw.clear_tenant_cache()
    yield
    tenant_mw.clear_tenant_cache()


def recording_app():
    scopes: list[dict] = []

    async def app(scope, receive, send):
        scopes.append(scope)
        if scope["type"] == "http":
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

    app.scopes = scopes  # type: ignore[attr-defined]
    return app


async def call(middleware, scope):
    sent: list[dict] = []

    async def receive():
        return {"type": "http.request", "body": b""}

    async def send(message):
        sent.append(message)

    await middleware(scope, receive, send)
    status = next((m["status"] for m in sent if m["type"] == "http.response.start"), None)
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, body


def http(path, state=None):
    scope = {"type": "http", "method": "GET", "path": path, "headers": [], "query_string": b""}
    if state is not None:
        scope["state"] = state
    return scope


def orm_tenant(slug="acme", status="active", credentials="iv:tag:ct"):
    return SimpleNamespace(
        id="uuid-1",
        name="Acme",
        slug=slug,
        status=status,
        database_name=f"milestone_{slug}",
        database_user=f"{slug}_user",
        credentials=SimpleNamespace(encrypted_password=credentials) if credentials else None,
    )


def master_session_returning(tenant):
    session = MagicMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = tenant
    session.execute = AsyncMock(return_value=result)

    @asynccontextmanager
    async def factory():
        yield session

    return factory, session


# ---------------------------------------------------------------------------
# extract_tenant_slug
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/t/acme/api/projects", ("acme", "/api/projects")),
        ("/t/acme", ("acme", "/")),
        ("/t/acme/", ("acme", "/")),
        ("/t/a/ws", ("a", "/ws")),
        ("/t/my-org-2/api/x", ("my-org-2", "/api/x")),
        ("/t/-bad/api", (None, "/t/-bad/api")),
        ("/t/bad-/api", (None, "/t/bad-/api")),
        ("/t/UPPER/api", (None, "/t/UPPER/api")),
        ("/api/projects", (None, "/api/projects")),
    ],
)
def test_extract_tenant_slug(path, expected):
    assert tenant_mw.extract_tenant_slug(path) == expected


# ---------------------------------------------------------------------------
# get_tenant_info_cached
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hit_is_flattened_to_primitives_and_cached():
    factory, session = master_session_returning(orm_tenant())
    with patch.object(tenant_mw.master_db, "session", factory):
        first = await tenant_mw.get_tenant_info_cached("acme")
        second = await tenant_mw.get_tenant_info_cached("acme")

    assert first == INFO
    assert second is first
    assert session.execute.await_count == 1


@pytest.mark.asyncio
async def test_tenant_without_credentials_has_no_password():
    factory, _ = master_session_returning(orm_tenant(credentials=None))
    with patch.object(tenant_mw.master_db, "session", factory):
        info = await tenant_mw.get_tenant_info_cached("acme")
    assert info["encrypted_password"] is None


@pytest.mark.asyncio
async def test_hit_expires_after_the_ttl():
    factory, session = master_session_returning(orm_tenant())
    with patch.object(tenant_mw.master_db, "session", factory):
        await tenant_mw.get_tenant_info_cached("acme")
        later = tenant_mw.utcnow_naive() + timedelta(seconds=tenant_mw._cache_ttl + 1)
        with patch.object(tenant_mw, "utcnow_naive", return_value=later):
            await tenant_mw.get_tenant_info_cached("acme")

    assert session.execute.await_count == 2


@pytest.mark.asyncio
async def test_a_tenant_that_disappears_is_evicted_and_negatively_cached():
    factory, session = master_session_returning(orm_tenant())
    with patch.object(tenant_mw.master_db, "session", factory):
        await tenant_mw.get_tenant_info_cached("acme")
        session.execute.return_value.scalar_one_or_none.return_value = None
        later = tenant_mw.utcnow_naive() + timedelta(seconds=tenant_mw._cache_ttl + 1)
        with patch.object(tenant_mw, "utcnow_naive", return_value=later):
            assert await tenant_mw.get_tenant_info_cached("acme") is None

    assert "acme" not in tenant_mw._tenant_cache
    assert "acme" in tenant_mw._negative_cache


@pytest.mark.asyncio
async def test_clear_one_slug_keeps_the_others():
    factory, session = master_session_returning(orm_tenant())
    with patch.object(tenant_mw.master_db, "session", factory):
        await tenant_mw.get_tenant_info_cached("acme")
        await tenant_mw.get_tenant_info_cached("globex")
    tenant_mw._negative_cache["ghost"] = tenant_mw.utcnow_naive()

    tenant_mw.clear_tenant_cache("acme")

    assert "acme" not in tenant_mw._tenant_cache
    assert "globex" in tenant_mw._tenant_cache
    assert "ghost" in tenant_mw._negative_cache

    tenant_mw.clear_tenant_cache()
    assert tenant_mw._tenant_cache == {} and tenant_mw._negative_cache == {}


# ---------------------------------------------------------------------------
# TenantMiddleware — passthrough
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_websocket_scope_is_passed_through_untouched():
    app = recording_app()
    scope = {"type": "websocket", "path": "/t/acme/ws"}
    with patch.object(tenant_mw, "get_tenant_info_cached", AsyncMock()) as lookup:
        await tenant_mw.TenantMiddleware(app)(scope, AsyncMock(), AsyncMock())

    assert app.scopes == [scope]
    assert app.scopes[0]["path"] == "/t/acme/ws"
    lookup.assert_not_awaited()


@pytest.mark.asyncio
async def test_lifespan_scope_is_passed_through():
    app = recording_app()
    scope = {"type": "lifespan"}
    await tenant_mw.TenantMiddleware(app)(scope, AsyncMock(), AsyncMock())
    assert app.scopes == [scope]


@pytest.mark.asyncio
async def test_non_tenant_path_gets_an_empty_tenant_context():
    app = recording_app()
    with patch.object(tenant_mw, "get_tenant_info_cached", AsyncMock()) as lookup:
        status, body = await call(tenant_mw.TenantMiddleware(app), http("/api/health"))

    assert (status, body) == (200, b"ok")
    (seen,) = app.scopes
    assert seen["path"] == "/api/health"
    assert seen["state"] == {"tenant": None, "tenant_slug": None}
    lookup.assert_not_awaited()


@pytest.mark.asyncio
async def test_existing_state_dict_is_kept_for_non_tenant_paths():
    app = recording_app()
    await call(tenant_mw.TenantMiddleware(app), http("/", state={"other": 1}))
    assert app.scopes[0]["state"] == {"other": 1, "tenant": None, "tenant_slug": None}


@pytest.mark.asyncio
async def test_invalid_slug_is_passed_through_unresolved():
    app = recording_app()
    with patch.object(tenant_mw, "get_tenant_info_cached", AsyncMock()) as lookup:
        status, _ = await call(tenant_mw.TenantMiddleware(app), http("/t/-nope/api/x"))

    assert status == 200
    assert app.scopes[0]["path"] == "/t/-nope/api/x"
    lookup.assert_not_awaited()


# ---------------------------------------------------------------------------
# TenantMiddleware — resolution
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_active_tenant_rewrites_path_and_fills_state():
    app = recording_app()
    engine = object()
    with (
        patch.object(tenant_mw, "get_tenant_info_cached", AsyncMock(return_value=INFO)),
        patch.object(
            tenant_mw.tenant_connection_manager,
            "get_pool_from_info",
            AsyncMock(return_value=engine),
        ) as pool,
    ):
        status, body = await call(
            tenant_mw.TenantMiddleware(app), http("/t/acme/api/projects", state={})
        )

    assert (status, body) == (200, b"ok")
    pool.assert_awaited_once_with(INFO)
    (seen,) = app.scopes
    assert seen["path"] == "/api/projects"
    assert seen["raw_path"] == b"/api/projects"
    assert seen["state"] == {"tenant": INFO, "tenant_slug": "acme", "tenant_engine": engine}


@pytest.mark.asyncio
async def test_tenant_without_credentials_skips_the_pool():
    app = recording_app()
    info = {**INFO, "encrypted_password": None}
    with (
        patch.object(tenant_mw, "get_tenant_info_cached", AsyncMock(return_value=info)),
        patch.object(
            tenant_mw.tenant_connection_manager, "get_pool_from_info", AsyncMock()
        ) as pool,
    ):
        status, _ = await call(tenant_mw.TenantMiddleware(app), http("/t/acme/"))

    assert status == 200
    pool.assert_not_awaited()
    assert app.scopes[0]["path"] == "/"
    assert "tenant_engine" not in app.scopes[0]["state"]


@pytest.mark.asyncio
async def test_unknown_tenant_is_404():
    app = recording_app()
    with patch.object(tenant_mw, "get_tenant_info_cached", AsyncMock(return_value=None)):
        status, body = await call(tenant_mw.TenantMiddleware(app), http("/t/ghost/api/x"))

    assert status == 404
    assert json.loads(body) == {
        "error": "Tenant not found",
        "message": "No organization found with identifier: ghost",
    }
    assert app.scopes == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status_value", "message"),
    [
        ("suspended", "This organization has been suspended. Please contact support."),
        ("pending", "This organization is pending activation."),
        ("archived", "This organization has been archived."),
        ("weird", "Organization is not accessible."),
    ],
)
async def test_inactive_tenant_is_403_with_status_message(status_value, message):
    app = recording_app()
    info = {**INFO, "status": status_value}
    with patch.object(tenant_mw, "get_tenant_info_cached", AsyncMock(return_value=info)):
        status, body = await call(tenant_mw.TenantMiddleware(app), http("/t/acme/api/x"))

    assert status == 403
    assert json.loads(body) == {"error": "Tenant not active", "message": message}
    assert app.scopes == []


@pytest.mark.asyncio
async def test_unreachable_tenant_database_is_503():
    app = recording_app()
    with (
        patch.object(tenant_mw, "get_tenant_info_cached", AsyncMock(return_value=INFO)),
        patch.object(
            tenant_mw.tenant_connection_manager,
            "get_pool_from_info",
            AsyncMock(side_effect=ConnectionError("refused")),
        ),
    ):
        status, body = await call(tenant_mw.TenantMiddleware(app), http("/t/acme/api/x"))

    assert status == 503
    assert json.loads(body)["error"] == "Database unavailable"
    assert app.scopes == []


@pytest.mark.asyncio
async def test_lookup_failure_is_an_opaque_500():
    app = recording_app()
    with patch.object(
        tenant_mw,
        "get_tenant_info_cached",
        AsyncMock(side_effect=RuntimeError("master db password=hunter2")),
    ):
        status, body = await call(tenant_mw.TenantMiddleware(app), http("/t/acme/api/x"))

    assert status == 500
    assert json.loads(body) == {
        "error": "Internal error",
        "message": "Failed to resolve organization context",
    }
    assert b"hunter2" not in body
