"""
Teams API endpoints.

A team is a named group of users at one site. Every authenticated user can
read teams; superusers and admins manage them, a superuser only at the sites
they belong to. Members must belong to the team's site.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.middleware.auth import get_current_user, require_superuser
from app.models.site import Site
from app.models.team import Team
from app.models.user import User
from app.schemas.team import TeamCreate, TeamResponse, TeamUpdate
from app.services.site_access import ensure_site_access
from app.services.team_rules import (
    TEAM_NOT_FOUND_DETAIL,
    TEAM_SITE_ACCESS_DETAIL,
    load_site_members,
)

router = APIRouter(prefix="/teams", tags=["teams"])

EMPTY_NAME_DETAIL = "Team name cannot be empty"


def _duplicate_name_detail(name: str) -> str:
    return f'A team named "{name}" already exists at this site'


def _clean_name(name: str) -> str:
    """The stripped name; 400 when nothing is left."""
    name = name.strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EMPTY_NAME_DETAIL)
    return name


async def _name_taken(
    db: AsyncSession, site_id: int, name: str, exclude_id: int | None = None
) -> bool:
    query = select(Team.id).where(Team.site_id == site_id, Team.name == name)
    if exclude_id is not None:
        query = query.where(Team.id != exclude_id)
    result = await db.execute(query)
    return result.scalar_one_or_none() is not None


async def _load_team(db: AsyncSession, team_id: int, *, with_members: bool = True) -> Team:
    """The team (members loaded unless told otherwise); 404 if it does not exist."""
    query = select(Team).where(Team.id == team_id)
    if with_members:
        query = query.options(selectinload(Team.members))
    team = (await db.execute(query)).scalar_one_or_none()
    if team is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=TEAM_NOT_FOUND_DETAIL)
    return team


async def _commit_team(db: AsyncSession, name: str) -> None:
    """Commit; a unique-name race lost to a concurrent write is a 400, not a 500."""
    try:
        await db.commit()
    except IntegrityError as e:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=_duplicate_name_detail(name)
        ) from e


async def _refresh_team(db: AsyncSession, team: Team) -> None:
    """
    Reload the team after a commit, members included.

    A plain refresh expires the lazy ``members`` collection, which an
    AsyncSession cannot lazy-load when the response reads ``member_ids``;
    naming it reloads it.
    """
    await db.refresh(team)
    await db.refresh(team, attribute_names=["members"])


@router.get("", response_model=list[TeamResponse])
async def get_teams(
    siteId: int | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get all teams, inactive ones included (every authenticated user).

    Ordered by site, then name; ``siteId`` limits the list to one site.
    One query (members come with the selectin load).
    """
    query = select(Team).options(selectinload(Team.members)).order_by(Team.site_id, Team.name)
    if siteId is not None:
        query = query.where(Team.site_id == siteId)
    result = await db.execute(query)
    return [TeamResponse.model_validate(team) for team in result.scalars().all()]


@router.get("/{team_id}", response_model=TeamResponse)
async def get_team(
    team_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get one team with its members (every authenticated user)."""
    return TeamResponse.model_validate(await _load_team(db, team_id))


@router.post("", response_model=TeamResponse, status_code=status.HTTP_201_CREATED)
async def create_team(
    data: TeamCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_superuser),
):
    """
    Create a team (superuser at their own sites, admin anywhere).

    Queries, in order: the site (404), the name at that site (400), then the
    members at that site when ``member_ids`` is not empty (400).
    """
    name = _clean_name(data.name)

    site = await db.execute(select(Site.id).where(Site.id == data.site_id))
    if site.scalar_one_or_none() is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site not found")
    ensure_site_access(current_user, [data.site_id], TEAM_SITE_ACCESS_DETAIL)

    if await _name_taken(db, data.site_id, name):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=_duplicate_name_detail(name)
        )

    members = await load_site_members(db, data.site_id, data.member_ids)

    team = Team(
        site_id=data.site_id,
        name=name,
        description=data.description,
        color=data.color,
        active=data.active,
        members=members,
    )
    db.add(team)
    await _commit_team(db, name)
    await _refresh_team(db, team)

    return TeamResponse.model_validate(team)


@router.put("/{team_id}", response_model=TeamResponse)
async def update_team(
    team_id: int,
    data: TeamUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_superuser),
):
    """
    Update a team (partial; superuser at their own sites, admin anywhere).

    Queries, in order: the team with its members (404), the new name at its
    site when the name changes (400), then the members at its site when
    ``member_ids`` is given (400; replaces the member list).
    """
    team = await _load_team(db, team_id)
    ensure_site_access(current_user, [team.site_id], TEAM_SITE_ACCESS_DETAIL)

    name: str | None = None
    if data.name is not None:
        name = _clean_name(data.name)
        if name != team.name and await _name_taken(db, team.site_id, name, exclude_id=team_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=_duplicate_name_detail(name)
            )

    members: list[User] | None = None
    if data.member_ids is not None:
        members = await load_site_members(db, team.site_id, data.member_ids)

    # Every check passed: apply. An explicit null clears description / color.
    fields = data.model_fields_set
    if name is not None:
        team.name = name
    if "description" in fields:
        team.description = data.description
    if "color" in fields:
        team.color = data.color
    if data.active is not None:
        team.active = data.active
    if members is not None:
        team.members = members

    await _commit_team(db, team.name)
    await _refresh_team(db, team)

    return TeamResponse.model_validate(team)


@router.delete("/{team_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_team(
    team_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_superuser),
):
    """
    Delete a team (superuser at their own sites, admin anywhere).

    Queries, in order: the team (404), then the DELETE. Its member, project,
    tag, event and equipment links go with it (ON DELETE CASCADE).
    """
    team = await _load_team(db, team_id, with_members=False)
    ensure_site_access(current_user, [team.site_id], TEAM_SITE_ACCESS_DETAIL)

    await db.execute(
        delete(Team).where(Team.id == team_id).execution_options(synchronize_session=False)
    )
    await db.commit()

    return None
