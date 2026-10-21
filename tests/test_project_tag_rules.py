"""
Project-tag rules (app/services/tag_rules.py) and their use by the project routes.

- A tag restricted to some sites is only applicable to projects at one of them;
  a project without a site may only carry tags available at every site.
- A single-select group allows one of its tags per project.
- Unknown tag ids are dropped silently (What-If replay of a deleted tag).
- POST /projects checks against the body's site_id, PUT /projects/{id} against
  the project's own site from the DB; both answer 400 with a string detail.
- Project responses embed tags as {id, name, color, group_id}.
"""

from datetime import date, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.models.site import Site
from app.models.tag import Tag, TagGroup
from app.services.tag_rules import (
    count_projects_outside_sites,
    count_projects_with_group_peer,
    count_projects_with_multiple_group_tags,
    validate_project_tags,
)
from tests.conftest import FakeUser

STAMP = datetime(2026, 1, 1, 12, 0, 0)

SINGLE = TagGroup(id=5, name="Project type", single_select=True)
MULTI = TagGroup(id=6, name="Topics", single_select=False)


def _tag(tag_id: int, name: str, group: TagGroup | None = None, site_ids=None) -> Tag:
    tag = Tag(
        id=tag_id,
        name=name,
        color="#6366f1",
        group_id=group.id if group else None,
        all_sites=site_ids is None,
        sort_order=0,
        sites=[Site(id=sid, name=f"Site {sid}") for sid in (site_ids or [])],
    )
    tag.group = group
    return tag


def _scalar_result(value):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    result.scalar.return_value = value
    return result


def _scalars_result(values):
    result = MagicMock()
    result.scalars.return_value.all.return_value = values
    return result


def _db(*results):
    db = MagicMock()
    db.execute = AsyncMock(side_effect=list(results))
    return db


def _sql(db) -> list[str]:
    return [
        str(call.args[0].compile(compile_kwargs={"literal_binds": True}))
        for call in db.execute.await_args_list
    ]


# ---------------------------------------------------------
# validate_project_tags
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_no_tags_needs_no_query():
    db = _db()
    assert await validate_project_tags(db, 1, []) == []
    db.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_two_tags_of_a_single_select_group_are_a_400():
    db = _db(_scalars_result([_tag(1, "Internal", SINGLE), _tag(2, "Customer", SINGLE)]))

    with pytest.raises(HTTPException) as exc:
        await validate_project_tags(db, 1, [1, 2])

    assert exc.value.status_code == 400
    assert exc.value.detail == (
        'Only one tag from the group "Project type" can be assigned to a project'
    )


@pytest.mark.asyncio
async def test_two_tags_of_a_multi_select_group_are_fine():
    tags = [_tag(1, "A", MULTI), _tag(2, "B", MULTI), _tag(3, "Internal", SINGLE)]
    db = _db(_scalars_result(tags))

    assert await validate_project_tags(db, 1, [1, 2, 3]) == tags


@pytest.mark.asyncio
async def test_tag_restricted_to_another_site_is_a_400():
    db = _db(_scalars_result([_tag(1, "Basel only", site_ids=[2, 3])]))

    with pytest.raises(HTTPException) as exc:
        await validate_project_tags(db, 1, [1])

    assert exc.value.status_code == 400
    assert exc.value.detail == 'The tag "Basel only" is not available at this project\'s site'


@pytest.mark.asyncio
async def test_tag_restricted_to_the_project_site_is_fine():
    tag = _tag(1, "Basel only", site_ids=[1, 3])
    db = _db(_scalars_result([tag]))

    assert await validate_project_tags(db, 3, [1]) == [tag]


@pytest.mark.asyncio
async def test_site_less_project_only_takes_all_sites_tags():
    db = _db(_scalars_result([_tag(1, "Basel only", site_ids=[1])]))
    with pytest.raises(HTTPException) as exc:
        await validate_project_tags(db, None, [1])
    assert exc.value.status_code == 400

    everywhere = _tag(2, "Critical")
    db = _db(_scalars_result([everywhere]))
    assert await validate_project_tags(db, None, [2]) == [everywhere]


@pytest.mark.asyncio
async def test_unknown_tag_ids_are_dropped_silently():
    known = _tag(1, "Critical")
    db = _db(_scalars_result([known]))

    assert await validate_project_tags(db, 1, [1, 404, 1]) == [known]
    assert "tags.id IN (1, 404)" in _sql(db)[0]


# ---------------------------------------------------------
# Count helpers behind the 409s
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_count_helpers_return_ints():
    db = _db(_scalar_result(2), _scalar_result(None), _scalar_result(5))

    assert await count_projects_with_multiple_group_tags(db, 5) == 2
    assert await count_projects_with_group_peer(db, 1, 5) == 0
    assert await count_projects_outside_sites(db, 1, []) == 5

    multiple, peer, outside = (" ".join(sql.split()) for sql in _sql(db))
    assert "GROUP BY project_tags.project_id HAVING count(*) > 1" in multiple
    assert "count(distinct(project_tags.project_id))" in peer
    # No allowed site: only the site-less projects are "outside" -- never NOT IN ().
    assert "projects.site_id IS NULL" in outside
    assert "NOT IN" not in outside


# ---------------------------------------------------------
# Project routes
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_create_project_rejects_two_single_select_tags(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [
        _scalar_result(1),  # the site exists
        _scalars_result([_tag(1, "Internal", SINGLE), _tag(2, "Customer", SINGLE)]),
    ]

    response = await client.post(
        "/api/projects",
        json={
            "name": "New",
            "site_id": 1,
            "start_date": "2026-01-05",
            "end_date": "2026-02-05",
            "tag_ids": [1, 2],
        },
    )

    assert response.status_code == 400
    assert isinstance(response.json()["detail"], str)
    assert "Project type" in response.json()["detail"]
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_create_project_checks_tags_against_the_body_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [
        _scalar_result(1),
        _scalars_result([_tag(1, "Bern only", site_ids=[2])]),
    ]

    response = await client.post(
        "/api/projects",
        json={
            "name": "New",
            "site_id": 1,
            "start_date": "2026-01-05",
            "end_date": "2026-02-05",
            "tag_ids": [1],
        },
    )

    assert response.status_code == 400
    assert (
        response.json()["detail"] == 'The tag "Bern only" is not available at this project\'s site'
    )


@pytest.mark.asyncio
async def test_create_site_less_project_with_a_restricted_tag_is_a_400(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    # Site-less projects are reachable with sites.view_all only (the admin).
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [_scalars_result([_tag(1, "Bern only", site_ids=[2])])]

    response = await client.post(
        "/api/projects",
        json={"name": "New", "start_date": "2026-01-05", "end_date": "2026-02-05", "tag_ids": [1]},
    )

    assert response.status_code == 400


def _project(site_id):
    project = MagicMock()
    project.id = 1
    project.name = "Bioprocess"
    project.pm_id = None
    project.site_id = site_id
    project.start_date = date(2026, 1, 5)
    project.end_date = date(2026, 2, 5)
    project.tags = []
    return project


@pytest.mark.asyncio
async def test_update_project_checks_tags_against_the_stored_site(authed_client, mock_db_session):
    client, set_user = authed_client
    # Site-less projects are reachable with sites.view_all only (the admin).
    set_user(FakeUser(1, "admin"))
    project = _project(site_id=None)
    mock_db_session.execute.side_effect = [
        _scalar_result(project),
        _scalars_result([_tag(1, "Basel only", site_ids=[1])]),
    ]

    response = await client.put("/api/projects/1", json={"tag_ids": [1]})

    assert response.status_code == 400
    assert project.tags == []
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_project_rejects_two_single_select_tags(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [
        _scalar_result(_project(site_id=1)),
        _scalars_result([_tag(1, "Internal", SINGLE), _tag(2, "Customer", SINGLE)]),
    ]

    response = await client.put("/api/projects/1", json={"tag_ids": [1, 2]})

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_update_project_with_valid_tags(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    project = _project(site_id=1)
    tags = [_tag(1, "Internal", SINGLE), _tag(2, "Basel only", MULTI, site_ids=[1])]
    mock_db_session.execute.side_effect = [_scalar_result(project), _scalars_result(tags)]

    with patch("app.routers.projects.broadcast_change", AsyncMock()):
        response = await client.put("/api/projects/1", json={"tag_ids": [1, 2]})

    assert response.status_code == 200, response.text
    assert project.tags == tags
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_update_project_clears_tags_without_a_query(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    project = _project(site_id=1)
    project.tags = [_tag(1, "Internal")]
    mock_db_session.execute.side_effect = [_scalar_result(project)]

    with patch("app.routers.projects.broadcast_change", AsyncMock()):
        response = await client.put("/api/projects/1", json={"tag_ids": []})

    assert response.status_code == 200, response.text
    assert project.tags == []


def test_project_responses_embed_the_tag_group():
    from app.routers.projects import _tag_dict
    from app.schemas.project import ProjectDetailResponse

    tag = _tag(3, "Customer", SINGLE)
    assert _tag_dict(tag) == {"id": 3, "name": "Customer", "color": "#6366f1", "group_id": 5}
    tag_field = ProjectDetailResponse.model_fields["tags"].annotation
    (item,) = tag_field.__args__
    assert set(item.model_fields) == {"id", "name", "color", "group_id"}
