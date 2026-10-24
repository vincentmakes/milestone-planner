"""
Who may see and edit a dashboard (app/services/dashboard_access.py).

``can_view`` / ``can_edit`` on plain dashboards, ``load_viewer_scope`` and the
SQL clause of the list against SQLite (it must agree with ``can_view``).
"""

from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy import select

from app.models.dashboard import (
    Dashboard,
    DashboardRole,
    DashboardSite,
    DashboardTeam,
    DashboardUser,
)
from app.models.rbac import Role
from app.models.site import Site
from app.models.team import Team, TeamMember
from app.models.user import User, UserSite
from app.routers.dashboards import _today
from app.services.dashboard_access import (
    ViewerScope,
    can_edit,
    can_view,
    load_viewer_scope,
    visible_dashboards_clause,
)
from tests.conftest import FakeUser
from tests.sqlite_support import AsyncSessionFacade, sqlite_session

OWNER, OTHER, ADMIN = 2, 3, 1
LEAD_ROLE, USER_ROLE = 4, 3
SITE_A, SITE_B = 1, 2
TEAM_A, TEAM_B = 10, 20


def dashboard(
    visibility: str,
    owner_id: int | None = OWNER,
    role_ids=(),
    site_ids=(),
    team_ids=(),
    user_ids=(),
) -> Dashboard:
    board = Dashboard(name="D", visibility=visibility, owner_id=owner_id)
    board.roles = [DashboardRole(role_id=i) for i in role_ids]
    board.sites = [DashboardSite(site_id=i) for i in site_ids]
    board.teams = [DashboardTeam(team_id=i) for i in team_ids]
    board.users = [DashboardUser(user_id=i) for i in user_ids]
    return board


def scope(
    who: str = "other", role_id=USER_ROLE, site_ids=(), team_ids=(), user_id=None
) -> ViewerScope:
    if who == "admin":
        return ViewerScope(user_id=ADMIN, is_admin=True)
    return ViewerScope(
        user_id=user_id or (OWNER if who == "owner" else OTHER),
        is_admin=False,
        role_id=role_id,
        site_ids=frozenset(site_ids),
        team_ids=frozenset(team_ids),
    )


VIEW_CASES = [
    # (id, viewer scope, dashboard, may view)
    ("admin sees private", scope("admin"), dashboard("private"), True),
    ("owner sees private", scope("owner"), dashboard("private"), True),
    ("other: private", scope(), dashboard("private"), False),
    ("other: everyone", scope(), dashboard("everyone"), True),
    ("admin-owned everyone", scope(), dashboard("everyone", owner_id=None), True),
    ("role match", scope(role_id=LEAD_ROLE), dashboard("shared", role_ids=[LEAD_ROLE]), True),
    ("other role", scope(), dashboard("shared", role_ids=[LEAD_ROLE]), False),
    ("no role", scope(role_id=None), dashboard("shared", role_ids=[LEAD_ROLE]), False),
    ("site member", scope(site_ids=[SITE_A]), dashboard("shared", site_ids=[SITE_A]), True),
    (
        "member of another site",
        scope(site_ids=[SITE_B]),
        dashboard("shared", site_ids=[SITE_A]),
        False,
    ),
    # A sites.view_all holder who is not a member: their scope lists only the
    # sites they belong to (none here), so no site match.
    ("view_all non-member", scope(site_ids=[]), dashboard("shared", site_ids=[SITE_A]), False),
    ("team member", scope(team_ids=[TEAM_A]), dashboard("shared", team_ids=[TEAM_A]), True),
    ("other team", scope(team_ids=[TEAM_B]), dashboard("shared", team_ids=[TEAM_A]), False),
    ("named person", scope(), dashboard("shared", user_ids=[OTHER]), True),
    ("someone else named", scope(), dashboard("shared", user_ids=[OWNER, 9]), False),
    (
        "two-way match",
        scope(site_ids=[SITE_A], team_ids=[TEAM_A]),
        dashboard("shared", site_ids=[SITE_A], team_ids=[TEAM_A]),
        True,
    ),
    (
        "one of several kinds",
        scope(team_ids=[TEAM_B]),
        dashboard("shared", role_ids=[LEAD_ROLE], site_ids=[SITE_A], team_ids=[TEAM_B]),
        True,
    ),
    ("nothing left", scope(site_ids=[SITE_A], team_ids=[TEAM_A]), dashboard("shared"), False),
    ("owner, nothing left", scope("owner"), dashboard("shared"), True),
    ("admin, nothing left", scope("admin"), dashboard("shared"), True),
    # Targets of a non-shared dashboard never open it.
    ("private with links", scope(), dashboard("private", user_ids=[OTHER]), False),
]


@pytest.mark.parametrize(
    ("viewer", "board", "expected"),
    [case[1:] for case in VIEW_CASES],
    ids=[case[0] for case in VIEW_CASES],
)
def test_can_view(viewer, board, expected):
    assert can_view(viewer, board) is expected


def caller(who: str, permissions=None) -> FakeUser:
    if who == "admin":
        return FakeUser(ADMIN, "admin")
    return FakeUser(OWNER if who == "owner" else OTHER, "superuser", permissions)


@pytest.mark.parametrize(
    ("who", "permissions", "board", "expected"),
    [
        ("admin", None, dashboard("private"), True),
        ("admin", None, dashboard("everyone", owner_id=None), True),
        ("owner", None, dashboard("private"), True),
        ("owner", {"views.dashboards"}, dashboard("private"), False),  # no manage key
        ("other", None, dashboard("everyone"), False),
        ("other", None, dashboard("everyone", owner_id=None), False),
        # Shared access is view only.
        ("other", None, dashboard("shared", user_ids=[OTHER]), False),
    ],
)
def test_can_edit(who, permissions, board, expected):
    assert can_edit(caller(who, permissions), board) is expected


@pytest.fixture
def db():
    with sqlite_session() as session:
        session.add_all(
            [
                Role(id=USER_ROLE, key="user", name="User"),
                Role(id=LEAD_ROLE, key="lead", name="Lead"),
                Site(id=SITE_A, name="A"),
                Site(id=SITE_B, name="B"),
            ]
        )
        session.flush()
        session.add_all(
            [
                User(id=OWNER, email="o@x", password="x", first_name="O", last_name="O"),
                User(id=OTHER, email="t@x", password="x", first_name="T", last_name="T"),
                Team(id=TEAM_A, site_id=SITE_A, name="TA"),
                Team(id=TEAM_B, site_id=SITE_B, name="TB"),
            ]
        )
        session.flush()
        session.add_all(
            [
                UserSite(user_id=OTHER, site_id=SITE_A),
                TeamMember(team_id=TEAM_B, user_id=OTHER),
                Dashboard(id=1, name="private", visibility="private", owner_id=OWNER),
                Dashboard(id=2, name="everyone", visibility="everyone"),
                Dashboard(
                    id=3,
                    name="lead",
                    visibility="shared",
                    owner_id=OWNER,
                    roles=[DashboardRole(role_id=LEAD_ROLE)],
                ),
                Dashboard(id=4, name="none left", visibility="shared", owner_id=OWNER),
                Dashboard(
                    id=5,
                    name="site A",
                    visibility="shared",
                    owner_id=OWNER,
                    sites=[DashboardSite(site_id=SITE_A)],
                ),
                Dashboard(
                    id=6,
                    name="team B",
                    visibility="shared",
                    owner_id=OWNER,
                    teams=[DashboardTeam(team_id=TEAM_B)],
                ),
                Dashboard(
                    id=7,
                    name="the other person",
                    visibility="shared",
                    owner_id=OWNER,
                    users=[DashboardUser(user_id=OTHER)],
                ),
                Dashboard(
                    id=8,
                    name="site B and team A",
                    visibility="shared",
                    owner_id=OWNER,
                    sites=[DashboardSite(site_id=SITE_B)],
                    teams=[DashboardTeam(team_id=TEAM_A)],
                ),
                # Links left on a private dashboard grant nothing.
                Dashboard(
                    id=9,
                    name="private with links",
                    visibility="private",
                    owner_id=OWNER,
                    users=[DashboardUser(user_id=OTHER)],
                ),
            ]
        )
        session.commit()
        yield AsyncSessionFacade(session)


async def _visible(db, viewer: ViewerScope) -> list[int]:
    result = await db.execute(
        select(Dashboard.id).where(visible_dashboards_clause(viewer)).order_by(Dashboard.id)
    )
    return list(result.scalars().all())


SCOPES = {
    "owner": scope("owner"),
    "role user": scope(),
    "role lead": scope(role_id=LEAD_ROLE),
    "no role": scope(role_id=None),
    "site A": scope(site_ids=[SITE_A]),
    "team B": scope(team_ids=[TEAM_B]),
    "site A + team B": scope(site_ids=[SITE_A], team_ids=[TEAM_B]),
    "site B + team A": scope(site_ids=[SITE_B], team_ids=[TEAM_A]),
    "admin": scope("admin"),
}


async def test_clause_examples(db):
    assert await _visible(db, SCOPES["owner"]) == [1, 2, 3, 4, 5, 6, 7, 8, 9]
    assert await _visible(db, SCOPES["role user"]) == [2, 7]  # OTHER is named on 7
    assert await _visible(db, SCOPES["role lead"]) == [2, 3, 7]
    assert await _visible(db, SCOPES["site A"]) == [2, 5, 7]
    assert await _visible(db, SCOPES["team B"]) == [2, 6, 7]
    assert await _visible(db, SCOPES["site A + team B"]) == [2, 5, 6, 7]
    assert await _visible(db, SCOPES["site B + team A"]) == [2, 7, 8]
    assert await _visible(db, SCOPES["admin"]) == list(range(1, 10))
    # Shared with nothing left: the owner and the administrators only.
    for name, viewer in SCOPES.items():
        if name not in {"owner", "admin"}:
            assert 4 not in await _visible(db, viewer), name


@pytest.mark.parametrize("name", SCOPES)
async def test_clause_agrees_with_can_view(db, name):
    viewer = SCOPES[name]
    boards = (await db.execute(select(Dashboard).order_by(Dashboard.id))).scalars().all()
    expected = [board.id for board in boards if can_view(viewer, board)]
    assert await _visible(db, viewer) == expected


async def test_load_viewer_scope_reads_role_sites_and_teams(db):
    viewer = await load_viewer_scope(db, FakeUser(OTHER, "lead", site_ids=[SITE_B]))
    # Sites come from the live user_sites rows, not the session's snapshot.
    assert viewer == ViewerScope(
        user_id=OTHER,
        is_admin=False,
        role_id=LEAD_ROLE,
        site_ids=frozenset({SITE_A}),
        team_ids=frozenset({TEAM_B}),
    )


async def test_load_viewer_scope_unknown_role_and_no_links(db):
    viewer = await load_viewer_scope(db, FakeUser(OWNER, "gone"))
    assert viewer == ViewerScope(user_id=OWNER, is_admin=False)
    viewer = await load_viewer_scope(db, SimpleNamespace(id=OWNER, is_admin=False, role=""))
    assert viewer.role_id is None


async def test_load_viewer_scope_uses_the_site_loader(db):
    """The membership loader of site_access (the route tests patch it)."""

    async def loader(_db, user_id):
        assert user_id == OTHER
        return frozenset({SITE_B})

    with patch("app.services.site_access._load_user_site_ids", loader):
        viewer = await load_viewer_scope(db, FakeUser(OTHER, "user"))
    assert viewer.site_ids == frozenset({SITE_B})


async def test_admin_scope_needs_no_query():
    class NoQueries:
        async def execute(self, *_args, **_kwargs):
            raise AssertionError("no query for an administrator")

    viewer = await load_viewer_scope(NoQueries(), FakeUser(ADMIN, "admin"))
    assert viewer == ViewerScope(user_id=ADMIN, is_admin=True)


def test_session_user_shape_is_enough():
    session_user = SimpleNamespace(
        id=OWNER,
        is_admin=False,
        role="superuser",
        permissions=FakeUser(OWNER, "superuser").permissions,
    )
    viewer = ViewerScope(user_id=session_user.id, is_admin=session_user.is_admin)
    assert can_view(viewer, dashboard("private"))
    assert can_edit(session_user, dashboard("private"))


def test_today_is_a_date():
    assert isinstance(_today(), date)
