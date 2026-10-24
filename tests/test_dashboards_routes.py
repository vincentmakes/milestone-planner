"""
Dashboards API (app/routers/dashboards.py) through ``authed_client``, on SQLite.

The module overrides ``mock_db_session`` with an ``AsyncSession`` facade over
an in-memory SQLite database (tests/sqlite_support.py), so the visibility
clause, the widget replace and the metric loader run real SQL. The callers
are FakeUsers whose ids and role keys match the seeded users and roles. A
caller's own sites are its FakeUser ``site_ids`` (authed_client patches the
membership loader); everyone else's ``user_sites`` and every team membership
are real rows of the fixture.
"""

import json
from datetime import date
from unittest.mock import patch

import pytest
from sqlalchemy import text

from app.models.assignment import ProjectAssignment
from app.models.dashboard import (
    Dashboard,
    DashboardRole,
    DashboardSite,
    DashboardTeam,
    DashboardUser,
    DashboardWidget,
)
from app.models.project import Project
from app.models.project_field import ProjectField
from app.models.rbac import Role, RolePermission
from app.models.site import Site
from app.models.team import Team, TeamMember
from app.models.user import User, UserSite
from app.routers import dashboards as dashboards_router
from app.services import metrics
from tests.conftest import FakeUser
from tests.sqlite_support import AsyncSessionFacade, sqlite_session

TODAY = date(2026, 10, 23)
ADMIN, SUE, UMA, LEO, SAM, FAY, ED, IVY = 1, 2, 3, 4, 5, 6, 7, 8
WINTERTHUR, FRANKFURT = 1, 2
QA_TEAM, LAB_TEAM = 1, 2
# The sharing dashboards (ids clear of the ones tests add themselves).
FRANKFURT_BOARD, QA_BOARD, FOR_LEO, TWO_WAYS = 20, 21, 22, 23
LAYOUT = {
    "lg": {"x": 0, "y": 0, "w": 6, "h": 4},
    "md": {"x": 0, "y": 0, "w": 8, "h": 4},
    "sm": {"x": 0, "y": 0, "w": 4, "h": 4},
}
KPI_QUERY = {
    "measure": "booked_days",
    "dimensions": [],
    "filters": {"archived": "exclude", "period": {"relative": "this_year"}},
    "percent_of": None,
    "top_n": None,
}
BY_SITE = {
    "measure": "booked_days",
    "dimensions": [{"kind": "site"}],
    "filters": {"period": {"from": "2026-03-01", "to": "2026-03-31"}},
}


def compact(value) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def widget_row(title: str, query, sort_order: int = 0, kind: str = "kpi") -> DashboardWidget:
    return DashboardWidget(
        kind=kind,
        title=title,
        query=query if isinstance(query, str) else compact(query),
        options="{}",
        layout=compact(LAYOUT),
        sort_order=sort_order,
    )


def widget_body(title: str = "Booked", query=None, **extra) -> dict:
    return {
        "kind": "bar",
        "title": title,
        "query": query or BY_SITE,
        "options": {"stacked": True},
        "layout": LAYOUT,
        **extra,
    }


@pytest.fixture
def sqlite():
    with sqlite_session() as session:
        session.add_all(
            [
                Role(id=1, key="admin", name="Administrator", is_system=True),
                Role(id=2, key="superuser", name="Superuser", is_system=True),
                Role(id=3, key="user", name="User", is_system=True),
                Role(id=4, key="lead", name="Team Lead"),
                # A custom role seeing every site: its holders are shareable
                # from any site.
                Role(id=5, key="auditor", name="Auditor"),
                Site(id=WINTERTHUR, name="Winterthur"),
                Site(id=FRANKFURT, name="Frankfurt"),
            ]
        )
        session.flush()
        session.add(RolePermission(role_id=5, permission="sites.view_all", mode="allow"))
        for user_id, role, first, active in (
            (ADMIN, "admin", "Ada", 1),
            (SUE, "superuser", "Sue", 1),
            (UMA, "user", "Uma", 1),
            (LEO, "lead", "Leo", 1),
            (SAM, "superuser", "Sam", 1),
            (FAY, "user", "Fay", 1),
            (ED, "user", "Ed", 0),
            (IVY, "auditor", "Ivy", 1),
        ):
            session.add(
                User(
                    id=user_id,
                    email=f"{first.lower()}@x",
                    password="x",
                    first_name=first,
                    last_name="Test",
                    role=role,
                    active=active,
                    job_title="Chemist" if user_id == LEO else None,
                )
            )
        session.flush()
        # Everyone's live user_sites rows (a caller's own come from its
        # FakeUser) and the teams: QA at Winterthur (Uma), Lab at Frankfurt
        # (Fay; inactive).
        session.add_all(
            [
                *(
                    UserSite(user_id=user_id, site_id=site_id)
                    for user_id, site_id in (
                        (SUE, WINTERTHUR),
                        (UMA, WINTERTHUR),
                        (LEO, WINTERTHUR),
                        (LEO, FRANKFURT),
                        (SAM, FRANKFURT),
                        (FAY, FRANKFURT),
                        (ED, WINTERTHUR),
                    )
                ),
                Team(id=QA_TEAM, site_id=WINTERTHUR, name="QA & Compliance"),
                Team(id=LAB_TEAM, site_id=FRANKFURT, name="Lab", active=False),
            ]
        )
        session.flush()
        session.add_all(
            [
                TeamMember(team_id=QA_TEAM, user_id=UMA),
                TeamMember(team_id=LAB_TEAM, user_id=FAY),
            ]
        )
        session.flush()
        session.add_all(
            [
                Project(
                    id=1,
                    name="Alpha",
                    site_id=1,
                    start_date=date(2026, 1, 1),
                    end_date=date(2026, 12, 31),
                ),
                Project(
                    id=2,
                    name="Beta",
                    site_id=2,
                    start_date=date(2026, 1, 1),
                    end_date=date(2026, 12, 31),
                ),
                ProjectField(id=30, name="Notes", field_type="text"),
            ]
        )
        session.flush()
        session.add_all(
            [
                ProjectAssignment(
                    id=1,
                    project_id=1,
                    staff_id=UMA,
                    allocation=100,
                    start_date=date(2026, 3, 2),
                    end_date=date(2026, 3, 6),
                ),
                ProjectAssignment(
                    id=2,
                    project_id=2,
                    staff_id=LEO,
                    allocation=50,
                    start_date=date(2026, 3, 2),
                    end_date=date(2026, 3, 6),
                ),
            ]
        )
        dashboards = [
            Dashboard(
                id=1,
                name="Overview",
                visibility="everyone",
                is_default=True,
                widgets=[widget_row("Booked days", KPI_QUERY)],
            ),
            Dashboard(id=2, name="Sue private", visibility="private", owner_id=SUE),
            Dashboard(
                id=3,
                name="Lead board",
                visibility="shared",
                owner_id=SUE,
                roles=[DashboardRole(role_id=4)],
            ),
            Dashboard(
                id=4,
                name="Users board",
                visibility="shared",
                owner_id=SUE,
                roles=[DashboardRole(role_id=3)],
            ),
            Dashboard(id=5, name="orphan shared", visibility="shared", owner_id=SUE),
            Dashboard(
                id=FRANKFURT_BOARD,
                name="Frankfurt board",
                visibility="shared",
                owner_id=SUE,
                sites=[DashboardSite(site_id=FRANKFURT)],
            ),
            Dashboard(
                id=QA_BOARD,
                name="QA board",
                visibility="shared",
                owner_id=SUE,
                teams=[DashboardTeam(team_id=QA_TEAM)],
            ),
            Dashboard(
                id=FOR_LEO,
                name="For Leo",
                visibility="shared",
                owner_id=SUE,
                users=[DashboardUser(user_id=LEO)],
            ),
            Dashboard(
                id=TWO_WAYS,
                name="Two ways",
                visibility="shared",
                owner_id=SUE,
                sites=[DashboardSite(site_id=FRANKFURT)],
                users=[DashboardUser(user_id=FAY)],
            ),
            Dashboard(id=6, name="Everyone by Sue", visibility="everyone", owner_id=SUE),
            Dashboard(
                id=7,
                name="Mixed",
                visibility="everyone",
                owner_id=SUE,
                widgets=[
                    widget_row("Good", BY_SITE, 0),
                    widget_row("Broken JSON", "{not json", 1),
                    widget_row("Invalid", {"measure": "nope"}, 2),
                    widget_row("By person", {**BY_SITE, "dimensions": [{"kind": "person"}]}, 3),
                    widget_row(
                        "Archived only",
                        {**BY_SITE, "filters": {**BY_SITE["filters"], "archived": "only"}},
                        4,
                    ),
                    widget_row(
                        "Gone field",
                        {**BY_SITE, "dimensions": [{"kind": "field", "field_id": 99}]},
                        5,
                    ),
                    widget_row(
                        "All time",
                        {"measure": "project_count", "filters": {"period": {"relative": "all"}}},
                        6,
                    ),
                    widget_row(
                        "Projects of a team",
                        {"measure": "project_count", "filters": {"team_ids": [1]}},
                        7,
                    ),
                    widget_row(
                        "One person",
                        {**BY_SITE, "filters": {**BY_SITE["filters"], "person_ids": [UMA]}},
                        8,
                    ),
                ],
            ),
        ]
        session.add_all(dashboards)
        session.commit()
        yield session


@pytest.fixture
def mock_db_session(sqlite):
    """The authed_client's session: real SQL on SQLite."""
    return AsyncSessionFacade(sqlite)


@pytest.fixture(autouse=True)
def pinned_today():
    with patch.object(dashboards_router, "_today", return_value=TODAY):
        yield


def user(user_id: int, role: str, permissions=None, site_ids=(1,)) -> FakeUser:
    return FakeUser(user_id, role, permissions, site_ids=site_ids)


def admin() -> FakeUser:
    return user(ADMIN, "admin")


def sue(**kwargs) -> FakeUser:
    return user(SUE, "superuser", **kwargs)


def uma(**kwargs) -> FakeUser:
    return user(UMA, "user", **kwargs)


def leo() -> FakeUser:
    return user(LEO, "lead", {"views.dashboards"})


def fay() -> FakeUser:
    """A Frankfurt member: matches by site (and is named on Two ways)."""
    return user(FAY, "user", site_ids=(FRANKFURT,))


def frank() -> FakeUser:
    """A Frankfurt member with a role that matches nothing (no role row)."""
    return user(SAM, "nobody", {"views.dashboards"}, site_ids=(FRANKFURT,))


def roaming() -> FakeUser:
    """Sees every site, but is a member of Winterthur only: no Frankfurt match."""
    return user(SAM, "nobody", {"views.dashboards", "sites.view_all"}, site_ids=(WINTERTHUR,))


# --- List and visibility -------------------------------------------------------


@pytest.mark.parametrize(
    ("caller", "expected"),
    [
        (admin, [1, 6, 22, 20, 3, 7, 5, 21, 2, 23, 4]),
        (sue, [1, 6, 22, 20, 3, 7, 5, 21, 2, 23, 4]),
        (uma, [1, 6, 7, 21, 4]),  # role user, team QA
        (leo, [1, 6, 22, 3, 7]),  # role lead, named on For Leo
        (frank, [1, 6, 20, 7, 23]),  # Frankfurt member
        (fay, [1, 6, 20, 7, 23, 4]),  # by site and by name: Two ways once
        (roaming, [1, 6, 7]),  # sites.view_all is not membership
    ],
)
async def test_list_shows_what_the_caller_may_open(authed_client, caller, expected):
    client, set_user = authed_client
    set_user(caller())
    resp = await client.get("/api/dashboards")
    assert resp.status_code == 200
    assert [row["id"] for row in resp.json()] == expected


async def test_list_row_shape(authed_client):
    client, set_user = authed_client
    set_user(sue())
    rows = {row["id"]: row for row in (await client.get("/api/dashboards")).json()}
    assert rows[1]["is_default"] is True and rows[1]["can_edit"] is False
    assert rows[1]["owner_id"] is None and rows[1]["owner_name"] is None
    assert rows[1]["widget_count"] == 1
    assert rows[3]["role_ids"] == [4] and rows[3]["owner_name"] == "Sue Test"
    assert rows[3]["can_edit"] is True
    assert rows[3]["shared_with"] == {
        "roles": [{"id": 4, "name": "Team Lead"}],
        "sites": [],
        "teams": [],
        "users": [],
    }
    # A shared dashboard with no target left: its owner sees it, shared with none.
    assert rows[5]["visibility"] == "shared"
    assert [rows[5][k] for k in ("role_ids", "site_ids", "team_ids", "user_ids")] == [[]] * 4
    assert rows[5]["shared_with"] == {"roles": [], "sites": [], "teams": [], "users": []}
    assert rows[TWO_WAYS]["site_ids"] == [FRANKFURT]
    assert rows[TWO_WAYS]["user_ids"] == [FAY]
    assert rows[TWO_WAYS]["shared_with"] == {
        "roles": [],
        "sites": [{"id": FRANKFURT, "name": "Frankfurt"}],
        "teams": [],
        "users": [{"id": FAY, "name": "Fay Test"}],
    }
    assert rows[QA_BOARD]["team_ids"] == [QA_TEAM]
    assert rows[QA_BOARD]["shared_with"]["teams"] == [
        {"id": QA_TEAM, "name": "QA & Compliance", "site_name": "Winterthur"}
    ]
    # Everyone's dashboards list no target.
    assert rows[1]["shared_with"] == {"roles": [], "sites": [], "teams": [], "users": []}
    assert rows[7]["widget_count"] == 9
    assert rows[1]["updated_at"].endswith("Z")


async def test_list_needs_the_view_key(authed_client):
    client, set_user = authed_client
    set_user(uma(permissions=set()))
    resp = await client.get("/api/dashboards")
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Permission required: views.dashboards"


async def test_admin_may_edit_everything(authed_client):
    client, set_user = authed_client
    set_user(admin())
    rows = (await client.get("/api/dashboards")).json()
    assert all(row["can_edit"] for row in rows)


@pytest.mark.parametrize(
    ("caller", "dashboard_id", "status"),
    [
        (sue, 2, 200),  # owner, private
        (uma, 2, 404),  # someone else's private
        (admin, 2, 200),
        (leo, 3, 200),  # shared with my role
        (uma, 3, 404),  # shared without my role
        (uma, 4, 200),
        (uma, 5, 404),  # shared with nothing left
        (sue, 5, 200),
        (admin, 5, 200),
        (uma, 6, 200),  # everyone
        (frank, FRANKFURT_BOARD, 200),  # member of the site
        (uma, FRANKFURT_BOARD, 404),
        (roaming, FRANKFURT_BOARD, 404),  # sees the site, is not a member
        (uma, QA_BOARD, 200),  # member of the team
        (leo, QA_BOARD, 404),
        (fay, QA_BOARD, 404),
        (leo, FOR_LEO, 200),  # named
        (uma, FOR_LEO, 404),
        (fay, TWO_WAYS, 200),  # two ways at once
        (uma, 99, 404),
    ],
)
async def test_get_visibility_matrix(authed_client, caller, dashboard_id, status):
    client, set_user = authed_client
    set_user(caller())
    resp = await client.get(f"/api/dashboards/{dashboard_id}")
    assert resp.status_code == status


async def test_get_returns_widgets_as_objects(authed_client):
    client, set_user = authed_client
    set_user(uma())
    body = (await client.get("/api/dashboards/1")).json()
    assert body["name"] == "Overview" and body["can_edit"] is False
    (widget,) = body["widgets"]
    assert widget["query"] == KPI_QUERY
    assert widget["options"] == {} and widget["layout"] == LAYOUT
    assert widget["title"] == "Booked days" and widget["kind"] == "kpi"


# --- Create --------------------------------------------------------------------


async def test_create_round_trips_widget_objects(authed_client, sqlite):
    client, set_user = authed_client
    set_user(sue())
    query = {
        "measure": "booked_weeks",
        "dimensions": [{"kind": "team"}, {"kind": "confirmed"}],
        "filters": {
            "archived": "exclude",
            "field_options": {"7": [1, 2]},
            "period": {"from": "2026-01-01", "to": "2026-06-30"},
        },
        "percent_of": "first_dimension",
    }
    options = {"stacked": True, "percent": True, "kpi_bucket": True}
    resp = await client.post(
        "/api/dashboards",
        json={
            "name": "  Mine ",
            "description": "Weeks",
            "visibility": "private",
            "is_default": True,
            "widgets": [widget_body("Team split", query, options=options, sort_order=3)],
        },
    )
    assert resp.status_code == 201
    created = resp.json()
    assert created["name"] == "Mine" and created["owner_id"] == SUE
    assert created["is_default"] is False and created["can_edit"] is True
    (widget,) = created["widgets"]
    assert (widget["query"], widget["options"], widget["layout"]) == (query, options, LAYOUT)
    assert widget["sort_order"] == 3

    again = (await client.get(f"/api/dashboards/{created['id']}")).json()
    assert again["widgets"] == created["widgets"]
    stored = sqlite.get(DashboardWidget, widget["id"])
    assert stored.query == compact(query) and stored.layout == compact(LAYOUT)


async def test_create_needs_the_manage_key(authed_client):
    client, set_user = authed_client
    set_user(uma())
    resp = await client.post("/api/dashboards", json={"name": "Mine"})
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Permission required: dashboards.manage"


async def test_create_copies_a_visible_source(authed_client):
    client, set_user = authed_client
    set_user(user(SAM, "superuser"))
    resp = await client.post(
        "/api/dashboards",
        json={"name": "Copy of Overview", "visibility": "everyone", "source_id": 1},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert [w["title"] for w in body["widgets"]] == ["Booked days"]
    assert body["widgets"][0]["query"] == KPI_QUERY
    assert body["owner_id"] == SAM and body["is_default"] is False


async def test_create_body_widgets_win_over_the_source(authed_client):
    client, set_user = authed_client
    set_user(sue())
    resp = await client.post(
        "/api/dashboards", json={"name": "Copy", "source_id": 1, "widgets": [widget_body("Own")]}
    )
    assert [w["title"] for w in resp.json()["widgets"]] == ["Own"]
    resp = await client.post(
        "/api/dashboards", json={"name": "Empty", "source_id": 1, "widgets": []}
    )
    assert resp.json()["widgets"] == []


async def test_create_from_an_invisible_source_is_404(authed_client):
    client, set_user = authed_client
    set_user(user(SAM, "superuser"))
    resp = await client.post("/api/dashboards", json={"name": "Copy", "source_id": 2})
    assert resp.status_code == 404


async def test_create_shared_with_roles(authed_client):
    client, set_user = authed_client
    set_user(sue())
    resp = await client.post(
        "/api/dashboards", json={"name": "Leads", "visibility": "shared", "role_ids": [4, 3, 4]}
    )
    assert resp.status_code == 201 and resp.json()["role_ids"] == [3, 4]
    # Targets are dropped for any other visibility.
    resp = await client.post(
        "/api/dashboards",
        json={
            "name": "All",
            "visibility": "everyone",
            "role_ids": [4],
            "site_ids": [WINTERTHUR],
            "team_ids": [QA_TEAM],
            "user_ids": [UMA],
        },
    )
    body = resp.json()
    assert [body[k] for k in ("role_ids", "site_ids", "team_ids", "user_ids")] == [[]] * 4


async def test_create_shared_with_every_kind(authed_client, sqlite):
    client, set_user = authed_client
    set_user(sue())
    resp = await client.post(
        "/api/dashboards",
        json={
            "name": "Shared",
            "visibility": "shared",
            "role_ids": [3],
            "site_ids": [WINTERTHUR, WINTERTHUR],
            "team_ids": [QA_TEAM],
            # An admin and a role seeing every site are shareable from anywhere.
            "user_ids": [UMA, ADMIN, IVY],
        },
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["visibility"] == "shared"
    assert body["role_ids"] == [3] and body["site_ids"] == [WINTERTHUR]
    assert body["team_ids"] == [QA_TEAM] and body["user_ids"] == [ADMIN, UMA, IVY]
    assert body["shared_with"] == {
        "roles": [{"id": 3, "name": "User"}],
        "sites": [{"id": WINTERTHUR, "name": "Winterthur"}],
        "teams": [{"id": QA_TEAM, "name": "QA & Compliance", "site_name": "Winterthur"}],
        "users": [
            {"id": ADMIN, "name": "Ada Test"},
            {"id": IVY, "name": "Ivy Test"},
            {"id": UMA, "name": "Uma Test"},
        ],
    }
    stored = sqlite.get(Dashboard, body["id"])
    assert (stored.site_ids, stored.team_ids, stored.user_ids) == (
        [WINTERTHUR],
        [QA_TEAM],
        [ADMIN, UMA, IVY],
    )


async def test_an_admin_picks_any_site_team_and_person(authed_client):
    client, set_user = authed_client
    set_user(admin())
    resp = await client.post(
        "/api/dashboards",
        json={
            "name": "Everywhere",
            "visibility": "shared",
            "site_ids": [FRANKFURT],
            "team_ids": [LAB_TEAM],  # inactive teams may be picked
            "user_ids": [FAY],
        },
    )
    assert resp.status_code == 201
    assert resp.json()["shared_with"]["teams"] == [
        {"id": LAB_TEAM, "name": "Lab", "site_name": "Frankfurt"}
    ]


async def test_create_shared_needs_a_target(authed_client):
    client, set_user = authed_client
    set_user(sue())
    resp = await client.post("/api/dashboards", json={"name": "Leads", "visibility": "shared"})
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Choose at least one role, site, team or person"
    # One target of any kind is enough.
    resp = await client.post(
        "/api/dashboards", json={"name": "Me", "visibility": "shared", "user_ids": [UMA]}
    )
    assert resp.status_code == 201


@pytest.mark.parametrize(
    ("targets", "detail"),
    [
        ({"role_ids": [4, 77]}, "Role not found"),
        ({"site_ids": [99]}, "Site not found"),
        ({"site_ids": [WINTERTHUR, FRANKFURT]}, "Site not found"),  # not a visible site
        ({"team_ids": [99]}, "Team not found"),
        ({"team_ids": [LAB_TEAM]}, "Team not found"),  # at a site Sue cannot see
        ({"user_ids": [99]}, "Person not found"),
        ({"user_ids": [FAY]}, "Person not found"),  # Frankfurt only
        ({"user_ids": [ED]}, "Person not found"),  # inactive
        # The first kind that fails answers.
        ({"role_ids": [77], "site_ids": [99]}, "Role not found"),
    ],
)
async def test_create_refuses_a_target_out_of_reach(authed_client, targets, detail):
    client, set_user = authed_client
    set_user(sue())
    resp = await client.post(
        "/api/dashboards", json={"name": "Bad", "visibility": "shared", **targets}
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == detail


async def test_targets_are_capped_per_kind(authed_client):
    client, set_user = authed_client
    set_user(sue())
    resp = await client.post(
        "/api/dashboards",
        json={"name": "Many", "visibility": "shared", "user_ids": list(range(1, 202))},
    )
    assert resp.status_code == 422


@pytest.mark.parametrize(
    ("widget", "message"),
    [
        (widget_body(kind="radar"), '"Booked": Input should be'),
        (
            widget_body(
                "Three",
                {**BY_SITE, "dimensions": [{"kind": "site"}, {"kind": "tag"}, {"kind": "project"}]},
            ),
            '"Three": A widget can be broken down by two dimensions at most',
        ),
        (
            widget_body(
                "Matrix",
                {"measure": "people_booked", "dimensions": [{"kind": "period", "grain": "month"}]},
            ),
            '"Matrix": People booked cannot be broken down by period',
        ),
    ],
)
async def test_create_refuses_an_invalid_widget(authed_client, widget, message):
    client, set_user = authed_client
    set_user(sue())
    resp = await client.post("/api/dashboards", json={"name": "Bad", "widgets": [widget]})
    assert resp.status_code == 422
    assert message in resp.json()["detail"][0]["msg"]


# --- Update --------------------------------------------------------------------


async def test_owner_replaces_fields_and_widgets(authed_client, sqlite):
    client, set_user = authed_client
    set_user(sue())
    before = sqlite.get(Dashboard, 7).updated_at
    resp = await client.put(
        "/api/dashboards/7",
        json={
            "name": "Mixed v2",
            "description": "  ",
            "visibility": "shared",
            "role_ids": [4],
            "is_default": True,
            "owner_id": UMA,
            "widgets": [widget_body("Only", id=999)],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert (body["name"], body["description"], body["visibility"]) == ("Mixed v2", None, "shared")
    assert body["role_ids"] == [4] and body["is_default"] is False and body["owner_id"] == SUE
    assert [w["title"] for w in body["widgets"]] == ["Only"]
    assert body["widgets"][0]["id"] != 999
    assert sqlite.query(DashboardWidget).filter_by(dashboard_id=7).count() == 1
    assert sqlite.get(Dashboard, 7).updated_at >= before


async def test_update_keeps_widgets_when_not_given_and_swaps_roles(authed_client):
    client, set_user = authed_client
    set_user(sue())
    resp = await client.put(
        "/api/dashboards/3", json={"name": "Lead board", "visibility": "shared", "role_ids": [3, 4]}
    )
    assert resp.json()["role_ids"] == [3, 4]
    resp = await client.put(
        "/api/dashboards/3", json={"name": "Lead board", "visibility": "shared", "role_ids": [3]}
    )
    assert resp.json()["role_ids"] == [3]
    resp = await client.put("/api/dashboards/7", json={"name": "Mixed", "visibility": "everyone"})
    assert len(resp.json()["widgets"]) == 9


async def test_update_swaps_every_kind_keeping_the_rows_that_stay(authed_client, sqlite):
    client, set_user = authed_client
    set_user(sue())
    shared = {"name": "QA board", "visibility": "shared"}
    resp = await client.put(
        f"/api/dashboards/{QA_BOARD}",
        json={**shared, "site_ids": [WINTERTHUR], "team_ids": [QA_TEAM], "user_ids": [UMA, LEO]},
    )
    assert resp.status_code == 200
    kept_team = sqlite.get(Dashboard, QA_BOARD).teams[0]
    resp = await client.put(
        f"/api/dashboards/{QA_BOARD}",
        json={**shared, "team_ids": [QA_TEAM], "user_ids": [LEO]},
    )
    body = resp.json()
    assert (body["site_ids"], body["team_ids"], body["user_ids"]) == ([], [QA_TEAM], [LEO])
    # The link that stayed is the same row (no delete + insert).
    assert sqlite.get(Dashboard, QA_BOARD).teams[0] is kept_team
    # Back to private: every link goes.
    resp = await client.put(f"/api/dashboards/{QA_BOARD}", json={**shared, "visibility": "private"})
    body = resp.json()
    assert [body[k] for k in ("role_ids", "site_ids", "team_ids", "user_ids")] == [[]] * 4
    assert sqlite.query(DashboardTeam).filter_by(dashboard_id=QA_BOARD).count() == 0


async def test_update_keeps_targets_the_editor_could_not_pick_now(authed_client):
    """Two ways is shared with Frankfurt and Fay, neither in Sue's reach: a
    save that keeps them passes, one that adds a new target out of reach does
    not."""
    client, set_user = authed_client
    set_user(sue())
    body = {
        "name": "Two ways",
        "visibility": "shared",
        "site_ids": [FRANKFURT],
        "user_ids": [FAY],
        "widgets": [widget_body("New widget")],
    }
    resp = await client.put(f"/api/dashboards/{TWO_WAYS}", json=body)
    assert resp.status_code == 200
    assert (resp.json()["site_ids"], resp.json()["user_ids"]) == ([FRANKFURT], [FAY])
    resp = await client.put(f"/api/dashboards/{TWO_WAYS}", json={**body, "team_ids": [LAB_TEAM]})
    assert resp.status_code == 404 and resp.json()["detail"] == "Team not found"
    resp = await client.put(f"/api/dashboards/{TWO_WAYS}", json={**body, "user_ids": [FAY, SAM]})
    assert resp.status_code == 404 and resp.json()["detail"] == "Person not found"


async def test_a_save_without_sharing_keys_keeps_the_sharing(authed_client, sqlite):
    """The widget editor sends the name, description and widgets only: the
    visibility and every target stay as they are."""
    client, set_user = authed_client
    set_user(sue())
    kept_site = sqlite.get(Dashboard, TWO_WAYS).sites[0]
    resp = await client.put(
        f"/api/dashboards/{TWO_WAYS}",
        json={"name": "Two ways v2", "description": "Notes", "widgets": [widget_body("New")]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert (body["name"], body["description"], body["visibility"]) == (
        "Two ways v2",
        "Notes",
        "shared",
    )
    assert (body["site_ids"], body["user_ids"]) == ([FRANKFURT], [FAY])
    assert [w["title"] for w in body["widgets"]] == ["New"]
    assert sqlite.get(Dashboard, TWO_WAYS).sites[0] is kept_site
    # Not even an everyone dashboard turns private.
    resp = await client.put("/api/dashboards/6", json={"name": "Everyone by Sue"})
    assert resp.json()["visibility"] == "everyone"


async def test_a_save_without_sharing_keys_survives_a_deleted_target(authed_client, sqlite):
    """A target deleted while the editor was open never blocks a widget save;
    re-sending its id with the sharing is a 404 (only ids still on the
    dashboard are kept as they are)."""
    sqlite.execute(text(f"DELETE FROM users WHERE id = {FAY}"))
    sqlite.commit()
    client, set_user = authed_client
    set_user(sue())
    resp = await client.put(
        f"/api/dashboards/{TWO_WAYS}",
        json={"name": "Two ways", "widgets": [widget_body("New")]},
    )
    assert resp.status_code == 200
    assert (resp.json()["visibility"], resp.json()["site_ids"]) == ("shared", [FRANKFURT])
    resp = await client.put(
        f"/api/dashboards/{TWO_WAYS}",
        json={
            "name": "Two ways",
            "visibility": "shared",
            "site_ids": [FRANKFURT],
            "user_ids": [FAY],
        },
    )
    assert resp.status_code == 404 and resp.json()["detail"] == "Person not found"


async def test_the_share_dialog_body_changes_the_sharing_and_keeps_the_widgets(authed_client):
    """Share... sends the name, description, visibility and lists, no widgets."""
    client, set_user = authed_client
    set_user(sue())
    resp = await client.put(
        "/api/dashboards/7",
        json={
            "name": "Mixed",
            "description": None,
            "visibility": "shared",
            "role_ids": [],
            "site_ids": [WINTERTHUR],
            "team_ids": [QA_TEAM],
            "user_ids": [LEO],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["visibility"] == "shared"
    assert (body["site_ids"], body["team_ids"], body["user_ids"]) == (
        [WINTERTHUR],
        [QA_TEAM],
        [LEO],
    )
    assert len(body["widgets"]) == 9
    # Lists without a visibility keep the current one and replace the targets.
    resp = await client.put("/api/dashboards/7", json={"name": "Mixed", "user_ids": [UMA]})
    body = resp.json()
    assert body["visibility"] == "shared"
    assert [body[k] for k in ("role_ids", "site_ids", "team_ids", "user_ids")] == [
        [],
        [],
        [],
        [UMA],
    ]
    # A visibility without lists means no target.
    resp = await client.put("/api/dashboards/7", json={"name": "Mixed", "visibility": "private"})
    body = resp.json()
    assert body["visibility"] == "private"
    assert [body[k] for k in ("role_ids", "site_ids", "team_ids", "user_ids")] == [[]] * 4


async def test_a_viewer_by_sharing_may_not_edit(authed_client):
    client, set_user = authed_client
    set_user(user(LEO, "lead", {"views.dashboards", "dashboards.manage"}))
    resp = await client.put(
        f"/api/dashboards/{FOR_LEO}", json={"name": "Mine now", "visibility": "everyone"}
    )
    assert resp.status_code == 403
    assert (await client.delete(f"/api/dashboards/{FOR_LEO}")).status_code == 403


async def test_admin_edits_the_default_which_stays_default(authed_client):
    client, set_user = authed_client
    set_user(admin())
    resp = await client.put(
        "/api/dashboards/1", json={"name": "Overview 2", "visibility": "everyone"}
    )
    assert resp.status_code == 200
    assert resp.json()["is_default"] is True and resp.json()["owner_id"] is None


@pytest.mark.parametrize(
    ("caller", "dashboard_id", "status"),
    [
        (sue, 1, 403),  # a viewer who may not edit
        (uma, 6, 403),
        (uma, 2, 404),  # may not even see it
        (lambda: sue(permissions={"views.dashboards"}), 2, 403),  # owner without manage
    ],
)
async def test_update_refusals(authed_client, caller, dashboard_id, status):
    client, set_user = authed_client
    set_user(caller())
    resp = await client.put(
        f"/api/dashboards/{dashboard_id}", json={"name": "X", "visibility": "everyone"}
    )
    assert resp.status_code == status


async def test_update_roles_without_role_is_400(authed_client):
    client, set_user = authed_client
    set_user(sue())
    resp = await client.put(
        "/api/dashboards/6",
        json={
            "name": "X",
            "visibility": "shared",
            "role_ids": [],
            "site_ids": [],
            "team_ids": [],
            "user_ids": [],
        },
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Choose at least one role, site, team or person"


# --- Delete --------------------------------------------------------------------


async def test_owner_deletes(authed_client, sqlite):
    client, set_user = authed_client
    set_user(sue())
    resp = await client.delete("/api/dashboards/7")
    assert resp.status_code == 204
    assert (await client.get("/api/dashboards/7")).status_code == 404
    assert sqlite.query(DashboardWidget).filter_by(dashboard_id=7).count() == 0


async def test_default_dashboard_delete_is_admin_only(authed_client):
    client, set_user = authed_client
    set_user(sue())
    resp = await client.delete("/api/dashboards/1")
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Only an administrator can delete the default dashboard"
    set_user(admin())
    assert (await client.delete("/api/dashboards/1")).status_code == 204


@pytest.mark.parametrize(("caller", "dashboard_id", "status"), [(uma, 6, 403), (uma, 2, 404)])
async def test_delete_refusals(authed_client, caller, dashboard_id, status):
    client, set_user = authed_client
    set_user(caller())
    assert (await client.delete(f"/api/dashboards/{dashboard_id}")).status_code == status


# --- Query ---------------------------------------------------------------------


async def test_query_is_cut_to_the_visible_sites(authed_client):
    client, set_user = authed_client
    set_user(uma(site_ids=(1,)))
    resp = await client.post("/api/dashboards/query", json=BY_SITE)
    assert resp.status_code == 200
    body = resp.json()
    assert [(r["keys"][0]["label"], r["value"]) for r in body["rows"]] == [("Winterthur", 5)]
    assert body["unit"] == "days" and body["warnings"] == []

    set_user(admin())
    body = (await client.post("/api/dashboards/query", json=BY_SITE)).json()
    assert [(r["keys"][0]["label"], r["value"]) for r in body["rows"]] == [
        ("Frankfurt", 2.5),
        ("Winterthur", 5),
    ]


async def test_query_needs_the_view_key(authed_client):
    client, set_user = authed_client
    set_user(uma(permissions=set()))
    assert (await client.post("/api/dashboards/query", json=BY_SITE)).status_code == 403


async def test_people_booked_needs_no_staff_view(authed_client):
    client, set_user = authed_client
    set_user(uma(permissions={"views.dashboards"}))
    resp = await client.post("/api/dashboards/query", json={**BY_SITE, "measure": "people_booked"})
    assert resp.status_code == 200


def _detail(resp) -> str:
    detail = resp.json()["detail"]
    return detail if isinstance(detail, str) else detail[0]["msg"]


@pytest.mark.parametrize(
    ("body", "message"),
    [
        (
            {**BY_SITE, "dimensions": [{"kind": "colour"}]},
            "does not match any of the expected tags",
        ),
        (
            {**BY_SITE, "dimensions": [{"kind": "site"}, {"kind": "tag"}, {"kind": "project"}]},
            "A widget can be broken down by two dimensions at most",
        ),
        (
            {**BY_SITE, "percent_of": "first_dimension"},
            "A percentage of the first dimension needs two dimensions",
        ),
        (
            {**BY_SITE, "dimensions": [{"kind": "period", "grain": "week"}], "top_n": 5},
            "Top N cannot be used when the first dimension is the period",
        ),
        (
            {"measure": "project_volume", "dimensions": [{"kind": "period", "grain": "year"}]},
            "Project volume cannot be broken down by period",
        ),
        (
            {**BY_SITE, "filters": {"period": {"from": "2020-01-01", "to": "2026-01-01"}}},
            "A period can cover at most five years",
        ),
        (
            {"measure": "project_weeks", "filters": {"person_ids": [1]}},
            "The People filter does not apply to project weeks",
        ),
        ({**BY_SITE, "dimensions": [{"kind": "field", "field_id": 30}]}, '"Notes" cannot be used'),
        ({**BY_SITE, "dimensions": [{"kind": "field", "field_id": 99}]}, "no longer exists"),
    ],
)
async def test_query_refusals(authed_client, body, message):
    client, set_user = authed_client
    set_user(uma())
    resp = await client.post("/api/dashboards/query", json=body)
    assert resp.status_code == 422
    assert message in _detail(resp)


@pytest.mark.parametrize(
    ("permissions", "body", "message"),
    [
        (
            {"views.dashboards", "views.archived"},
            {**BY_SITE, "dimensions": [{"kind": "person"}]},
            "This widget needs the Staff view permission",
        ),
        (
            {"views.dashboards", "views.staff"},
            {**BY_SITE, "filters": {**BY_SITE["filters"], "archived": "only"}},
            "This widget needs the Archived view permission",
        ),
        (
            {"views.dashboards", "views.archived"},
            {**BY_SITE, "filters": {**BY_SITE["filters"], "person_ids": [UMA]}},
            "This widget needs the Staff view permission",
        ),
    ],
)
async def test_query_permission_refusals(authed_client, permissions, body, message):
    client, set_user = authed_client
    set_user(uma(permissions=permissions))
    resp = await client.post("/api/dashboards/query", json=body)
    assert resp.status_code == 422 and resp.json()["detail"] == message


def test_viewer_holds_the_users_view_keys():
    assert dashboards_router._viewer(admin()).keys == frozenset(
        {"views.staff", "views.equipment", "views.archived"}
    )
    partial = uma(permissions={"views.dashboards", "views.equipment", "views.kanban"})
    assert dashboards_router._viewer(partial).keys == frozenset({"views.equipment"})


@pytest.mark.parametrize(
    ("measure", "families"),
    [("phase_count", {"phase"}), ("booked_days", {"booking"}), ("project_volume", {"project"})],
)
async def test_query_loads_the_families_of_its_measure(authed_client, measure, families):
    client, set_user = authed_client
    set_user(admin())
    with patch.object(
        dashboards_router, "load_facts", wraps=dashboards_router.load_facts
    ) as loader:
        resp = await client.post("/api/dashboards/query", json={"measure": measure})
    assert resp.status_code == 200
    assert loader.await_args.kwargs["families"] == frozenset(families)


async def test_query_too_many_facts(authed_client, monkeypatch):
    client, set_user = authed_client
    set_user(uma())
    monkeypatch.setattr(metrics, "MAX_FACT_ROWS", 0)
    resp = await client.post("/api/dashboards/query", json=BY_SITE)
    assert resp.status_code == 422
    assert resp.json()["detail"] == "Narrow the filters: this query covers too many bookings"


async def test_query_all_period_uses_the_extent(authed_client):
    client, set_user = authed_client
    set_user(admin())
    resp = await client.post(
        "/api/dashboards/query",
        json={"measure": "project_count", "filters": {"period": {"relative": "all"}}},
    )
    body = resp.json()
    assert body["period"] == {"from": "2026-01-01", "to": "2026-12-31"}
    assert body["rows"] == [{"keys": [], "value": 2}]


# --- Data ----------------------------------------------------------------------


async def test_data_answers_each_widget_from_one_load(authed_client):
    client, set_user = authed_client
    set_user(uma(permissions={"views.dashboards"}))
    with patch.object(
        dashboards_router, "load_facts", wraps=dashboards_router.load_facts
    ) as loader:
        resp = await client.post("/api/dashboards/7/data")
    assert resp.status_code == 200
    assert loader.await_count == 1
    # The union of the valid widgets' periods ("all" = the projects' extent).
    assert loader.await_args.kwargs["period"] == (date(2026, 1, 1), date(2026, 12, 31))
    # The families of the widgets that parsed and passed the permission check.
    assert loader.await_args.kwargs["families"] == frozenset({"booking", "project"})
    body = resp.json()
    assert body["loaded_at"].endswith("Z")
    results = body["widgets"]
    detail = (await client.get("/api/dashboards/7")).json()
    widgets = {w["title"]: results[str(w["id"])] for w in detail["widgets"]}
    good = widgets["Good"]
    assert [(r["keys"][0]["label"], r["value"]) for r in good["rows"]] == [("Winterthur", 5)]
    assert widgets["Broken JSON"] == {"error": "This widget's query cannot be read"}
    assert "error" in widgets["Invalid"]
    assert widgets["By person"] == {"error": "This widget needs the Staff view permission"}
    assert widgets["Archived only"] == {"error": "This widget needs the Archived view permission"}
    assert widgets["Gone field"] == {"error": "The project field of this widget no longer exists"}
    assert widgets["All time"]["rows"] == [{"keys": [], "value": 1}]
    assert widgets["Projects of a team"] == {"error": "The Teams filter does not apply to projects"}
    # A People filter needs the Staff view, like the person dimension.
    assert widgets["One person"] == {"error": "This widget needs the Staff view permission"}


async def test_data_with_every_permission(authed_client):
    client, set_user = authed_client
    set_user(admin())
    detail = (await client.get("/api/dashboards/7")).json()
    results = (await client.post("/api/dashboards/7/data")).json()["widgets"]
    widgets = {w["title"]: results[str(w["id"])] for w in detail["widgets"]}
    assert [r["keys"][0]["label"] for r in widgets["By person"]["rows"]] == ["Leo Test", "Uma Test"]
    assert widgets["Archived only"]["rows"] == []  # no archived project
    assert "error" not in widgets["One person"]
    assert "error" in widgets["Projects of a team"]


async def test_data_of_an_invisible_dashboard_is_404(authed_client):
    client, set_user = authed_client
    set_user(uma())
    assert (await client.post("/api/dashboards/2/data")).status_code == 404
    set_user(uma(permissions=set()))
    assert (await client.post("/api/dashboards/1/data")).status_code == 403


async def test_data_without_valid_widgets_loads_nothing(authed_client):
    client, set_user = authed_client
    set_user(sue())
    with patch.object(dashboards_router, "load_facts") as loader:
        resp = await client.post("/api/dashboards/6/data")
    assert resp.json()["widgets"] == {}
    loader.assert_not_called()


async def test_data_too_many_facts_errors_every_valid_widget(authed_client, monkeypatch):
    client, set_user = authed_client
    set_user(admin())
    monkeypatch.setattr(metrics, "MAX_FACT_ROWS", 0)
    body = (await client.post("/api/dashboards/1/data")).json()
    assert list(body["widgets"].values()) == [
        {"error": "Narrow the filters: this query covers too many bookings"}
    ]


async def test_data_resolves_all_per_archived_mode(authed_client, sqlite):
    """An archived project is the oldest: only the include widget reaches back to it."""
    sqlite.add(
        Project(
            id=3,
            name="Old",
            site_id=1,
            archived=1,
            start_date=date(2024, 1, 1),
            end_date=date(2024, 6, 30),
        )
    )
    all_time = {"measure": "project_count", "filters": {"period": {"relative": "all"}}}
    sqlite.add(
        Dashboard(
            id=8,
            name="All time",
            visibility="everyone",
            owner_id=SUE,
            widgets=[
                widget_row("Exclude", all_time, 0),
                widget_row(
                    "Include",
                    {**all_time, "filters": {**all_time["filters"], "archived": "include"}},
                    1,
                ),
            ],
        )
    )
    sqlite.commit()
    client, set_user = authed_client
    set_user(admin())
    detail = (await client.get("/api/dashboards/8")).json()
    with (
        patch.object(dashboards_router, "load_facts", wraps=dashboards_router.load_facts) as loader,
        patch.object(
            dashboards_router, "load_extent", wraps=dashboards_router.load_extent
        ) as extent,
    ):
        results = (await client.post("/api/dashboards/8/data")).json()["widgets"]
    widgets = {w["title"]: results[str(w["id"])] for w in detail["widgets"]}
    assert widgets["Exclude"]["period"] == {"from": "2026-01-01", "to": "2026-12-31"}
    assert widgets["Exclude"]["rows"] == [{"keys": [], "value": 2}]
    assert widgets["Include"]["period"] == {"from": "2024-01-01", "to": "2026-12-31"}
    assert widgets["Include"]["rows"] == [{"keys": [], "value": 3}]
    assert loader.await_count == 1
    assert sorted(call.kwargs["archived"] for call in extent.await_args_list) == [
        "exclude",
        "include",
    ]
    assert loader.await_args.kwargs["period"] == (date(2024, 1, 1), date(2026, 12, 31))


# --- Sharing: copies, deletes, the people picker ---------------------------------


async def test_a_copy_takes_the_widgets_not_the_sharing(authed_client):
    client, set_user = authed_client
    set_user(sue())
    resp = await client.post(
        "/api/dashboards",
        json={"name": "Copy of Two ways", "visibility": "private", "source_id": TWO_WAYS},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["visibility"] == "private"
    assert [body[k] for k in ("role_ids", "site_ids", "team_ids", "user_ids")] == [[]] * 4
    assert body["shared_with"] == {"roles": [], "sites": [], "teams": [], "users": []}


async def test_a_deleted_owner_leaves_the_dashboard_and_its_links(authed_client, sqlite):
    sqlite.execute(text(f"DELETE FROM users WHERE id = {SUE}"))
    sqlite.commit()
    client, set_user = authed_client
    set_user(fay())
    body = (await client.get(f"/api/dashboards/{TWO_WAYS}")).json()
    assert body["owner_id"] is None and body["owner_name"] is None
    assert body["can_edit"] is False
    assert body["shared_with"]["sites"] == [{"id": FRANKFURT, "name": "Frankfurt"}]
    assert body["shared_with"]["users"] == [{"id": FAY, "name": "Fay Test"}]
    set_user(admin())
    assert (await client.get(f"/api/dashboards/{TWO_WAYS}")).json()["can_edit"] is True


async def test_a_deleted_target_drops_its_link(authed_client, sqlite):
    sqlite.execute(text(f"DELETE FROM users WHERE id = {FAY}"))
    sqlite.execute(text(f"DELETE FROM teams WHERE id = {QA_TEAM}"))
    sqlite.commit()
    client, set_user = authed_client
    set_user(sue())
    rows = {row["id"]: row for row in (await client.get("/api/dashboards")).json()}
    assert rows[TWO_WAYS]["user_ids"] == [] and rows[TWO_WAYS]["site_ids"] == [FRANKFURT]
    assert rows[TWO_WAYS]["shared_with"]["users"] == []
    # QA board is shared with nothing left: Uma no longer sees it.
    assert rows[QA_BOARD]["team_ids"] == [] and rows[QA_BOARD]["shared_with"]["teams"] == []
    set_user(uma())
    assert (await client.get(f"/api/dashboards/{QA_BOARD}")).status_code == 404


def _people(resp) -> list[tuple[int, str, str | None, list[str]]]:
    return [(p["id"], p["name"], p["job_title"], p["site_names"]) for p in resp.json()]


async def test_shareable_users_of_a_site_member(authed_client):
    client, set_user = authed_client
    set_user(sue())
    resp = await client.get("/api/dashboards/shareable-users")
    assert resp.status_code == 200
    # Winterthur's active members, the admin and the all-sites auditor; by
    # name; site names among Sue's visible sites only. Not Ed (inactive), not
    # Fay or Sam (Frankfurt only).
    assert _people(resp) == [
        (ADMIN, "Ada Test", None, []),
        (IVY, "Ivy Test", None, []),
        (LEO, "Leo Test", "Chemist", ["Winterthur"]),
        (SUE, "Sue Test", None, ["Winterthur"]),
        (UMA, "Uma Test", None, ["Winterthur"]),
    ]


async def test_shareable_users_over_two_sites_lists_each_person_once(authed_client):
    client, set_user = authed_client
    set_user(sue(site_ids=(WINTERTHUR, FRANKFURT)))
    people = _people(await client.get("/api/dashboards/shareable-users"))
    assert [p[0] for p in people] == [ADMIN, FAY, IVY, LEO, SAM, SUE, UMA]
    assert dict((p[0], p[3]) for p in people)[LEO] == ["Frankfurt", "Winterthur"]


async def test_shareable_users_of_an_admin_are_every_active_user(authed_client):
    client, set_user = authed_client
    set_user(admin())
    people = _people(await client.get("/api/dashboards/shareable-users"))
    assert [p[0] for p in people] == [ADMIN, FAY, IVY, LEO, SAM, SUE, UMA]
    assert dict((p[0], p[3]) for p in people)[SAM] == ["Frankfurt"]


async def test_shareable_users_needs_the_manage_key(authed_client):
    client, set_user = authed_client
    set_user(uma())
    resp = await client.get("/api/dashboards/shareable-users")
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Permission required: dashboards.manage"


async def test_an_empty_list(authed_client, sqlite):
    sqlite.execute(text("DELETE FROM dashboards"))
    sqlite.commit()
    client, set_user = authed_client
    set_user(uma())
    resp = await client.get("/api/dashboards")
    assert resp.status_code == 200 and resp.json() == []
