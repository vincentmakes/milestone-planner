"""
Route tests for project-field values on /api/projects (2.0.0).

Responses carry ``field_values: {field_id: value}`` read in two column queries
for the whole list (masked cross-site rows carry ``{}`` and are not queried);
``POST`` / ``PUT`` accept ``field_values``: values are checked by
``validate_field_values`` (types, items of their field, site / team scope,
one item on a ``select`` field), only the fields given change, and a team
change re-checks the items the project already holds.

Mock-based, house style (tests/conftest.py).
"""

from datetime import date, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.project import Project
from app.models.project_field import ProjectFieldOption, ProjectFieldValue
from app.models.site import Site
from app.models.team import Team
from app.services.project_field_rules import (
    invalid_value_detail,
    option_not_applicable_detail,
    option_not_applicable_to_teams_detail,
    single_item_detail,
)
from tests.conftest import FakeUser
from tests.support import scalar_result, scalars_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)

# id → (name, type)
FIELDS = {
    1: ("Remark", "text"),
    2: ("Budget", "number"),
    3: ("Regulated", "toggle"),
    4: ("Project type", "select"),
    5: ("Area", "multiselect"),
}


def rows_result(rows):
    result = MagicMock()
    result.all.return_value = list(rows)
    return result


def first_result(row):
    result = MagicMock()
    result.first.return_value = row
    return result


def fields_result(*field_ids):
    return rows_result([(fid, *FIELDS[fid]) for fid in field_ids])


def make_option(option_id, field_id, name, sort_order=0, site_ids=None, teams=()):
    return ProjectFieldOption(
        id=option_id,
        field_id=field_id,
        name=name,
        color="#6366f1",
        sort_order=sort_order,
        all_sites=site_ids is None,
        sites=[Site(id=sid, name=f"Site {sid}") for sid in (site_ids or [])],
        teams=list(teams),
    )


def make_project(project_id=1, site_id=1, **fields) -> Project:
    return Project(
        id=project_id,
        name=f"Project {project_id}",
        site_id=site_id,
        customer="ACME",
        pm_id=None,
        sales_pm="Sam",
        confirmed=1,
        volume=None,
        start_date=date(2026, 1, 5),
        end_date=date(2026, 3, 31),
        notes="n",
        archived=0,
        created_at=STAMP,
        updated_at=STAMP,
        tags=[],
        teams=fields.get("teams", []),
        field_values=fields.get("field_values", []),
        field_selections=fields.get("field_selections", []),
    )


def loader_paths(statement) -> set[str]:
    return {
        " -> ".join(str(attr) for attr in element.path.natural_path[1::2])
        for option in statement._with_options
        for element in option.context
    }


def sql(db, index: int) -> str:
    stmt = db.execute.await_args_list[index].args[0]
    return " ".join(str(stmt.compile(compile_kwargs={"literal_binds": True})).split())


def added_project(db) -> Project:
    (project,) = (c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], Project))
    return project


@pytest.fixture
def broadcast():
    with patch("app.routers.projects.broadcast_change", new_callable=AsyncMock) as mock:
        yield mock


def _body(**overrides):
    body = {
        "name": "Scale-up",
        "site_id": 1,
        "start_date": "2026-01-05",
        "end_date": "2026-03-31",
    }
    body.update(overrides)
    return body


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_carries_field_values_and_masked_rows_carry_none(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user", site_ids=[1, 2]))
    own, external = make_project(1, site_id=1), make_project(2, site_id=2)
    mock_db_session.execute.side_effect = [
        scalar_result(2),
        rows_result([(own, "Winterthur", None), (external, "Basel", None)]),
        rows_result(
            [
                (1, 1, "text", "Pilot", None, None),
                (1, 2, "number", None, 1250.0, None),
                (1, 3, "toggle", None, None, False),
            ]
        ),
        rows_result([(1, 4, "select", 42), (1, 5, "multiselect", 51), (1, 5, "multiselect", 52)]),
    ]

    response = await client.get("/api/projects?siteId=1&includeOtherSites=true")

    assert response.status_code == 200, response.text
    own_row, external_row = response.json()["items"]
    # JSON object keys are strings; whole numbers come out as integers.
    assert own_row["field_values"] == {
        "1": "Pilot",
        "2": 1250,
        "3": False,
        "4": 42,
        "5": [51, 52],
    }
    assert external_row["field_values"] == {}
    # The list loads no field relationship; the two column queries cover the
    # shown (unmasked) projects only.
    assert {"Project.field_values", "Project.field_selections"} <= loader_paths(
        mock_db_session.execute.await_args_list[1].args[0]
    )
    assert "project_field_values.project_id IN (1)" in sql(mock_db_session, 2)
    assert "project_field_selections.project_id IN (1)" in sql(mock_db_session, 3)
    assert mock_db_session.execute.await_count == 4


@pytest.mark.asyncio
async def test_an_empty_list_runs_no_field_query(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [scalar_result(0), rows_result([])]

    response = await client.get("/api/projects")

    assert response.status_code == 200
    assert mock_db_session.execute.await_count == 2


@pytest.mark.asyncio
async def test_a_page_of_masked_rows_runs_no_field_query(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user", site_ids=[1, 2]))
    mock_db_session.execute.side_effect = [
        scalar_result(1),
        rows_result([(make_project(2, site_id=2), "Basel", None)]),
    ]

    response = await client.get("/api/projects?siteId=1&includeOtherSites=true")

    assert response.status_code == 200
    assert response.json()["items"][0]["field_values"] == {}
    assert mock_db_session.execute.await_count == 2


@pytest.mark.asyncio
async def test_detail_carries_field_values(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [
        first_result((make_project(1), "Winterthur", None)),
        scalars_result([]),
        scalars_result([]),
        rows_result([]),
        rows_result([]),
        rows_result([]),
        rows_result([]),
        scalars_result([]),  # pending approval requests
        rows_result([(1, 2, "number", None, 2.5, None)]),
        rows_result([(1, 4, "select", 41)]),
    ]

    response = await client.get("/api/projects/1")

    assert response.status_code == 200, response.text
    assert response.json()["field_values"] == {"2": 2.5, "4": 41}
    assert {"Project.field_values", "Project.field_selections"} <= loader_paths(
        mock_db_session.execute.await_args_list[0].args[0]
    )
    assert "project_field_values.project_id IN (1)" in sql(mock_db_session, 8)


@pytest.mark.asyncio
async def test_detail_without_values_answers_an_empty_object(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [
        first_result((make_project(1), "Winterthur", None)),
        *[scalars_result([])] * 2,
        *[rows_result([])] * 4,
        scalars_result([]),
        rows_result([]),
        rows_result([]),
    ]

    response = await client.get("/api/projects/1")

    assert response.status_code == 200
    assert response.json()["field_values"] == {}


# ---------------------------------------------------------------------------
# POST /projects
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_project_with_field_values(authed_client, mock_db_session, broadcast):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    customer = make_option(42, 4, "Customer", 1)
    process, analytics = make_option(51, 5, "Process", 0), make_option(52, 5, "Analytics", 1)
    mock_db_session.execute.side_effect = [
        scalar_result(1),  # the site exists
        fields_result(1, 2, 3, 4, 5),
        scalars_result([analytics, customer, process]),
    ]

    response = await client.post(
        "/api/projects",
        json=_body(
            field_values={"1": " Pilot ", "2": 12.5, "3": True, "4": 42, "5": [52, 51, 999]}
        ),
    )

    assert response.status_code == 200, response.text
    project = added_project(mock_db_session)
    assert [
        (row.field_id, row.value_text, row.value_number, row.value_bool)
        for row in project.field_values
    ] == [(1, "Pilot", None, None), (2, None, 12.5, None), (3, None, None, True)]
    # Item order, the unknown id 999 dropped.
    assert project.field_selections == [customer, process, analytics]
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_project_without_field_values_runs_no_field_query(
    authed_client, mock_db_session, broadcast
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(1)]

    response = await client.post("/api/projects", json=_body(field_values={}))

    assert response.status_code == 200, response.text
    project = added_project(mock_db_session)
    assert (project.field_values, project.field_selections) == ([], [])
    assert mock_db_session.execute.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field_values", "results", "status", "detail"),
    [
        ({"2": "12"}, [fields_result(2)], 422, invalid_value_detail("Budget")),
        (
            {"4": [41, 42]},
            [
                fields_result(4),
                scalars_result([make_option(41, 4, "Internal"), make_option(42, 4, "Customer")]),
            ],
            400,
            single_item_detail("Project type"),
        ),
        (
            {"5": [53]},
            [fields_result(5), scalars_result([make_option(53, 5, "GxP", site_ids=[2])])],
            400,
            option_not_applicable_detail("GxP", "Area"),
        ),
    ],
)
async def test_create_project_rejects_bad_field_values(
    authed_client, mock_db_session, broadcast, field_values, results, status, detail
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(1), *results]

    response = await client.post("/api/projects", json=_body(field_values=field_values))

    assert response.status_code == status
    assert response.json()["detail"] == detail
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_project_field_values_must_be_keyed_by_field_id(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))

    response = await client.post("/api/projects", json=_body(field_values={"budget": 1}))

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_project_ignores_an_unknown_field(authed_client, mock_db_session, broadcast):
    # A What-If replay may carry a field deleted meantime: the write succeeds.
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(1), fields_result(2)]

    response = await client.post("/api/projects", json=_body(field_values={"2": 5, "9": "x"}))

    assert response.status_code == 200, response.text
    project = added_project(mock_db_session)
    assert [(r.field_id, r.value_number) for r in project.field_values] == [(2, 5.0)]
    assert project.field_selections == []
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_project_ignores_an_unknown_field(authed_client, mock_db_session, broadcast):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    project = make_project(1)
    mock_db_session.execute.side_effect = [scalar_result(project), fields_result()]

    response = await client.put("/api/projects/1", json={"field_values": {"9": [1]}})

    assert response.status_code == 200, response.text
    assert (project.field_values, project.field_selections) == ([], [])
    assert mock_db_session.execute.await_count == 2
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_project_field_values_are_capped_at_500_fields(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))

    response = await client.put(
        "/api/projects/1", json={"field_values": {str(i): None for i in range(1, 502)}}
    )

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_project_with_field_values_needs_projects_create(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    response = await client.post("/api/projects", json=_body(field_values={"1": "x"}))

    assert response.status_code == 403
    mock_db_session.add.assert_not_called()


# ---------------------------------------------------------------------------
# PUT /projects/{id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_project_writes_only_the_fields_given(
    authed_client, mock_db_session, broadcast
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    kept = ProjectFieldValue(field_id=3, value_bool=True)
    remark = ProjectFieldValue(field_id=1, value_text="old")
    internal, customer = make_option(41, 4, "Internal", 0), make_option(42, 4, "Customer", 1)
    process = make_option(51, 5, "Process", 0)
    project = make_project(1, field_values=[kept, remark], field_selections=[internal, process])
    mock_db_session.execute.side_effect = [
        scalar_result(project),
        fields_result(1, 2, 4),
        scalars_result([customer]),
    ]

    response = await client.put(
        "/api/projects/1", json={"field_values": {"1": None, "2": 7, "4": 42}}
    )

    assert response.status_code == 200, response.text
    assert [(r.field_id, r.value_bool, r.value_number) for r in project.field_values] == [
        (3, True, None),
        (2, None, 7.0),
    ]
    # Area (left out) keeps its item; Project type is replaced.
    assert project.field_selections == [process, customer]
    # Loaded with the project for the write (not skipped).
    paths = loader_paths(mock_db_session.execute.await_args_list[0].args[0])
    assert "Project.field_values" not in paths
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_project_clears_a_dropdown_field(authed_client, mock_db_session, broadcast):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    process = make_option(51, 5, "Process", 0)
    project = make_project(1, field_selections=[process])
    mock_db_session.execute.side_effect = [scalar_result(project), fields_result(5)]

    response = await client.put("/api/projects/1", json={"field_values": {"5": []}})

    assert response.status_code == 200, response.text
    assert project.field_selections == []
    assert mock_db_session.execute.await_count == 2


@pytest.mark.asyncio
async def test_update_without_field_values_or_teams_skips_the_field_relationships(
    authed_client, mock_db_session, broadcast
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(make_project(1))]

    response = await client.put("/api/projects/1", json={"name": "Renamed"})

    assert response.status_code == 200, response.text
    paths = loader_paths(mock_db_session.execute.await_args_list[0].args[0])
    assert {"Project.field_values", "Project.field_selections"} <= paths
    assert mock_db_session.execute.await_count == 1


@pytest.mark.asyncio
async def test_update_project_teams_recheck_the_items_it_holds(
    authed_client, mock_db_session, broadcast
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    old, new = Team(id=3, site_id=1, name="Upstream"), Team(id=5, site_id=1, name="Downstream")
    upstream_only = make_option(54, 5, "Upstream work", teams=[old])
    project = make_project(1, teams=[old], field_selections=[upstream_only])
    mock_db_session.execute.side_effect = [
        scalar_result(project),
        scalars_result([new]),  # the teams
        fields_result(5),
        scalars_result([upstream_only]),  # the held item, re-checked
    ]

    response = await client.put("/api/projects/1", json={"team_ids": [5]})

    assert response.status_code == 400
    assert response.json()["detail"] == option_not_applicable_to_teams_detail(
        "Upstream work", "Area"
    )
    assert "project_fields.id IN (5)" in sql(mock_db_session, 2)
    assert "project_field_options.id IN (54)" in sql(mock_db_session, 3)
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_project_teams_keep_items_still_applicable(
    authed_client, mock_db_session, broadcast
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    old, new = Team(id=3, site_id=1, name="Upstream"), Team(id=5, site_id=1, name="Downstream")
    anywhere = make_option(51, 5, "Process")
    internal = make_option(41, 4, "Internal")
    project = make_project(1, teams=[old], field_selections=[internal, anywhere])
    mock_db_session.execute.side_effect = [
        scalar_result(project),
        scalars_result([new]),
        fields_result(4, 5),
        scalars_result([internal, anywhere]),
    ]

    response = await client.put("/api/projects/1", json={"team_ids": [5]})

    assert response.status_code == 200, response.text
    assert project.teams == [new]
    assert project.field_selections == [internal, anywhere]
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_project_values_given_win_over_held_items_on_a_team_change(
    authed_client, mock_db_session, broadcast
):
    # The held item of "Area" is limited to the old team, but the write replaces
    # it in the same request: only the new item is checked.
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    old, new = Team(id=3, site_id=1, name="Upstream"), Team(id=5, site_id=1, name="Downstream")
    upstream_only = make_option(54, 5, "Upstream work", teams=[old])
    process = make_option(51, 5, "Process")
    project = make_project(1, teams=[old], field_selections=[upstream_only])
    mock_db_session.execute.side_effect = [
        scalar_result(project),
        scalars_result([new]),
        fields_result(5),
        scalars_result([process]),
    ]

    response = await client.put(
        "/api/projects/1", json={"team_ids": [5], "field_values": {"5": [51]}}
    )

    assert response.status_code == 200, response.text
    assert project.field_selections == [process]
    assert "project_field_options.id IN (51)" in sql(mock_db_session, 3)


@pytest.mark.asyncio
async def test_update_project_rejects_a_bad_value(authed_client, mock_db_session, broadcast):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(make_project(1)), fields_result(3)]

    response = await client.put("/api/projects/1", json={"field_values": {"3": "yes"}})

    assert response.status_code == 422
    assert response.json()["detail"] == invalid_value_detail("Regulated")
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_project_field_values_needs_an_editor(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))  # not the PM, no projects.edit_any
    mock_db_session.execute.side_effect = [scalar_result(make_project(1))]

    response = await client.put("/api/projects/1", json={"field_values": {"1": "x"}})

    assert response.status_code == 403
    assert mock_db_session.execute.await_count == 1
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_project_field_values_on_an_unknown_project_is_404(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.put("/api/projects/9", json={"field_values": {"1": "x"}})

    assert response.status_code == 404


# ---------------------------------------------------------------------------
# DELETE /projects/{id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_project_delete_skips_the_field_relationships(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.delete("/api/projects/9")

    assert response.status_code == 404
    paths = loader_paths(mock_db_session.execute.await_args_list[0].args[0])
    assert {"Project.field_values", "Project.field_selections"} <= paths
