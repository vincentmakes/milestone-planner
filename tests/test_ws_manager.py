"""
WebSocket ConnectionManager (app/websocket/manager.py).

Per-tenant rooms, several connections per user (tabs/devices), presence
join/leave emitted once per *user* rather than once per tab, and fan-out
that excludes a user or a single connection.
"""

import json

import pytest
from starlette.websockets import WebSocketState

from app.websocket.manager import ConnectedUser, ConnectionManager
from tests.support import fake_websocket


def sent_messages(ws) -> list[dict]:
    """Every JSON frame the manager pushed to ``ws`` (it sends with send_text)."""
    return [json.loads(call.args[0]) for call in ws.send_text.await_args_list]


def types_sent(ws) -> list[str]:
    return [m["type"] for m in sent_messages(ws)]


@pytest.fixture
def mgr():
    return ConnectionManager()


async def join(mgr, tenant="acme", user_id=1, first="Ada", last="Lovelace", session_id=None):
    ws = fake_websocket()
    conn_id = await mgr.connect(ws, tenant, user_id, first, last, session_id=session_id)
    return ws, conn_id


# ---------------------------------------------------------------------------
# connect / presence
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_connect_accepts_and_sends_presence_list_including_self(mgr):
    ws, conn_id = await join(mgr, user_id=7, first="Ada", last="L")

    ws.accept.assert_awaited_once()
    assert conn_id == 1
    (msg,) = sent_messages(ws)
    assert msg["type"] == "presence:list"
    assert msg["timestamp"].endswith("Z")
    (user,) = msg["payload"]["users"]
    assert user["user_id"] == 7 and user["first_name"] == "Ada" and user["last_name"] == "L"
    assert user["connected_at"].endswith("Z")


@pytest.mark.asyncio
async def test_connection_ids_are_unique_and_increasing(mgr):
    _, a = await join(mgr, user_id=1)
    _, b = await join(mgr, user_id=1)
    _, c = await join(mgr, tenant="other", user_id=2)
    assert (a, b, c) == (1, 2, 3)


@pytest.mark.asyncio
async def test_join_is_broadcast_once_per_user_not_per_tab(mgr):
    observer, _ = await join(mgr, user_id=2, first="Bob")
    await join(mgr, user_id=7, first="Ada")  # first tab
    await join(mgr, user_id=7, first="Ada")  # second tab

    joins = [m for m in sent_messages(observer) if m["type"] == "presence:join"]
    assert len(joins) == 1
    assert joins[0]["payload"]["user_id"] == 7


@pytest.mark.asyncio
async def test_join_is_not_echoed_to_the_joining_connection(mgr):
    ws, _ = await join(mgr, user_id=7)
    assert types_sent(ws) == ["presence:list"]


@pytest.mark.asyncio
async def test_second_tab_join_reaches_neither_tab(mgr):
    tab1, _ = await join(mgr, user_id=7)
    tab2, _ = await join(mgr, user_id=7)
    assert "presence:join" not in types_sent(tab1)
    assert types_sent(tab2) == ["presence:list"]


@pytest.mark.asyncio
async def test_presence_list_is_deduplicated_by_user(mgr):
    await join(mgr, user_id=7)
    await join(mgr, user_id=7)
    ws, _ = await join(mgr, user_id=8, first="Bob")

    (msg,) = (m for m in sent_messages(ws) if m["type"] == "presence:list")
    assert sorted(u["user_id"] for u in msg["payload"]["users"]) == [7, 8]


@pytest.mark.asyncio
async def test_rooms_are_isolated_per_tenant(mgr):
    acme, _ = await join(mgr, tenant="acme", user_id=1)
    await join(mgr, tenant="globex", user_id=2)

    assert types_sent(acme) == ["presence:list"]  # never told about globex's user
    assert mgr.get_online_count("acme") == 1
    assert mgr.get_online_count("globex") == 1
    assert mgr.get_online_count("nobody") == 0


@pytest.mark.asyncio
async def test_connect_of_an_already_closed_socket_is_unregistered(mgr):
    ws = fake_websocket()
    ws.client_state = WebSocketState.DISCONNECTED

    conn_id = await mgr.connect(ws, "acme", 7, "Ada", "L")

    assert conn_id == 1
    assert "acme" not in mgr._connections
    ws.send_text.assert_not_awaited()


@pytest.mark.asyncio
async def test_presence_list_failure_unregisters_the_connection(mgr, monkeypatch):
    async def boom(websocket, tenant_id):
        raise RuntimeError("socket gone")

    monkeypatch.setattr(mgr, "_send_presence_list", boom)
    ws = fake_websocket()

    await mgr.connect(ws, "acme", 7, "Ada", "L")

    assert mgr.get_online_users("acme") == []


@pytest.mark.asyncio
async def test_get_online_users_dedupes_and_keeps_first_connection(mgr):
    await join(mgr, user_id=7, first="Ada")
    await join(mgr, user_id=7, first="Ada")
    await join(mgr, user_id=8, first="Bob")

    users = mgr.get_online_users("acme")
    assert [u["user_id"] for u in users] == [7, 8]
    assert users[1]["first_name"] == "Bob"
    assert mgr.get_online_count("acme") == 2


def test_to_presence_dict_formats_utc_timestamp():
    from datetime import datetime

    conn = ConnectedUser(
        connection_id=1,
        user_id=3,
        first_name="Ada",
        last_name="L",
        websocket=fake_websocket(),
        connected_at=datetime(2026, 1, 2, 3, 4, 5),
    )
    assert conn.to_presence_dict() == {
        "user_id": 3,
        "first_name": "Ada",
        "last_name": "L",
        "connected_at": "2026-01-02T03:04:05Z",
    }


# ---------------------------------------------------------------------------
# disconnect
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_leave_is_broadcast_only_when_the_last_tab_closes(mgr):
    observer, _ = await join(mgr, user_id=2)
    _, tab1 = await join(mgr, user_id=7)
    _, tab2 = await join(mgr, user_id=7)

    await mgr.disconnect("acme", tab1)
    assert "presence:leave" not in types_sent(observer)
    assert mgr.get_online_count("acme") == 2

    await mgr.disconnect("acme", tab2)
    leaves = [m for m in sent_messages(observer) if m["type"] == "presence:leave"]
    assert [m["payload"] for m in leaves] == [{"user_id": 7}]
    assert mgr.get_online_count("acme") == 1


@pytest.mark.asyncio
async def test_last_connection_removes_the_tenant_room(mgr):
    _, conn = await join(mgr, user_id=7)
    await mgr.disconnect("acme", conn)
    assert "acme" not in mgr._connections


@pytest.mark.asyncio
async def test_disconnect_of_unknown_connection_is_a_noop(mgr):
    observer, _ = await join(mgr, user_id=2)
    before = observer.send_text.await_count

    await mgr.disconnect("acme", 999)
    await mgr.disconnect("no-such-tenant", 1)

    assert observer.send_text.await_count == before
    assert mgr.get_online_count("acme") == 1


# ---------------------------------------------------------------------------
# disconnect_user (session revocation)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_disconnect_user_uses_custom_close_code_and_announces_leave(mgr):
    observer, _ = await join(mgr, user_id=2)
    tab1, _ = await join(mgr, user_id=7, session_id="s1")
    tab2, _ = await join(mgr, user_id=7, session_id="s2")

    removed = await mgr.disconnect_user("acme", 7, code=4003, reason="User account is disabled")

    assert removed == 2
    tab1.close.assert_awaited_once_with(code=4003, reason="User account is disabled")
    tab2.close.assert_awaited_once_with(code=4003, reason="User account is disabled")
    assert sent_messages(observer)[-1]["type"] == "presence:leave"
    assert mgr.get_online_count("acme") == 1


@pytest.mark.asyncio
async def test_disconnect_user_ignores_close_failures_and_drops_empty_room(mgr):
    tab, _ = await join(mgr, user_id=7)
    tab.close.side_effect = RuntimeError("already closed")

    assert await mgr.disconnect_user("acme", 7) == 1
    assert "acme" not in mgr._connections


@pytest.mark.asyncio
async def test_disconnect_user_with_no_matching_connection_returns_zero(mgr):
    observer, _ = await join(mgr, user_id=2)
    before = observer.send_text.await_count

    assert await mgr.disconnect_user("acme", 7) == 0
    assert observer.send_text.await_count == before


# ---------------------------------------------------------------------------
# broadcast_to_tenant / send_to_user / broadcast_change
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_broadcast_reaches_every_connection_of_the_tenant(mgr):
    a, _ = await join(mgr, user_id=1)
    b, _ = await join(mgr, user_id=2)
    elsewhere, _ = await join(mgr, tenant="globex", user_id=3)

    sent = await mgr.broadcast_to_tenant("acme", {"type": "change:site"})

    assert sent == 2
    assert types_sent(a)[-1] == "change:site"
    assert types_sent(b)[-1] == "change:site"
    assert "change:site" not in types_sent(elsewhere)


@pytest.mark.asyncio
async def test_broadcast_exclude_user_skips_all_of_that_users_tabs(mgr):
    tab1, _ = await join(mgr, user_id=7)
    tab2, _ = await join(mgr, user_id=7)
    other, _ = await join(mgr, user_id=8)

    sent = await mgr.broadcast_to_tenant("acme", {"type": "change:tag"}, exclude_user=7)

    assert sent == 1
    assert "change:tag" not in types_sent(tab1) + types_sent(tab2)
    assert types_sent(other)[-1] == "change:tag"


@pytest.mark.asyncio
async def test_broadcast_exclude_connection_skips_only_that_tab(mgr):
    tab1, conn1 = await join(mgr, user_id=7)
    tab2, _ = await join(mgr, user_id=7)

    sent = await mgr.broadcast_to_tenant("acme", {"type": "x"}, exclude_connection=conn1)

    assert sent == 1
    assert "x" not in types_sent(tab1)
    assert types_sent(tab2)[-1] == "x"


@pytest.mark.asyncio
async def test_broadcast_to_empty_tenant_sends_nothing(mgr):
    assert await mgr.broadcast_to_tenant("ghost", {"type": "x"}) == 0


@pytest.mark.asyncio
async def test_dead_socket_is_skipped_without_breaking_the_fan_out(mgr):
    dead, _ = await join(mgr, user_id=1)
    alive, _ = await join(mgr, user_id=2)
    dead.client_state = WebSocketState.DISCONNECTED
    dead.send_text.reset_mock()

    await mgr.broadcast_to_tenant("acme", {"type": "change:note"})

    dead.send_text.assert_not_awaited()
    assert types_sent(alive)[-1] == "change:note"


@pytest.mark.asyncio
async def test_send_errors_are_swallowed_per_socket(mgr):
    closing, _ = await join(mgr, user_id=1)
    broken, _ = await join(mgr, user_id=2)
    alive, _ = await join(mgr, user_id=3)
    closing.send_text.side_effect = RuntimeError("Cannot call send once close sent")
    broken.send_text.side_effect = OSError("broken pipe")

    sent = await mgr.broadcast_to_tenant("acme", {"type": "change:skill"})

    # _send_json swallows both errors, so the broadcast still counts them as
    # attempted, and the healthy socket still gets the message.
    assert sent == 3
    assert types_sent(alive)[-1] == "change:skill"


@pytest.mark.asyncio
async def test_send_json_failure_is_counted_as_not_sent(mgr, monkeypatch):
    a, _ = await join(mgr, user_id=1)
    b, _ = await join(mgr, user_id=2)

    original = mgr._send_json

    async def flaky(websocket, data):
        if websocket is a:
            raise RuntimeError("boom")
        await original(websocket, data)

    monkeypatch.setattr(mgr, "_send_json", flaky)

    assert await mgr.broadcast_to_tenant("acme", {"type": "x"}) == 1
    assert await mgr.send_to_user("acme", 1, {"type": "y"}) == 0
    assert types_sent(b)[-1] == "x"


@pytest.mark.asyncio
async def test_send_to_user_reaches_every_tab_of_that_user_only(mgr):
    tab1, _ = await join(mgr, user_id=7)
    tab2, _ = await join(mgr, user_id=7)
    other, _ = await join(mgr, user_id=8)

    sent = await mgr.send_to_user("acme", 7, {"type": "notification:new", "payload": {"id": 1}})

    assert sent == 2
    assert types_sent(tab1)[-1] == "notification:new"
    assert types_sent(tab2)[-1] == "notification:new"
    assert "notification:new" not in types_sent(other)
    assert await mgr.send_to_user("acme", 99, {"type": "x"}) == 0
    assert await mgr.send_to_user("ghost", 7, {"type": "x"}) == 0


@pytest.mark.asyncio
async def test_broadcast_change_payload_and_sender_exclusion(mgr):
    sender, _ = await join(mgr, user_id=7)
    receiver, _ = await join(mgr, user_id=8)

    await mgr.broadcast_change(
        "acme",
        user_id=7,
        user_name="Ada L.",
        entity_type="phase",
        entity_id=42,
        project_id=3,
        action="update",
        summary="moved to Jan 15",
    )

    assert "change:phase" not in types_sent(sender)
    msg = sent_messages(receiver)[-1]
    assert msg["type"] == "change:phase"
    assert msg["payload"] == {
        "user_id": 7,
        "user_name": "Ada L.",
        "entity_type": "phase",
        "entity_id": 42,
        "project_id": 3,
        "action": "update",
        "summary": "moved to Jan 15",
    }
