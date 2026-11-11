"""
GET /api/projects/details (2.5.1): every project of a listing page in one
request, each exactly as GET /api/projects/{id} returns it.

Against SQLite (``tests/sqlite_support.py``): the module overrides
``mock_db_session``, so ``authed_client`` serves the routes from a real
database -- the equivalence of the bulk items and the single bodies is
checked on real rows (nested subphases, bookings at the three levels,
equipment, tags, field values, a pending approval request), not on mocks.
"""

import json
from datetime import date

import pytest

from app.models.assignment import (
    PhaseStaffAssignment,
    ProjectAssignment,
    SubphaseStaffAssignment,
)
from app.models.equipment import Equipment, EquipmentAssignment
from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.project_field import ProjectField, ProjectFieldValue
from app.models.rbac import ApprovalRequest, Role
from app.models.site import Site
from app.models.tag import ProjectTag, Tag
from app.models.user import User
from app.services.approvals import ACTION_CREATE
from tests.conftest import FakeUser
from tests.sqlite_support import AsyncSessionFacade, sqlite_session


def d(text: str) -> date:
    return date.fromisoformat(text)


class CountingFacade(AsyncSessionFacade):
    """The SQLite facade, counting the statements a request runs."""

    statements = 0

    async def execute(self, statement, params=None):
        self.statements += 1
        return await super().execute(statement, params)


@pytest.fixture
def mock_db_session():
    """Overrides conftest's mock: authed_client serves from SQLite."""
    with sqlite_session() as session:
        session.add_all(
            [
                Role(id=1, key="user", name="User"),
                Site(id=1, name="Winterthur"),
                Site(id=2, name="Frankfurt"),
                User(id=1, email="ann@x", password="x", first_name="Ann", last_name="A"),
                User(
                    id=2,
                    email="bob@x",
                    password="x",
                    first_name="Bob",
                    last_name="B",
                    job_title="Chemist",
                ),
            ]
        )
        session.flush()
        session.add_all(
            [
                Project(
                    id=1,
                    name="Alpha",
                    site_id=1,
                    pm_id=2,
                    customer="Acme",
                    confirmed=1,
                    volume=10.5,
                    start_date=d("2026-03-01"),
                    end_date=d("2026-05-31"),
                ),
                Project(
                    id=2,
                    name="Beta",
                    site_id=1,
                    start_date=d("2026-04-01"),
                    end_date=d("2026-04-30"),
                ),
                Project(
                    id=3,
                    name="Gamma (Frankfurt)",
                    site_id=2,
                    start_date=d("2026-02-01"),
                    end_date=d("2026-02-28"),
                ),
                Project(
                    id=4,
                    name="Old",
                    site_id=1,
                    archived=1,
                    start_date=d("2025-01-01"),
                    end_date=d("2025-01-31"),
                ),
                Tag(id=20, name="Red", color="#ff0000"),
                ProjectField(id=30, name="Code", field_type="text"),
                Equipment(id=40, name="HPLC", type="Analytics", site_id=1),
            ]
        )
        session.flush()
        session.add_all(
            [
                ProjectTag(project_id=1, tag_id=20),
                ProjectFieldValue(field_id=30, project_id=1, value_text="A-1"),
                ProjectPhase(
                    id=100,
                    project_id=1,
                    type="Design",
                    start_date=d("2026-03-02"),
                    end_date=d("2026-03-27"),
                    sort_order=0,
                    dependencies=json.dumps([{"id": 101, "type": "FS"}]),
                ),
                ProjectPhase(
                    id=101,
                    project_id=1,
                    type="Gate",
                    start_date=d("2026-04-01"),
                    end_date=d("2026-04-01"),
                    is_milestone=1,
                    sort_order=1,
                ),
                ProjectPhase(
                    id=110,
                    project_id=2,
                    type="Build",
                    start_date=d("2026-04-01"),
                    end_date=d("2026-04-30"),
                ),
            ]
        )
        session.flush()
        session.add_all(
            [
                ProjectSubphase(
                    id=200,
                    parent_id=100,
                    parent_type="phase",
                    project_id=1,
                    name="Prep",
                    start_date=d("2026-03-02"),
                    end_date=d("2026-03-13"),
                ),
                ProjectSubphase(
                    id=201,
                    parent_id=200,
                    parent_type="subphase",
                    project_id=1,
                    name="Detail",
                    start_date=d("2026-03-03"),
                    end_date=d("2026-03-05"),
                    depth=2,
                ),
                PhaseStaffAssignment(id=1, project_id=1, phase_id=100, staff_id=2, allocation=50),
                PhaseStaffAssignment(
                    id=2,
                    project_id=1,
                    phase_id=100,
                    staff_id=1,
                    allocation=20,
                    start_date=d("2026-03-10"),
                    end_date=d("2026-03-20"),
                    approval_status="pending",
                ),
                PhaseStaffAssignment(id=3, project_id=2, phase_id=110, staff_id=2, allocation=100),
                ProjectAssignment(
                    id=1,
                    project_id=1,
                    staff_id=2,
                    allocation=10,
                    start_date=d("2026-03-01"),
                    end_date=d("2026-05-31"),
                ),
                EquipmentAssignment(
                    id=1,
                    project_id=1,
                    equipment_id=40,
                    start_date=d("2026-03-02"),
                    end_date=d("2026-03-06"),
                    note="Column",
                ),
                ApprovalRequest(
                    id=50,
                    requester_id=1,
                    action=ACTION_CREATE,
                    project_id=1,
                    level="phase",
                    target_id=100,
                    assignment_id=2,
                    requested=json.dumps({"allocation": 20}),
                ),
            ]
        )
        session.flush()
        session.add(
            SubphaseStaffAssignment(id=1, project_id=1, subphase_id=201, staff_id=2, allocation=30)
        )
        session.commit()
        yield CountingFacade(session)


ADMIN = FakeUser(9, "admin", site_ids=[1, 2])


async def _bulk(client, query: str = "archived=all&limit=200"):
    return await client.get(f"/api/projects/details?{query}")


@pytest.mark.asyncio
async def test_the_bulk_items_equal_the_single_project_bodies(authed_client):
    client, set_user = authed_client
    set_user(ADMIN)

    response = await _bulk(client)

    assert response.status_code == 200
    page = response.json()
    assert [p["id"] for p in page["items"]] == [4, 3, 1, 2]  # start_date, then id
    assert page["total"] == 4 and page["offset"] == 0 and page["limit"] == 200
    for item in page["items"]:
        single = await client.get(f"/api/projects/{item['id']}")
        assert single.status_code == 200
        assert item == single.json()

    alpha = next(p for p in page["items"] if p["id"] == 1)
    # The nested data really is there (the equivalence is not of empty bodies).
    assert [p["type"] for p in alpha["phases"]] == ["Design", "Gate"]
    design = alpha["phases"][0]
    assert design["dependencies"] == [{"id": 101, "type": "FS"}]
    assert design["children"][0]["children"][0]["staffAssignments"][0]["allocation"] == 30
    assert {s["staff_id"] for s in design["staffAssignments"]} == {1, 2}
    pending = next(s for s in design["staffAssignments"] if s["id"] == 2)
    assert pending["approval_status"] == "pending"
    assert pending["approval"]["request_id"] == 50
    assert alpha["staffAssignments"][0]["staff_name"] == "Bob B"
    assert alpha["equipmentAssignments"][0]["equipment_name"] == "HPLC"
    assert alpha["tags"] == [{"id": 20, "name": "Red", "color": "#ff0000"}]
    assert alpha["field_values"] == {"30": "A-1"}
    assert alpha["pm_name"] == "Bob B"
    # Another project's bookings never leak into this one.
    beta = next(p for p in page["items"] if p["id"] == 2)
    assert [s["id"] for s in beta["phases"][0]["staffAssignments"]] == [3]


@pytest.mark.asyncio
async def test_the_bulk_page_matches_the_list_page(authed_client):
    client, set_user = authed_client
    set_user(ADMIN)
    for query in ("", "archived=true", "archived=all&siteId=1", "limit=2&offset=1"):
        bulk = (await _bulk(client, query)).json()
        listed = (await client.get(f"/api/projects?{query}")).json()
        assert [p["id"] for p in bulk["items"]] == [p["id"] for p in listed["items"]]
        assert bulk["total"] == listed["total"]
        assert (bulk["offset"], bulk["limit"]) == (listed["offset"], listed["limit"])


@pytest.mark.asyncio
async def test_the_query_count_does_not_grow_with_the_projects(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)

    mock_db_session.statements = 0
    assert (await _bulk(client, "limit=1&siteId=1")).json()["items"][0]["id"] == 1
    one = mock_db_session.statements

    mock_db_session.statements = 0
    assert len((await _bulk(client, "archived=all")).json()["items"]) == 4
    four = mock_db_session.statements

    assert one == four
    # count + page + 6 child tables + approvals (+ policies) + 2 field-value queries
    # (+ the tags' selectin load): a constant, about a dozen.
    assert four <= 13


@pytest.mark.asyncio
async def test_only_the_visible_sites_are_listed(authed_client):
    client, set_user = authed_client
    set_user(FakeUser(1, "user", permissions=[], site_ids=[1]))

    response = await _bulk(client)

    assert response.status_code == 200
    # Site 2's project is left out; 'all' without views.archived drops the archived one.
    assert [p["id"] for p in response.json()["items"]] == [1, 2]

    assert (await _bulk(client, "siteId=2")).status_code == 403
    single = await client.get("/api/projects/3")
    assert single.status_code == 403


@pytest.mark.asyncio
async def test_archived_needs_views_archived(authed_client):
    client, set_user = authed_client
    set_user(FakeUser(1, "user", permissions=[], site_ids=[1]))
    response = await _bulk(client, "archived=true")
    assert response.status_code == 403
    assert "views.archived" in response.text

    set_user(FakeUser(1, "user", permissions=["views.archived"], site_ids=[1]))
    archived = await _bulk(client, "archived=true")
    assert archived.status_code == 200
    assert [p["id"] for p in archived.json()["items"]] == [4]


@pytest.mark.asyncio
async def test_other_sites_need_views_crosssite(authed_client):
    client, set_user = authed_client
    set_user(FakeUser(1, "user", permissions=[], site_ids=[1]))
    response = await _bulk(client, "includeOtherSites=true")
    assert response.status_code == 403
    assert "views.crosssite" in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("query", ["limit=201", "limit=0", "offset=-1", "siteId=abc"])
async def test_invalid_parameters_are_422(authed_client, query):
    client, set_user = authed_client
    set_user(ADMIN)
    assert (await _bulk(client, query)).status_code == 422


@pytest.mark.asyncio
async def test_an_empty_page(authed_client):
    client, set_user = authed_client
    set_user(ADMIN)
    response = await _bulk(client, "offset=50")
    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 3, "offset": 50, "limit": 50}


@pytest.mark.asyncio
async def test_the_route_is_not_taken_for_a_project_id(authed_client):
    client, set_user = authed_client
    set_user(ADMIN)
    assert (await client.get("/api/projects/1")).json()["id"] == 1
    assert (await client.get("/api/projects/999")).status_code == 404


def test_a_read_never_broadcasts():
    from app.middleware.broadcast import WRITE_METHODS, _resolve_entity_type

    assert "GET" not in WRITE_METHODS
    # And even as a write the path belongs to the rich (router) tier.
    assert _resolve_entity_type("/api/projects/details") is None
