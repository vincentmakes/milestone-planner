"""
BroadcastMiddleware (app/middleware/broadcast.py), driven as a raw ASGI app.

A successful (2xx) write to a coarse-broadcast path fires one tenant-wide
``change:<entity>`` that excludes the sender. Reads, failed writes, paths whose
routers broadcast richly (SKIP_PATTERNS) and non-HTTP scopes pass straight
through without touching the WebSocket manager.
"""

from unittest.mock import AsyncMock, patch

import pytest

from app.middleware import broadcast as bmw


def inner_app(status: int = 200, body: bytes = b"{}"):
    calls: list[dict] = []

    async def app(scope, receive, send):
        calls.append(scope)
        await send({"type": "http.response.start", "status": status, "headers": []})
        await send({"type": "http.response.body", "body": body})

    app.calls = calls  # type: ignore[attr-defined]
    return app


async def run(middleware, scope):
    sent: list[dict] = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    await middleware(scope, receive, send)
    return sent


def http_scope(method="POST", path="/api/vacations", state=None):
    scope = {"type": "http", "method": method, "path": path, "headers": [], "query_string": b""}
    if state is not None:
        scope["state"] = state
    return scope


USER = {"id": 7, "firstName": "Ada", "lastName": "Lovelace"}


@pytest.fixture
def broadcast():
    with patch.object(bmw.manager, "broadcast_to_tenant", AsyncMock(return_value=1)) as mock:
        yield mock


@pytest.fixture
def session_lookup():
    with patch.object(bmw, "get_current_user_from_session", AsyncMock(return_value=None)) as mock:
        yield mock


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "action"),
    [("POST", "create"), ("DELETE", "delete"), ("PUT", "update"), ("PATCH", "update")],
)
def test_action_for_method(method, action):
    assert bmw._action_for_method(method) == action


@pytest.mark.parametrize(
    ("path", "entity"),
    [
        ("/api/users/3", "user"),
        ("/api/staff", "staff"),
        ("/api/equipment-blocks/2", "equipment_block"),
        ("/api/equipment-types/Oven", "equipment"),
        ("/api/equipment/4", "equipment"),
        ("/api/sites/2/holidays", "bank_holiday"),
        ("/api/sites/2", "site"),
        ("/api/skills", "skill"),
        ("/api/teams", "team"),
        ("/api/teams/3", "team"),
        ("/api/custom-columns/values", "custom_column"),
        ("/api/predefined-phases/reorder", "predefined_phase"),
        ("/api/settings/instance_title", "settings"),
        ("/api/projects/1", None),
        ("/api/equipment-assignments/1", None),
        ("/api/auth/login", None),
        ("/api/admin/tenants", None),
        ("/api/health", None),
        ("/api/unknown-thing", None),
    ],
)
def test_resolve_entity_type(path, entity):
    assert bmw._resolve_entity_type(path) == entity


# ---------------------------------------------------------------------------
# Passthrough cases
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_non_http_scope_passes_through(broadcast):
    seen = []

    async def app(scope, receive, send):
        seen.append(scope["type"])

    await bmw.BroadcastMiddleware(app)({"type": "websocket", "path": "/ws"}, None, None)
    await bmw.BroadcastMiddleware(app)({"type": "lifespan"}, None, None)

    assert seen == ["websocket", "lifespan"]
    broadcast.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS"])
async def test_reads_are_not_broadcast(broadcast, method):
    app = inner_app()
    sent = await run(bmw.BroadcastMiddleware(app), http_scope(method, state={"current_user": USER}))

    assert sent[0]["status"] == 200
    assert len(app.calls) == 1
    broadcast.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/projects/1", "/api/kanban/cards/phase/1/status"])
async def test_skip_patterns_are_not_broadcast(broadcast, path):
    app = inner_app()
    await run(bmw.BroadcastMiddleware(app), http_scope("PUT", path, {"current_user": USER}))

    assert len(app.calls) == 1
    broadcast.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [201, 204])
async def test_any_2xx_is_broadcast(broadcast, status):
    await run(
        bmw.BroadcastMiddleware(inner_app(status)),
        http_scope("POST", "/api/tags", {"current_user": USER}),
    )
    broadcast.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [302, 400, 403, 404, 409, 422, 500])
async def test_non_2xx_writes_are_not_broadcast(broadcast, status, session_lookup):
    sent = await run(
        bmw.BroadcastMiddleware(inner_app(status)),
        http_scope("POST", "/api/vacations", {"current_user": USER}),
    )

    assert sent[0]["status"] == status  # response untouched
    broadcast.assert_not_awaited()
    session_lookup.assert_not_awaited()


# ---------------------------------------------------------------------------
# Successful writes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_successful_write_broadcasts_change_and_excludes_sender(broadcast):
    sent = await run(
        bmw.BroadcastMiddleware(inner_app(200, b'{"ok":true}')),
        http_scope(
            "DELETE",
            "/api/sites/2/events/9",
            {"tenant_slug": "acme", "current_user": USER},
        ),
    )

    # The response reached the client unchanged.
    assert [m["type"] for m in sent] == ["http.response.start", "http.response.body"]
    assert sent[1]["body"] == b'{"ok":true}'

    broadcast.assert_awaited_once()
    tenant, message = broadcast.await_args.args
    assert tenant == "acme"
    assert broadcast.await_args.kwargs == {"exclude_user": 7}
    assert message["type"] == "change:company_event"
    assert message["timestamp"].endswith("Z")
    assert message["payload"] == {
        "user_id": 7,
        "user_name": "Ada L.",
        "entity_type": "company_event",
        "entity_id": 0,
        "project_id": 0,
        "action": "delete",
    }


@pytest.mark.asyncio
async def test_snake_case_user_and_missing_last_name(broadcast):
    await run(
        bmw.BroadcastMiddleware(inner_app()),
        http_scope(
            "PATCH", "/api/custom-columns/3", {"current_user": {"id": 2, "first_name": "Bo"}}
        ),
    )
    tenant, message = broadcast.await_args.args
    assert tenant == "default"  # no tenant slug: single-tenant room
    assert message["payload"]["user_name"] == "Bo"
    assert message["payload"]["action"] == "update"


@pytest.mark.asyncio
async def test_falls_back_to_session_lookup_when_state_has_no_user(broadcast, session_lookup):
    session_lookup.return_value = {"id": 9, "first_name": "Cy", "last_name": "Young"}

    await run(bmw.BroadcastMiddleware(inner_app()), http_scope("POST", "/api/skills", state={}))

    session_lookup.assert_awaited_once()
    assert broadcast.await_args.args[1]["payload"]["user_name"] == "Cy Y."
    assert broadcast.await_args.kwargs == {"exclude_user": 9}


@pytest.mark.asyncio
async def test_state_object_that_is_not_a_dict_is_ignored(broadcast, session_lookup):
    session_lookup.return_value = USER
    scope = http_scope("POST", "/api/notes")
    scope["state"] = object()  # e.g. a Starlette State wrapper

    await run(bmw.BroadcastMiddleware(inner_app()), scope)

    session_lookup.assert_awaited_once()
    assert broadcast.await_args.args[0] == "default"


@pytest.mark.asyncio
async def test_anonymous_write_is_not_broadcast(broadcast, session_lookup):
    await run(bmw.BroadcastMiddleware(inner_app()), http_scope("POST", "/api/notes"))

    session_lookup.assert_awaited_once()
    broadcast.assert_not_awaited()


@pytest.mark.asyncio
async def test_session_lookup_error_is_swallowed(broadcast, session_lookup):
    session_lookup.side_effect = RuntimeError("db down")

    sent = await run(bmw.BroadcastMiddleware(inner_app()), http_scope("POST", "/api/notes"))

    assert sent[0]["status"] == 200
    broadcast.assert_not_awaited()


@pytest.mark.asyncio
async def test_broadcast_failure_never_breaks_the_response(broadcast):
    broadcast.side_effect = RuntimeError("ws manager exploded")

    sent = await run(
        bmw.BroadcastMiddleware(inner_app(201)),
        http_scope("POST", "/api/tags", {"current_user": USER}),
    )

    assert sent[0]["status"] == 201
    broadcast.assert_awaited_once()
