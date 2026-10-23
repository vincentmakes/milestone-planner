"""
Dashboards API (app/routers/dashboards.py) through ``authed_client``, on SQLite.

The module overrides ``mock_db_session`` with an ``AsyncSession`` facade over
an in-memory SQLite database (tests/sqlite_support.py), so the visibility
clause, the widget replace and the metric loader run real SQL. The callers
are FakeUsers whose ids and role keys match the seeded users and roles.
"""

import json
from datetime import date
from unittest.mock import patch

import pytest

from app.models.assignment import ProjectAssignment
from app.models.dashboard import Dashboard, DashboardRole, DashboardWidget
from app.models.project import Project
from app.models.project_field import ProjectField
from app.models.rbac import Role
from app.models.site import Site
from app.models.user import User
from app.routers import dashboards as dashboards_router
from app.services import metrics
from tests.conftest import FakeUser
from tests.sqlite_support import AsyncSessionFacade, sqlite_session

TODAY = date(2026, 10, 23)
ADMIN, SUE, UMA, LEO, SAM = 1, 2, 3, 4, 5
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
                Site(id=1, name="Winterthur"),
                Site(id=2, name="Frankfurt"),
            ]
        )
        session.flush()
        for user_id, role, first in (
            (ADMIN, "admin", "Ada"),
            (SUE, "superuser", "Sue"),
            (UMA, "user", "Uma"),
            (LEO, "lead", "Leo"),
            (SAM, "superuser", "Sam"),
        ):
            session.add(
                User(
                    id=user_id,
                    email=f"{first.lower()}@x",
                    password="x",
                    first_name=first,
                    last_name="Test",
                    role=role,
                )
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
                visibility="roles",
                owner_id=SUE,
                roles=[DashboardRole(role_id=4)],
            ),
            Dashboard(
                id=4,
                name="Users board",
                visibility="roles",
                owner_id=SUE,
                roles=[DashboardRole(role_id=3)],
            ),
            Dashboard(id=5, name="orphan roles", visibility="roles", owner_id=SUE),
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


# --- List and visibility -------------------------------------------------------


@pytest.mark.parametrize(
    ("caller", "expected"),
    [
        (admin, [1, 6, 3, 7, 5, 2, 4]),
        (sue, [1, 6, 3, 7, 5, 2, 4]),
        (uma, [1, 6, 7, 4]),
        (leo, [1, 6, 3, 7]),
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
    # A roles dashboard with no role left: its owner sees it, shared with none.
    assert rows[5]["role_ids"] == [] and rows[5]["visibility"] == "roles"
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
        (leo, 3, 200),  # roles with my role
        (uma, 3, 404),  # roles without my role
        (uma, 4, 200),
        (uma, 5, 404),  # roles with no role left
        (sue, 5, 200),
        (uma, 6, 200),  # everyone
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
        "/api/dashboards", json={"name": "Leads", "visibility": "roles", "role_ids": [4, 3, 4]}
    )
    assert resp.status_code == 201 and resp.json()["role_ids"] == [3, 4]
    # Roles are dropped for any other visibility.
    resp = await client.post(
        "/api/dashboards", json={"name": "All", "visibility": "everyone", "role_ids": [4]}
    )
    assert resp.json()["role_ids"] == []


async def test_create_roles_needs_a_role(authed_client):
    client, set_user = authed_client
    set_user(sue())
    resp = await client.post("/api/dashboards", json={"name": "Leads", "visibility": "roles"})
    assert resp.status_code == 400 and resp.json()["detail"] == "Choose at least one role"
    resp = await client.post(
        "/api/dashboards", json={"name": "Leads", "visibility": "roles", "role_ids": [4, 77]}
    )
    assert resp.status_code == 404 and resp.json()["detail"] == "Role not found"


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
            "visibility": "roles",
            "role_ids": [4],
            "is_default": True,
            "owner_id": UMA,
            "widgets": [widget_body("Only", id=999)],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert (body["name"], body["description"], body["visibility"]) == ("Mixed v2", None, "roles")
    assert body["role_ids"] == [4] and body["is_default"] is False and body["owner_id"] == SUE
    assert [w["title"] for w in body["widgets"]] == ["Only"]
    assert body["widgets"][0]["id"] != 999
    assert sqlite.query(DashboardWidget).filter_by(dashboard_id=7).count() == 1
    assert sqlite.get(Dashboard, 7).updated_at >= before


async def test_update_keeps_widgets_when_not_given_and_swaps_roles(authed_client):
    client, set_user = authed_client
    set_user(sue())
    resp = await client.put(
        "/api/dashboards/3", json={"name": "Lead board", "visibility": "roles", "role_ids": [3, 4]}
    )
    assert resp.json()["role_ids"] == [3, 4]
    resp = await client.put(
        "/api/dashboards/3", json={"name": "Lead board", "visibility": "roles", "role_ids": [3]}
    )
    assert resp.json()["role_ids"] == [3]
    resp = await client.put("/api/dashboards/7", json={"name": "Mixed", "visibility": "everyone"})
    assert len(resp.json()["widgets"]) == 9


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
        "/api/dashboards/6", json={"name": "X", "visibility": "roles", "role_ids": []}
    )
    assert resp.status_code == 400


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
            "The Teams and People filters apply to booked time only",
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
    assert widgets["Projects of a team"] == {
        "error": "The Teams and People filters apply to booked time only"
    }
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
