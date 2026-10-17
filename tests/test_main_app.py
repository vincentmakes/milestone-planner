"""
App factory (app/main.py): Node-compatible JSON, docs gating, SPA serving
(index.html fallback vs ``/api/*`` 404 vs ``/ws`` 426), the opaque 500
handler, the lifespan in multi-tenant mode, and the middleware wrapping.

The SPA routes depend on a ``public/`` directory relative to the working
directory, so those tests build the app inside a temporary directory.
"""

import json
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app import main
from app.config import Settings

INDEX = "<!doctype html><title>Milestone SPA</title>"


def settings(**overrides) -> Settings:
    return Settings(session_secret="s" * 64, debug=False, **overrides)


@contextmanager
def built_app(tmp_path, monkeypatch, *, frontend: str | None = "full", **overrides):
    """create_app() run with cwd=tmp_path, optionally with a fake built frontend."""
    if frontend is not None:
        public = tmp_path / "public"
        public.mkdir()
        if frontend == "full":
            (public / "index.html").write_text(INDEX)
            for sub in ("css", "js", "images", "img", "fonts", "assets"):
                (public / sub).mkdir()
            (public / "css" / "app.css").write_text("body{}")
            (public / "assets" / "index-abc.js").write_text("console.log(1)")
        elif frontend == "legacy-admin":
            (public / "admin").mkdir()
            (public / "admin" / "index.html").write_text("<title>Legacy admin</title>")
    monkeypatch.chdir(tmp_path)
    # create_app() probes the image path /app/public before ./public; point that
    # probe at a missing directory so the temp frontend wins inside Docker too.
    real_path = Path
    monkeypatch.setattr(
        main,
        "Path",
        lambda p: real_path(tmp_path / "no-image-public")
        if str(p) == "/app/public"
        else real_path(p),
    )
    with patch.object(main, "get_settings", return_value=settings(**overrides)):
        yield main.create_app()


def client(app, **transport_kwargs):
    return AsyncClient(transport=ASGITransport(app=app, **transport_kwargs), base_url="http://t")


def with_state(app, state: dict):
    """Pure-ASGI wrapper that pre-fills scope["state"] like TenantMiddleware does."""

    async def wrapper(scope, receive, send):
        if scope["type"] == "http":
            scope = {**scope, "state": dict(state)}
        await app(scope, receive, send)

    return wrapper


# ---------------------------------------------------------------------------
# Node-compatible JSON
# ---------------------------------------------------------------------------


def test_custom_json_serializer_formats_like_node():
    # Naive datetimes are stored UTC, so they are output unshifted.
    assert main.custom_json_serializer(datetime(2026, 1, 2, 3, 4, 5, 678000)) == (
        "2026-01-02T03:04:05.678Z"
    )
    # An aware value is converted to UTC first (CEST: minus two hours).
    cest = timezone(timedelta(hours=2))
    assert main.custom_json_serializer(datetime(2026, 7, 1, 12, 0, tzinfo=cest)) == (
        "2026-07-01T10:00:00.000Z"
    )
    assert main.custom_json_serializer(date(2026, 1, 2)) == "2026-01-02"
    with pytest.raises(TypeError, match="set"):
        main.custom_json_serializer({1})


def test_convert_floats_to_ints_recurses():
    assert main.convert_floats_to_ints({"a": 1.0, "b": [2.5, 3.0, {"c": 0.0}], "d": "1.0"}) == {
        "a": 1,
        "b": [2.5, 3, {"c": 0}],
        "d": "1.0",
    }


def test_custom_json_response_renders_compact_utf8():
    body = main.CustomJSONResponse(
        {"when": datetime(2026, 5, 1, 12, 0), "pct": 50.0, "name": "Zürich"}
    ).body
    # No offset shift (UTC in, UTC out); whole floats become ints; no ASCII escaping.
    assert body == '{"when":"2026-05-01T12:00:00.000Z","pct":50,"name":"Zürich"}'.encode()


# ---------------------------------------------------------------------------
# API docs gating
# ---------------------------------------------------------------------------


# create_app() imports get_current_user_from_session when it runs, so the patch
# must be in place before the app is built.


@pytest.mark.asyncio
@pytest.mark.parametrize("user", [None, {"id": 2, "role": "superuser"}, {"id": 3, "role": "user"}])
async def test_docs_are_refused_to_non_admins(tmp_path, monkeypatch, user):
    lookup = AsyncMock(return_value=user)
    with (
        patch("app.middleware.auth.get_current_user_from_session", lookup),
        built_app(tmp_path, monkeypatch) as app,
    ):
        async with client(app) as c:
            schema = await c.get("/api/openapi.json")
            docs = await c.get("/api/docs")
            redoc = await c.get("/api/redoc")

    assert lookup.await_count == 3
    assert schema.status_code == 401
    assert schema.json() == {"error": "Authentication required. Admin access only."}
    for page in (docs, redoc):
        assert page.status_code == 401
        assert "Authentication Required" in page.text
        assert "swagger" not in page.text.lower() and "redoc" not in page.text.lower()


@pytest.mark.asyncio
# The multi-method SPA catch-all once leaked into the schema with duplicate
# operation ids (a UserWarning); fail on that warning should it come back.
@pytest.mark.filterwarnings("error:Duplicate Operation ID")
async def test_admin_gets_the_openapi_schema(tmp_path, monkeypatch):
    with (
        patch(
            "app.middleware.auth.get_current_user_from_session",
            AsyncMock(return_value={"id": 1, "role": "admin"}),
        ),
        built_app(tmp_path, monkeypatch) as app,
    ):
        async with client(app) as c:
            resp = await c.get("/api/openapi.json")

    assert resp.status_code == 200
    schema = resp.json()
    assert schema["info"]["title"] == app.title
    assert "/api/auth/login" in schema["paths"]
    # Hidden routes stay hidden, the SPA catch-all included.
    assert "/api/openapi.json" not in schema["paths"]
    assert any(getattr(r, "path", None) == "/{full_path:path}" for r in app.routes)
    assert not [path for path in schema["paths"] if "full_path" in path]


# ---------------------------------------------------------------------------
# SPA serving
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_single_tenant_root_and_deep_links_serve_index(tmp_path, monkeypatch):
    with built_app(tmp_path, monkeypatch) as app:
        async with client(app) as c:
            root = await c.get("/")
            deep = await c.get("/t/acme/some/view")
            admin = await c.get("/admin")
            admin_slash = await c.get("/admin/")

    for resp in (root, deep, admin, admin_slash):
        assert resp.status_code == 200
        assert resp.text == INDEX


@pytest.mark.asyncio
async def test_static_mounts_serve_files(tmp_path, monkeypatch):
    with built_app(tmp_path, monkeypatch) as app:
        async with client(app) as c:
            css = await c.get("/css/app.css")
            js = await c.get("/assets/index-abc.js")
            missing = await c.get("/css/missing.css")

    assert (css.status_code, css.text) == (200, "body{}")
    assert (js.status_code, js.text) == (200, "console.log(1)")
    assert missing.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["GET", "POST", "PUT", "PATCH", "DELETE"])
async def test_unknown_api_path_is_json_404_never_the_spa(tmp_path, monkeypatch, method):
    with built_app(tmp_path, monkeypatch) as app:
        async with client(app) as c:
            resp = await c.request(method, "/api/definitely-not-a-route")

    assert resp.status_code == 404
    assert resp.json() == {"error": "Not found"}


@pytest.mark.asyncio
async def test_non_get_to_a_spa_path_is_404(tmp_path, monkeypatch):
    with built_app(tmp_path, monkeypatch) as app:
        async with client(app) as c:
            resp = await c.post("/some/view")
    assert resp.status_code == 404
    assert resp.json() == {"error": "Not found"}


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/ws", "/ws/extra", "/t/acme/ws", "/t/acme/ws/x"])
async def test_websocket_paths_over_http_get_426(tmp_path, monkeypatch, path):
    with built_app(tmp_path, monkeypatch) as app:
        async with client(app) as c:
            resp = await c.get(path)

    assert resp.status_code == 426
    assert resp.headers["upgrade"] == "websocket"
    assert "WebSocket endpoint" in resp.json()["error"]


@pytest.mark.asyncio
async def test_multi_tenant_root_without_tenant_redirects_to_admin(tmp_path, monkeypatch):
    with built_app(tmp_path, monkeypatch, multi_tenant=True) as app:
        async with client(app) as c:
            bare = await c.get("/")
        async with client(with_state(app, {"tenant": {"slug": "acme"}})) as c:
            tenant = await c.get("/")

    assert bare.status_code == 302
    assert bare.headers["location"] == "/admin"
    assert (tenant.status_code, tenant.text) == (200, INDEX)


@pytest.mark.asyncio
async def test_public_dir_without_index(tmp_path, monkeypatch):
    with built_app(tmp_path, monkeypatch, frontend="empty") as app:
        async with client(app) as c:
            root = await c.get("/")
            admin = await c.get("/admin")
            deep = await c.get("/some/view")

    assert root.status_code == 404
    assert root.json() == {"error": "Frontend not found - index.html missing"}
    assert admin.status_code == 404
    assert admin.json() == {"error": "Admin panel not found"}
    assert deep.status_code == 404
    assert deep.json() == {"error": "Frontend not found"}


@pytest.mark.asyncio
async def test_admin_falls_back_to_a_legacy_admin_page(tmp_path, monkeypatch):
    with built_app(tmp_path, monkeypatch, frontend="legacy-admin") as app:
        async with client(app) as c:
            resp = await c.get("/admin")
    assert resp.status_code == 200
    assert "Legacy admin" in resp.text


@pytest.mark.asyncio
async def test_no_public_dir_root_explains_itself(tmp_path, monkeypatch):
    with built_app(tmp_path, monkeypatch, frontend=None) as app:
        async with client(app) as c:
            root = await c.get("/")
            other = await c.get("/some/view")

    assert root.status_code == 404
    assert root.json()["error"] == "Frontend not found"
    assert "/app/public" in root.json()["message"]
    assert other.status_code == 404  # no catch-all without a frontend


# ---------------------------------------------------------------------------
# Global exception handler
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unhandled_exception_is_an_opaque_500(tmp_path, monkeypatch):
    from app.middleware.auth import get_current_user

    def explode():
        raise RuntimeError("asyncpg: password authentication failed for user 'milestone'")

    with built_app(tmp_path, monkeypatch) as app:
        app.dependency_overrides[get_current_user] = explode
        async with client(app, raise_app_exceptions=False) as c:
            resp = await c.get("/api/tags")

    assert resp.status_code == 500
    assert resp.json() == {"error": "Internal server error"}
    assert "asyncpg" not in resp.text and "milestone" not in resp.text


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_multi_tenant_lifespan_starts_and_stops_tenant_pools(caplog):
    cfg = settings(
        multi_tenant=True,
        https_proxy="http://proxy.corp:8080",
        http_proxy="http://proxy.corp:8080",
        proxy_pac_url="http://wpad/proxy.pac",
    )
    master = MagicMock()
    master.init_db = AsyncMock()
    master.verify_admin_exists = AsyncMock()
    master.close = AsyncMock()
    tenants = MagicMock()
    tenants.close_all = AsyncMock()
    init_tenant_db = AsyncMock()
    close_db = AsyncMock()

    with (
        patch.object(main, "get_settings", return_value=cfg),
        patch.object(main, "init_db", init_tenant_db),
        patch.object(main, "close_db", close_db),
        patch("app.services.master_db.master_db", master),
        patch("app.services.tenant_manager.tenant_connection_manager", tenants),
        caplog.at_level("INFO", logger="app.main"),
    ):
        async with main.lifespan(MagicMock()):
            master.init_db.assert_awaited_once()
            master.verify_admin_exists.assert_awaited_once()
            tenants.start_cleanup_task.assert_called_once()
            tenants.close_all.assert_not_awaited()

    init_tenant_db.assert_not_awaited()  # no default tenant DB in multi-tenant mode
    close_db.assert_awaited_once()
    master.close.assert_awaited_once()
    tenants.close_all.assert_awaited_once()
    assert "HTTPS_PROXY: http://proxy.corp:8080" in caplog.text
    assert "PROXY_PAC_URL: http://wpad/proxy.pac" in caplog.text


@pytest.mark.asyncio
async def test_debug_lifespan_warns_about_the_default_secret(caplog):
    from app.config import DEFAULT_SESSION_SECRET

    cfg = Settings(session_secret=DEFAULT_SESSION_SECRET, debug=True, multi_tenant=False)
    master = MagicMock()
    master.init_db = AsyncMock()
    master.verify_admin_exists = AsyncMock()
    master.close = AsyncMock()
    with (
        patch.object(main, "get_settings", return_value=cfg),
        patch.object(main, "init_db", AsyncMock()),
        patch.object(main, "close_db", AsyncMock()),
        patch("app.services.master_db.master_db", master),
        patch("app.database.get_engine", return_value=object()),
        patch("app.services.tenant_manager.run_single_tenant_auto_migrations", AsyncMock()),
        caplog.at_level("WARNING", logger="app.main"),
    ):
        async with main.lifespan(MagicMock()):
            pass

    assert "SESSION_SECRET is a published default" in caplog.text


# ---------------------------------------------------------------------------
# create_wrapped_app
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("multi_tenant", [False, True])
def test_wrapped_app_layers(multi_tenant):
    from app.middleware.broadcast import BroadcastMiddleware
    from app.middleware.tenant import TenantMiddleware

    cfg = settings(multi_tenant=multi_tenant)
    with patch.object(main, "get_settings", return_value=cfg):
        wrapped = main.create_wrapped_app()

    if multi_tenant:
        assert isinstance(wrapped, TenantMiddleware)
        inner = wrapped.app
    else:
        inner = wrapped
    assert isinstance(inner, BroadcastMiddleware)
    assert inner.app.title == cfg.app_name


def test_render_is_valid_json_for_nested_payloads():
    payload = {"items": [{"start": date(2026, 3, 1), "alloc": 100.0}]}
    assert json.loads(main.CustomJSONResponse(payload).body) == {
        "items": [{"start": "2026-03-01", "alloc": 100}]
    }
