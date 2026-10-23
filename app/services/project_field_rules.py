"""
Project-field rules shared by the routers (2.0.0).

The items of a dropdown field (select / multiselect) are scoped like tags:

- an item restricted to some sites (``all_sites = false``) applies only to
  projects at one of those sites; a project without a site may only hold
  items available at every site;
- an item linked to teams at a site applies to a project at that site only
  when the project shares one of those teams (team rows at other sites do not
  restrict it there).

The count helpers back the 409s that keep existing projects consistent when an
item's sites or teams are narrowed underneath projects that hold it; they are
the tag counters of ``tag_rules`` over ``project_field_selections``, and the
409 details share the tag texts' shape ("... use this item").

Error details are plain strings (the frontend renders ``detail`` as text).
"""

from collections.abc import Iterable

from sqlalchemy import func, select, union
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project_field import (
    ProjectFieldOption,
    ProjectFieldSelection,
    ProjectFieldValue,
)
from app.models.team import Team
from app.services.tag_rules import (
    count_linked_projects_outside_sites,
    count_linked_projects_outside_teams,
    other_sites_conflict_detail,
    other_teams_conflict_detail,
)

ITEM_NOUN = "item"


def option_other_sites_conflict_detail(count: int) -> str:
    """409 when narrowing an item's sites: "2 projects at other sites use this item"."""
    return other_sites_conflict_detail(count, ITEM_NOUN)


def option_other_teams_conflict_detail(count: int) -> str:
    """409 when narrowing an item's teams: "1 project outside these teams uses this item"."""
    return other_teams_conflict_detail(count, ITEM_NOUN)


def option_applies_to_site(option: ProjectFieldOption, site_id: int | None) -> bool:
    """Whether ``option`` may be held by a project at ``site_id``."""
    if option.all_sites:
        return True
    return site_id is not None and site_id in option.site_ids


def option_applies_to_project(
    option: ProjectFieldOption, site_id: int | None, team_ids: Iterable[int]
) -> bool:
    """Whether ``option`` may be held by a project at ``site_id`` in teams ``team_ids``."""
    if not option_applies_to_site(option, site_id):
        return False
    scoped = {team.id for team in option.teams if team.site_id == site_id}
    return not scoped or bool(scoped & set(team_ids))


async def count_projects_outside_option_sites(
    db: AsyncSession, option_id: int, site_ids: list[int]
) -> int:
    """Projects holding ``option_id`` that are not at one of ``site_ids`` (incl. site-less ones)."""
    return await count_linked_projects_outside_sites(
        db,
        ProjectFieldSelection.project_id,
        ProjectFieldSelection.option_id,
        option_id,
        site_ids,
    )


async def count_projects_outside_option_teams(
    db: AsyncSession, option_id: int, teams: list[Team]
) -> int:
    """
    Projects holding ``option_id`` at a site of ``teams`` that share none of ``teams``.

    No query for no teams.
    """
    return await count_linked_projects_outside_teams(
        db,
        ProjectFieldSelection.project_id,
        ProjectFieldSelection.option_id,
        option_id,
        teams,
    )


async def count_projects_using_field(db: AsyncSession, field_id: int) -> int:
    """
    Projects holding a value or an item of ``field_id`` (what deleting it would clear).

    One query: the union of the value rows and the selections of the field's items.
    """
    with_value = select(ProjectFieldValue.project_id).where(ProjectFieldValue.field_id == field_id)
    with_item = (
        select(ProjectFieldSelection.project_id)
        .join(ProjectFieldOption, ProjectFieldOption.id == ProjectFieldSelection.option_id)
        .where(ProjectFieldOption.field_id == field_id)
    )
    projects = union(with_value, with_item).subquery()
    result = await db.execute(select(func.count()).select_from(projects))
    return int(result.scalar() or 0)
