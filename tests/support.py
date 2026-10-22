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
``app/websocket`` layer; ``ApprovalFakeDB`` and its builders (``approval_request``,
``pending_phase_row``, ``approvable_db``, ...) a statement-dispatching session
for app/services/approvals.py. Prefer these over redefining the helpers per file
(tests/test_domain_routes_misc.py keeps its own private copies).
"""

from typing import Any
from unittest.mock import AsyncMock, MagicMock

from sqlalchemy.sql.dml import Update
from starlette.websockets import WebSocket, WebSocketState

from app.models.assignment import (
    PhaseStaffAssignment,
    ProjectAssignment,
    SubphaseStaffAssignment,
)
from app.models.notification import Notification
from app.models.project import Project
from app.models.rbac import ApprovalPolicy, ApprovalRequest, RolePermission
from app.models.user import User, UserSite
from app.services.approvals import ACTION_CREATE
from tests.conftest import FakeUser


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


# ---------------------------------------------------------------------------
# Approval workflow fakes (tests/test_approvals_service.py,
# tests/test_approvals_followups.py)
# ---------------------------------------------------------------------------

ADMIN_ID = 1
REQUESTER_ID = 3
PM_ID = 7


def approval_admin(user_id: int = ADMIN_ID) -> FakeUser:
    return FakeUser(user_id, "admin")


def dispatch_result(values: list) -> MagicMock:
    result = MagicMock()
    result.scalar_one_or_none.return_value = values[0] if values else None
    result.scalars.return_value.all.return_value = list(values)
    result.first.return_value = values[0] if values else None
    result.all.return_value = list(values)
    return result


_APPROVAL_ASSIGNMENT_MODELS = (ProjectAssignment, PhaseStaffAssignment, SubphaseStaffAssignment)


class ApprovalFakeDB:
    """Answers each SELECT by what it selects; records writes."""

    def __init__(self, **answers):
        self.answers: dict[str, list] = {key: list(value) for key, value in answers.items()}
        self.added: list = []
        self.deleted: list = []
        self.updates: list = []
        self.statements: list = []
        self.commit = AsyncMock()
        self._next_id = 100

    def add(self, obj) -> None:
        self.added.append(obj)

    def add_all(self, objs) -> None:
        self.added.extend(objs)

    async def delete(self, obj) -> None:
        self.deleted.append(obj)

    async def flush(self) -> None:
        for obj in self.added:
            if getattr(obj, "id", None) is None:
                obj.id = self._next_id
                self._next_id += 1

    @staticmethod
    def key(stmt) -> str:
        first = stmt.column_descriptions[0]
        entity, name = first.get("entity"), first.get("name")
        if entity is ApprovalRequest:
            return "request"
        if entity is Project:
            return "context"
        if entity is ApprovalPolicy:
            return "policy"
        if entity is User:
            return "approvers" if name == "id" else "requester"
        if entity is UserSite:
            return "member"
        if entity is RolePermission:
            return "perms"
        if entity in _APPROVAL_ASSIGNMENT_MODELS:
            return "row" if stmt._for_update_arg is not None else "duplicate"
        raise AssertionError(f"unexpected query: {stmt}")

    async def execute(self, stmt):
        self.statements.append(stmt)
        if isinstance(stmt, Update):
            self.updates.append(stmt)
            return MagicMock()
        return dispatch_result(self.answers.get(self.key(stmt), []))

    def queried(self, key: str) -> int:
        return sum(1 for s in self.statements if not isinstance(s, Update) and self.key(s) == key)

    @property
    def notifications(self) -> list[Notification]:
        return [obj for obj in self.added if isinstance(obj, Notification)]


def approval_context(*, pm_id=PM_ID, site_id=1, target=True, name="Design"):
    return ("Alpha", pm_id, site_id, 11 if target else None, name if target else None)


def approval_request(**fields) -> ApprovalRequest:
    values = {
        "id": 50,
        "requester_id": REQUESTER_ID,
        "action": ACTION_CREATE,
        "project_id": 1,
        "level": "phase",
        "target_id": 11,
        "assignment_id": 70,
        "requested": '{"allocation": 80}',
        "previous": None,
        "status": "pending",
    }
    values.update(fields)
    return ApprovalRequest(**values)


def pending_phase_row(**fields) -> PhaseStaffAssignment:
    values = {
        "id": 70,
        "project_id": 1,
        "phase_id": 11,
        "staff_id": REQUESTER_ID,
        "allocation": 80,
        "approval_status": "pending",
        "approval_request_id": 50,
    }
    values.update(fields)
    return PhaseStaffAssignment(**values)


def approvable_db(pending, assignment, /, **extra):
    answers = {
        "request": [pending],
        "context": [approval_context()],
        "requester": [(1, "user", True)],
        "perms": [(pending.action, "approval")],
        "member": [(REQUESTER_ID,)],
        "row": [assignment] if assignment is not None else [],
        "approvers": [ADMIN_ID, PM_ID],
    }
    answers.update(extra)
    return ApprovalFakeDB(**answers)
