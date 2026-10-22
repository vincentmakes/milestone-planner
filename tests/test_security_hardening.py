"""
Backend security hardening (review package A).

B1-7 docs gate through the tenant session, B1-9/B1-10/B2-15 generic error
bodies, B1-11 no fall-through to the default DB, B1-12 tenant status takes
effect immediately, B1-13 one pool per cold tenant, B1-15 ws-debug admin-only,
B1-16 quoted relation names, B1-18 negative tenant cache, B1-19 WebSocket
Origin check, B1-22 password minimum, B2-25 startup refusal, N1 session
pre-filter, N3 WebSockets closed on revocation.
"""

import asyncio
import json
import re
from contextlib import asynccontextmanager
from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from app.config import DEFAULT_SESSION_SECRET, Settings
from tests.conftest import FakeUser

# ---------------------------------------------------------------------------
# B2-25 — refuse to start on a published SESSION_SECRET
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "secret",
    [
        DEFAULT_SESSION_SECRET,
        "change-me-in-production",
        "change-this-to-a-random-64-character-string-in-production",
        "",
        "   ",
    ],
)
def test_insecure_secret_is_refused_in_production(secret):
    settings = Settings(session_secret=secret, debug=False)
    assert settings.has_insecure_session_secret
    with pytest.raises(RuntimeError, match="SESSION_SECRET"):
        settings.check_startup_security()


def test_insecure_secret_is_tolerated_in_debug():
    Settings(session_secret=DEFAULT_SESSION_SECRET, debug=True).check_startup_security()


def test_random_secret_starts():
    settings = Settings(session_secret="a3f1" * 16, debug=False)
    assert not settings.has_insecure_session_secret
    settings.check_startup_security()


@pytest.mark.asyncio
async def test_lifespan_refuses_before_touching_any_database():
    from app import main

    insecure = Settings(session_secret=DEFAULT_SESSION_SECRET, debug=False)
    init = AsyncMock()
    with (
        patch.object(main, "get_settings", return_value=insecure),
        patch("app.services.master_db.master_db.init_db", init),
        pytest.raises(RuntimeError, match="SESSION_SECRET"),
    ):
        async with main.lifespan(MagicMock()):
            pass
    init.assert_not_awaited()


# ---------------------------------------------------------------------------
# B1-7 — API docs gate resolves the session in the request's tenant DB
# ---------------------------------------------------------------------------


def fake_request(cookie: str | None = "s%3Asid-1.", slug: str | None = None):
    request = MagicMock()
    request.cookies = {"connect.sid": cookie} if cookie else {}
    request.state = MagicMock(spec=["tenant_slug"])
    request.state.tenant_slug = slug
    return request


def tenant_factory(db):
    @asynccontextmanager
    async def factory():
        yield db

    return factory


@pytest.mark.asyncio
async def test_docs_gate_without_tenant_context_in_multi_tenant_never_uses_default_db():
    from app.middleware.auth import get_current_user_from_session

    with (
        patch("app.config.get_settings", return_value=Settings(multi_tenant=True)),
        patch("app.database.get_session_factory", side_effect=AssertionError("default DB")),
    ):
        assert await get_current_user_from_session(fake_request()) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("live_role, expected", [("admin", "admin"), ("user", "user")])
async def test_docs_gate_uses_the_tenant_db_and_the_live_role(live_role, expected):
    from app.middleware.auth import get_current_user_from_session
    from app.services.session import SessionService

    db = MagicMock()
    live = MagicMock()
    live.all.return_value = [(1, live_role, None, None, None)]
    db.execute = AsyncMock(return_value=live)

    with (
        patch(
            "app.services.tenant_manager.tenant_connection_manager.get_session_factory",
            return_value=tenant_factory(db),
        ) as tenant_lookup,
        patch("app.database.get_session_factory", side_effect=AssertionError("default DB")),
        patch.object(
            SessionService,
            "get_user_from_session",
            AsyncMock(return_value={"id": 7, "role": "admin"}),
        ),
    ):
        user = await get_current_user_from_session(fake_request(slug="acme"))

    tenant_lookup.assert_called_once_with("acme")
    assert user["role"] == expected
    # The live role's permissions come with it (docs gate, broadcast fallback).
    assert user["permissions"].role_key == expected
    assert user["permissions"].has("system.api_docs") is (expected == "admin")


@pytest.mark.asyncio
async def test_docs_gate_refuses_a_deactivated_admin():
    from app.middleware.auth import get_current_user_from_session
    from app.services.session import SessionService

    db = MagicMock()
    live = MagicMock()
    live.all.return_value = [(0, "admin", None, None, None)]
    db.execute = AsyncMock(return_value=live)

    with (
        patch("app.database.get_session_factory", return_value=tenant_factory(db)),
        patch.object(SessionService, "get_user_from_session", AsyncMock(return_value={"id": 7})),
    ):
        assert await get_current_user_from_session(fake_request()) is None


@pytest.mark.asyncio
async def test_docs_page_loads_the_schema_relative_to_the_tenant_prefix(test_settings):
    with (
        patch("app.config.get_settings", return_value=test_settings),
        patch(
            "app.middleware.auth.get_current_user_from_session",
            AsyncMock(return_value={"id": 1, "role": "admin"}),
        ),
    ):
        from app.main import create_app

        app = create_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            docs = await c.get("/api/docs")
            redoc = await c.get("/api/redoc")

    assert docs.status_code == 200
    assert "'openapi.json'" in docs.text and "/api/openapi.json" not in docs.text
    assert redoc.status_code == 200
    assert "/api/openapi.json" not in redoc.text


# ---------------------------------------------------------------------------
# B1-9 / B1-10 / B2-15 — no driver errors in response bodies
# ---------------------------------------------------------------------------

DRIVER_ERROR = 'password authentication failed for user "milestone" at 10.0.0.5:5432'


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/health", "/api/health"])
async def test_health_reports_a_generic_database_error(app_client, mock_db_session, path):
    mock_db_session.execute.side_effect = RuntimeError(DRIVER_ERROR)
    resp = await app_client.get(path)
    assert resp.status_code == 200
    assert resp.json()["database"] == "error"
    assert "milestone" not in resp.text and "10.0.0.5" not in resp.text


@pytest.mark.asyncio
async def test_tenant_middleware_503_does_not_echo_the_connection_error():
    from app.middleware import tenant as tenant_mw

    info = {
        "id": "t1",
        "slug": "acme",
        "status": "active",
        "database_name": "milestone_acme",
        "database_user": "acme_user",
        "encrypted_password": "iv:tag:ct",
    }
    sent: list[dict] = []

    async def send(message):
        sent.append(message)

    inner = AsyncMock()
    middleware = tenant_mw.TenantMiddleware(inner)
    with (
        patch.object(tenant_mw, "get_tenant_info_cached", AsyncMock(return_value=info)),
        patch.object(
            tenant_mw.tenant_connection_manager,
            "get_pool_from_info",
            AsyncMock(
                side_effect=ConnectionError(
                    f"Failed to connect to tenant database acme (milestone_acme): {DRIVER_ERROR}"
                )
            ),
        ),
    ):
        await middleware(
            {"type": "http", "path": "/t/acme/api/projects", "headers": []}, AsyncMock(), send
        )

    inner.assert_not_awaited()
    assert sent[0]["status"] == 503
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    assert b"milestone_acme" not in body and b"password" not in body
    assert json.loads(body)["error"] == "Database unavailable"


@pytest.mark.asyncio
async def test_site_save_error_body_is_generic(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.commit.side_effect = RuntimeError('relation "sites" violates check "secret"')

    resp = await client.post("/api/sites", json={"name": "Lab"})

    assert resp.status_code == 500
    assert resp.json()["detail"] == "Could not save the changes"
    assert "relation" not in resp.text


@pytest.mark.asyncio
async def test_predefined_phase_save_error_body_is_generic(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    max_order = MagicMock()
    max_order.scalar.return_value = 3
    mock_db_session.execute.return_value = max_order
    mock_db_session.commit.side_effect = RuntimeError("deadlock detected on relation 1234")

    resp = await client.post("/api/predefined-phases", json={"name": "Design"})

    assert resp.status_code == 500
    assert resp.json()["detail"] == "Could not save the changes"
    assert "deadlock" not in resp.text


# ---------------------------------------------------------------------------
# B1-11 — a tenant request never falls through to the default DB
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("dependency", ["get_db", "get_db_readonly"])
async def test_tenant_request_without_a_pool_is_503(dependency):
    from app import database

    gen = getattr(database, dependency)(fake_request(slug="acme"))
    with (
        patch(
            "app.services.tenant_manager.tenant_connection_manager.get_session_factory",
            return_value=None,
        ),
        patch.object(database, "get_session_factory", side_effect=AssertionError("default DB")),
        pytest.raises(HTTPException) as exc,
    ):
        await gen.__anext__()
    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_request_without_tenant_context_uses_the_default_db():
    from app import database

    db = MagicMock()
    db.commit = AsyncMock()
    with patch.object(database, "get_session_factory", return_value=tenant_factory(db)):
        gen = database.get_db(fake_request(slug=None))
        assert await gen.__anext__() is db


# ---------------------------------------------------------------------------
# B1-12 — tenant status changes take effect immediately
# ---------------------------------------------------------------------------


def tenant_row(status="active"):
    tenant = MagicMock()
    tenant.id = "tenant-uuid"
    tenant.slug = "acme"
    tenant.status = status
    tenant.credentials = None
    return tenant


def master_db_returning(tenant):
    db = MagicMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = tenant
    result.scalar_one.return_value = tenant
    db.execute = AsyncMock(return_value=result)
    db.commit = AsyncMock()
    db.delete = AsyncMock()
    db.add = MagicMock()
    return db


@pytest.fixture
def runtime_reset():
    with (
        patch("app.middleware.tenant.clear_tenant_cache") as clear,
        patch(
            "app.routers.admin.tenants.tenant_connection_manager._close_pool", AsyncMock()
        ) as close,
        patch("app.routers.admin.tenants.add_audit_log", AsyncMock()),
        patch("app.routers.admin.tenants.tenant_to_response", return_value={}),
    ):
        yield clear, close


@pytest.mark.asyncio
@pytest.mark.parametrize("new_status", ["suspended", "archived", "active"])
async def test_status_change_clears_cache_and_pool(runtime_reset, new_status):
    from app.routers.admin.tenants import update_tenant_status

    clear, close = runtime_reset
    request = MagicMock()
    request.json = AsyncMock(return_value={"status": new_status})
    db = master_db_returning(tenant_row())

    await update_tenant_status("tenant-uuid", request, admin=MagicMock(email="p@x"), db=db)

    clear.assert_called_once_with("acme")
    close.assert_awaited_once_with("acme")


@pytest.mark.asyncio
async def test_generic_update_of_status_clears_cache_and_pool(runtime_reset):
    from app.routers.admin.tenants import update_tenant
    from app.schemas.tenant import TenantUpdate

    clear, close = runtime_reset
    db = master_db_returning(tenant_row("active"))

    await update_tenant(
        "tenant-uuid", TenantUpdate(status="suspended"), admin=MagicMock(email="p@x"), db=db
    )

    clear.assert_called_once_with("acme")
    close.assert_awaited_once_with("acme")


@pytest.mark.asyncio
async def test_delete_clears_cache_and_pool(runtime_reset):
    from app.routers.admin.tenants import delete_tenant

    clear, close = runtime_reset
    db = master_db_returning(tenant_row("suspended"))

    await delete_tenant("tenant-uuid", delete_database=False, admin=MagicMock(email="p"), db=db)

    clear.assert_called_once_with("acme")
    close.assert_awaited_once_with("acme")


def test_tenant_update_status_is_validated():
    from app.schemas.tenant import TenantUpdate

    for status in ("pending", "active", "suspended", "archived"):
        assert TenantUpdate(status=status).status == status
    with pytest.raises(ValidationError):
        TenantUpdate(status="deleted")


# ---------------------------------------------------------------------------
# B1-13 — one pool (and one auto-migration run) per cold tenant
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrent_first_requests_create_one_pool():
    from app.services.tenant_manager import TenantConnectionManager

    mgr = TenantConnectionManager()
    engine = MagicMock()

    async def slow_create(info):
        await asyncio.sleep(0.01)
        return engine

    create = AsyncMock(side_effect=slow_create)
    info = {"slug": "acme", "database_name": "d", "database_user": "u", "encrypted_password": "x"}
    with patch.object(mgr, "_create_pool", create):
        engines = await asyncio.gather(*(mgr.get_pool_from_info(info) for _ in range(5)))

    assert create.await_count == 1
    assert all(e is engine for e in engines)
    assert mgr.slug_for_bind(engine) == "acme"
    assert mgr.slug_for_bind(MagicMock()) is None


# ---------------------------------------------------------------------------
# B1-15 — ws-debug is admin-only
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("role, expected", [("user", 403), ("superuser", 403), ("admin", 200)])
async def test_ws_debug_requires_admin(authed_client, role, expected):
    client, set_user = authed_client
    set_user(FakeUser(1, role))
    assert (await client.get("/api/ws-debug")).status_code == expected
    with patch("app.routers.health.broadcast_change", AsyncMock()):
        assert (await client.post("/api/ws-debug/broadcast")).status_code == expected


# ---------------------------------------------------------------------------
# B1-16 — relation names are quoted server-side
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reassign_owner_uses_quote_ident():
    from app.services.tenant_provisioner import _reassign_public_schema_owner

    conn = MagicMock()
    conn.fetch = AsyncMock(return_value=[{"relname_quoted": '"we""ird"', "relkind": "r"}])
    conn.execute = AsyncMock()

    await _reassign_public_schema_owner(conn, "acme_user")

    assert "quote_ident(c.relname)" in conn.fetch.await_args.args[0]
    assert conn.execute.await_args_list[0].args[0] == (
        'ALTER TABLE public."we""ird" OWNER TO "acme_user"'
    )


# ---------------------------------------------------------------------------
# B1-18 — unknown slugs are negative-cached
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unknown_slug_is_cached_until_cleared():
    from app.middleware import tenant as tenant_mw

    session = MagicMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=result)

    @asynccontextmanager
    async def master_session():
        yield session

    tenant_mw.clear_tenant_cache("ghost")
    with patch.object(tenant_mw.master_db, "session", master_session):
        assert await tenant_mw.get_tenant_info_cached("ghost") is None
        assert await tenant_mw.get_tenant_info_cached("ghost") is None
        assert session.execute.await_count == 1

        tenant_mw.clear_tenant_cache("ghost")
        assert await tenant_mw.get_tenant_info_cached("ghost") is None
        assert session.execute.await_count == 2
    tenant_mw.clear_tenant_cache("ghost")


def _master_session_returning(tenant_by_slug):
    """A master_db.session() stand-in whose lookups return tenant_by_slug(slug)."""
    calls: list[str] = []

    @asynccontextmanager
    async def master_session():
        session = MagicMock()

        async def execute(stmt):
            slug = next(iter(stmt.compile().params.values()))
            calls.append(slug)
            result = MagicMock()
            result.scalar_one_or_none.return_value = tenant_by_slug(slug)
            return result

        session.execute = execute
        yield session

    return master_session, calls


@pytest.mark.asyncio
async def test_negative_tenant_cache_is_capped_oldest_first():
    from app.middleware import tenant as tenant_mw

    master_session, calls = _master_session_returning(lambda slug: None)
    tenant_mw.clear_tenant_cache()
    try:
        with (
            patch.object(tenant_mw.master_db, "session", master_session),
            patch.object(tenant_mw, "_NEGATIVE_CACHE_MAX", 3),
        ):
            for slug in ["a", "b", "c", "d", "e"]:
                assert await tenant_mw.get_tenant_info_cached(slug) is None
            assert list(tenant_mw._negative_cache) == ["c", "d", "e"]

            # Still cached: no new lookup. Evicted: looked up again.
            calls.clear()
            assert await tenant_mw.get_tenant_info_cached("e") is None
            assert calls == []
            assert await tenant_mw.get_tenant_info_cached("a") is None
            assert len(calls) == 1
            assert len(tenant_mw._negative_cache) == 3
    finally:
        tenant_mw.clear_tenant_cache()


@pytest.mark.asyncio
async def test_expired_misses_are_pruned_and_misses_never_evict_real_tenants():
    from app.middleware import tenant as tenant_mw

    real = MagicMock()
    real.id = "uuid-1"
    real.name = "Acme"
    real.slug = "acme"
    real.status = "active"
    real.database_name = "milestone_acme"
    real.database_user = "acme_user"
    real.credentials = None
    master_session, _calls = _master_session_returning(
        lambda slug: real if slug == "acme" else None
    )
    tenant_mw.clear_tenant_cache()
    try:
        with (
            patch.object(tenant_mw.master_db, "session", master_session),
            patch.object(tenant_mw, "_NEGATIVE_CACHE_MAX", 2),
        ):
            assert (await tenant_mw.get_tenant_info_cached("acme"))["slug"] == "acme"
            start = tenant_mw.utcnow_naive()
            with patch.object(tenant_mw, "utcnow_naive", return_value=start):
                for slug in ["x1", "x2"]:
                    await tenant_mw.get_tenant_info_cached(slug)
            later = start + timedelta(seconds=tenant_mw._cache_ttl + 1)
            with patch.object(tenant_mw, "utcnow_naive", return_value=later):
                await tenant_mw.get_tenant_info_cached("x3")
            # Both stale misses went, not just the one needed for room.
            assert list(tenant_mw._negative_cache) == ["x3"]
            for i in range(50):
                await tenant_mw.get_tenant_info_cached(f"junk{i}")
            assert len(tenant_mw._negative_cache) == 2
            assert "acme" in tenant_mw._tenant_cache
    finally:
        tenant_mw.clear_tenant_cache()


# ---------------------------------------------------------------------------
# B1-19 — WebSocket Origin check
# ---------------------------------------------------------------------------


def ws_with(headers: dict):
    ws = MagicMock()
    ws.headers = headers
    ws.cookies = {"connect.sid": "s%3Asid."}
    ws.accept = AsyncMock()
    ws.close = AsyncMock()
    return ws


@pytest.mark.parametrize(
    "headers, allowed",
    [
        ({"host": "planner.example.com"}, True),  # no Origin: non-browser client
        ({"host": "planner.example.com", "origin": "https://planner.example.com"}, True),
        ({"host": "planner.example.com:443", "origin": "https://planner.example.com"}, True),
        ({"host": "localhost:8485", "origin": "http://localhost:8485"}, True),
        ({"host": "planner.example.com", "origin": "https://evil.example"}, False),
        ({"host": "planner.example.com", "origin": "https://planner.example.com:8443"}, False),
        ({"host": "planner.example.com", "origin": "null"}, False),
        (
            {
                "host": "127.0.0.1:8485",
                "x-forwarded-host": "planner.example.com",
                "origin": "https://planner.example.com",
            },
            True,
        ),
    ],
)
def test_origin_check(headers, allowed):
    from app.websocket.handler import is_origin_allowed

    with patch("app.websocket.handler.get_settings", return_value=Settings(debug=False)):
        assert is_origin_allowed(ws_with(headers)) is allowed


def test_configured_cors_origin_is_allowed_for_the_dev_server():
    from app.websocket.handler import is_origin_allowed

    ws = ws_with({"host": "devbox:8485", "origin": "http://devbox:3333"})
    with patch("app.websocket.handler.get_settings", return_value=Settings(debug=False)):
        assert not is_origin_allowed(ws)
    with patch(
        "app.websocket.handler.get_settings",
        return_value=Settings(debug=False, cors_origins="http://devbox:3333"),
    ):
        assert is_origin_allowed(ws)


@pytest.mark.parametrize(
    "overrides",
    [
        {"debug": False},
        {"debug": True},
        {"debug": True, "cors_origins": "https://planner.example.com, http://devbox:3333"},
        {"debug": False, "cors_origins": "https://planner.example.com"},
    ],
    ids=["prod-same-origin", "debug-localhost", "debug-explicit", "prod-explicit"],
)
def test_cors_middleware_uses_the_shared_origin_list(overrides):
    """CORS and the WebSocket Origin check read one list (settings.allowed_origins)."""
    from fastapi.middleware.cors import CORSMiddleware

    from app.main import create_app

    settings = Settings(session_secret="s" * 64, **overrides)
    with patch("app.main.get_settings", return_value=settings):
        app = create_app()

    (cors,) = [m for m in app.user_middleware if m.cls is CORSMiddleware]
    assert cors.kwargs["allow_origins"] == settings.allowed_origins
    if "cors_origins" in overrides:
        assert "http://localhost:3333" not in cors.kwargs["allow_origins"]
    elif overrides["debug"]:
        assert "http://localhost:3333" in cors.kwargs["allow_origins"]
    else:
        assert cors.kwargs["allow_origins"] == []


@pytest.mark.asyncio
async def test_cross_site_handshake_is_closed_with_4003_before_auth():
    from app.websocket import handler

    ws = ws_with({"host": "planner.example.com", "origin": "https://evil.example"})
    with (
        patch.object(handler, "get_settings", return_value=Settings(debug=False)),
        patch.object(handler, "get_user_from_session", AsyncMock()) as lookup,
    ):
        await handler.handle_websocket_connection(ws, tenant_slug=None)

    ws.close.assert_awaited_once()
    assert ws.close.await_args.kwargs["code"] == 4003
    lookup.assert_not_awaited()


# ---------------------------------------------------------------------------
# B1-22 — 8-character minimum for new passwords
# ---------------------------------------------------------------------------


def test_change_password_requires_eight_characters():
    from app.schemas.auth import ChangePasswordRequest

    with pytest.raises(ValidationError):
        ChangePasswordRequest(currentPassword="x", newPassword="1234567")
    ChangePasswordRequest(currentPassword="x", newPassword="12345678")


def test_login_is_unaffected_by_the_minimum():
    from app.schemas.auth import LoginRequest

    LoginRequest(email="a@b.c", password="123")


@pytest.mark.asyncio
async def test_change_password_route_rejects_short_passwords(authed_client):
    client, _ = authed_client
    resp = await client.post(
        "/api/auth/change-password", json={"currentPassword": "old", "newPassword": "short"}
    )
    assert resp.status_code == 422


def test_portal_set_tenant_passwords_require_eight_characters():
    from app.schemas.tenant import (
        AdminUserCreate,
        AdminUserUpdate,
        ResetAdminPasswordRequest,
        TenantProvisionRequest,
    )

    for build in (
        lambda p: ResetAdminPasswordRequest(password=p),
        lambda p: TenantProvisionRequest(adminPassword=p),
        lambda p: AdminUserCreate(email="a@example.com", password=p),
        lambda p: AdminUserUpdate(password=p),
    ):
        with pytest.raises(ValidationError):
            build("1234567")
        build("12345678")
    assert ResetAdminPasswordRequest().password is None


# ---------------------------------------------------------------------------
# N1 — session pre-filter matches the serialised id token
# ---------------------------------------------------------------------------


def like_to_regex(pattern: str) -> re.Pattern:
    return re.compile("^" + ".*".join(re.escape(p) for p in pattern.split("%")) + "$", re.S)


def matches(user_id: int, sess: str) -> bool:
    from app.services.session import session_user_id_patterns

    return any(like_to_regex(p).match(sess) for p in session_user_id_patterns(user_id))


@pytest.mark.asyncio
async def test_prefilter_matches_sessions_written_by_create_session():
    from app.services.session import SessionService

    db = MagicMock()
    db.commit = AsyncMock()
    user = MagicMock(
        id=7, email="u@x.y", first_name="A", last_name="B", job_title=None, role="user", sites=[]
    )
    await SessionService(db).create_session(user)
    written = db.add.call_args.args[0].sess

    assert matches(7, written)
    assert not matches(70, written) and not matches(17, written)


def test_prefilter_matches_node_style_and_trailing_id():
    assert matches(7, json.dumps({"user": {"id": 7, "role": "admin"}}, separators=(",", ":")))
    assert matches(7, json.dumps({"user": {"id": 7}}))
    assert not matches(7, json.dumps({"user": {"id": 77}}))
    assert not matches(7, json.dumps({"cookie": {"originalMaxAge": 86400007}}))


@pytest.mark.asyncio
async def test_destroy_user_sessions_queries_with_the_token_patterns():
    from app.services.session import SessionService, session_user_id_patterns

    db = MagicMock()
    select_result = MagicMock()
    select_result.all.return_value = []
    db.execute = AsyncMock(return_value=select_result)
    db.commit = AsyncMock()

    with patch("app.services.session.disconnect_user_websockets", AsyncMock()):
        await SessionService(db).destroy_user_sessions(7)

    params = db.execute.await_args.args[0].compile().params
    assert set(params.values()) == set(session_user_id_patterns(7))


# ---------------------------------------------------------------------------
# N3 — revocation closes the user's open WebSockets
# ---------------------------------------------------------------------------


def fake_socket():
    ws = MagicMock()
    ws.client_state.name = "CONNECTED"
    ws.send_text = AsyncMock()
    ws.close = AsyncMock()
    return ws


@pytest.mark.asyncio
async def test_disconnect_user_closes_only_that_users_other_sessions():
    from app.websocket.manager import ConnectedUser, ConnectionManager

    mgr = ConnectionManager()
    keep, drop, other = fake_socket(), fake_socket(), fake_socket()
    mgr._connections["acme"] = {
        1: ConnectedUser(1, 7, "A", "B", keep, session_id="current"),
        2: ConnectedUser(2, 7, "A", "B", drop, session_id="stolen"),
        3: ConnectedUser(3, 8, "C", "D", other, session_id="x"),
    }

    assert await mgr.disconnect_user("acme", 7, except_session_id="current") == 1
    drop.close.assert_awaited_once_with(code=4001, reason="Session revoked")
    keep.close.assert_not_awaited()
    other.send_text.assert_not_awaited()  # user 7 is still online: no presence:leave

    assert await mgr.disconnect_user("acme", 7) == 1
    keep.close.assert_awaited_once()
    leave = json.loads(other.send_text.await_args.args[0])
    assert leave == {**leave, "type": "presence:leave", "payload": {"user_id": 7}}
    assert set(mgr._connections["acme"]) == {3}
    assert await mgr.disconnect_user("nowhere", 7) == 0


@pytest.mark.asyncio
async def test_destroy_user_sessions_closes_websockets_single_tenant():
    from app.services.session import SessionService

    db = MagicMock()
    select_result = MagicMock()
    select_result.all.return_value = []
    db.execute = AsyncMock(return_value=select_result)
    db.commit = AsyncMock()

    with patch("app.services.session.disconnect_user_websockets", AsyncMock()) as ws_close:
        await SessionService(db).destroy_user_sessions(7, except_session_id="mine")

    ws_close.assert_awaited_once_with("default", 7, except_session_id="mine")


@pytest.mark.asyncio
async def test_destroy_user_sessions_targets_the_tenant_room():
    from app.services.session import SessionService
    from app.services.tenant_manager import tenant_connection_manager

    db = MagicMock()
    engine = MagicMock()
    db.bind = engine
    select_result = MagicMock()
    select_result.all.return_value = []
    db.execute = AsyncMock(return_value=select_result)
    db.commit = AsyncMock()

    service = SessionService(db)
    service.settings = Settings(multi_tenant=True)
    with (
        patch.dict(tenant_connection_manager._pools, {"acme": engine}),
        patch("app.websocket.manager.manager.disconnect_user", AsyncMock(return_value=1)) as dc,
    ):
        await service.destroy_user_sessions(7)

    dc.assert_awaited_once_with("acme", 7, except_session_id=None)


@pytest.mark.asyncio
async def test_websocket_disconnect_failure_never_breaks_revocation():
    from app.services.session import disconnect_user_websockets

    with patch(
        "app.websocket.manager.manager.disconnect_user", AsyncMock(side_effect=RuntimeError)
    ):
        assert await disconnect_user_websockets("acme", 7) == 0
    assert await disconnect_user_websockets(None, 7) == 0
