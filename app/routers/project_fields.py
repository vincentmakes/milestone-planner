"""
Project fields API endpoints (2.0.0).

Instance-wide custom fields on projects: ``text``, ``number``, ``toggle``,
``select`` and ``multiselect``. Dropdown fields (select / multiselect) carry
items scoped like tags: available at every site (``all_sites``) or only at
some (``project_field_option_sites``), optionally limited to teams per site
(``project_field_option_teams``). Every user can read the fields; only
``project_fields.manage`` manages them. The values on projects are written
through the project routes.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, get_db_readonly
from app.middleware.auth import get_current_user, require_permission
from app.models.project_field import ProjectField, ProjectFieldOption
from app.models.site import Site
from app.models.user import User
from app.schemas.project_field import (
    ProjectFieldCreate,
    ProjectFieldOptionCreate,
    ProjectFieldOptionReorder,
    ProjectFieldOptionResponse,
    ProjectFieldOptionUpdate,
    ProjectFieldReorder,
    ProjectFieldResponse,
    ProjectFieldUpdate,
    ProjectFieldUsageResponse,
)
from app.services.project_field_rules import (
    count_projects_outside_option_sites,
    count_projects_outside_option_teams,
    count_projects_using_field,
    option_other_sites_conflict_detail,
    option_other_teams_conflict_detail,
)
from app.services.team_rules import (
    ensure_teams_within_sites,
    load_teams,
    prune_teams_to_sites,
    team_ids_of,
    team_outside_sites_detail,
)

router = APIRouter(prefix="/project-fields", tags=["project-fields"])

MANAGE = "project_fields.manage"

FIELD_NOT_FOUND_DETAIL = "Project field not found"
EMPTY_FIELD_NAME_DETAIL = "Field name cannot be empty"
DUPLICATE_FIELD_NAME_DETAIL = "A project field with this name already exists"
FIELD_TYPE_IMMUTABLE_DETAIL = "The type of a project field cannot be changed"
DECIMALS_NUMBER_ONLY_DETAIL = "Only number fields have decimals"
NOT_A_DROPDOWN_DETAIL = "Only dropdown fields (select, multiselect) have items"
OPTION_NOT_FOUND_DETAIL = "Item not found"
EMPTY_OPTION_NAME_DETAIL = "Item name cannot be empty"
DUPLICATE_OPTION_NAME_DETAIL = "This field already has an item with this name"
OPTION_NO_SITE_DETAIL = "Select at least one site or make the item available at all sites"
SITE_NOT_FOUND_DETAIL = "Site not found"


# ---------------------------------------------------------
# Helpers
# ---------------------------------------------------------


def _trimmed(name: str, empty_detail: str) -> str:
    trimmed = name.strip()
    if not trimmed:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=empty_detail)
    return trimmed


async def _load_field(db: AsyncSession, field_id: int) -> ProjectField:
    field = (
        await db.execute(select(ProjectField).where(ProjectField.id == field_id))
    ).scalar_one_or_none()
    if field is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=FIELD_NOT_FOUND_DETAIL)
    return field


async def _load_dropdown_field(db: AsyncSession, field_id: int) -> ProjectField:
    field = await _load_field(db, field_id)
    if not field.is_dropdown:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=NOT_A_DROPDOWN_DETAIL)
    return field


async def _load_option(db: AsyncSession, option_id: int) -> ProjectFieldOption:
    option = (
        await db.execute(select(ProjectFieldOption).where(ProjectFieldOption.id == option_id))
    ).scalar_one_or_none()
    if option is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=OPTION_NOT_FOUND_DETAIL)
    return option


async def _field_name_taken(db: AsyncSession, name: str, exclude_id: int | None = None) -> bool:
    """Case-insensitive: "Budget" and "budget" are the same field name."""
    query = select(ProjectField.id).where(func.lower(ProjectField.name) == name.lower())
    if exclude_id is not None:
        query = query.where(ProjectField.id != exclude_id)
    return (await db.execute(query.limit(1))).scalar_one_or_none() is not None


async def _option_name_taken(
    db: AsyncSession, field_id: int, name: str, exclude_id: int | None = None
) -> bool:
    """Case-insensitive, within one field."""
    query = select(ProjectFieldOption.id).where(
        ProjectFieldOption.field_id == field_id,
        func.lower(ProjectFieldOption.name) == name.lower(),
    )
    if exclude_id is not None:
        query = query.where(ProjectFieldOption.id != exclude_id)
    return (await db.execute(query.limit(1))).scalar_one_or_none() is not None


async def _load_sites(db: AsyncSession, site_ids: list[int]) -> list[Site]:
    """The de-duplicated sites ordered by id; 404 if any does not exist."""
    wanted = sorted(set(site_ids))
    result = await db.execute(select(Site).where(Site.id.in_(wanted)).order_by(Site.id))
    sites = list(result.scalars().all())
    if {s.id for s in sites} != set(wanted):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=SITE_NOT_FOUND_DETAIL)
    return sites


def _resolve_all_sites(requested: bool | None, site_ids: list[int] | None) -> bool | None:
    """
    The effective ``all_sites`` of a request: an explicit value wins; when it
    is omitted, a non-empty ``site_ids`` restricts the item to those sites
    (``None`` = no site change requested).
    """
    if requested is not None:
        return requested
    if site_ids:
        return False
    return None


async def _commit(db: AsyncSession, duplicate_detail: str) -> None:
    """Commit; a unique-name race lost to a concurrent write is a 400, not a 500."""
    try:
        await db.commit()
    except IntegrityError as e:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=duplicate_detail) from e


# ---------------------------------------------------------
# Fields
# ---------------------------------------------------------


@router.get("", response_model=list[ProjectFieldResponse])
async def get_project_fields(
    db: AsyncSession = Depends(get_db_readonly),
    current_user: User = Depends(get_current_user),
):
    """Every project field in display order, with its items in item order (every user)."""
    result = await db.execute(
        select(ProjectField).order_by(ProjectField.sort_order, ProjectField.id)
    )
    return result.scalars().all()


@router.post("", response_model=ProjectFieldResponse, status_code=status.HTTP_201_CREATED)
async def create_project_field(
    data: ProjectFieldCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(MANAGE)),
):
    """Create a project field (``project_fields.manage``), appended at the end."""
    name = _trimmed(data.name, EMPTY_FIELD_NAME_DETAIL)
    if data.decimals is not None and data.field_type != "number":
        raise HTTPException(status_code=422, detail=DECIMALS_NUMBER_ONLY_DETAIL)
    if await _field_name_taken(db, name):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=DUPLICATE_FIELD_NAME_DETAIL
        )

    max_order = (await db.execute(select(func.max(ProjectField.sort_order)))).scalar()
    field = ProjectField(
        name=name,
        field_type=data.field_type,
        sort_order=(max_order + 1) if max_order is not None else 0,
        decimals=data.decimals,
        options=[],
    )
    db.add(field)
    await _commit(db, DUPLICATE_FIELD_NAME_DETAIL)
    await db.refresh(field)
    return field


# Declared before the /{field_id} routes so "reorder" is not parsed as an id.
@router.put("/reorder")
async def reorder_project_fields(
    data: ProjectFieldReorder,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(MANAGE)),
):
    """Set each listed field's sort_order to its index (``project_fields.manage``)."""
    if data.field_order:
        result = await db.execute(
            select(ProjectField).where(ProjectField.id.in_(set(data.field_order)))
        )
        by_id = {f.id: f for f in result.scalars().all()}
        for index, field_id in enumerate(data.field_order):
            if field_id in by_id:
                by_id[field_id].sort_order = index

    await db.commit()
    return {"success": True}


@router.get("/{field_id}/usage", response_model=ProjectFieldUsageResponse)
async def get_project_field_usage(
    field_id: int,
    db: AsyncSession = Depends(get_db_readonly),
    current_user: User = Depends(get_current_user),
):
    """How many projects hold a value or an item of the field (what deleting it clears)."""
    await _load_field(db, field_id)
    return {"projects": await count_projects_using_field(db, field_id)}


@router.put("/{field_id}", response_model=ProjectFieldResponse)
async def update_project_field(
    field_id: int,
    data: ProjectFieldUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(MANAGE)),
):
    """
    Rename a project field or set a number field's decimals
    (``project_fields.manage``); its type never changes (422).

    ``decimals`` applies whenever it is sent -- ``null`` resets a number field
    to "as typed" -- so it is read from ``model_fields_set``, not by value. A
    non-null value on another type is a 422 (null is accepted there: clients
    send the whole field back). Stored values are never rewritten: new writes
    round to it, readers round for display.
    """
    field = await _load_field(db, field_id)

    if data.field_type is not None and data.field_type != field.field_type:
        raise HTTPException(status_code=422, detail=FIELD_TYPE_IMMUTABLE_DETAIL)
    if "decimals" in data.model_fields_set:
        if data.decimals is not None and field.field_type != "number":
            raise HTTPException(status_code=422, detail=DECIMALS_NUMBER_ONLY_DETAIL)
        field.decimals = data.decimals

    if data.name is not None:
        name = _trimmed(data.name, EMPTY_FIELD_NAME_DETAIL)
        if name != field.name and await _field_name_taken(db, name, exclude_id=field_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=DUPLICATE_FIELD_NAME_DETAIL
            )
        field.name = name

    await _commit(db, DUPLICATE_FIELD_NAME_DETAIL)
    await db.refresh(field)
    return field


@router.delete("/{field_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project_field(
    field_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(MANAGE)),
):
    """
    Delete a project field (``project_fields.manage``).

    Its items, their site / team links, every project's value and selected
    items go with it (ON DELETE CASCADE).
    """
    field = await _load_field(db, field_id)
    await db.delete(field)
    await db.commit()
    return None


# ---------------------------------------------------------
# Items of dropdown fields
# ---------------------------------------------------------


@router.post(
    "/{field_id}/options",
    response_model=ProjectFieldOptionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_project_field_option(
    field_id: int,
    data: ProjectFieldOptionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(MANAGE)),
):
    """Add an item to a dropdown field (``project_fields.manage``), appended at the end."""
    field = await _load_dropdown_field(db, field_id)
    name = _trimmed(data.name, EMPTY_OPTION_NAME_DETAIL)
    if await _option_name_taken(db, field.id, name):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=DUPLICATE_OPTION_NAME_DETAIL
        )

    # all_sites omitted + a non-empty site list = restricted to those sites.
    all_sites = data.all_sites
    if "all_sites" not in data.model_fields_set and data.site_ids:
        all_sites = False

    sites: list[Site] = []
    if not all_sites:
        if not data.site_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=OPTION_NO_SITE_DETAIL
            )
        sites = await _load_sites(db, data.site_ids)

    # An item available at every site may carry teams of any site.
    teams = await load_teams(db, data.team_ids or [])
    if not all_sites:
        ensure_teams_within_sites(teams, [s.id for s in sites], team_outside_sites_detail)

    max_order = (
        await db.execute(
            select(func.max(ProjectFieldOption.sort_order)).where(
                ProjectFieldOption.field_id == field.id
            )
        )
    ).scalar()
    option = ProjectFieldOption(
        field_id=field.id,
        name=name,
        color=data.color,
        all_sites=all_sites,
        sort_order=(max_order + 1) if max_order is not None else 0,
        sites=sites,
        teams=teams,
    )
    db.add(option)
    await _commit(db, DUPLICATE_OPTION_NAME_DETAIL)
    await db.refresh(option)
    return option


# Declared before /options/{option_id} for readability; the paths do not overlap.
@router.put("/{field_id}/options/reorder")
async def reorder_project_field_options(
    field_id: int,
    data: ProjectFieldOptionReorder,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(MANAGE)),
):
    """
    Set each listed item's sort_order to its index (``project_fields.manage``).

    Only the field's own items move; other ids are ignored.
    """
    field = await _load_dropdown_field(db, field_id)
    if data.option_order:
        result = await db.execute(
            select(ProjectFieldOption).where(
                ProjectFieldOption.field_id == field.id,
                ProjectFieldOption.id.in_(set(data.option_order)),
            )
        )
        by_id = {o.id: o for o in result.scalars().all()}
        for index, option_id in enumerate(data.option_order):
            if option_id in by_id:
                by_id[option_id].sort_order = index

    await db.commit()
    return {"success": True}


@router.put("/options/{option_id}", response_model=ProjectFieldOptionResponse)
async def update_project_field_option(
    option_id: int,
    data: ProjectFieldOptionUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(MANAGE)),
):
    """
    Update an item (``project_fields.manage``, partial).

    Refused with 409 when the change would strand projects that hold the item:
    restricting it away from a site (or from site-less projects) where
    projects hold it, or limiting it to teams that projects holding it at
    those teams' sites are not part of. ``team_ids`` replaces the item's teams
    (each must be at one of its sites unless it is available at every site);
    narrowing only the sites drops the teams of the removed sites.
    """
    option = await _load_option(db, option_id)

    name: str | None = None
    if data.name is not None:
        name = _trimmed(data.name, EMPTY_OPTION_NAME_DETAIL)
        if name != option.name and await _option_name_taken(
            db, option.field_id, name, exclude_id=option_id
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=DUPLICATE_OPTION_NAME_DETAIL
            )

    # Sites, on the merged state (all_sites=true clears the site list; an
    # omitted all_sites with a non-empty site_ids restricts the item).
    requested_all_sites = _resolve_all_sites(data.all_sites, data.site_ids)
    new_all_sites = requested_all_sites if requested_all_sites is not None else option.all_sites
    sites_change = data.all_sites is not None or data.site_ids is not None
    new_sites: list[Site] = []
    new_site_ids: list[int] = []
    if sites_change and not new_all_sites:
        if data.site_ids is not None:
            if not data.site_ids:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST, detail=OPTION_NO_SITE_DETAIL
                )
            new_sites = await _load_sites(db, data.site_ids)
        else:
            new_sites = list(option.sites)
            if not new_sites:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST, detail=OPTION_NO_SITE_DETAIL
                )
        new_site_ids = [s.id for s in new_sites]
        narrows = option.all_sites or bool(set(option.site_ids) - set(new_site_ids))
        if narrows:
            outside = await count_projects_outside_option_sites(db, option_id, new_site_ids)
            if outside:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=option_other_sites_conflict_detail(outside),
                )

    # Teams, on the merged sites. Without team_ids, a site change silently
    # drops the teams of the removed sites (no query).
    teams_change = data.team_ids is not None
    new_teams = await load_teams(db, data.team_ids or []) if teams_change else list(option.teams)
    if not new_all_sites:
        allowed = new_site_ids if sites_change else option.site_ids
        if teams_change:
            ensure_teams_within_sites(new_teams, allowed, team_outside_sites_detail)
        else:
            new_teams = prune_teams_to_sites(new_teams, allowed)
    if teams_change and set(team_ids_of(new_teams)) != set(option.team_ids):
        outside = await count_projects_outside_option_teams(db, option_id, new_teams)
        if outside:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=option_other_teams_conflict_detail(outside),
            )

    # Every check passed: apply.
    if name is not None:
        option.name = name
    if data.color is not None:
        option.color = data.color
    if sites_change:
        option.all_sites = new_all_sites
        option.sites = new_sites
    if teams_change or sites_change:
        option.teams = new_teams

    await _commit(db, DUPLICATE_OPTION_NAME_DETAIL)
    await db.refresh(option)
    return option


@router.delete("/options/{option_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project_field_option(
    option_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(MANAGE)),
):
    """
    Delete an item (``project_fields.manage``).

    Its site / team links and every project's selection of it go with it
    (ON DELETE CASCADE).
    """
    option = await _load_option(db, option_id)
    await db.delete(option)
    await db.commit()
    return None
