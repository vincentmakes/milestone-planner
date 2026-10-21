"""
Teams API endpoints.

A team is a named group of users at one site. Every authenticated user reads
the teams of their visible sites; ``teams.manage`` manages them, at the
visible sites only. Members must belong to the team's site.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import noload, selectinload

from app.database import get_db
from app.middleware.auth import get_current_user, require_permission
from app.models.site import Site
from app.models.team import Team
from app.models.user import User
from app.schemas.team import TeamCreate, TeamResponse, TeamUpdate
from app.services.site_access import (
    ensure_site_access,
    ensure_site_visible,
    site_is_visible,
    visible_site_ids,
    visible_sites_clause,
)
from app.services.team_rules import (
    TEAM_NOT_FOUND_DETAIL,
    TEAM_SITE_ACCESS_DETAIL,
    count_projects_stranded_by_team_delete,
    load_site_members,
    team_delete_strands_projects_detail,
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


def _members_for_ids():
    """
    Load ``Team.members`` for a read-only response, which only reads ``member_ids``.

    Skips each member's own eager collections (sites, skills, teams), which
    would otherwise cost three more selectin queries.
    """
    return selectinload(Team.members).options(
        noload(User.sites), noload(User.skills), noload(User.teams)
    )


async def _load_team(
    db: AsyncSession, team_id: int, *, with_members: bool = True, read_only: bool = False
) -> Team:
    """
    The team (members loaded unless told otherwise); 404 if it does not exist.

    ``read_only``: members are loaded for ``member_ids`` only (``_members_for_ids``);
    never for a team whose member list is then rewritten.
    """
    query = select(Team).where(Team.id == team_id)
    if with_members:
        query = query.options(_members_for_ids() if read_only else selectinload(Team.members))
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
    request: Request,
    siteId: int | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get the teams of the user's visible sites, inactive ones included.

    Ordered by site, then name; ``siteId`` limits the list to one site (403
    outside the visible sites). One query (members come with the selectin
    load).
    """
    query = select(Team).options(_members_for_ids()).order_by(Team.site_id, Team.name)
    if siteId is not None:
        await ensure_site_visible(request, db, current_user, siteId)
        query = query.where(Team.site_id == siteId)
    else:
        in_visible = visible_sites_clause(
            Team.site_id, await visible_site_ids(request, db, current_user)
        )
        if in_visible is not None:
            query = query.where(in_visible)
    result = await db.execute(query)
    return [TeamResponse.model_validate(team) for team in result.scalars().all()]


@router.get("/{team_id}", response_model=TeamResponse)
async def get_team(
    team_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get one team with its members (404 outside the user's visible sites)."""
    team = await _load_team(db, team_id, read_only=True)
    if not site_is_visible(await visible_site_ids(request, db, current_user), team.site_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=TEAM_NOT_FOUND_DETAIL)
    return TeamResponse.model_validate(team)


@router.post("", response_model=TeamResponse, status_code=status.HTTP_201_CREATED)
async def create_team(
    data: TeamCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("teams.manage")),
):
    """
    Create a team (``teams.manage``, at a visible site).

    Queries, in order: the site (404), the name at that site (400), then the
    members at that site when ``member_ids`` is not empty (400).
    """
    name = _clean_name(data.name)

    site = await db.execute(select(Site.id).where(Site.id == data.site_id))
    if site.scalar_one_or_none() is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site not found")
    await ensure_site_access(request, db, current_user, [data.site_id], TEAM_SITE_ACCESS_DETAIL)

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
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("teams.manage")),
):
    """
    Update a team (partial; ``teams.manage``, at a visible site).

    Queries, in order: the team with its members (404), the new name at its
    site when the name changes (400), then the members at its site when
    ``member_ids`` is given (400; replaces the member list).
    """
    team = await _load_team(db, team_id)
    await ensure_site_access(request, db, current_user, [team.site_id], TEAM_SITE_ACCESS_DETAIL)

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
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("teams.manage")),
):
    """
    Delete a team (``teams.manage``, at a visible site).

    Queries, in order: the team (404), the projects deleting it would strand
    (409: a project of the team holding a tag also limited to other teams at
    the site, none of which it is part of), then the DELETE. Its member,
    project, tag, event and equipment links go with it (ON DELETE CASCADE).
    """
    team = await _load_team(db, team_id, with_members=False)
    await ensure_site_access(request, db, current_user, [team.site_id], TEAM_SITE_ACCESS_DETAIL)

    stranded = await count_projects_stranded_by_team_delete(db, team)
    if stranded:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=team_delete_strands_projects_detail(stranded),
        )

    await db.execute(
        delete(Team).where(Team.id == team_id).execution_options(synchronize_session=False)
    )
    await db.commit()

    return None
