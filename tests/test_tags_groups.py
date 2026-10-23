"""
Site-scoped tags and admin-only tag management (tag groups became project
fields in 2.0.0: their routes, model and ``group_id`` are gone).

- Every tag write is admin-only (superusers are refused like plain users);
  every authenticated user can read the list.
- POST/PUT /tags: site scoping (all_sites=true clears the site list), 404 for
  unknown site ids, 422 for a ``group_id``, append ordering, reorder.
- The 409s that protect existing project data carry their count in a
  plain-string detail (the frontend renders `detail` as text).
- Deleting a site deletes the site-restricted tags it leaves without a site.
- Site export sheets, schema sources and the broadcast mapping.

Mock-based: each test lays out the `db.execute` results in the order the
handler consumes them and inspects the compiled statements.
"""

import re
import sys
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.database import Base
from app.middleware.broadcast import _resolve_entity_type
from app.models.project import Project
from app.models.site import Site
from app.models.tag import Tag, TagSite
from app.models.team import Team
from app.routers.export import build_site_export_workbook
from app.services.tag_rules import other_teams_conflict_detail
from app.services.team_rules import TEAM_NOT_FOUND_DETAIL, team_outside_sites_detail
from app.services.tenant_provisioner import get_tenant_schema_sql
from tests.conftest import FakeUser
from tests.test_export_formula_injection import _fake_openpyxl, _FakeWorkbook

STAMP = datetime(2026, 1, 1, 12, 0, 0)
ROOT = Path(__file__).resolve().parents[1]


def _scalar_result(value):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    result.scalar.return_value = value
    return result


def _scalars_result(values):
    result = MagicMock()
    result.scalars.return_value.all.return_value = values
    return result


def _site(site_id: int, name: str | None = None) -> Site:
    return Site(id=site_id, name=name or f"Site {site_id}")


def _tag(tag_id: int = 1, name: str = "Internal", **kwargs) -> Tag:
    return Tag(
        id=tag_id,
        name=name,
        color=kwargs.get("color", "#6366f1"),
        all_sites=kwargs.get("all_sites", True),
        sort_order=kwargs.get("sort_order", 0),
        sites=kwargs.get("sites", []),
        teams=kwargs.get("teams", []),
        created_at=STAMP,
        updated_at=STAMP,
    )


def _team(team_id: int = 7, site_id: int = 1, name: str = "Analytical Lab") -> Team:
    return Team(id=team_id, site_id=site_id, name=name)


def _sql(mock_db_session) -> list[str]:
    return [
        str(call.args[0].compile(compile_kwargs={"literal_binds": True}))
        for call in mock_db_session.execute.await_args_list
    ]


@pytest.fixture
def stamp_on_refresh(mock_db_session):
    """Simulate the DB filling id/timestamps when a new row is refreshed."""

    async def refresh(obj):
        if getattr(obj, "id", None) is None:
            obj.id = 42
        if getattr(obj, "created_at", None) is None:
            obj.created_at = STAMP
        if getattr(obj, "updated_at", None) is None:
            obj.updated_at = STAMP

    mock_db_session.refresh.side_effect = refresh
    return mock_db_session


# ---------------------------------------------------------
# Role gating
# ---------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["user", "superuser"])
@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("post", "/api/tags", {"name": "Critical"}),
        ("put", "/api/tags/reorder", {"tag_order": [2, 1]}),
        ("put", "/api/tags/1", {"name": "Renamed"}),
        ("delete", "/api/tags/1", None),
    ],
)
async def test_tag_writes_are_admin_only(authed_client, role, method, path, body):
    client, set_user = authed_client
    set_user(FakeUser(1, role))

    kwargs = {"json": body} if body is not None else {}
    response = await client.request(method.upper(), path, **kwargs)

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_any_user_lists_tags_in_tag_order(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = _scalars_result(
        [
            _tag(1, "Internal", sort_order=0),
            _tag(
                2,
                "Basel only",
                all_sites=False,
                sites=[_site(1)],
                teams=[_team(8), _team(7)],
                sort_order=1,
            ),
        ]
    )

    response = await client.get("/api/tags")

    assert response.status_code == 200
    body = response.json()
    assert body[0] == {
        "id": 1,
        "name": "Internal",
        "color": "#6366f1",
        "all_sites": True,
        "site_ids": [],
        "team_ids": [],
        "sort_order": 0,
    }
    assert body[1]["all_sites"] is False
    assert body[1]["site_ids"] == [1]
    assert body[1]["team_ids"] == [7, 8]
    sql = _sql(mock_db_session)[0]
    # One flat list: tag order, then name (no group join any more).
    assert sql[sql.index("ORDER BY") :] == "ORDER BY tags.sort_order, tags.name"
    assert "tag_groups" not in sql


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("get", "/api/tag-groups", None),
        ("post", "/api/tag-groups", {"name": "Project type"}),
        ("put", "/api/tag-groups/reorder", {"group_order": [2, 1]}),
        ("put", "/api/tag-groups/1", {"name": "Renamed"}),
        ("delete", "/api/tag-groups/1", None),
    ],
)
async def test_tag_group_routes_are_gone(authed_client, mock_db_session, method, path, body):
    """/api/tag-groups was removed in 2.0.0 (tag groups became project fields)."""
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    kwargs = {"json": body} if body is not None else {}
    response = await client.request(method.upper(), path, **kwargs)

    assert response.status_code in (404, 405)
    mock_db_session.execute.assert_not_awaited()


# ---------------------------------------------------------
# Tag create / update / reorder
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_admin_creates_a_site_scoped_tag(authed_client, stamp_on_refresh):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = stamp_on_refresh
    db.execute.side_effect = [
        _scalar_result(None),  # name not taken
        _scalars_result([_site(1), _site(2)]),  # the sites
        _scalar_result(3),  # max sort_order
    ]

    response = await client.post(
        "/api/tags",
        json={
            "name": " Customer ",
            "color": "#0ea5e9",
            "all_sites": False,
            "site_ids": [2, 1, 2],
        },
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["name"] == "Customer"
    assert "group_id" not in body
    assert body["all_sites"] is False
    assert body["site_ids"] == [1, 2]
    assert body["sort_order"] == 4
    sql = _sql(db)
    # Appended after the last tag (one flat list).
    assert sql[2] == "SELECT max(tags.sort_order) AS max_1 \nFROM tags"
    db.commit.assert_awaited()


@pytest.mark.asyncio
async def test_all_sites_tag_clears_the_site_list(authed_client, stamp_on_refresh):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = stamp_on_refresh
    db.execute.side_effect = [
        _scalar_result(None),  # name not taken
        _scalar_result(None),  # no tag yet
    ]

    response = await client.post(
        "/api/tags", json={"name": "Critical", "all_sites": True, "site_ids": [1, 2]}
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["all_sites"] is True
    assert body["site_ids"] == []
    assert body["sort_order"] == 0
    assert "WHERE" not in _sql(db)[1]


@pytest.mark.asyncio
async def test_restricted_tag_needs_a_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [_scalar_result(None)]

    response = await client.post("/api/tags", json={"name": "Nowhere", "all_sites": False})

    assert response.status_code == 400
    assert isinstance(response.json()["detail"], str)


@pytest.mark.asyncio
async def test_unknown_site_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    mock_db_session.execute.side_effect = [_scalar_result(None), _scalars_result([_site(1)])]
    response = await client.post(
        "/api/tags", json={"name": "X", "all_sites": False, "site_ids": [1, 99]}
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Site not found"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path"),
    [("post", "/api/tags"), ("put", "/api/tags/1")],
)
async def test_a_group_id_is_refused(authed_client, mock_db_session, method, path):
    """Tag groups became project fields in 2.0.0: a stale client's group_id is a 422."""
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.request(method.upper(), path, json={"name": "X", "group_id": 5})

    assert response.status_code == 422
    assert "group_id" in response.text
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_duplicate_tag_name_is_still_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [_scalar_result(7)]

    response = await client.post("/api/tags", json={"name": "Critical"})

    assert response.status_code == 400
    assert response.json()["detail"] == "A tag with this name already exists"


@pytest.mark.asyncio
async def test_reorder_sets_sort_order_to_the_index(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    first, second = _tag(1, "A", sort_order=0), _tag(2, "B", sort_order=1)
    mock_db_session.execute.return_value = _scalars_result([first, second])

    response = await client.put("/api/tags/reorder", json={"tag_order": [2, 1, 99]})

    assert response.status_code == 200
    assert (second.sort_order, first.sort_order) == (0, 1)
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_update_changes_only_the_given_fields(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, sort_order=4)
    mock_db_session.execute.side_effect = [_scalar_result(tag)]

    response = await client.put("/api/tags/1", json={"color": "#123456"})

    assert response.status_code == 200, response.text
    assert tag.color == "#123456"
    assert tag.sort_order == 4  # the tag keeps its place
    assert "group_id" not in response.json()


@pytest.mark.asyncio
async def test_update_to_all_sites_clears_site_ids(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, all_sites=False, sites=[_site(1)])
    mock_db_session.execute.side_effect = [_scalar_result(tag)]

    response = await client.put("/api/tags/1", json={"all_sites": True, "site_ids": [1, 2]})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["all_sites"] is True
    assert body["site_ids"] == []
    assert mock_db_session.execute.await_count == 1  # no site lookup, no 409 count


@pytest.mark.asyncio
async def test_widening_the_site_list_needs_no_usage_check(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, all_sites=False, sites=[_site(1)])
    mock_db_session.execute.side_effect = [
        _scalar_result(tag),
        _scalars_result([_site(1), _site(2)]),
    ]

    response = await client.put("/api/tags/1", json={"site_ids": [1, 2]})

    assert response.status_code == 200, response.text
    assert response.json()["site_ids"] == [1, 2]
    assert mock_db_session.execute.await_count == 2


# ---------------------------------------------------------
# 409 conflicts (string detail with the count)
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_restricting_a_tag_used_at_other_sites_is_a_409(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, all_sites=True)
    mock_db_session.execute.side_effect = [
        _scalar_result(tag),
        _scalars_result([_site(1)]),
        _scalar_result(3),
    ]

    response = await client.put("/api/tags/1", json={"all_sites": False, "site_ids": [1]})

    assert response.status_code == 409
    assert response.json()["detail"] == "3 projects at other sites use this tag"
    assert tag.all_sites is True
    count_sql = _sql(mock_db_session)[2]
    # Site-less projects count as "elsewhere" too.
    assert "projects.site_id IS NULL OR (projects.site_id NOT IN (1))" in count_sql
    assert "project_tags.tag_id = 1" in count_sql


@pytest.mark.asyncio
async def test_shrinking_the_site_list_is_a_409_with_a_singular_detail(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, all_sites=False, sites=[_site(1), _site(2)])
    mock_db_session.execute.side_effect = [
        _scalar_result(tag),
        _scalars_result([_site(1)]),
        _scalar_result(1),
    ]

    response = await client.put("/api/tags/1", json={"site_ids": [1]})

    assert response.status_code == 409
    assert response.json()["detail"] == "1 project at another site uses this tag"


# ---------------------------------------------------------
# Team scoping (no team at a site = the whole site)
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_create_links_the_tag_to_teams_at_its_sites(authed_client, stamp_on_refresh):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = stamp_on_refresh
    db.execute.side_effect = [
        _scalar_result(None),  # name not taken
        _scalars_result([_site(1), _site(2)]),  # the sites
        _scalars_result([_team(7, 1)]),  # the teams
        _scalar_result(None),  # no tag yet
    ]

    response = await client.post(
        "/api/tags", json={"name": "GMP", "site_ids": [1, 2], "team_ids": [7]}
    )

    assert response.status_code == 201, response.text
    assert response.json()["team_ids"] == [7]
    (tag,) = (c.args[0] for c in db.add.call_args_list)
    assert [t.id for t in tag.teams] == [7]
    assert "teams.id IN (7)" in _sql(db)[2]


@pytest.mark.asyncio
async def test_create_with_a_team_outside_the_tag_sites_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [
        _scalar_result(None),  # name not taken
        _scalars_result([_site(1)]),  # the sites
        _scalars_result([_team(9, 2, "Formulation")]),  # a team at site 2
    ]

    response = await client.post(
        "/api/tags", json={"name": "GMP", "site_ids": [1], "team_ids": [9]}
    )

    assert response.status_code == 400
    assert response.json()["detail"] == team_outside_sites_detail("Formulation")
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_an_all_sites_tag_may_carry_teams_of_any_site(authed_client, stamp_on_refresh):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = stamp_on_refresh
    db.execute.side_effect = [
        _scalar_result(None),  # name not taken
        _scalars_result([_team(7, 1), _team(9, 2, "Formulation")]),  # the teams
        _scalar_result(None),  # no tag yet
    ]

    response = await client.post("/api/tags", json={"name": "Lab", "team_ids": [7, 9]})

    assert response.status_code == 201, response.text
    body = response.json()
    assert (body["all_sites"], body["team_ids"]) == (True, [7, 9])


@pytest.mark.asyncio
async def test_create_with_an_unknown_team_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [
        _scalar_result(None),  # name not taken
        _scalars_result([]),  # no such team
    ]

    response = await client.post("/api/tags", json={"name": "Lab", "team_ids": [99]})

    assert response.status_code == 404
    assert response.json()["detail"] == TEAM_NOT_FOUND_DETAIL


@pytest.mark.asyncio
async def test_restricting_a_tag_to_teams_used_by_other_projects_is_a_409(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, all_sites=False, sites=[_site(1)])
    mock_db_session.execute.side_effect = [
        _scalar_result(tag),
        _scalars_result([_team(7, 1)]),  # the teams
        _scalar_result(2),  # projects at site 1 outside team 7 use the tag
    ]

    response = await client.put("/api/tags/1", json={"team_ids": [7]})

    assert response.status_code == 409
    assert response.json()["detail"] == other_teams_conflict_detail(2)
    assert tag.teams == []  # nothing applied
    mock_db_session.commit.assert_not_awaited()
    count_sql = _sql(mock_db_session)[2]
    assert "project_tags.tag_id = 1" in count_sql
    assert "projects.site_id IN (1)" in count_sql
    assert "project_teams.team_id IN (7)" in count_sql


@pytest.mark.asyncio
async def test_update_replaces_the_teams_when_no_project_is_left_out(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, all_sites=False, sites=[_site(1)], teams=[_team(8)])
    mock_db_session.execute.side_effect = [
        _scalar_result(tag),
        _scalars_result([_team(7, 1)]),
        _scalar_result(0),
    ]

    response = await client.put("/api/tags/1", json={"team_ids": [7]})

    assert response.status_code == 200, response.text
    assert response.json()["team_ids"] == [7]
    assert tag.team_ids == [7]


@pytest.mark.asyncio
async def test_clearing_or_resending_the_teams_needs_no_usage_check(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    tag = _tag(1, all_sites=False, sites=[_site(1)], teams=[_team(7)])
    mock_db_session.execute.side_effect = [_scalar_result(tag)]
    response = await client.put("/api/tags/1", json={"team_ids": []})
    assert response.status_code == 200, response.text
    assert response.json()["team_ids"] == []
    assert mock_db_session.execute.await_count == 1

    mock_db_session.execute.reset_mock()
    tag = _tag(1, all_sites=False, sites=[_site(1)], teams=[_team(7)])
    mock_db_session.execute.side_effect = [_scalar_result(tag), _scalars_result([_team(7)])]
    response = await client.put("/api/tags/1", json={"team_ids": [7]})
    assert response.status_code == 200, response.text
    assert mock_db_session.execute.await_count == 2  # tag + teams, no 409 count


@pytest.mark.asyncio
async def test_update_with_a_team_outside_the_tag_sites_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, all_sites=False, sites=[_site(1), _site(2)])
    mock_db_session.execute.side_effect = [
        _scalar_result(tag),
        _scalars_result([_site(1)]),  # narrowed to site 1
        _scalar_result(0),  # no project at site 2 uses the tag
        _scalars_result([_team(9, 2, "Formulation")]),  # a team at site 2
    ]

    response = await client.put("/api/tags/1", json={"site_ids": [1], "team_ids": [9]})

    assert response.status_code == 400
    assert response.json()["detail"] == team_outside_sites_detail("Formulation")
    assert tag.site_ids == [1, 2]  # nothing applied
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_narrowing_the_sites_prunes_their_teams_without_a_query(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(
        1,
        all_sites=False,
        sites=[_site(1), _site(2)],
        teams=[_team(7, 1), _team(9, 2, "Formulation")],
    )
    mock_db_session.execute.side_effect = [
        _scalar_result(tag),
        _scalars_result([_site(1)]),
        _scalar_result(0),  # no project at site 2 uses the tag
    ]

    response = await client.put("/api/tags/1", json={"site_ids": [1]})

    assert response.status_code == 200, response.text
    assert response.json()["team_ids"] == [7]
    assert mock_db_session.execute.await_count == 3


@pytest.mark.asyncio
async def test_a_tag_made_global_keeps_its_teams(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, all_sites=False, sites=[_site(1)], teams=[_team(7, 1)])
    mock_db_session.execute.side_effect = [_scalar_result(tag)]

    response = await client.put("/api/tags/1", json={"all_sites": True})

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["all_sites"], body["site_ids"], body["team_ids"]) == (True, [], [7])


# ---------------------------------------------------------
# Site delete removes orphaned restricted tags
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_site_delete_removes_restricted_tags_left_without_a_site(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    site = _site(1)
    mock_db_session.execute.side_effect = [
        _scalar_result(site),
        _scalars_result([]),  # events
        _scalars_result([]),  # equipment
        _scalars_result([]),  # projects
        _scalars_result([9, 10]),  # tags linked to the site
        MagicMock(),  # delete orphaned restricted tags
    ]

    response = await client.delete("/api/sites/1")

    assert response.status_code == 200, response.text
    sql = _sql(mock_db_session)
    assert "FROM tag_sites" in sql[4] and "tag_sites.site_id = 1" in sql[4]
    assert sql[5].startswith("DELETE FROM tags ")
    assert "tags.id IN (9, 10)" in sql[5]
    assert "tags.all_sites IS false" in sql[5]
    assert "NOT (EXISTS" in sql[5] and "tag_sites.tag_id = tags.id" in sql[5]
    # The site row goes first so its tag_sites links are gone (FK cascade).
    mock_db_session.delete.assert_awaited_once_with(site)


# ---------------------------------------------------------
# Site export
# ---------------------------------------------------------


def _export_db(captured: list):
    site = _site(1, "Basel")
    tag = _tag(3, "Customer", all_sites=False, sites=[_site(1, "Basel"), _site(2, "Bern")])
    plain = _tag(6, "Critical")
    project = Project(id=11, name="Bioprocess", site_id=1, confirmed=1, archived=0)
    project.tags = [tag]
    rows = {Site: [site], Tag: [tag, plain], Project: [project]}

    async def execute(stmt, *args, **kwargs):
        entity = stmt.column_descriptions[0].get("entity")
        captured.append((entity, stmt))
        found = rows.get(entity, [])
        result = MagicMock()
        result.scalar_one_or_none.return_value = found[0] if found else None
        result.scalars.return_value.all.return_value = list(found)
        result.__iter__.return_value = iter([])
        return result

    db = MagicMock()
    db.execute = execute
    return db


@pytest.mark.asyncio
async def test_site_export_tag_sheets():
    captured: list = []
    with patch.dict(sys.modules, _fake_openpyxl()):
        await build_site_export_workbook(_export_db(captured), 1)

    sheets = _FakeWorkbook.sheets
    tags = sheets["Tags"].rows
    assert tags[0] == [
        "ID",
        "Name",
        "Color",
        "All sites",
        "Sites",
        "Sort order",
        "Teams",
        "Created at",
    ]
    assert tags[1][:7] == [3, "Customer", "#6366f1", False, "Basel, Bern", 0, ""]
    assert tags[2][3:5] == [True, ""]

    # Tag groups became project fields in 2.0.0: no sheet, no Group column.
    assert "Tag groups" not in sheets

    project_tags = sheets["Project tags"].rows
    assert project_tags[0] == ["Project ID", "Project name", "Tag ID", "Tag name", "Tag color"]
    assert project_tags[1] == [11, "Bioprocess", 3, "Customer", "#6366f1"]

    # Only tags applicable to the exported site.
    tag_stmt = next(stmt for entity, stmt in captured if entity is Tag)
    tag_sql = str(tag_stmt.compile(compile_kwargs={"literal_binds": True}))
    assert "tags.all_sites IS true" in tag_sql
    assert "tag_sites.site_id = 1" in tag_sql


# ---------------------------------------------------------
# Models, schema sources, broadcast mapping
# ---------------------------------------------------------


def test_tag_model_has_no_group():
    assert "tag_groups" not in Base.metadata.tables
    assert "tag_sites" in Base.metadata.tables
    tags = Base.metadata.tables["tags"]
    assert {"all_sites", "sort_order"} <= set(tags.c.keys())
    assert "group_id" not in tags.c
    assert {i.name for i in tags.indexes} == set()  # idx_tags_group is gone
    assert {fk.ondelete for col in TagSite.__table__.c for fk in col.foreign_keys} == {"CASCADE"}


def _schema_sources() -> list[tuple[str, str]]:
    sources = [("provisioner", get_tenant_schema_sql())]
    for relative in ("setup_databases.sql", "scripts/sql/tenant_schema_template.sql"):
        path = ROOT / relative
        if path.exists():
            sources.append((relative, path.read_text()))
    return sources


@pytest.mark.parametrize(("label", "sql"), _schema_sources(), ids=lambda v: str(v)[:30])
def test_every_schema_source_has_tag_sites_and_no_tag_groups(label, sql):
    norm = re.sub(r"\s+", " ", sql)
    assert re.search(r"CREATE TABLE (IF NOT EXISTS )?tag_sites \(", norm), label
    # 2.0.0: tag groups are project fields; no fresh source creates them.
    assert not re.search(r"CREATE TABLE (IF NOT EXISTS )?tag_groups \(", norm), label
    tags_create = re.search(r"CREATE TABLE (?:IF NOT EXISTS )?tags \((.*?)\);", norm)
    assert tags_create, label
    sites_at = re.search(r"CREATE TABLE (?:IF NOT EXISTS )?tag_sites \(", norm).start()
    assert tags_create.start() < sites_at, label
    tags_block = tags_create.group(1)
    assert "group_id" not in tags_block
    assert "all_sites BOOLEAN NOT NULL DEFAULT TRUE" in tags_block
    assert "sort_order INTEGER NOT NULL DEFAULT 0" in tags_block
    assert "colors_projects" not in norm, label
    assert "idx_tags_group" not in norm, label
    assert "idx_tag_sites_site ON tag_sites(site_id)" in norm


@pytest.mark.parametrize(
    ("relative", "columns"),
    [
        ("setup_databases.sql", ("all_sites", "sort_order")),
        ("migrations/add_tag_groups_and_sites.sql", ("group_id", "all_sites", "sort_order")),
    ],
)
def test_upgrade_sources_add_the_tag_columns_in_guarded_blocks(relative, columns):
    path = ROOT / relative
    if not path.exists():
        pytest.skip(f"{relative} is not part of this checkout")
    sql = path.read_text()
    blocks = re.findall(r"DO \$\$(.*?)END \$\$;", sql, flags=re.S)
    for column in columns:
        guarded = [b for b in blocks if re.search(rf"ALTER TABLE tags ADD COLUMN {column}\b", b)]
        assert guarded, column
        assert all("information_schema.columns" in b for b in guarded), column
    if "group_id" not in columns:
        # A fresh install has no tag_groups for group_id to reference.
        assert "ADD COLUMN group_id" not in sql


def test_migration_file_exists_and_is_listed():
    migration = ROOT / "migrations" / "add_tag_groups_and_sites.sql"
    assert migration.exists()
    sql = migration.read_text()
    assert "CREATE TABLE IF NOT EXISTS tag_groups" in sql
    assert "CREATE TABLE IF NOT EXISTS tag_sites" in sql
    assert sql.index("tag_groups (") < sql.index("ADD COLUMN group_id")
    readme = ROOT / "migrations" / "README.md"
    if readme.exists():
        text = readme.read_text()
        assert "`add_tag_groups_and_sites`" in text
        # Since 2.0.0 the groups are converted by add_project_fields.
        assert "`add_project_fields`" in text


@pytest.mark.parametrize(
    "path", ["/api/tag-groups", "/api/tag-groups/reorder", "/api/tag-groups/3"]
)
def test_tag_group_paths_no_longer_broadcast(path):
    assert _resolve_entity_type(path) is None


def test_tag_paths_still_broadcast_as_tag():
    assert _resolve_entity_type("/api/tags/reorder") == "tag"
    assert _resolve_entity_type("/api/tags/3") == "tag"
