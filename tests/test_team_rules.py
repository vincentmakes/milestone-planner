"""
Team rules (app/services/team_rules.py) and the team-aware tag rules
(app/services/tag_rules.py).

- load_teams dedups ids, answers 404 for an unknown id (strict) or drops it
  (non-strict, What-If replay of a deleted team), and runs no query for [].
- Team members must belong to the team's site (400).
- A tag restricted to teams at a site applies to a project at that site only
  when the project shares one of those teams; team rows at other sites do not
  restrict it here.
- Deleting a team is refused while it would strand projects: projects of the
  team holding a tag also limited to other teams they are not part of.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.models.site import Site
from app.models.tag import Tag
from app.models.team import Team
from app.models.user import User
from app.services.tag_rules import (
    count_projects_outside_teams,
    other_teams_conflict_detail,
    tag_applies_to_project,
    tag_not_applicable_to_teams_detail,
    validate_project_tags,
)
from app.services.team_rules import (
    MEMBER_NOT_AT_SITE_DETAIL,
    TEAM_NOT_FOUND_DETAIL,
    count_projects_stranded_by_team_delete,
    ensure_teams_within_sites,
    load_site_members,
    load_teams,
    prune_teams_to_sites,
    team_delete_strands_projects_detail,
    team_ids_of,
    team_outside_project_site_detail,
    team_outside_sites_detail,
    team_outside_user_sites_detail,
)
from tests.support import scalar_result, scalars_result


def _team(team_id: int, site_id: int, name: str | None = None) -> Team:
    return Team(id=team_id, site_id=site_id, name=name or f"Team {team_id}", active=True)


def _tag(tag_id: int, name: str, site_ids=None, teams=None) -> Tag:
    tag = Tag(
        id=tag_id,
        name=name,
        color="#6366f1",
        all_sites=site_ids is None,
        sort_order=0,
        sites=[Site(id=sid, name=f"Site {sid}") for sid in (site_ids or [])],
        teams=list(teams or []),
    )
    return tag


def _db(*results):
    db = MagicMock()
    db.execute = AsyncMock(side_effect=list(results))
    return db


def _sql(db) -> list[str]:
    return [
        " ".join(str(call.args[0].compile(compile_kwargs={"literal_binds": True})).split())
        for call in db.execute.await_args_list
    ]


# ---------------------------------------------------------
# Detail strings
# ---------------------------------------------------------


def test_detail_strings():
    assert team_outside_sites_detail("Upstream") == (
        'The team "Upstream" is not at one of the selected sites'
    )
    assert team_outside_project_site_detail("Upstream") == (
        'The team "Upstream" is not at this project\'s site'
    )
    assert team_outside_user_sites_detail("Upstream") == (
        'The team "Upstream" is not at one of the user\'s sites'
    )
    assert tag_not_applicable_to_teams_detail("Pilot") == (
        'The tag "Pilot" is limited to teams this project is not part of'
    )
    assert other_teams_conflict_detail(1) == "1 project outside these teams uses this tag"
    assert other_teams_conflict_detail(3) == "3 projects outside these teams use this tag"
    assert team_delete_strands_projects_detail(1) == (
        "1 project would keep a tag or field item limited to other teams; "
        "move it to another of those teams or widen the tag or item first"
    )
    assert team_delete_strands_projects_detail(4) == (
        "4 projects would keep tags or field items limited to other teams; "
        "move them to another of those teams or widen the tags or items first"
    )


# ---------------------------------------------------------
# load_teams
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_load_teams_without_ids_needs_no_query():
    db = _db()
    assert await load_teams(db, []) == []
    db.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_load_teams_dedups_and_orders_by_id():
    teams = [_team(1, 1), _team(2, 1)]
    db = _db(scalars_result(teams))

    assert await load_teams(db, [2, 1, 2]) == teams

    (sql,) = _sql(db)
    assert "teams.id IN (1, 2)" in sql
    assert "ORDER BY teams.id" in sql


@pytest.mark.asyncio
async def test_load_teams_strict_unknown_id_is_a_404():
    db = _db(scalars_result([_team(1, 1)]))

    with pytest.raises(HTTPException) as exc:
        await load_teams(db, [1, 404])

    assert exc.value.status_code == 404
    assert exc.value.detail == TEAM_NOT_FOUND_DETAIL


@pytest.mark.asyncio
async def test_load_teams_non_strict_drops_unknown_ids():
    known = _team(1, 1)
    db = _db(scalars_result([known]))

    assert await load_teams(db, [1, 404], strict=False) == [known]


# ---------------------------------------------------------
# Site checks on teams
# ---------------------------------------------------------


def test_ensure_teams_within_sites_raises_the_callback_detail():
    teams = [_team(1, 1, "Upstream"), _team(2, 2, "Analytics")]

    with pytest.raises(HTTPException) as exc:
        ensure_teams_within_sites(teams, [1], team_outside_project_site_detail)

    assert exc.value.status_code == 400
    assert exc.value.detail == 'The team "Analytics" is not at this project\'s site'


def test_ensure_teams_within_sites_passes_when_all_inside():
    ensure_teams_within_sites([_team(1, 1), _team(2, 2)], {1, 2}, team_outside_sites_detail)
    ensure_teams_within_sites([], [], team_outside_sites_detail)


def test_prune_teams_to_sites_keeps_order():
    a, b, c = _team(3, 1), _team(1, 2), _team(2, 1)
    assert prune_teams_to_sites([a, b, c], [1]) == [a, c]
    assert prune_teams_to_sites([a, b, c], []) == []


def test_team_ids_of_is_sorted_and_unique():
    assert team_ids_of([_team(3, 1), _team(1, 1), _team(3, 1)]) == [1, 3]
    assert team_ids_of([]) == []


# ---------------------------------------------------------
# load_site_members
# ---------------------------------------------------------


def _user(user_id: int) -> User:
    return User(id=user_id, email=f"u{user_id}@example.com", first_name="U", last_name=str(user_id))


@pytest.mark.asyncio
async def test_load_site_members_without_ids_needs_no_query():
    db = _db()
    assert await load_site_members(db, 1, []) == []
    db.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_load_site_members_joins_user_sites():
    users = [_user(4), _user(7)]
    db = _db(scalars_result(users))

    assert await load_site_members(db, 2, [7, 4, 7]) == users

    (sql,) = _sql(db)
    assert "JOIN user_sites ON user_sites.user_id = users.id" in sql
    assert "user_sites.site_id = 2" in sql
    assert "users.id IN (4, 7)" in sql
    assert "ORDER BY users.id" in sql


@pytest.mark.asyncio
async def test_load_site_members_member_outside_the_site_is_a_400():
    db = _db(scalars_result([_user(4)]))

    with pytest.raises(HTTPException) as exc:
        await load_site_members(db, 2, [4, 7])

    assert exc.value.status_code == 400
    assert exc.value.detail == MEMBER_NOT_AT_SITE_DETAIL


# ---------------------------------------------------------
# tag_applies_to_project
# ---------------------------------------------------------


def test_tag_applies_to_project_truth_table():
    everywhere = _tag(1, "Critical")
    assert tag_applies_to_project(everywhere, 1, []) is True

    other_site_teams = _tag(2, "Pilot", teams=[_team(10, 2)])
    assert tag_applies_to_project(other_site_teams, 1, []) is True

    this_site_teams = _tag(3, "Pilot", teams=[_team(10, 1), _team(11, 1), _team(12, 2)])
    assert tag_applies_to_project(this_site_teams, 1, [11, 99]) is True
    assert tag_applies_to_project(this_site_teams, 1, [12, 99]) is False
    assert tag_applies_to_project(this_site_teams, 1, []) is False

    elsewhere = _tag(4, "Bern only", site_ids=[2])
    assert tag_applies_to_project(elsewhere, 1, []) is False


# ---------------------------------------------------------
# validate_project_tags with teams
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_validate_project_tags_rejects_a_tag_of_other_teams():
    db = _db(scalars_result([_tag(1, "Pilot", teams=[_team(10, 1)])]))

    with pytest.raises(HTTPException) as exc:
        await validate_project_tags(db, 1, [1], [11])

    assert exc.value.status_code == 400
    assert exc.value.detail == 'The tag "Pilot" is limited to teams this project is not part of'


@pytest.mark.asyncio
async def test_validate_project_tags_accepts_a_shared_team():
    tag = _tag(1, "Pilot", teams=[_team(10, 1)])
    db = _db(scalars_result([tag]))

    assert await validate_project_tags(db, 1, [1], [10]) == [tag]


@pytest.mark.asyncio
async def test_validate_project_tags_site_check_comes_first():
    tags = [
        _tag(1, "Pilot", teams=[_team(10, 1)]),
        _tag(2, "Bern only", site_ids=[2]),
    ]
    db = _db(scalars_result(tags))

    with pytest.raises(HTTPException) as exc:
        await validate_project_tags(db, 1, [1, 2], [])

    assert exc.value.detail == 'The tag "Bern only" is not available at this project\'s site'


# ---------------------------------------------------------
# count_projects_outside_teams
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_count_projects_outside_teams_without_teams_needs_no_query():
    db = _db()
    assert await count_projects_outside_teams(db, 1, []) == 0
    db.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_count_projects_outside_teams_query():
    db = _db(scalar_result(4))

    assert await count_projects_outside_teams(db, 7, [_team(10, 1), _team(11, 2)]) == 4

    (sql,) = _sql(db)
    assert "count(distinct(projects.id))" in sql
    assert "project_tags.tag_id = 7" in sql
    assert "projects.site_id IN (1, 2)" in sql
    assert "NOT (EXISTS" in sql
    assert "project_teams.team_id IN (10, 11)" in sql


# ---------------------------------------------------------
# count_projects_stranded_by_team_delete
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_count_projects_stranded_by_team_delete_query():
    db = _db(scalar_result(2))

    assert await count_projects_stranded_by_team_delete(db, _team(3, 1)) == 2

    (sql,) = _sql(db)
    # One query: the distinct projects stranded by a tag or by a field item.
    assert sql.startswith("SELECT count(*)")
    by_tag, by_item = sql.split(" UNION ")
    # Projects of the team at its site, holding a tag linked to the team...
    assert "project_teams.project_id = projects.id AND project_teams.team_id = 3" in by_tag
    assert "JOIN project_tags ON project_tags.project_id = projects.id" in by_tag
    assert "tag_teams.tag_id = project_tags.tag_id AND tag_teams.team_id = 3" in by_tag
    assert "projects.site_id = 1" in by_tag
    # ...that the tag also limits to another team at the site...
    assert "AND (EXISTS (SELECT" in by_tag
    assert "tag_teams_1.team_id != 3" in by_tag
    assert "teams_1.site_id = 1" in by_tag
    # ...none of which the project is part of.
    assert "NOT (EXISTS (SELECT" in by_tag
    assert "project_teams_1.project_id = projects.id" in by_tag
    # The same rule over the project-field items (selections + item teams).
    assert "project_teams.project_id = projects.id AND project_teams.team_id = 3" in by_item
    assert (
        "JOIN project_field_selections ON project_field_selections.project_id = projects.id"
        in by_item
    )
    assert (
        "project_field_option_teams.option_id = project_field_selections.option_id "
        "AND project_field_option_teams.team_id = 3"
    ) in by_item
    assert "projects.site_id = 1" in by_item
    assert "project_field_option_teams_1.team_id != 3" in by_item
    assert "teams_2.site_id = 1" in by_item
    assert "NOT (EXISTS (SELECT" in by_item
    assert "project_teams_2.project_id = projects.id" in by_item
    assert "tag" not in by_item
