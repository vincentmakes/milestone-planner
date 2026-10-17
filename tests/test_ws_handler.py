"""
WebSocket endpoint handler (app/websocket/handler.py).

Covers the cookie parsing, the session -> user lookup, tenant resolution from
the ASGI scope, every handshake rejection with its close code (4001-4006),
and the ping/pong receive loop up to the disconnect.
"""

import json
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import WebSocketDisconnect
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import Settings
from app.websocket import handler
from tests.support import fake_websocket, scalar_result

COOKIE = "s%3Aabc123.signature"


def user(active=1, uid=7):
    return SimpleNamespace(id=uid, first_name="Ada", last_name="Lovelace", active=active)


def session_row(*, expired_in_ms=60_000, sess=None):
    return SimpleNamespace(
        sid="abc123",
        expired=int(time.time() * 1000) + expired_in_ms,
        sess=json.dumps(sess if sess is not None else {"user": {"id": 7}}),
    )


def factory_yielding(db):
    @asynccontextmanager
    async def factory():
        yield db

    return factory


def close_kwargs(ws) -> dict:
    ws.close.assert_awaited_once()
    return ws.close.await_args.kwargs


def ws_with_cookie(cookie=COOKIE, **kwargs):
    return fake_websocket(
        headers={"host": "planner.example.com"},
        cookies={"connect.sid": cookie} if cookie is not None else {},
        **kwargs,
    )


@pytest.fixture(autouse=True)
def same_origin_settings():
    with patch.object(handler, "get_settings", return_value=Settings(debug=False)):
        yield


# ---------------------------------------------------------------------------
# extract_session_id
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("cookie", "expected"),
    [
        ("s%3Aabc123.sig", "abc123"),  # URL-encoded express-session cookie
        ("s:abc123.sig", "abc123"),
        ("s%3Aabc123.", "abc123"),  # this app's own unsigned format
        ("abc123", "abc123"),  # bare id
        ("abc123.sig", "abc123"),
        ("", None),
    ],
)
def test_extract_session_id(cookie, expected):
    assert handler.extract_session_id(cookie) == expected


# ---------------------------------------------------------------------------
# _normalise_host / is_origin_allowed edge cases not in test_security_hardening
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("host", "scheme", "expected"),
    [
        ("Planner.Example.com:443", "https", "planner.example.com"),
        ("planner.example.com:80", "http", "planner.example.com"),
        ("planner.example.com:8443", "https", "planner.example.com:8443"),
        ("planner.example.com:443", "http", "planner.example.com:443"),
        ("planner.example.com:443", None, "planner.example.com"),
        ("planner.example.com:80", None, "planner.example.com"),
        (" localhost:8485 ", None, "localhost:8485"),
    ],
)
def test_normalise_host(host, scheme, expected):
    assert handler._normalise_host(host, scheme) == expected


@pytest.mark.parametrize(
    ("headers", "allowed"),
    [
        ({"host": "a.example", "origin": "garbage"}, False),
        ({"origin": "https://a.example"}, False),  # no Host to compare with
        (
            {
                "host": "127.0.0.1",
                "x-forwarded-host": "proxy.example, a.example",
                "origin": "https://a.example",
            },
            True,
        ),
        ({"host": "a.example", "origin": "wss://a.example:443"}, True),
    ],
)
def test_origin_edge_cases(headers, allowed):
    ws = fake_websocket(headers=headers)
    assert handler.is_origin_allowed(ws) is allowed


# ---------------------------------------------------------------------------
# get_tenant_from_scope
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("scope", "expected"),
    [
        ({"state": {"tenant_slug": "acme"}, "path": "/ws"}, "acme"),
        ({"state": {}, "path": "/t/globex-2/ws"}, "globex-2"),
        ({"state": {"tenant_slug": None}, "path": "/ws"}, "default"),
        ({"state": {}, "path": "/t/UPPER/ws"}, "default"),  # slugs are lower-case
    ],
)
def test_get_tenant_from_scope(scope, expected):
    ws = fake_websocket(scope=scope)
    assert handler.get_tenant_from_scope(ws) == expected


def test_get_tenant_from_scope_without_state_or_path():
    ws = fake_websocket()
    ws.scope = {"type": "websocket"}
    assert handler.get_tenant_from_scope(ws) == "default"


# ---------------------------------------------------------------------------
# get_user_from_session
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_valid_session_returns_the_user(mock_db_session):
    the_user = user()
    mock_db_session.execute.side_effect = [scalar_result(session_row()), scalar_result(the_user)]

    assert await handler.get_user_from_session("abc123", mock_db_session) is the_user
    assert mock_db_session.execute.await_count == 2


@pytest.mark.asyncio
async def test_unknown_session_returns_none(mock_db_session):
    mock_db_session.execute.side_effect = [scalar_result(None)]
    assert await handler.get_user_from_session("nope", mock_db_session) is None
    assert mock_db_session.execute.await_count == 1


@pytest.mark.asyncio
async def test_expired_session_returns_none_without_user_lookup(mock_db_session):
    mock_db_session.execute.side_effect = [scalar_result(session_row(expired_in_ms=-1000))]
    assert await handler.get_user_from_session("abc123", mock_db_session) is None
    assert mock_db_session.execute.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("sess", [{}, {"user": {}}, {"user": {"id": None}}])
async def test_session_without_user_id_returns_none(mock_db_session, sess):
    mock_db_session.execute.side_effect = [scalar_result(session_row(sess=sess))]
    assert await handler.get_user_from_session("abc123", mock_db_session) is None
    assert mock_db_session.execute.await_count == 1


@pytest.mark.asyncio
async def test_session_for_deleted_user_returns_none(mock_db_session):
    mock_db_session.execute.side_effect = [scalar_result(session_row()), scalar_result(None)]
    assert await handler.get_user_from_session("abc123", mock_db_session) is None


@pytest.mark.asyncio
async def test_corrupt_session_blob_returns_none(mock_db_session):
    row = session_row()
    row.sess = "{not json"
    mock_db_session.execute.side_effect = [scalar_result(row)]
    assert await handler.get_user_from_session("abc123", mock_db_session) is None


@pytest.mark.asyncio
async def test_database_error_returns_none(mock_db_session):
    mock_db_session.execute.side_effect = RuntimeError("db down")
    assert await handler.get_user_from_session("abc123", mock_db_session) is None


# ---------------------------------------------------------------------------
# handle_websocket_connection — rejections
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("cookie", [None, ""])
async def test_missing_session_cookie_closes_4001(cookie):
    ws = ws_with_cookie(cookie)
    with patch.object(handler, "get_user_from_session", AsyncMock()) as lookup:
        await handler.handle_websocket_connection(ws)

    ws.accept.assert_awaited_once()
    assert close_kwargs(ws) == {"code": 4001, "reason": "No session cookie"}
    lookup.assert_not_awaited()


@pytest.mark.asyncio
async def test_single_tenant_invalid_session_closes_4001(mock_db_session):
    ws = ws_with_cookie()
    with (
        patch.object(
            handler, "get_session_factory", return_value=factory_yielding(mock_db_session)
        ),
        patch.object(handler, "get_user_from_session", AsyncMock(return_value=None)) as lookup,
        patch.object(handler.manager, "connect", AsyncMock()) as connect,
    ):
        await handler.handle_websocket_connection(ws, tenant_slug=None)

    lookup.assert_awaited_once_with("abc123", mock_db_session)
    assert close_kwargs(ws) == {"code": 4001, "reason": "Invalid or expired session"}
    connect.assert_not_awaited()


@pytest.mark.asyncio
async def test_disabled_user_closes_4003(mock_db_session):
    ws = ws_with_cookie()
    with (
        patch.object(
            handler, "get_session_factory", return_value=factory_yielding(mock_db_session)
        ),
        patch.object(handler, "get_user_from_session", AsyncMock(return_value=user(active=0))),
        patch.object(handler.manager, "connect", AsyncMock()) as connect,
    ):
        await handler.handle_websocket_connection(ws)

    assert close_kwargs(ws) == {"code": 4003, "reason": "User account is disabled"}
    connect.assert_not_awaited()


@pytest.mark.asyncio
async def test_database_failure_during_auth_closes_4002():
    ws = ws_with_cookie()
    with (
        patch.object(handler, "get_session_factory", side_effect=RuntimeError("no engine")),
        patch.object(handler.manager, "connect", AsyncMock()) as connect,
    ):
        await handler.handle_websocket_connection(ws)

    assert close_kwargs(ws) == {"code": 4002, "reason": "Authentication error"}
    connect.assert_not_awaited()


TENANT = {
    "id": "t1",
    "slug": "acme",
    "status": "active",
    "database_name": "milestone_acme",
    "database_user": "acme_user",
    "encrypted_password": "iv:tag:ct",
}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("info", "code", "reason"),
    [
        (None, 4004, "Tenant not found"),
        ({**TENANT, "status": "suspended"}, 4005, "Tenant not active"),
        ({**TENANT, "encrypted_password": None}, 4006, "Tenant database not configured"),
    ],
)
async def test_tenant_rejections(info, code, reason):
    ws = ws_with_cookie()
    with (
        patch("app.middleware.tenant.get_tenant_info_cached", AsyncMock(return_value=info)) as get,
        patch(
            "app.services.tenant_manager.tenant_connection_manager.get_pool_from_info",
            AsyncMock(),
        ) as pool,
        patch.object(handler.manager, "connect", AsyncMock()) as connect,
    ):
        await handler.handle_websocket_connection(ws, tenant_slug="acme")

    get.assert_awaited_once_with("acme")
    assert close_kwargs(ws) == {"code": code, "reason": reason}
    pool.assert_not_awaited()
    connect.assert_not_awaited()


@pytest.mark.asyncio
async def test_tenant_pool_failure_closes_4002():
    ws = ws_with_cookie()
    with (
        patch("app.middleware.tenant.get_tenant_info_cached", AsyncMock(return_value=TENANT)),
        patch(
            "app.services.tenant_manager.tenant_connection_manager.get_pool_from_info",
            AsyncMock(side_effect=ConnectionError("db unreachable")),
        ),
    ):
        await handler.handle_websocket_connection(ws, tenant_slug="acme")

    assert close_kwargs(ws)["code"] == 4002


# ---------------------------------------------------------------------------
# handle_websocket_connection — accepted connection and receive loop
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tenant_connection_registers_in_the_tenant_room_and_answers_pings():
    ws = ws_with_cookie()
    ws.receive_text.side_effect = [
        json.dumps({"type": "ping"}),
        "not json",
        json.dumps({"type": "something-else"}),
        json.dumps({"type": "ping"}),
        WebSocketDisconnect(code=1001),
    ]
    engine = create_async_engine("postgresql+asyncpg://u:p@localhost:1/never_connected")
    lookup = AsyncMock(return_value=user())
    try:
        with (
            patch("app.middleware.tenant.get_tenant_info_cached", AsyncMock(return_value=TENANT)),
            patch(
                "app.services.tenant_manager.tenant_connection_manager.get_pool_from_info",
                AsyncMock(return_value=engine),
            ) as pool,
            patch.object(handler, "get_user_from_session", lookup),
            patch.object(handler.manager, "connect", AsyncMock(return_value=11)) as connect,
            patch.object(handler.manager, "disconnect", AsyncMock()) as disconnect,
        ):
            await handler.handle_websocket_connection(ws, tenant_slug="acme")
    finally:
        await engine.dispose()

    pool.assert_awaited_once_with(TENANT)
    assert lookup.await_args.args[0] == "abc123"
    assert lookup.await_args.args[1].bind is engine  # session on the tenant's engine
    connect.assert_awaited_once_with(
        websocket=ws,
        tenant_id="acme",
        user_id=7,
        first_name="Ada",
        last_name="Lovelace",
        session_id="abc123",
    )
    pongs = [json.loads(c.args[0]) for c in ws.send_text.await_args_list]
    assert [p["type"] for p in pongs] == ["pong", "pong"]
    assert all(p["timestamp"].endswith("Z") for p in pongs)
    disconnect.assert_awaited_once_with("acme", 11)
    ws.close.assert_not_awaited()


@pytest.mark.asyncio
async def test_single_tenant_connection_uses_default_room_and_cleans_up_on_error(
    mock_db_session,
):
    ws = ws_with_cookie()
    ws.receive_text.side_effect = RuntimeError("transport reset")
    with (
        patch.object(
            handler, "get_session_factory", return_value=factory_yielding(mock_db_session)
        ),
        patch.object(handler, "get_user_from_session", AsyncMock(return_value=user(uid=3))),
        patch.object(handler.manager, "connect", AsyncMock(return_value=5)) as connect,
        patch.object(handler.manager, "disconnect", AsyncMock()) as disconnect,
    ):
        await handler.handle_websocket_connection(ws)

    assert connect.await_args.kwargs["tenant_id"] == "default"
    assert connect.await_args.kwargs["user_id"] == 3
    disconnect.assert_awaited_once_with("default", 5)


# ---------------------------------------------------------------------------
# Route functions delegate with the right tenant
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_route_functions_delegate_to_the_shared_handler():
    ws = MagicMock()
    with patch.object(handler, "handle_websocket_connection", AsyncMock()) as handle:
        await handler.websocket_endpoint(ws)
        await handler.websocket_tenant_endpoint(ws, "acme")

    assert handle.await_args_list[0].args == (ws,)
    assert handle.await_args_list[0].kwargs == {"tenant_slug": None}
    assert handle.await_args_list[1].kwargs == {"tenant_slug": "acme"}
