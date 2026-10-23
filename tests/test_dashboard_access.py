"""
Who may see and edit a dashboard (app/services/dashboard_access.py).

``can_view`` / ``can_edit`` on plain dashboards, and the SQL clause of the
list against SQLite (it must agree with ``can_view``).
"""

from datetime import date
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.models.dashboard import Dashboard, DashboardRole
from app.models.rbac import Role
from app.models.user import User
from app.routers.dashboards import _today
from app.services.dashboard_access import (
    can_edit,
    can_view,
    role_id_for_key,
    visible_dashboards_clause,
)
from tests.conftest import FakeUser
from tests.sqlite_support import AsyncSessionFacade, sqlite_session

OWNER, OTHER = 2, 3
LEAD_ROLE, USER_ROLE = 4, 3


def dashboard(visibility: str, owner_id: int | None = OWNER, role_ids=()) -> Dashboard:
    board = Dashboard(name="D", visibility=visibility, owner_id=owner_id)
    board.roles = [DashboardRole(role_id=role_id) for role_id in role_ids]
    return board


VIEW_CASES = [
    # (who, role id, dashboard, may view)
    ("admin", None, dashboard("private"), True),
    ("owner", USER_ROLE, dashboard("private"), True),
    ("other", USER_ROLE, dashboard("private"), False),
    ("other", USER_ROLE, dashboard("everyone"), True),
    ("other", USER_ROLE, dashboard("everyone", owner_id=None), True),
    ("other", LEAD_ROLE, dashboard("roles", role_ids=[LEAD_ROLE]), True),
    ("other", USER_ROLE, dashboard("roles", role_ids=[LEAD_ROLE]), False),
    ("other", None, dashboard("roles", role_ids=[LEAD_ROLE]), False),
    ("other", USER_ROLE, dashboard("roles"), False),  # no role left
    ("owner", USER_ROLE, dashboard("roles"), True),
]


def caller(who: str, permissions=None) -> FakeUser:
    if who == "admin":
        return FakeUser(1, "admin")
    return FakeUser(OWNER if who == "owner" else OTHER, "superuser", permissions)


@pytest.mark.parametrize(("who", "role_id", "board", "expected"), VIEW_CASES)
def test_can_view(who, role_id, board, expected):
    assert can_view(caller(who), board, role_id) is expected


@pytest.mark.parametrize(
    ("who", "permissions", "board", "expected"),
    [
        ("admin", None, dashboard("private"), True),
        ("admin", None, dashboard("everyone", owner_id=None), True),
        ("owner", None, dashboard("private"), True),
        ("owner", {"views.dashboards"}, dashboard("private"), False),  # no manage key
        ("other", None, dashboard("everyone"), False),
        ("other", None, dashboard("everyone", owner_id=None), False),
    ],
)
def test_can_edit(who, permissions, board, expected):
    assert can_edit(caller(who, permissions), board) is expected


def test_session_user_shape_is_enough():
    session_user = SimpleNamespace(
        id=OWNER, is_admin=False, permissions=FakeUser(OWNER, "superuser").permissions
    )
    assert can_view(session_user, dashboard("private"), None)
    assert can_edit(session_user, dashboard("private"))


@pytest.fixture
def db():
    with sqlite_session() as session:
        session.add_all(
            [
                Role(id=USER_ROLE, key="user", name="User"),
                Role(id=LEAD_ROLE, key="lead", name="Lead"),
            ]
        )
        session.flush()
        session.add_all(
            [
                User(id=OWNER, email="o@x", password="x", first_name="O", last_name="O"),
                User(id=OTHER, email="t@x", password="x", first_name="T", last_name="T"),
            ]
        )
        session.flush()
        session.add_all(
            [
                Dashboard(id=1, name="private", visibility="private", owner_id=OWNER),
                Dashboard(id=2, name="everyone", visibility="everyone"),
                Dashboard(
                    id=3,
                    name="lead",
                    visibility="roles",
                    owner_id=OWNER,
                    roles=[DashboardRole(role_id=LEAD_ROLE)],
                ),
                Dashboard(id=4, name="none left", visibility="roles", owner_id=OWNER),
            ]
        )
        session.commit()
        yield AsyncSessionFacade(session)


async def _visible(db, user_id, role_id, is_admin=False):
    result = await db.execute(
        select(Dashboard.id)
        .where(visible_dashboards_clause(user_id, role_id, is_admin))
        .order_by(Dashboard.id)
    )
    return list(result.scalars().all())


async def test_clause_agrees_with_can_view(db):
    assert await _visible(db, OWNER, USER_ROLE) == [1, 2, 3, 4]
    assert await _visible(db, OTHER, USER_ROLE) == [2]
    assert await _visible(db, OTHER, LEAD_ROLE) == [2, 3]
    assert await _visible(db, OTHER, None) == [2]
    assert await _visible(db, OTHER, None, is_admin=True) == [1, 2, 3, 4]
    boards = (await db.execute(select(Dashboard).order_by(Dashboard.id))).scalars().all()
    for user_id, role_id in ((OWNER, USER_ROLE), (OTHER, USER_ROLE), (OTHER, LEAD_ROLE)):
        user = FakeUser(user_id, "superuser")
        expected = [b.id for b in boards if can_view(user, b, role_id)]
        assert await _visible(db, user_id, role_id) == expected


async def test_role_id_for_key(db):
    assert await role_id_for_key(db, "lead") == LEAD_ROLE
    assert await role_id_for_key(db, "gone") is None
    assert await role_id_for_key(db, None) is None
    assert await role_id_for_key(db, "") is None


def test_today_is_a_date():
    assert isinstance(_today(), date)
