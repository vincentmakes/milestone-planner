"""
Tag groups, site-scoped tags and admin-only tag management.

- Every tag / tag-group write is admin-only (superusers are refused like plain
  users); every authenticated user can read both lists.
- POST/PUT /tags: group + site scoping (all_sites=true clears the site list),
  404 for unknown group/site ids, append ordering, reorder.
- The three 409s that protect existing project data carry their count in a
  plain-string detail (the frontend renders `detail` as text).
- colors_projects requires single_select on the merged state and is exclusive:
  the previous colouring group is cleared and flushed BEFORE the new one is set
  (partial unique index).
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
from app.models.tag import Tag, TagGroup, TagSite
from app.routers.export import build_site_export_workbook
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
        group_id=kwargs.get("group_id"),
        all_sites=kwargs.get("all_sites", True),
        sort_order=kwargs.get("sort_order", 0),
        sites=kwargs.get("sites", []),
        created_at=STAMP,
        updated_at=STAMP,
    )


def _group(group_id: int = 5, name: str = "Project type", **kwargs) -> TagGroup:
    return TagGroup(
        id=group_id,
        name=name,
        single_select=kwargs.get("single_select", False),
        colors_projects=kwargs.get("colors_projects", False),
        sort_order=kwargs.get("sort_order", 0),
        created_at=STAMP,
        updated_at=STAMP,
    )


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
        ("post", "/api/tag-groups", {"name": "Project type"}),
        ("put", "/api/tag-groups/reorder", {"group_order": [2, 1]}),
        ("put", "/api/tag-groups/1", {"name": "Renamed"}),
        ("delete", "/api/tag-groups/1", None),
    ],
)
async def test_tag_and_group_writes_are_admin_only(authed_client, role, method, path, body):
    client, set_user = authed_client
    set_user(FakeUser(1, role))

    kwargs = {"json": body} if body is not None else {}
    response = await client.request(method.upper(), path, **kwargs)

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_any_user_lists_tags_grouped_then_ungrouped(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = _scalars_result(
        [
            _tag(1, "Internal", group_id=5, sort_order=0),
            _tag(2, "Basel only", all_sites=False, sites=[_site(1)], sort_order=1),
        ]
    )

    response = await client.get("/api/tags")

    assert response.status_code == 200
    body = response.json()
    assert body[0] == {
        "id": 1,
        "name": "Internal",
        "color": "#6366f1",
        "group_id": 5,
        "all_sites": True,
        "site_ids": [],
        "sort_order": 0,
    }
    assert body[1]["all_sites"] is False
    assert body[1]["site_ids"] == [1]
    sql = _sql(mock_db_session)[0]
    order_by = sql[sql.index("ORDER BY") :]
    # Group order first with ungrouped tags last, then tag order, then name.
    assert "tag_groups.sort_order ASC NULLS LAST" in order_by
    assert order_by.index("tag_groups.sort_order") < order_by.index("tags.sort_order")
    assert order_by.index("tags.sort_order") < order_by.index("tags.name")


@pytest.mark.asyncio
async def test_any_user_lists_tag_groups(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = _scalars_result(
        [_group(5, single_select=True, colors_projects=True)]
    )

    response = await client.get("/api/tag-groups")

    assert response.status_code == 200
    body = response.json()
    assert body[0]["name"] == "Project type"
    assert body[0]["single_select"] is True
    assert body[0]["colors_projects"] is True
    assert set(body[0]) == {
        "id",
        "name",
        "single_select",
        "colors_projects",
        "sort_order",
        "created_at",
        "updated_at",
    }


# ---------------------------------------------------------
# Tag create / update / reorder
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_admin_creates_a_site_scoped_tag_in_a_group(authed_client, stamp_on_refresh):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = stamp_on_refresh
    db.execute.side_effect = [
        _scalar_result(None),  # name not taken
        _scalar_result(_group(5)),  # the group
        _scalars_result([_site(1), _site(2)]),  # the sites
        _scalar_result(3),  # max sort_order within the group
    ]

    response = await client.post(
        "/api/tags",
        json={
            "name": " Customer ",
            "color": "#0ea5e9",
            "group_id": 5,
            "all_sites": False,
            "site_ids": [2, 1, 2],
        },
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["name"] == "Customer"
    assert body["group_id"] == 5
    assert body["all_sites"] is False
    assert body["site_ids"] == [1, 2]
    assert body["sort_order"] == 4
    sql = _sql(db)
    assert "tags.group_id = 5" in sql[3]
    db.commit.assert_awaited()


@pytest.mark.asyncio
async def test_all_sites_tag_clears_the_site_list(authed_client, stamp_on_refresh):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = stamp_on_refresh
    db.execute.side_effect = [
        _scalar_result(None),  # name not taken
        _scalar_result(None),  # no ungrouped tag yet
    ]

    response = await client.post(
        "/api/tags", json={"name": "Critical", "all_sites": True, "site_ids": [1, 2]}
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["all_sites"] is True
    assert body["site_ids"] == []
    assert body["sort_order"] == 0
    assert "tags.group_id IS NULL" in _sql(db)[1]


@pytest.mark.asyncio
async def test_restricted_tag_needs_a_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [_scalar_result(None)]

    response = await client.post("/api/tags", json={"name": "Nowhere", "all_sites": False})

    assert response.status_code == 400
    assert isinstance(response.json()["detail"], str)


@pytest.mark.asyncio
async def test_unknown_group_or_site_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    mock_db_session.execute.side_effect = [_scalar_result(None), _scalar_result(None)]
    response = await client.post("/api/tags", json={"name": "X", "group_id": 99})
    assert response.status_code == 404
    assert response.json()["detail"] == "Tag group not found"

    mock_db_session.execute.side_effect = [_scalar_result(None), _scalars_result([_site(1)])]
    response = await client.post(
        "/api/tags", json={"name": "X", "all_sites": False, "site_ids": [1, 99]}
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Site not found"


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
async def test_group_reorder_sets_sort_order_to_the_index(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    first, second = _group(1, "A"), _group(2, "B", sort_order=1)
    mock_db_session.execute.return_value = _scalars_result([first, second])

    response = await client.put("/api/tag-groups/reorder", json={"group_order": [2, 1]})

    assert response.status_code == 200
    assert (second.sort_order, first.sort_order) == (0, 1)


@pytest.mark.asyncio
async def test_explicit_null_group_ungroups_the_tag(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, group_id=5, sort_order=0)
    mock_db_session.execute.side_effect = [
        _scalar_result(tag),
        _scalar_result(2),  # max sort_order of the ungrouped tags
    ]

    response = await client.put("/api/tags/1", json={"group_id": None})

    assert response.status_code == 200, response.text
    assert response.json()["group_id"] is None
    assert tag.sort_order == 3


@pytest.mark.asyncio
async def test_omitted_group_keeps_the_tag_in_its_group(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, group_id=5)
    mock_db_session.execute.side_effect = [_scalar_result(tag)]

    response = await client.put("/api/tags/1", json={"color": "#123456"})

    assert response.status_code == 200, response.text
    assert response.json()["group_id"] == 5
    assert tag.color == "#123456"


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
async def test_moving_a_tag_into_a_single_select_group_with_peers_is_a_409(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1)
    mock_db_session.execute.side_effect = [
        _scalar_result(tag),
        _scalar_result(_group(5, single_select=True)),
        _scalar_result(2),  # projects holding this tag + another of the group
    ]

    response = await client.put("/api/tags/1", json={"group_id": 5})

    assert response.status_code == 409
    assert response.json()["detail"] == "2 projects already have another tag from this group"
    assert tag.group_id is None  # nothing applied
    mock_db_session.commit.assert_not_awaited()
    count_sql = _sql(mock_db_session)[2]
    assert "project_tags_1.project_id = project_tags.project_id" in count_sql
    assert "tags_1.group_id = 5" in count_sql and "tags_1.id != 1" in count_sql


@pytest.mark.asyncio
async def test_moving_a_tag_into_a_multi_select_group_skips_the_check(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1)
    mock_db_session.execute.side_effect = [
        _scalar_result(tag),
        _scalar_result(_group(5, single_select=False)),
        _scalar_result(None),  # max sort_order in the group
    ]

    response = await client.put("/api/tags/1", json={"group_id": 5})

    assert response.status_code == 200, response.text
    assert tag.group_id == 5


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


@pytest.mark.asyncio
async def test_making_a_group_single_select_with_conflicts_is_a_409(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    group = _group(5, single_select=False)
    mock_db_session.execute.side_effect = [_scalar_result(group), _scalar_result(4)]

    response = await client.put("/api/tag-groups/5", json={"single_select": True})

    assert response.status_code == 409
    assert response.json()["detail"] == "4 projects have more than one tag from this group"
    assert group.single_select is False
    count_sql = _sql(mock_db_session)[1]
    assert "tags.group_id = 5" in count_sql
    assert "HAVING count(*) > 1" in count_sql


@pytest.mark.asyncio
async def test_making_a_group_single_select_without_conflicts(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    group = _group(5, single_select=False)
    mock_db_session.execute.side_effect = [_scalar_result(group), _scalar_result(0)]

    response = await client.put("/api/tag-groups/5", json={"single_select": True})

    assert response.status_code == 200, response.text
    assert response.json()["single_select"] is True


# ---------------------------------------------------------
# colors_projects: requires single_select, exclusive
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_coloring_group_must_be_single_select_on_create(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [_scalar_result(None)]

    response = await client.post(
        "/api/tag-groups", json={"name": "Type", "single_select": False, "colors_projects": True}
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "A group that colours projects must be single-select"


@pytest.mark.asyncio
async def test_coloring_group_must_stay_single_select_on_the_merged_state(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    group = _group(5, single_select=True, colors_projects=True)
    mock_db_session.execute.side_effect = [_scalar_result(group)]

    response = await client.put("/api/tag-groups/5", json={"single_select": False})

    assert response.status_code == 400
    assert response.json()["detail"] == "A group that colours projects must be single-select"


@pytest.mark.asyncio
async def test_both_flags_can_be_cleared_in_one_request(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    group = _group(5, single_select=True, colors_projects=True)
    mock_db_session.execute.side_effect = [_scalar_result(group)]

    response = await client.put(
        "/api/tag-groups/5", json={"single_select": False, "colors_projects": False}
    )

    assert response.status_code == 200, response.text
    assert (group.single_select, group.colors_projects) == (False, False)


@pytest.mark.asyncio
async def test_new_coloring_group_clears_the_previous_one_first(authed_client, stamp_on_refresh):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = stamp_on_refresh
    order: list[str] = []
    db.flush.side_effect = lambda: order.append("flush")
    db.add.side_effect = lambda obj: order.append("add")
    db.execute.side_effect = [
        _scalar_result(None),  # name not taken
        MagicMock(),  # clear the previous colouring group
        _scalar_result(1),  # max sort_order
    ]

    response = await client.post(
        "/api/tag-groups",
        json={"name": "Project type", "single_select": True, "colors_projects": True},
    )

    assert response.status_code == 201, response.text
    assert response.json()["colors_projects"] is True
    assert response.json()["sort_order"] == 2
    assert order == ["flush", "add"]
    clear_sql = _sql(db)[1]
    assert clear_sql.startswith("UPDATE tag_groups SET colors_projects=false")
    assert "tag_groups.colors_projects IS true" in clear_sql


@pytest.mark.asyncio
async def test_existing_group_becomes_the_coloring_one_after_the_flush(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    group = _group(5, single_select=True, colors_projects=False)
    seen_at_flush: list[bool] = []
    mock_db_session.flush.side_effect = lambda: seen_at_flush.append(group.colors_projects)
    mock_db_session.execute.side_effect = [_scalar_result(group), MagicMock()]

    response = await client.put("/api/tag-groups/5", json={"colors_projects": True})

    assert response.status_code == 200, response.text
    assert seen_at_flush == [False]  # flushed before this group was flagged
    assert group.colors_projects is True
    clear_sql = _sql(mock_db_session)[1]
    assert "tag_groups.id != 5" in clear_sql


@pytest.mark.asyncio
async def test_group_delete_ungroups_its_tags(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    group = _group(3)
    # The ungrouped pool already holds sort orders 0 and 1; the group's tags
    # (0 and 1 inside the group) must not collide with them once ungrouped.
    loose_a, loose_b = _tag(1, "Loose A", sort_order=0), _tag(2, "Loose B", sort_order=1)
    member_a = _tag(3, "Member A", group_id=3, sort_order=0)
    member_b = _tag(4, "Member B", group_id=3, sort_order=1)
    mock_db_session.execute.side_effect = [
        _scalar_result(group),
        _scalars_result([loose_a, loose_b]),  # already ungrouped, in display order
        _scalars_result([member_a, member_b]),  # the group's tags, in display order
    ]

    response = await client.delete("/api/tag-groups/3")

    assert response.status_code == 200
    sql = _sql(mock_db_session)
    assert "tags.group_id IS NULL" in sql[1]
    assert "tags.group_id = 3" in sql[2]
    for statement in sql[1:]:
        assert "ORDER BY tags.sort_order, tags.name, tags.id" in statement
    assert member_a.group_id is None and member_b.group_id is None
    # Existing ungrouped first (current order), then the newly ungrouped.
    assert [t.sort_order for t in (loose_a, loose_b, member_a, member_b)] == [0, 1, 2, 3]
    mock_db_session.delete.assert_awaited_once_with(group)
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_duplicate_group_name_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [_scalar_result(2)]

    response = await client.post("/api/tag-groups", json={"name": "Project type"})

    assert response.status_code == 400
    assert response.json()["detail"] == "A tag group with this name already exists"


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
    group = _group(4, single_select=True, colors_projects=True)
    tag = _tag(
        3, "Customer", group_id=4, all_sites=False, sites=[_site(1, "Basel"), _site(2, "Bern")]
    )
    plain = _tag(6, "Critical")
    project = Project(id=11, name="Bioprocess", site_id=1, confirmed=1, archived=0)
    project.tags = [tag]
    rows = {Site: [site], Tag: [tag, plain], TagGroup: [group], Project: [project]}

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
        "Group",
        "All sites",
        "Sites",
        "Sort order",
        "Created at",
    ]
    assert tags[1][:7] == [3, "Customer", "#6366f1", "Project type", False, "Basel, Bern", 0]
    assert tags[2][3:6] == ["", True, ""]

    groups = sheets["Tag groups"].rows
    assert groups[0] == ["ID", "Name", "Single select", "Colours projects", "Sort order"]
    assert groups[1] == [4, "Project type", True, True, 0]

    project_tags = sheets["Project tags"].rows
    assert project_tags[0][-1] == "Group"
    assert project_tags[1] == [11, "Bioprocess", 3, "Customer", "#6366f1", "Project type"]

    # Only tags applicable to the exported site.
    tag_stmt = next(stmt for entity, stmt in captured if entity is Tag)
    tag_sql = str(tag_stmt.compile(compile_kwargs={"literal_binds": True}))
    assert "tags.all_sites IS true" in tag_sql
    assert "tag_sites.site_id = 1" in tag_sql


# ---------------------------------------------------------
# Models, schema sources, broadcast mapping
# ---------------------------------------------------------


def test_new_models_live_on_the_tenant_base():
    for table in ("tag_groups", "tag_sites"):
        assert table in Base.metadata.tables
    tags = Base.metadata.tables["tags"]
    assert {"group_id", "all_sites", "sort_order"} <= set(tags.c.keys())
    (fk,) = tags.c.group_id.foreign_keys
    assert fk.ondelete == "SET NULL"
    assert {fk.ondelete for col in TagSite.__table__.c for fk in col.foreign_keys} == {"CASCADE"}


def _schema_sources() -> list[tuple[str, str]]:
    sources = [("provisioner", get_tenant_schema_sql())]
    for relative in ("setup_databases.sql", "scripts/sql/tenant_schema_template.sql"):
        path = ROOT / relative
        if path.exists():
            sources.append((relative, path.read_text()))
    return sources


@pytest.mark.parametrize(("label", "sql"), _schema_sources(), ids=lambda v: str(v)[:30])
def test_every_schema_source_has_tag_groups_and_sites(label, sql):
    norm = re.sub(r"\s+", " ", sql)
    for table in ("tag_groups", "tag_sites"):
        assert re.search(rf"CREATE TABLE (IF NOT EXISTS )?{table} \(", norm), (label, table)
    # tag_groups before tags (group_id references it), tag_sites after tags.
    tags_create = re.search(r"CREATE TABLE (?:IF NOT EXISTS )?tags \((.*?)\);", norm)
    assert tags_create, label
    groups_at = re.search(r"CREATE TABLE (?:IF NOT EXISTS )?tag_groups \(", norm).start()
    sites_at = re.search(r"CREATE TABLE (?:IF NOT EXISTS )?tag_sites \(", norm).start()
    assert groups_at < tags_create.start() < sites_at, label
    tags_block = tags_create.group(1)
    assert "group_id INTEGER REFERENCES tag_groups(id) ON DELETE SET NULL" in tags_block
    assert "all_sites BOOLEAN NOT NULL DEFAULT TRUE" in tags_block
    assert "sort_order INTEGER NOT NULL DEFAULT 0" in tags_block
    assert "idx_tag_groups_colors_projects ON tag_groups ((true)) WHERE colors_projects" in norm
    assert "idx_tag_sites_site ON tag_sites(site_id)" in norm


@pytest.mark.parametrize(
    "relative", ["setup_databases.sql", "migrations/add_tag_groups_and_sites.sql"]
)
def test_upgrade_sources_add_the_tag_columns_in_guarded_blocks(relative):
    path = ROOT / relative
    if not path.exists():
        pytest.skip(f"{relative} is not part of this checkout")
    sql = path.read_text()
    blocks = re.findall(r"DO \$\$(.*?)END \$\$;", sql, flags=re.S)
    for column in ("group_id", "all_sites", "sort_order"):
        guarded = [b for b in blocks if re.search(rf"ALTER TABLE tags ADD COLUMN {column}\b", b)]
        assert guarded, column
        assert all("information_schema.columns" in b for b in guarded), column


def test_migration_file_exists_and_is_listed():
    migration = ROOT / "migrations" / "add_tag_groups_and_sites.sql"
    assert migration.exists()
    sql = migration.read_text()
    assert "CREATE TABLE IF NOT EXISTS tag_groups" in sql
    assert "CREATE TABLE IF NOT EXISTS tag_sites" in sql
    assert sql.index("tag_groups (") < sql.index("ADD COLUMN group_id")
    readme = ROOT / "migrations" / "README.md"
    if readme.exists():
        assert "`add_tag_groups_and_sites`" in readme.read_text()


@pytest.mark.parametrize(
    "path", ["/api/tag-groups", "/api/tag-groups/reorder", "/api/tag-groups/3"]
)
def test_tag_group_writes_broadcast_as_tag_group(path):
    assert _resolve_entity_type(path) == "tag_group"


def test_tag_paths_still_broadcast_as_tag():
    assert _resolve_entity_type("/api/tags/reorder") == "tag"
    assert _resolve_entity_type("/api/tags/3") == "tag"
