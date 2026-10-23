"""
Project-field item rules (app/services/project_field_rules.py, 2.0.0).

The items of dropdown fields are scoped like tags: the applicability helpers
mirror ``tag_applies_to_site`` / ``tag_applies_to_project``, the 409 counters
are the tag counters over ``project_field_selections`` (shared generic
helpers in ``tag_rules``), and the details share the tag texts' shape.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.models.project_field import ProjectFieldOption
from app.models.site import Site
from app.models.team import Team
from app.services.project_field_rules import (
    count_projects_outside_option_sites,
    count_projects_outside_option_teams,
    count_projects_using_field,
    option_applies_to_project,
    option_applies_to_site,
    option_other_sites_conflict_detail,
    option_other_teams_conflict_detail,
)
from app.services.tag_rules import other_sites_conflict_detail, other_teams_conflict_detail
from tests.support import scalar_result


def _team(team_id: int, site_id: int) -> Team:
    return Team(id=team_id, site_id=site_id, name=f"Team {team_id}")


def _option(site_ids=None, teams=None) -> ProjectFieldOption:
    return ProjectFieldOption(
        id=9,
        field_id=5,
        name="Customer",
        all_sites=site_ids is None,
        sites=[Site(id=sid, name=f"Site {sid}") for sid in (site_ids or [])],
        teams=list(teams or []),
    )


def _db(*results):
    db = MagicMock()
    db.execute = AsyncMock(side_effect=list(results))
    return db


def _sql(db) -> list[str]:
    return [
        " ".join(str(call.args[0].compile(compile_kwargs={"literal_binds": True})).split())
        for call in db.execute.await_args_list
    ]


def test_detail_texts_share_the_tag_shape():
    assert option_other_sites_conflict_detail(1) == "1 project at another site uses this item"
    assert option_other_sites_conflict_detail(3) == "3 projects at other sites use this item"
    assert option_other_teams_conflict_detail(1) == "1 project outside these teams uses this item"
    assert option_other_teams_conflict_detail(2) == "2 projects outside these teams use this item"
    # The tag texts are unchanged.
    assert other_sites_conflict_detail(1) == "1 project at another site uses this tag"
    assert other_teams_conflict_detail(4) == "4 projects outside these teams use this tag"


def test_option_applies_to_site_truth_table():
    everywhere = _option()
    assert option_applies_to_site(everywhere, 1) is True
    assert option_applies_to_site(everywhere, None) is True

    basel = _option(site_ids=[2, 3])
    assert option_applies_to_site(basel, 2) is True
    assert option_applies_to_site(basel, 1) is False
    assert option_applies_to_site(basel, None) is False  # site-less project


def test_option_applies_to_project_truth_table():
    assert option_applies_to_project(_option(), 1, []) is True

    other_site_teams = _option(teams=[_team(10, 2)])
    assert option_applies_to_project(other_site_teams, 1, []) is True

    this_site_teams = _option(teams=[_team(10, 1), _team(11, 1), _team(12, 2)])
    assert option_applies_to_project(this_site_teams, 1, [11, 99]) is True
    assert option_applies_to_project(this_site_teams, 1, [12, 99]) is False
    assert option_applies_to_project(this_site_teams, 1, []) is False

    assert option_applies_to_project(_option(site_ids=[2]), 1, []) is False


@pytest.mark.asyncio
async def test_count_outside_sites_query():
    db = _db(scalar_result(2), scalar_result(None))

    assert await count_projects_outside_option_sites(db, 9, [1, 2]) == 2
    assert await count_projects_outside_option_sites(db, 9, []) == 0

    narrowed, nowhere = _sql(db)
    assert narrowed.startswith("SELECT count(distinct(projects.id))")
    assert (
        "JOIN project_field_selections ON project_field_selections.project_id = projects.id "
        "AND project_field_selections.option_id = 9"
    ) in narrowed
    assert "projects.site_id IS NULL OR (projects.site_id NOT IN (1, 2))" in narrowed
    # No allowed site: only the site-less projects are outside -- never NOT IN ().
    assert "projects.site_id IS NULL" in nowhere
    assert "NOT IN" not in nowhere


@pytest.mark.asyncio
async def test_count_outside_teams_query():
    db = _db(scalar_result(4))

    assert await count_projects_outside_option_teams(db, 9, [_team(10, 1), _team(11, 2)]) == 4

    (sql,) = _sql(db)
    assert "count(distinct(projects.id))" in sql
    assert "project_field_selections.option_id = 9" in sql
    assert "projects.site_id IN (1, 2)" in sql
    assert "NOT (EXISTS" in sql
    assert "project_teams.team_id IN (10, 11)" in sql


@pytest.mark.asyncio
async def test_count_outside_teams_without_teams_needs_no_query():
    db = _db()
    assert await count_projects_outside_option_teams(db, 9, []) == 0
    db.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_count_projects_using_a_field():
    db = _db(scalar_result(None), scalar_result(7))

    assert await count_projects_using_field(db, 5) == 0
    assert await count_projects_using_field(db, 5) == 7

    sql = _sql(db)[0]
    assert sql.startswith("SELECT count(*)")
    with_value, with_item = sql.split(" UNION ")
    assert "FROM project_field_values WHERE project_field_values.field_id = 5" in with_value
    assert (
        "FROM project_field_selections JOIN project_field_options "
        "ON project_field_options.id = project_field_selections.option_id"
    ) in with_item
    assert "project_field_options.field_id = 5" in with_item
