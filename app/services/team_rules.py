"""
Team rules shared by the routers that link teams to other data.

- A team belongs to one site; its members must belong to that site too
  (``user_sites``).
- A project's teams must all be at the project's site; a site-less project
  cannot have teams.
- Tags, equipment and company events: no team rows at a site means the whole
  site; rows mean only those teams at that site.

``load_teams`` resolves the ids a request carries; the ``*_detail`` helpers
give the 400 messages each router raises through ``ensure_teams_within_sites``.
``count_projects_stranded_by_team_delete`` backs the 409 that refuses to
delete a team while a project would keep a tag or a project-field item limited
to other teams.

Error details are plain strings (the frontend renders ``detail`` as text).
"""

from collections.abc import Callable, Iterable
from typing import Any

from fastapi import HTTPException
from sqlalchemy import Select, and_, func, literal, not_, select, union
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models.project import Project
from app.models.project_field import ProjectFieldOptionTeam, ProjectFieldSelection
from app.models.tag import ProjectTag
from app.models.team import ProjectTeam, TagTeam, Team
from app.models.user import User, UserSite

TEAM_NOT_FOUND_DETAIL = "Team not found"
TEAM_SITE_ACCESS_DETAIL = "You can only manage teams at sites you have access to"
MEMBER_NOT_AT_SITE_DETAIL = "Every team member must belong to the team's site"
SITE_LESS_PROJECT_TEAMS_DETAIL = "A project without a site cannot have teams"


def team_outside_sites_detail(team_name: str) -> str:
    return f'The team "{team_name}" is not at one of the selected sites'


def team_outside_project_site_detail(team_name: str) -> str:
    return f'The team "{team_name}" is not at this project\'s site'


def team_outside_user_sites_detail(team_name: str) -> str:
    return f'The team "{team_name}" is not at one of the user\'s sites'


def team_delete_strands_projects_detail(count: int) -> str:
    if count == 1:
        return (
            "1 project would keep a tag or field item limited to other teams; "
            "move it to another of those teams or widen the tag or item first"
        )
    return (
        f"{count} projects would keep tags or field items limited to other teams; "
        "move them to another of those teams or widen the tags or items first"
    )


async def load_teams(
    db: AsyncSession, team_ids: Iterable[int], *, strict: bool = True
) -> list[Team]:
    """
    Load the teams for ``team_ids``, ordered by id (no query for no ids).

    ``strict``: an unknown id is a 404. Non-strict drops unknown ids silently
    (a What-If replay may carry the id of a team deleted in the meantime).
    """
    ids = set(team_ids)
    if not ids:
        return []
    result = await db.execute(select(Team).where(Team.id.in_(ids)).order_by(Team.id))
    teams = list(result.scalars().all())
    if strict and len(teams) != len(ids):
        raise HTTPException(status_code=404, detail=TEAM_NOT_FOUND_DETAIL)
    return teams


def ensure_teams_within_sites(
    teams: Iterable[Team], site_ids: Iterable[int], detail_for: Callable[[str], str]
) -> None:
    """Raise 400 (``detail_for(team.name)``) for the first team not at one of ``site_ids``."""
    allowed = set(site_ids)
    for team in teams:
        if team.site_id not in allowed:
            raise HTTPException(status_code=400, detail=detail_for(team.name))


def prune_teams_to_sites(teams: Iterable[Team], site_ids: Iterable[int]) -> list[Team]:
    """The teams at one of ``site_ids``, order preserved."""
    allowed = set(site_ids)
    return [team for team in teams if team.site_id in allowed]


def team_ids_of(teams: Iterable[Team]) -> list[int]:
    """Ids of ``teams``, ascending and unique."""
    return sorted({team.id for team in teams})


async def load_site_members(db: AsyncSession, site_id: int, user_ids: Iterable[int]) -> list[User]:
    """
    Load the users for ``user_ids`` that belong to ``site_id``, ordered by id.

    No query for no ids. Raises 400 when a requested user is unknown or not at
    the site.
    """
    ids = set(user_ids)
    if not ids:
        return []
    result = await db.execute(
        select(User)
        .join(UserSite, UserSite.user_id == User.id)
        .where(UserSite.site_id == site_id, User.id.in_(ids))
        .order_by(User.id)
    )
    users = list(result.scalars().all())
    if len(users) != len(ids):
        raise HTTPException(status_code=400, detail=MEMBER_NOT_AT_SITE_DETAIL)
    return users


def _stranded_project_ids(
    team: Team, link: Any, link_entity: Any, scope: Any, scope_entity: Any
) -> Select[Any]:
    """
    Ids of the projects of ``team`` (at its site) that deleting it would strand
    on one kind of team-scoped entity (tags, project-field items).

    ``link`` / ``link_entity``: the project junction and its entity column
    (``project_tags.tag_id``); ``scope`` / ``scope_entity``: the entity's team
    junction and its entity column (``tag_teams.tag_id``). A project is
    stranded when it holds an entity linked to ``team`` and to at least one
    other team at the site, while it is in none of those other teams.
    """
    other_link = aliased(scope)
    other_entity = getattr(other_link, scope_entity.key)
    other_team = aliased(Team)
    other_membership = aliased(ProjectTeam)
    # Aliases throughout: the outer query already uses the team junction and
    # project_teams, which would otherwise be correlated out of the subqueries.
    other_teams_of_entity = (
        select(literal(1))
        .select_from(other_link)
        .join(other_team, other_team.id == other_link.team_id)
        .where(
            other_entity == link_entity,
            other_link.team_id != team.id,
            other_team.site_id == team.site_id,
        )
    )
    in_another_entity_team = other_teams_of_entity.join(
        other_membership,
        and_(
            other_membership.team_id == other_link.team_id,
            other_membership.project_id == Project.id,
        ),
    )
    return (
        select(Project.id)
        .select_from(Project)
        .join(
            ProjectTeam,
            and_(ProjectTeam.project_id == Project.id, ProjectTeam.team_id == team.id),
        )
        .join(link, link.project_id == Project.id)
        .join(scope, and_(scope_entity == link_entity, scope.team_id == team.id))
        .where(
            Project.site_id == team.site_id,
            other_teams_of_entity.exists(),
            not_(in_another_entity_team.exists()),
        )
    )


async def count_projects_stranded_by_team_delete(db: AsyncSession, team: Team) -> int:
    """
    Projects that deleting ``team`` would leave holding a tag or a project-field
    item limited to other teams.

    A project at the team's site, in ``team``, holding a tag (or an item) whose
    team rows at that site name ``team`` and at least one other team, while the
    project is in none of those other teams: once ``team``'s rows go (ON DELETE
    CASCADE), the tag / item is limited to teams the project is not part of. (A
    tag or item linked to ``team`` alone at the site becomes open to the whole
    site instead.) One query; a project stranded both ways counts once.
    """
    by_tag = _stranded_project_ids(team, ProjectTag, ProjectTag.tag_id, TagTeam, TagTeam.tag_id)
    by_item = _stranded_project_ids(
        team,
        ProjectFieldSelection,
        ProjectFieldSelection.option_id,
        ProjectFieldOptionTeam,
        ProjectFieldOptionTeam.option_id,
    )
    stranded = union(by_tag, by_item).subquery()
    result = await db.execute(select(func.count()).select_from(stranded))
    return int(result.scalar() or 0)
