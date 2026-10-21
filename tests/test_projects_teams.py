"""
Route tests for a project's teams on /api/projects.

Responses carry ``team_ids`` (masked cross-site rows carry none); writes
accept ``team_ids``: the teams must be at the project's site, unknown ids are
dropped (a What-If replay may carry a deleted team), and a team change
re-validates the project's tags against its new teams.

Mock-based, house style (tests/conftest.py).
"""

from datetime import date, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.project import Project
from app.models.tag import Tag
from app.models.team import Team
from app.services.tag_rules import tag_not_applicable_to_teams_detail
from app.services.team_rules import (
    SITE_LESS_PROJECT_TEAMS_DETAIL,
    team_outside_project_site_detail,
)
from tests.conftest import FakeUser
from tests.support import scalar_result, scalars_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)


def make_team(team_id: int = 3, site_id: int = 1, name: str = "Upstream") -> Team:
    return Team(id=team_id, site_id=site_id, name=name)


def make_tag(tag_id: int = 4, name: str = "Priority", teams: list[Team] | None = None) -> Tag:
    return Tag(
        id=tag_id,
        name=name,
        color="#ff0000",
        group_id=None,
        all_sites=True,
        sort_order=0,
        sites=[],
        teams=list(teams or []),
    )


def make_project(project_id: int = 1, site_id: int | None = 1, **fields) -> Project:
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
        tags=fields.get("tags", []),
        teams=fields.get("teams", []),
    )


def rows_result(rows):
    result = MagicMock()
    result.all.return_value = rows
    return result


def first_result(row):
    result = MagicMock()
    result.first.return_value = row
    return result


@pytest.fixture
def broadcast():
    with patch("app.routers.projects.broadcast_change", new_callable=AsyncMock) as mock:
        yield mock


def loader_paths(statement) -> set[str]:
    """The relationship paths of a statement's loader options, e.g. "Project.tags -> Tag.sites"."""
    return {
        " -> ".join(str(attr) for attr in element.path.natural_path[1::2])
        for option in statement._with_options
        for element in option.context
    }


def added_project(db) -> Project:
    (project,) = [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], Project)]
    return project


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_rows_carry_team_ids_and_masked_rows_carry_none(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    own = make_project(1, site_id=1, teams=[make_team(5, 1, "B"), make_team(3, 1, "A")])
    external = make_project(2, site_id=2, teams=[make_team(9, 2)])
    mock_db_session.execute.side_effect = [
        scalar_result(2),
        rows_result([(own, "Winterthur", None), (external, "Basel", None)]),
    ]

    response = await client.get("/api/projects?siteId=1&includeOtherSites=true")

    assert response.status_code == 200
    own_row, external_row = response.json()["items"]
    assert own_row["team_ids"] == [3, 5]
    assert external_row["name"] == "[External Project]"
    assert external_row["team_ids"] == []


@pytest.mark.asyncio
async def test_list_query_skips_the_tags_team_links(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [scalar_result(0), rows_result([])]

    response = await client.get("/api/projects")

    assert response.status_code == 200
    paths = loader_paths(mock_db_session.execute.await_args_list[1].args[0])
    assert {"Project.tags -> Tag.sites", "Project.tags -> Tag.teams"} <= paths


@pytest.mark.asyncio
async def test_detail_carries_team_ids(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    project = make_project(1, teams=[make_team(3), make_team(7, 1, "Downstream")])
    mock_db_session.execute.side_effect = [
        first_result((project, "Winterthur", None)),
        scalars_result([]),
        scalars_result([]),
        rows_result([]),
        rows_result([]),
        rows_result([]),
        rows_result([]),
    ]

    response = await client.get("/api/projects/1")

    assert response.status_code == 200, response.text
    assert response.json()["team_ids"] == [3, 7]


# ---------------------------------------------------------------------------
# POST /projects
# ---------------------------------------------------------------------------


def _body(**overrides):
    body = {
        "name": "Scale-up",
        "site_id": 1,
        "pm_id": 7,
        "start_date": "2026-01-05",
        "end_date": "2026-03-31",
    }
    body.update(overrides)
    return body


@pytest.mark.asyncio
async def test_create_project_with_teams(authed_client, mock_db_session, broadcast):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    team = make_team(3, 1)
    tag = make_tag(4, "Upstream only", teams=[team])
    mock_db_session.execute.side_effect = [
        scalar_result(1),  # the site exists
        scalar_result(7),  # the PM exists
        scalars_result([team]),  # the teams (404 dropped)
        scalars_result([tag]),  # the tags
    ]

    response = await client.post("/api/projects", json=_body(team_ids=[3, 404], tag_ids=[4]))

    assert response.status_code == 200, response.text
    project = added_project(mock_db_session)
    assert project.teams == [team]
    assert project.tags == [tag]
    assert mock_db_session.execute.await_count == 4
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_project_with_a_team_at_another_site_is_a_400(
    authed_client, mock_db_session, broadcast
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [
        scalar_result(1),
        scalar_result(7),
        scalars_result([make_team(9, 2, "Basel QC")]),
    ]

    response = await client.post("/api/projects", json=_body(team_ids=[9]))

    assert response.status_code == 400
    assert response.json()["detail"] == team_outside_project_site_detail("Basel QC")
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_create_site_less_project_with_teams_is_a_400(
    authed_client, mock_db_session, broadcast
):
    client, set_user = authed_client
    # Site-less projects are reachable with sites.view_all only (the admin).
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalars_result([make_team(3, 1)])]

    response = await client.post(
        "/api/projects", json=_body(site_id=None, pm_id=None, team_ids=[3])
    )

    assert response.status_code == 400
    assert response.json()["detail"] == SITE_LESS_PROJECT_TEAMS_DETAIL
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_create_project_with_only_unknown_teams_drops_them(
    authed_client, mock_db_session, broadcast
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(1), scalar_result(7), scalars_result([])]

    response = await client.post("/api/projects", json=_body(team_ids=[404]))

    assert response.status_code == 200, response.text
    assert added_project(mock_db_session).teams == []


# ---------------------------------------------------------------------------
# PUT /projects/{id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_project_teams_revalidates_existing_tags(
    authed_client, mock_db_session, broadcast
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    old, new = make_team(3, 1, "Upstream"), make_team(5, 1, "Downstream")
    tag = make_tag(4, "Anywhere")
    project = make_project(1, tags=[tag], teams=[old])
    mock_db_session.execute.side_effect = [
        scalar_result(project),
        scalars_result([new]),
        scalars_result([tag]),  # the existing tags, re-checked against the new teams
    ]

    response = await client.put("/api/projects/1", json={"team_ids": [5]})

    assert response.status_code == 200, response.text
    assert project.teams == [new]
    assert project.tags == [tag]
    assert mock_db_session.execute.await_count == 3
    tags_sql = str(
        mock_db_session.execute.await_args_list[2].args[0].compile(
            compile_kwargs={"literal_binds": True}
        )
    )
    assert "tags.id IN (4)" in tags_sql
    assert "Project.teams" in loader_paths(mock_db_session.execute.await_args_list[0].args[0])
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_project_teams_rejects_a_tag_limited_to_a_dropped_team(
    authed_client, mock_db_session, broadcast
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    old, new = make_team(3, 1, "Upstream"), make_team(5, 1, "Downstream")
    tag = make_tag(4, "Upstream only", teams=[old])
    project = make_project(1, tags=[tag], teams=[old])
    mock_db_session.execute.side_effect = [
        scalar_result(project),
        scalars_result([new]),
        scalars_result([tag]),
    ]

    response = await client.put("/api/projects/1", json={"team_ids": [5]})

    assert response.status_code == 400
    assert response.json()["detail"] == tag_not_applicable_to_teams_detail("Upstream only")
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_project_team_at_another_site_is_a_400(
    authed_client, mock_db_session, broadcast
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    project = make_project(1)
    mock_db_session.execute.side_effect = [
        scalar_result(project),
        scalars_result([make_team(9, 2, "Basel QC")]),
    ]

    response = await client.put("/api/projects/1", json={"team_ids": [9]})

    assert response.status_code == 400
    assert response.json()["detail"] == team_outside_project_site_detail("Basel QC")
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_site_less_project_with_teams_is_a_400(
    authed_client, mock_db_session, broadcast
):
    client, set_user = authed_client
    # Site-less projects are reachable with sites.view_all only (the admin).
    set_user(FakeUser(1, "admin"))
    project = make_project(1, site_id=None)
    mock_db_session.execute.side_effect = [scalar_result(project), scalars_result([make_team(3)])]

    response = await client.put("/api/projects/1", json={"team_ids": [3]})

    assert response.status_code == 400
    assert response.json()["detail"] == SITE_LESS_PROJECT_TEAMS_DETAIL


@pytest.mark.asyncio
async def test_update_project_clearing_teams_needs_no_team_query(
    authed_client, mock_db_session, broadcast
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    project = make_project(1, tags=[], teams=[make_team(3)])
    mock_db_session.execute.side_effect = [scalar_result(project)]

    response = await client.put("/api/projects/1", json={"team_ids": []})

    assert response.status_code == 200, response.text
    assert project.teams == []
    assert mock_db_session.execute.await_count == 1  # no teams, no tags: no query


@pytest.mark.asyncio
async def test_update_project_tags_are_checked_against_the_current_teams(
    authed_client, mock_db_session, broadcast
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    team = make_team(3, 1, "Upstream")
    tag = make_tag(4, "Upstream only", teams=[team])
    project = make_project(1, teams=[team])
    mock_db_session.execute.side_effect = [scalar_result(project), scalars_result([tag])]

    response = await client.put("/api/projects/1", json={"tag_ids": [4]})

    assert response.status_code == 200, response.text
    assert project.tags == [tag]
    assert project.teams == [team]


@pytest.mark.asyncio
async def test_update_project_tags_and_teams_together_checks_the_tags_against_the_new_teams(
    authed_client, mock_db_session, broadcast
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    old, new = make_team(3, 1, "Upstream"), make_team(5, 1, "Downstream")
    downstream_tag = make_tag(4, "Downstream only", teams=[new])
    upstream_tag = make_tag(6, "Upstream only", teams=[old])
    project = make_project(1, teams=[old])

    # A tag limited to the new team passes...
    mock_db_session.execute.side_effect = [
        scalar_result(project),
        scalars_result([new]),
        scalars_result([downstream_tag]),
    ]
    response = await client.put("/api/projects/1", json={"tag_ids": [4], "team_ids": [5]})
    assert response.status_code == 200, response.text
    assert (project.teams, project.tags) == ([new], [downstream_tag])

    # ...one limited to the team being dropped does not.
    project = make_project(1, teams=[old])
    mock_db_session.execute.side_effect = [
        scalar_result(project),
        scalars_result([new]),
        scalars_result([upstream_tag]),
    ]
    mock_db_session.commit.reset_mock()
    response = await client.put("/api/projects/1", json={"tag_ids": [6], "team_ids": [5]})
    assert response.status_code == 400
    assert response.json()["detail"] == tag_not_applicable_to_teams_detail("Upstream only")
    mock_db_session.commit.assert_not_awaited()
