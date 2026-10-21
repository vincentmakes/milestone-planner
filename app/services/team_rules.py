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

Error details are plain strings (the frontend renders ``detail`` as text).
"""

from collections.abc import Callable, Iterable

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.team import Team
from app.models.user import User, UserSite

TEAM_NOT_FOUND_DETAIL = "Team not found"
TEAM_SITE_ACCESS_DETAIL = "You can only manage teams at sites you have access to"
MEMBER_NOT_AT_SITE_DETAIL = "Every team member must belong to the team's site"


def team_outside_sites_detail(team_name: str) -> str:
    return f'The team "{team_name}" is not at one of the selected sites'


def team_outside_project_site_detail(team_name: str) -> str:
    return f'The team "{team_name}" is not at this project\'s site'


def team_outside_user_sites_detail(team_name: str) -> str:
    return f'The team "{team_name}" is not at one of the user\'s sites'


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
