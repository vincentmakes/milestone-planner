"""
One database session, one pooled connection per request (2.5.1).

Before 2.5.1 ``get_db_readonly`` opened a session of its own while the auth
dependencies ran on ``get_db``: every authenticated read held two pooled
connections at once, and with more than ~30 reads in flight the pool
deadlocked until ``pool_timeout`` (30 s) failed them with 500s. And a write
that re-read after its commit (``db.refresh``, a reload ``select``) held a
connection again when ``broadcast_change`` / ``change_notifications.deliver``
opened their own session.

These tests go through the **real** dependency chain (no override of
``get_db``, ``get_db_readonly`` or ``get_current_user``): only the session
factory is faked, by one that counts the sessions it opens and how many of
them hold a connection at the same time.
"""

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import Depends, Request
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.services import audit_log, change_notifications
from app.services.permissions import PermissionSet

# The real derived tiers, captured before conftest's autouse fixtures swap
# them for recorders (the precedent of tests/test_change_notifications.py).
REAL_RECORD_DETACHED = audit_log.record_detached
REAL_DELIVER = change_notifications.deliver

COOKIE = {"connect.sid": "s%3Asid-1.signature"}


class Pool:
    """A session factory whose fake sessions track a held connection each."""

    def __init__(self) -> None:
        self.opened = 0
        self.held = 0
        self.max_held = 0
        self.events: list[str] = []
        # Connections other sessions held when each session was opened.
        self.held_at_open: list[int] = []

    def __call__(self) -> "FakeSessionContext":
        return FakeSessionContext(self)

    def checkout(self, session: "FakeSession") -> None:
        if not session.holding:
            session.holding = True
            self.held += 1
            self.max_held = max(self.max_held, self.held)

    def checkin(self, session: "FakeSession") -> None:
        if session.holding:
            session.holding = False
            self.held -= 1


class FakeSession:
    def __init__(self, pool: Pool, number: int) -> None:
        self.pool = pool
        self.number = number
        self.holding = False
        self.mock = MagicMock(spec=AsyncSession)
        self.mock.in_transaction.side_effect = lambda: self.holding
        self.mock.execute = AsyncMock(side_effect=self._execute)
        self.mock.flush = AsyncMock(side_effect=self._flush)
        self.mock.commit = AsyncMock(side_effect=self._commit)
        self.mock.rollback = AsyncMock(side_effect=self._end)
        self.mock.close = AsyncMock(side_effect=self._end)

    async def _execute(self, *args: Any, **kwargs: Any) -> Any:
        self.pool.checkout(self)
        self.pool.events.append(f"execute#{self.number}")
        result = MagicMock()
        result.first.return_value = None
        result.scalar_one_or_none.return_value = None
        result.scalars.return_value.all.return_value = []
        result.all.return_value = []
        return result

    async def _flush(self) -> None:
        self.pool.checkout(self)

    async def _commit(self) -> None:
        self.pool.events.append(f"commit#{self.number}")
        self.pool.checkin(self)

    async def _end(self) -> None:
        self.pool.checkin(self)


class FakeSessionContext:
    def __init__(self, pool: Pool) -> None:
        self.pool = pool

    async def __aenter__(self) -> Any:
        self.pool.held_at_open.append(self.pool.held)
        self.pool.opened += 1
        self.session = FakeSession(self.pool, self.pool.opened)
        self.pool.events.append(f"open#{self.pool.opened}")
        return self.session.mock

    async def __aexit__(self, *exc: Any) -> None:
        self.pool.checkin(self.session)


@pytest.fixture
async def real_chain(test_settings):
    """(client, app, pool): the app with its real session dependencies."""
    pool = Pool()
    user_data = {
        "id": 1,
        "email": "admin@example.com",
        "first_name": "Ada",
        "last_name": "Admin",
        "role": "admin",
    }
    with patch("app.config.get_settings", return_value=test_settings):
        from app.main import create_app

        app = create_app()
    with (
        patch.object(audit_log, "record_detached", REAL_RECORD_DETACHED),
        patch.object(change_notifications, "deliver", REAL_DELIVER),
        patch("app.database.get_session_factory", return_value=pool),
        patch.object(change_notifications, "get_session_factory", return_value=pool),
        patch(
            "app.middleware.auth.SessionService.get_user_from_session",
            AsyncMock(return_value=user_data),
        ),
        patch(
            "app.middleware.auth.load_live_user",
            AsyncMock(return_value=(True, "admin", PermissionSet("admin", {}))),
        ),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            client.cookies.update(COOKIE)
            yield client, app, pool


def add_probe_routes(app: Any) -> None:
    """Two probe routes, put ahead of the SPA catch-all."""
    before = len(app.router.routes)
    _define_probe_routes(app)
    added = app.router.routes[before:]
    del app.router.routes[before:]
    app.router.routes[0:0] = added


def _define_probe_routes(app: Any) -> None:
    from app.database import REQUEST_SESSION_STATE_KEY, get_db, get_db_readonly
    from app.middleware.auth import get_current_user
    from app.websocket.broadcast import broadcast_change

    @app.get("/api/__probe/read")
    async def probe_read(
        request: Request,
        db: AsyncSession = Depends(get_db_readonly),
        user: Any = Depends(get_current_user),
    ) -> dict:
        await db.execute(select(1))
        return {"same": db is getattr(request.state, REQUEST_SESSION_STATE_KEY)}

    @app.post("/api/__probe/write")
    async def probe_write(
        request: Request,
        db: AsyncSession = Depends(get_db),
        user: Any = Depends(get_current_user),
    ) -> dict:
        await db.execute(select(1))  # the write
        await db.commit()
        await db.execute(select(1))  # the post-commit re-read (db.refresh, reload)
        await broadcast_change(request, user, "project", 1, 1, "update", "P")
        await db.execute(select(1))  # another re-read before the notifications
        with patch.object(change_notifications, "_write", AsyncMock(return_value=[])):
            await change_notifications.deliver(
                db, request, user.id, [SimpleNamespace(user_id=2)], already_notified=()
            )
        return {"success": True}


@pytest.mark.asyncio
async def test_a_read_route_opens_exactly_one_session(real_chain):
    client, app, pool = real_chain
    add_probe_routes(app)

    response = await client.get("/api/__probe/read")

    assert response.status_code == 200
    assert response.json() == {"same": True}
    assert pool.opened == 1
    assert pool.max_held == 1


@pytest.mark.asyncio
async def test_a_real_get_db_readonly_route_opens_exactly_one_session(real_chain):
    """GET /api/projects/{id} (get_db_readonly + get_current_user): one session."""
    client, _app, pool = real_chain

    response = await client.get("/api/projects/999")

    assert response.status_code == 404
    assert pool.opened == 1
    assert pool.max_held == 1


@pytest.mark.asyncio
async def test_a_write_that_re_reads_after_its_commit_never_holds_two_connections(real_chain):
    client, app, pool = real_chain
    add_probe_routes(app)

    response = await client.post("/api/__probe/write")

    assert response.status_code == 200
    # The request's session, the audit row's and the notifications'.
    assert pool.opened == 3, pool.events
    assert pool.max_held == 1
    # The request session (#1) was committed -- its connection back in the
    # pool -- before each derived session opened.
    assert pool.held_at_open == [0, 0, 0]
    assert pool.events.index("open#2") > pool.events.index("commit#1")
