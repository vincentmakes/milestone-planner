"""
More route tests for the project tree API: the project list (filters,
pagination, cross-site masking) and detail (phase/subphase tree with
assignments), project create/update field handling, and phase/subphase
creation (append vs. insert-at-index, depth limit).

Access rules and delete cascades are covered elsewhere
(test_project_access_routes.py, test_project_delete_cleanup.py,
test_phase_delete_cascade.py). Mock-based, house style; ``broadcast_change``
is patched at the router so each write's announcement can be asserted.
"""

from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.project import Project, ProjectPhase, ProjectSubphase
from tests.conftest import FakeUser
from tests.support import scalar_result, scalars_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)


def make_project(project_id=1, site_id=1, **overrides):
    values = {
        "id": project_id,
        "name": f"Project {project_id}",
        "site_id": site_id,
        "customer": "ACME",
        "pm_id": 7,
        "sales_pm": "Sam",
        "confirmed": 1,
        "volume": 1000.0,
        "start_date": date(2026, 1, 5),
        "end_date": date(2026, 3, 31),
        "notes": "secret notes",
        "archived": 0,
        "created_at": STAMP,
        "updated_at": STAMP,
        "tags": [SimpleNamespace(id=4, name="Priority", color="#ff0000", group_id=None)],
        "team_ids": [],
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def rows_result(rows):
    result = MagicMock()
    result.all.return_value = rows
    return result


def first_result(row):
    result = MagicMock()
    result.first.return_value = row
    return result


def sql(db, index: int) -> str:
    stmt = db.execute.await_args_list[index].args[0]
    return str(stmt.compile(compile_kwargs={"literal_binds": True}))


@pytest.fixture
def broadcast():
    with patch("app.routers.projects.broadcast_change", new_callable=AsyncMock) as mock:
        yield mock


# ---------------------------------------------------------------------------
# GET /projects
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_projects_for_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [
        scalar_result(1),
        rows_result([(make_project(1), "Winterthur", "Alice Martin")]),
    ]

    response = await client.get("/api/projects?siteId=1&limit=10")

    assert response.status_code == 200
    body = response.json()
    assert (body["total"], body["offset"], body["limit"]) == (1, 0, 10)
    (item,) = body["items"]
    assert (item["name"], item["site_name"], item["pm_name"], item["customer"]) == (
        "Project 1",
        "Winterthur",
        "Alice Martin",
        "ACME",
    )
    assert item["tags"] == [{"id": 4, "name": "Priority", "color": "#ff0000", "group_id": None}]
    count_sql, list_sql = sql(mock_db_session, 0), sql(mock_db_session, 1)
    assert "projects.archived = 0 OR projects.archived IS NULL" in count_sql
    assert "projects.site_id = 1" in count_sql
    assert "ORDER BY projects.start_date, projects.id" in list_sql
    assert "LIMIT 10 OFFSET 0" in list_sql


@pytest.mark.asyncio
async def test_list_projects_masks_other_sites_in_cross_site_view(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user", site_ids=[1, 2]))
    mock_db_session.execute.side_effect = [
        scalar_result(2),
        rows_result(
            [
                (make_project(1, site_id=1), "Winterthur", "Alice"),
                (make_project(2, site_id=2), "Basel", "Bob"),
            ]
        ),
    ]

    response = await client.get("/api/projects?siteId=1&includeOtherSites=true")

    assert response.status_code == 200
    own, external = response.json()["items"]
    assert own["name"] == "Project 1"
    assert own["notes"] == "secret notes"
    assert (external["name"], external["customer"], external["sales_pm"]) == (
        "[External Project]",
        "[Hidden]",
        "[Hidden]",
    )
    assert (external["notes"], external["volume"], external["tags"]) == (None, None, [])
    assert external["site_name"] == "Basel"  # where it is stays visible
    # Not limited to siteId, but to the visible sites (RBAC decision 6).
    assert "projects.site_id = " not in sql(mock_db_session, 0)
    assert "projects.site_id IN (1, 2)" in sql(mock_db_session, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("archived", "expected", "absent"),
    [
        ("true", "projects.archived = 1", "IS NULL"),
        ("all", None, "projects.archived"),
    ],
)
async def test_list_projects_archived_filter(
    authed_client, mock_db_session, archived, expected, absent
):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [scalar_result(None), rows_result([])]

    response = await client.get(f"/api/projects?archived={archived}")

    assert response.status_code == 200
    assert response.json()["total"] == 0
    count_sql = sql(mock_db_session, 0)
    if expected:
        assert expected in count_sql
    assert absent not in count_sql.split("FROM projects")[-1]


@pytest.mark.asyncio
async def test_list_projects_rejects_bad_pagination(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))

    response = await client.get("/api/projects?offset=-1")

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_list_projects_requires_authentication(app_client):
    assert (await app_client.get("/api/projects")).status_code == 401


# ---------------------------------------------------------------------------
# GET /projects/{id}
# ---------------------------------------------------------------------------


def _phase(phase_id, sort_order, deps=None, milestone=0):
    return SimpleNamespace(
        id=phase_id,
        project_id=1,
        type=f"Phase {phase_id}",
        start_date=date(2026, 1, 5),
        end_date=date(2026, 2, 5),
        is_milestone=milestone,
        sort_order=sort_order,
        completion=25,
        status="in_progress",
        dependencies=deps,
        created_at=STAMP,
    )


def _subphase(sp_id, parent_id, parent_type, depth, deps=None):
    return SimpleNamespace(
        id=sp_id,
        parent_id=parent_id,
        parent_type=parent_type,
        project_id=1,
        name=f"Sub {sp_id}",
        start_date=date(2026, 1, 6),
        end_date=date(2026, 1, 9),
        is_milestone=0,
        sort_order=0,
        depth=depth,
        completion=None,
        status="todo",
        dependencies=deps,
        created_at=STAMP,
    )


def _assignment(aid, staff_id, **extra):
    extra.setdefault("approval_status", "approved")
    extra.setdefault("approval_request_id", None)
    # Phase / subphase rows without own dates are linked (follow the card).
    extra.setdefault("start_date", None)
    extra.setdefault("end_date", None)
    return SimpleNamespace(id=aid, project_id=1, staff_id=staff_id, allocation=50, **extra)


@pytest.mark.asyncio
async def test_project_detail_builds_the_tree(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [
        first_result((make_project(1), "Winterthur", "Alice Martin")),
        scalars_result(
            [_phase(10, 0, deps='[{"id": 11, "type": "FS"}]'), _phase(11, 1, deps="{broken")]
        ),
        scalars_result(
            [
                _subphase(20, 10, "phase", 1, deps='[{"id": 21}]'),
                _subphase(21, 20, "subphase", 2, deps="nope"),
            ]
        ),
        rows_result([(_assignment(30, 7, phase_id=10), "Alice Martin", "Chemist")]),
        rows_result([(_assignment(31, 8, subphase_id=21), "Bob Brown", None)]),
        rows_result(
            [
                (
                    _assignment(32, 7, start_date=date(2026, 1, 5), end_date=date(2026, 1, 30)),
                    "Alice Martin",
                    "Chemist",
                )
            ]
        ),
        rows_result(
            [
                (
                    SimpleNamespace(
                        id=40,
                        project_id=1,
                        equipment_id=3,
                        start_date=date(2026, 1, 7),
                        end_date=date(2026, 1, 8),
                        created_at=STAMP,
                    ),
                    "HPLC",
                    "Analytical",
                )
            ]
        ),
        scalars_result([]),  # no pending approval requests
    ]

    response = await client.get("/api/projects/1")

    assert response.status_code == 200
    body = response.json()
    assert (body["site_name"], body["pm_name"]) == ("Winterthur", "Alice Martin")
    first, second = body["phases"]
    assert first["dependencies"] == [{"id": 11, "type": "FS"}]
    assert second["dependencies"] == []  # unparsable JSON degrades to empty
    assert [(a["id"], a["staff_name"]) for a in first["staffAssignments"]] == [(30, "Alice Martin")]
    assert second["staffAssignments"] == []
    (sub,) = first["children"]
    assert (sub["id"], sub["dependencies"], sub["staffAssignments"]) == (20, [{"id": 21}], [])
    (child,) = sub["children"]
    assert (child["id"], child["depth"], child["dependencies"]) == (21, 2, [])
    assert [(a["id"], a["staff_name"]) for a in child["staffAssignments"]] == [(31, "Bob Brown")]
    assert second["children"] == []
    assert [(a["id"], a["staff_role"]) for a in body["staffAssignments"]] == [(32, "Chemist")]
    (equipment,) = body["equipmentAssignments"]
    assert (equipment["equipment_name"], equipment["equipment_type"]) == ("HPLC", "Analytical")
    assert body["tags"][0]["name"] == "Priority"
    # The 8th query: the project's pending approval requests (none here, so
    # no policy lookup).
    assert mock_db_session.execute.await_count == 8
    assert first["staffAssignments"][0]["approval_status"] == "approved"
    assert first["staffAssignments"][0]["approval"] is None
    assert body["staffAssignments"][0]["approval"] is None
    # Card bookings without own dates are linked: their dates are the card's.
    phase_booking = first["staffAssignments"][0]
    assert phase_booking["linked"] is True
    assert (phase_booking["start_date"], phase_booking["end_date"]) == (
        "2026-01-05T00:00:00.000Z",
        "2026-02-05T00:00:00.000Z",
    )
    child_booking = child["staffAssignments"][0]
    assert child_booking["linked"] is True
    assert (child_booking["start_date"], child_booking["end_date"]) == (
        "2026-01-06T00:00:00.000Z",
        "2026-01-09T00:00:00.000Z",
    )
    assert body["staffAssignments"][0]["linked"] is False


@pytest.mark.asyncio
async def test_project_detail_serialises_pending_bookings_and_requests(
    authed_client, mock_db_session
):
    from app.models.rbac import ApprovalRequest

    client, set_user = authed_client
    set_user(FakeUser(7, "user"))  # the PM of the project (make_project pm_id)
    phase = _phase(10, 0)
    pending_create = ApprovalRequest(
        id=50,
        requester_id=5,
        action="assignments.self_create",
        project_id=1,
        level="phase",
        target_id=10,
        assignment_id=30,
        requested='{"allocation": 40}',
        status="pending",
        created_at=STAMP,
    )
    pending_update = ApprovalRequest(
        id=51,
        requester_id=7,  # the PM's own request: never theirs to decide
        action="assignments.self_update",
        project_id=1,
        level="project",
        target_id=1,
        assignment_id=32,
        requested='{"allocation": 80, "end_date": "2026-01-30", "start_date": "2026-01-05"}',
        previous='{"allocation": 50, "end_date": "2026-01-30", "start_date": "2026-01-05"}',
        status="pending",
        created_at=STAMP,
    )
    mock_db_session.execute.side_effect = [
        first_result((make_project(1, pm_id=7), "Winterthur", "Alice Martin")),
        scalars_result([phase]),
        scalars_result([_subphase(20, 10, "phase", 1)]),
        rows_result(
            [
                (
                    _assignment(
                        30, 5, phase_id=10, approval_status="pending", approval_request_id=50
                    ),
                    "Eve",
                    None,
                )
            ]
        ),
        rows_result([(_assignment(31, 8, subphase_id=20), "Bob Brown", None)]),
        rows_result(
            [
                (
                    _assignment(
                        32,
                        7,
                        start_date=date(2026, 1, 5),
                        end_date=date(2026, 1, 30),
                        approval_request_id=51,
                    ),
                    "Alice Martin",
                    "Chemist",
                )
            ]
        ),
        rows_result([]),
        scalars_result([pending_create, pending_update]),
        scalars_result([]),  # policies: the defaults (the PM approves)
    ]

    response = await client.get("/api/projects/1")

    assert response.status_code == 200
    body = response.json()
    (phase_row,) = body["phases"][0]["staffAssignments"]
    assert phase_row["approval_status"] == "pending"
    assert phase_row["approval"] == {
        "request_id": 50,
        "action": "assignments.self_create",
        "requester_id": 5,
        "requested": {"allocation": 40},
        "previous": None,
        "created_at": "2026-01-01T12:00:00.000Z",
        "can_decide": True,
    }
    (sub_row,) = body["phases"][0]["children"][0]["staffAssignments"]
    assert (sub_row["approval_status"], sub_row["approval"]) == ("approved", None)
    (project_row,) = body["staffAssignments"]
    assert project_row["approval_status"] == "approved"
    assert project_row["approval"]["previous"]["allocation"] == 50
    assert project_row["approval"]["requested"]["allocation"] == 80
    assert project_row["approval"]["can_decide"] is False


@pytest.mark.asyncio
async def test_project_detail_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [first_result(None)]

    response = await client.get("/api/projects/99")

    assert response.status_code == 404
    assert response.json()["detail"] == "Project not found"
    assert mock_db_session.execute.await_count == 1


# ---------------------------------------------------------------------------
# POST /projects
# ---------------------------------------------------------------------------


def _project_body(**overrides):
    body = {
        "name": "Scale-up",
        "site_id": 1,
        "pm_id": 7,
        "start_date": "2026-01-05",
        "end_date": "2026-03-31",
        "confirmed": True,
        "phases": [
            {"type": "Design", "start_date": "2026-01-05", "end_date": "2026-01-31"},
            {
                "type": "Gate",
                "start_date": "2026-02-01",
                "end_date": "2026-02-01",
                "is_milestone": True,
            },
        ],
        "tag_ids": [4],
    }
    body.update(overrides)
    return body


@pytest.mark.asyncio
async def test_create_project_with_phases(authed_client, mock_db_session, broadcast):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(1), scalar_result(7)]

    async def flush():
        project = mock_db_session.add.call_args_list[0].args[0]
        project.id = 77

    mock_db_session.flush.side_effect = flush

    with patch(
        "app.routers.projects.validate_project_tags", AsyncMock(return_value=[])
    ) as validate:
        response = await client.post("/api/projects", json=_project_body())

    assert response.status_code == 200
    assert response.json() == {"id": 77, "success": True}
    validate.assert_awaited_once_with(mock_db_session, 1, [4], [])
    added = [c.args[0] for c in mock_db_session.add.call_args_list]
    project, design, gate = added
    assert isinstance(project, Project)
    assert (project.confirmed, project.pm_id) == (1, 7)
    assert all(isinstance(p, ProjectPhase) for p in (design, gate))
    assert [(p.type, p.sort_order, p.is_milestone, p.project_id) for p in (design, gate)] == [
        ("Design", 0, 0, 77),
        ("Gate", 1, 1, 77),
    ]
    broadcast.assert_awaited_once()
    assert broadcast.await_args.kwargs["action"] == "create"
    assert broadcast.await_args.kwargs["summary"] == "Scale-up"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("results", "detail"),
    [
        ([None], "Site not found"),
        ([1, None], "Project manager not found"),
    ],
)
async def test_create_project_unknown_reference_404(
    authed_client, mock_db_session, broadcast, results, detail
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(r) for r in results]

    response = await client.post("/api/projects", json=_project_body())

    assert response.status_code == 404
    assert response.json()["detail"] == detail
    mock_db_session.add.assert_not_called()
    broadcast.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_project_rejects_inverted_dates(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.post(
        "/api/projects", json=_project_body(start_date="2026-04-01", end_date="2026-03-01")
    )

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_project_forbidden_for_plain_user(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))

    response = await client.post("/api/projects", json=_project_body())

    assert response.status_code == 403
    mock_db_session.add.assert_not_called()


# ---------------------------------------------------------------------------
# PUT /projects/{id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_project_every_field(authed_client, mock_db_session, broadcast):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    project = make_project(1, pm_id=7)
    mock_db_session.execute.side_effect = [scalar_result(project), scalar_result(8)]

    with patch(
        "app.routers.projects.validate_project_tags", AsyncMock(return_value=["T"])
    ) as validate:
        response = await client.put(
            "/api/projects/1",
            json={
                "name": "Renamed",
                "customer": "Initech",
                "pm_id": 8,
                "sales_pm": "Sue",
                "confirmed": False,
                "volume": 5.5,
                "start_date": "2026-02-01",
                "end_date": "2026-04-30",
                "notes": "n",
                "archived": True,
                "tag_ids": [],
            },
        )

    assert response.status_code == 200
    assert (project.name, project.customer, project.pm_id, project.sales_pm) == (
        "Renamed",
        "Initech",
        8,
        "Sue",
    )
    assert (project.confirmed, project.volume, project.archived, project.notes) == (0, 5.5, 1, "n")
    assert (project.start_date, project.end_date) == (date(2026, 2, 1), date(2026, 4, 30))
    assert project.tags == ["T"]
    validate.assert_awaited_once_with(mock_db_session, 1, [], [])
    assert broadcast.await_args.kwargs["summary"] == "Renamed"


@pytest.mark.asyncio
async def test_update_project_same_pm_skips_lookup(authed_client, mock_db_session, broadcast):
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))  # the PM edits their own project
    project = make_project(1, pm_id=7)
    mock_db_session.execute.side_effect = [scalar_result(project)]

    response = await client.put("/api/projects/1", json={"pm_id": 7, "confirmed": True})

    assert response.status_code == 200
    assert project.confirmed == 1
    assert mock_db_session.execute.await_count == 1


@pytest.mark.asyncio
async def test_update_project_unknown_new_pm_404(authed_client, mock_db_session, broadcast):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    project = make_project(1, pm_id=7)
    mock_db_session.execute.side_effect = [scalar_result(project), scalar_result(None)]

    response = await client.put("/api/projects/1", json={"pm_id": 99})

    assert response.status_code == 404
    assert response.json()["detail"] == "Project manager not found"
    assert project.pm_id == 7
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_project_merged_dates_must_be_ordered(
    authed_client, mock_db_session, broadcast
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(make_project(1))]

    response = await client.put("/api/projects/1", json={"end_date": "2025-12-01"})

    assert response.status_code == 422
    mock_db_session.commit.assert_not_awaited()
    broadcast.assert_not_awaited()


# ---------------------------------------------------------------------------
# POST /projects/{id}/phases
# ---------------------------------------------------------------------------


def _phase_body(**overrides):
    body = {"type": "Validation", "start_date": "2026-02-01", "end_date": "2026-02-10"}
    body.update(overrides)
    return body


@pytest.mark.asyncio
async def test_create_phase_at_index_shifts_siblings(authed_client, mock_db_session, broadcast):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [MagicMock()]  # the UPDATE shifting siblings

    response = await client.post(
        "/api/projects/1/phases",
        json=_phase_body(order_index=2, dependencies=[{"id": 3, "type": "FS"}]),
    )

    assert response.status_code == 200
    shift = sql(mock_db_session, 0)
    assert shift.startswith("UPDATE project_phases SET sort_order=(project_phases.sort_order + 1)")
    assert "project_phases.sort_order >= 2" in shift
    (phase,) = (c.args[0] for c in mock_db_session.add.call_args_list)
    assert (phase.sort_order, phase.type) == (2, "Validation")
    assert phase.dependencies == '[{"id": 3, "type": "FS"}]'
    assert broadcast.await_args.kwargs["entity_type"] == "phase"


@pytest.mark.asyncio
async def test_create_phase_appends_after_last(authed_client, mock_db_session, broadcast):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(4)]

    response = await client.post("/api/projects/1/phases", json=_phase_body(is_milestone=True))

    assert response.status_code == 200
    (phase,) = (c.args[0] for c in mock_db_session.add.call_args_list)
    assert (phase.sort_order, phase.is_milestone, phase.dependencies) == (5, 1, None)


@pytest.mark.asyncio
async def test_create_phase_after_single_phase_at_zero_gets_sort_order_one(
    authed_client, mock_db_session, broadcast
):
    """A phase added after one at sort_order 0 must get sort_order 1."""
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(0)]

    response = await client.post("/api/projects/1/phases", json=_phase_body())

    assert response.status_code == 200
    (phase,) = (c.args[0] for c in mock_db_session.add.call_args_list)
    assert phase.sort_order == 1


@pytest.mark.asyncio
async def test_create_phase_validates_body(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))

    response = await client.post("/api/projects/1/phases", json=_phase_body(type=""))

    assert response.status_code == 422
    mock_db_session.add.assert_not_called()


# ---------------------------------------------------------------------------
# Subphase creation
# ---------------------------------------------------------------------------


def _sub_body(**overrides):
    body = {"name": "Prep", "start_date": "2026-02-01", "end_date": "2026-02-03", "project_id": 99}
    body.update(overrides)
    return body


@pytest.mark.asyncio
async def test_create_subphase_at_index_under_phase(authed_client, mock_db_session, broadcast):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    phase = SimpleNamespace(id=10, project_id=1)
    mock_db_session.execute.side_effect = [scalar_result(phase), MagicMock()]

    response = await client.post(
        "/api/phases/10/subphases", json=_sub_body(order_index=0, is_milestone=True)
    )

    assert response.status_code == 200
    body = response.json()
    assert (body["parent_id"], body["parent_type"], body["project_id"]) == (10, "phase", 1)
    assert (body["sort_order"], body["depth"], body["is_milestone"]) == (0, 1, True)
    shift = sql(mock_db_session, 1)
    assert "project_subphases.parent_type = 'phase'" in shift
    assert "project_subphases.sort_order >= 0" in shift
    assert broadcast.await_args.kwargs["entity_type"] == "subphase"


@pytest.mark.asyncio
async def test_child_subphase_appends_one_level_deeper(authed_client, mock_db_session, broadcast):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    parent = SimpleNamespace(id=20, project_id=1, depth=2)
    mock_db_session.execute.side_effect = [scalar_result(parent), scalar_result(3)]

    response = await client.post(
        "/api/subphases/20/children", json=_sub_body(dependencies=[{"id": 21}])
    )

    assert response.status_code == 200
    body = response.json()
    assert (body["parent_id"], body["parent_type"], body["depth"], body["sort_order"]) == (
        20,
        "subphase",
        3,
        4,
    )
    (child,) = (c.args[0] for c in mock_db_session.add.call_args_list)
    assert isinstance(child, ProjectSubphase)
    assert child.project_id == 1  # the parent's project, not the body's 99
    assert child.dependencies == '[{"id": 21}]'


@pytest.mark.asyncio
async def test_child_subphase_at_index_shifts_siblings(authed_client, mock_db_session, broadcast):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    parent = SimpleNamespace(id=20, project_id=1, depth=None)
    mock_db_session.execute.side_effect = [scalar_result(parent), MagicMock()]

    response = await client.post("/api/subphases/20/children", json=_sub_body(order_index=1))

    assert response.status_code == 200
    assert (response.json()["depth"], response.json()["sort_order"]) == (2, 1)
    assert "project_subphases.parent_type = 'subphase'" in sql(mock_db_session, 1)


@pytest.mark.asyncio
async def test_child_subphase_depth_limit(authed_client, mock_db_session, broadcast):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [
        scalar_result(SimpleNamespace(id=20, project_id=1, depth=10))
    ]

    response = await client.post("/api/subphases/20/children", json=_sub_body())

    assert response.status_code == 400
    assert response.json()["detail"] == "Maximum depth of 10 levels reached"
    mock_db_session.add.assert_not_called()
    broadcast.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("url", "detail"),
    [
        ("/api/phases/10/subphases", "Phase not found"),
        ("/api/subphases/20/children", "Parent subphase not found"),
    ],
)
async def test_subphase_parent_404(authed_client, mock_db_session, broadcast, url, detail):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.post(url, json=_sub_body())

    assert response.status_code == 404
    assert response.json()["detail"] == detail
    mock_db_session.add.assert_not_called()


# ---------------------------------------------------------------------------
# Phase / subphase field updates
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_phase_fields(authed_client, mock_db_session, broadcast, change_intents):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    phase = ProjectPhase(
        id=10,
        project_id=1,
        type="Old",
        start_date=date(2026, 1, 5),
        end_date=date(2026, 1, 30),
        is_milestone=0,
        completion=0,
        status="todo",
    )
    bookings = MagicMock()
    bookings.all.return_value = [(4, 60)]
    # The phase, its approved bookings, then its segments to fit (none).
    mock_db_session.execute.side_effect = [scalar_result(phase), bookings, scalars_result([])]

    response = await client.put(
        "/api/phases/10",
        json={
            "type": "New",
            "start_date": "2026-01-06",
            "end_date": "2026-01-31",
            "is_milestone": True,
            "dependencies": [{"id": 9, "type": "SS"}],
        },
    )

    assert response.status_code == 200
    assert (phase.type, phase.is_milestone) == ("New", 1)
    assert (phase.start_date, phase.end_date) == (date(2026, 1, 6), date(2026, 1, 31))
    assert phase.dependencies == '[{"id": 9, "type": "SS"}]'
    assert broadcast.await_args.kwargs["project_id"] == 1
    ((_, intents, _),) = change_intents
    dates = "dates 2026-01-05–2026-01-30 → 2026-01-06–2026-01-31"
    assert [(i.recipient, i.user_id, i.title, i.body) for i in intents] == [
        ("person", 4, "Test User1 moved New", f"{dates} (you are booked at 60%)"),
        ("pm", None, "Test User1 moved New", dates),
    ]
    assert all((i.entity_type, i.entity_id, i.project_id) == ("phase", 10, 1) for i in intents)


@pytest.mark.asyncio
async def test_update_subphase_fields(authed_client, mock_db_session, broadcast, change_intents):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    subphase = ProjectSubphase(
        id=20,
        project_id=1,
        name="Old",
        start_date=date(2026, 1, 5),
        end_date=date(2026, 1, 30),
        is_milestone=1,
        completion=0,
        status="todo",
    )
    mock_db_session.execute.side_effect = [
        scalar_result(subphase),
        MagicMock(),
        scalars_result([]),
    ]

    response = await client.put(
        "/api/subphases/20",
        json={
            "name": "New",
            "start_date": "2026-01-06",
            "end_date": "2026-01-31",
            "is_milestone": False,
            "dependencies": [],
        },
    )

    assert response.status_code == 200
    assert (subphase.name, subphase.is_milestone, subphase.dependencies) == ("New", 0, "[]")
    assert subphase.end_date == date(2026, 1, 31)
    ((_, intents, _),) = change_intents
    assert [(i.recipient, i.entity_type, i.entity_id) for i in intents] == [("pm", "subphase", 20)]


@pytest.mark.asyncio
@pytest.mark.parametrize("url", ["/api/phases/10", "/api/subphases/20"])
async def test_update_rejects_inverted_merged_range(authed_client, mock_db_session, url):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    row = SimpleNamespace(
        id=1, project_id=1, start_date=date(2026, 1, 5), end_date=date(2026, 1, 30)
    )
    mock_db_session.execute.side_effect = [scalar_result(row)]

    response = await client.put(url, json={"start_date": "2026-02-15"})

    assert response.status_code == 422
    mock_db_session.commit.assert_not_awaited()
