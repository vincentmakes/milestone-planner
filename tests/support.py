"""
Shared builders for the mock-based test suite (house style: tests/conftest.py).

Router code reads query results through SQLAlchemy's ``Result`` API —
``scalar_one_or_none()``, ``scalars().all()``, ``unique().scalar_one_or_none()``
— and these helpers build ``MagicMock`` results answering exactly those calls,
to queue on ``mock_db_session.execute.side_effect``::

    mock_db_session.execute.side_effect = [
        scalar_result(project),          # the project lookup
        scalars_result([phase_a, phase_b]),
    ]

``fake_websocket()`` gives a Starlette-shaped WebSocket double for the
``app/websocket`` layer. Prefer these over redefining the helpers per file
(tests/test_domain_routes_misc.py keeps its own private copies).
"""

from typing import Any
from unittest.mock import AsyncMock, MagicMock

from starlette.websockets import WebSocket, WebSocketState


class _ScalarList(list):
    """A list answering the ``ScalarResult`` calls routers chain onto ``scalars()``."""

    def all(self) -> list:
        return list(self)

    def first(self) -> Any:
        return self[0] if self else None

    def unique(self) -> "_ScalarList":
        return self


def scalar_result(value: Any) -> MagicMock:
    """Result whose ``scalar_one_or_none()`` / ``scalar()`` / ``scalar_one()`` return ``value``.

    Use for single-row lookups (``select(Model).where(Model.id == ...)``) and
    aggregate queries (``select(func.count())``).
    """
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    result.scalar.return_value = value
    result.scalar_one.return_value = value
    return result


def scalars_result(values: list[Any]) -> MagicMock:
    """Result whose ``scalars()`` yields ``values`` (``.all()``, ``.first()``, ``.unique().all()``)."""
    result = MagicMock()
    result.scalars.return_value = _ScalarList(values)
    return result


def unique_scalar_result(value: Any) -> MagicMock:
    """Result for joined-eager-load lookups: ``result.unique().scalar_one_or_none()`` returns ``value``.

    SQLAlchemy requires ``unique()`` before reading rows of a query with a
    ``joinedload`` on a collection (e.g. ``GET /users/{id}``).
    """
    result = MagicMock()
    result.unique.return_value.scalar_one_or_none.return_value = value
    result.unique.return_value.scalar_one.return_value = value
    return result


def fake_websocket(
    *,
    headers: dict[str, str] | None = None,
    cookies: dict[str, str] | None = None,
    scope: dict[str, Any] | None = None,
) -> AsyncMock:
    """A connected Starlette ``WebSocket`` double.

    ``accept`` / ``send_json`` / ``send_text`` / ``receive_text`` / ``close``
    (and every other coroutine method of ``WebSocket``) are ``AsyncMock`` objects, so
    tests assert with ``ws.close.assert_awaited_once_with(code=4001, ...)``.
    ``client_state`` is the real ``WebSocketState.CONNECTED`` enum (the manager
    checks ``client_state.name``); set it to ``WebSocketState.DISCONNECTED`` to
    simulate a dead socket. ``headers`` / ``cookies`` / ``scope`` are plain
    dicts — note real ``Headers`` are case-insensitive, so use lower-case keys.
    Script inbound frames with ``ws.receive_text.side_effect = [...]``.
    """
    ws = AsyncMock(spec=WebSocket)
    ws.client_state = WebSocketState.CONNECTED
    ws.application_state = WebSocketState.CONNECTED
    ws.headers = dict(headers or {})
    ws.cookies = dict(cookies or {})
    ws.scope = {"type": "websocket", "path": "/ws", "state": {}, **(scope or {})}
    ws.client = MagicMock(host="127.0.0.1", port=50000)
    return ws
