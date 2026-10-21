"""
Tags API endpoints.

Tags are tenant-wide labels assignable to projects. A tag may belong to a tag
group, may be restricted to some sites (``all_sites = false`` + the
``tag_sites`` links) and may be limited to teams (``tag_teams``; a site with
no linked team keeps the whole site). Every user can read them; only ``tags.manage``
manages them.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import contains_eager

from app.database import get_db
from app.middleware.auth import get_current_user, require_permission
from app.models.site import Site
from app.models.tag import Tag, TagGroup
from app.models.user import User
from app.schemas.tag import (
    TagCreate,
    TagListResponse,
    TagReorder,
    TagResponse,
    TagUpdate,
)
from app.services.tag_rules import (
    count_projects_outside_sites,
    count_projects_outside_teams,
    count_projects_with_group_peer,
    group_peer_conflict_detail,
    other_sites_conflict_detail,
    other_teams_conflict_detail,
)
from app.services.team_rules import (
    ensure_teams_within_sites,
    load_teams,
    prune_teams_to_sites,
    team_ids_of,
    team_outside_sites_detail,
)

router = APIRouter(prefix="/tags", tags=["tags"])

DUPLICATE_NAME_DETAIL = "A tag with this name already exists"
EMPTY_NAME_DETAIL = "Tag name cannot be empty"
NO_SITE_DETAIL = "Select at least one site or make the tag available at all sites"
GROUP_NOT_FOUND_DETAIL = "Tag group not found"


async def _name_taken(db: AsyncSession, name: str, exclude_id: int | None = None) -> bool:
    query = select(Tag.id).where(Tag.name == name)
    if exclude_id is not None:
        query = query.where(Tag.id != exclude_id)
    result = await db.execute(query)
    return result.scalar_one_or_none() is not None


async def _load_group(db: AsyncSession, group_id: int) -> TagGroup:
    group = (await db.execute(select(TagGroup).where(TagGroup.id == group_id))).scalar_one_or_none()
    if group is None:
        raise HTTPException(status_code=404, detail=GROUP_NOT_FOUND_DETAIL)
    return group


async def _load_sites(db: AsyncSession, site_ids: list[int]) -> list[Site]:
    """The de-duplicated sites ordered by id; 404 if any does not exist."""
    wanted = sorted(set(site_ids))
    result = await db.execute(select(Site).where(Site.id.in_(wanted)).order_by(Site.id))
    sites = list(result.scalars().all())
    if {s.id for s in sites} != set(wanted):
        raise HTTPException(status_code=404, detail="Site not found")
    return sites


def _resolve_all_sites(requested: bool | None, site_ids: list[int] | None) -> bool | None:
    """
    The effective ``all_sites`` of a request: an explicit value wins; when it
    is omitted, a non-empty ``site_ids`` restricts the tag to those sites
    (``None`` = no site change requested).
    """
    if requested is not None:
        return requested
    if site_ids:
        return False
    return None


async def _commit_tag(db: AsyncSession) -> None:
    """Commit; a unique-name race lost to a concurrent write is a 400, not a 500."""
    try:
        await db.commit()
    except IntegrityError as e:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=DUPLICATE_NAME_DETAIL
        ) from e


async def _next_sort_order(db: AsyncSession, group_id: int | None) -> int:
    """Append position within a group (or among the ungrouped tags)."""
    query = select(func.max(Tag.sort_order))
    if group_id is None:
        query = query.where(Tag.group_id.is_(None))
    else:
        query = query.where(Tag.group_id == group_id)
    max_order = (await db.execute(query)).scalar()
    return (max_order + 1) if max_order is not None else 0


@router.get("", response_model=list[TagListResponse])
async def get_tags(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get all tags (every authenticated user).

    Ordered by group (group order, ungrouped tags last), then the tag order
    within its group, then name.
    """
    # contains_eager: Tag.group is lazy="joined", so without it the explicit
    # outer join (needed for the ordering) would be joined a second time.
    result = await db.execute(
        select(Tag)
        .outerjoin(TagGroup, TagGroup.id == Tag.group_id)
        .options(contains_eager(Tag.group))
        .order_by(
            TagGroup.sort_order.asc().nulls_last(),
            TagGroup.id.asc().nulls_last(),
            Tag.sort_order,
            Tag.name,
        )
    )
    return result.scalars().all()


@router.post("", response_model=TagResponse, status_code=status.HTTP_201_CREATED)
async def create_tag(
    tag_data: TagCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("tags.manage")),
):
    """Create a tag (``tags.manage``), appended at the end of its group."""
    name = tag_data.name.strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EMPTY_NAME_DETAIL)
    if await _name_taken(db, name):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=DUPLICATE_NAME_DETAIL)

    if tag_data.group_id is not None:
        await _load_group(db, tag_data.group_id)

    # all_sites omitted + a non-empty site list = restricted to those sites.
    all_sites = tag_data.all_sites
    if "all_sites" not in tag_data.model_fields_set and tag_data.site_ids:
        all_sites = False

    sites: list[Site] = []
    if not all_sites:
        if not tag_data.site_ids:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=NO_SITE_DETAIL)
        sites = await _load_sites(db, tag_data.site_ids)

    # A tag available at every site may carry teams of any site.
    teams = await load_teams(db, tag_data.team_ids or [])
    if not all_sites:
        ensure_teams_within_sites(teams, [s.id for s in sites], team_outside_sites_detail)

    tag = Tag(
        name=name,
        color=tag_data.color,
        group_id=tag_data.group_id,
        all_sites=all_sites,
        sort_order=await _next_sort_order(db, tag_data.group_id),
        sites=sites,
        teams=teams,
    )
    db.add(tag)
    await _commit_tag(db)
    await db.refresh(tag)

    return tag


# Declared before the /{tag_id} routes so "reorder" is not parsed as an id.
@router.put("/reorder")
async def reorder_tags(
    data: TagReorder,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("tags.manage")),
):
    """Set each listed tag's sort_order to its index (``tags.manage``)."""
    if data.tag_order:
        result = await db.execute(select(Tag).where(Tag.id.in_(data.tag_order)))
        by_id = {t.id: t for t in result.scalars().all()}
        for index, tag_id in enumerate(data.tag_order):
            if tag_id in by_id:
                by_id[tag_id].sort_order = index

    await db.commit()
    return {"success": True}


@router.put("/{tag_id}", response_model=TagResponse)
async def update_tag(
    tag_id: int,
    tag_data: TagUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("tags.manage")),
):
    """
    Update a tag (``tags.manage``, partial).

    Refused with 409 when the change would break projects that already use the
    tag: moving it into a single-select group where a project also holds
    another tag of that group, restricting it away from a site (or from
    site-less projects) where projects use it, or limiting it to teams that
    projects using it at those teams' sites are not part of.

    ``team_ids`` replaces the tag's teams (each must be at one of its sites
    unless it is available at every site); narrowing only the sites drops the
    teams of the removed sites.
    """
    tag = (await db.execute(select(Tag).where(Tag.id == tag_id))).scalar_one_or_none()
    if not tag:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tag not found")

    fields = tag_data.model_fields_set

    name: str | None = None
    if tag_data.name is not None:
        name = tag_data.name.strip()
        if not name:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EMPTY_NAME_DETAIL)
        if name != tag.name and await _name_taken(db, name, exclude_id=tag_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=DUPLICATE_NAME_DETAIL
            )

    # Group: an explicit null ungroups the tag, an omitted field keeps it.
    group_changes = "group_id" in fields and tag_data.group_id != tag.group_id
    new_group_id = tag_data.group_id if group_changes else tag.group_id
    if group_changes and new_group_id is not None:
        group = await _load_group(db, new_group_id)
        if group.single_select:
            peers = await count_projects_with_group_peer(db, tag_id, new_group_id)
            if peers:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=group_peer_conflict_detail(peers),
                )

    # Sites, on the merged state (all_sites=true clears the site list; an
    # omitted all_sites with a non-empty site_ids restricts the tag).
    requested_all_sites = _resolve_all_sites(tag_data.all_sites, tag_data.site_ids)
    new_all_sites = requested_all_sites if requested_all_sites is not None else tag.all_sites
    sites_change = tag_data.all_sites is not None or tag_data.site_ids is not None
    new_sites: list[Site] = []
    new_site_ids: list[int] = []
    if sites_change and not new_all_sites:
        if tag_data.site_ids is not None:
            if not tag_data.site_ids:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=NO_SITE_DETAIL)
            new_sites = await _load_sites(db, tag_data.site_ids)
        else:
            new_sites = list(tag.sites)
            if not new_sites:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=NO_SITE_DETAIL)
        new_site_ids = [s.id for s in new_sites]
        narrows = tag.all_sites or bool(set(tag.site_ids) - set(new_site_ids))
        if narrows:
            outside = await count_projects_outside_sites(db, tag_id, new_site_ids)
            if outside:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=other_sites_conflict_detail(outside),
                )

    # Teams, on the merged sites. Without team_ids, a site change silently
    # drops the teams of the removed sites (no query).
    teams_change = tag_data.team_ids is not None
    new_teams = await load_teams(db, tag_data.team_ids or []) if teams_change else list(tag.teams)
    if not new_all_sites:
        allowed = new_site_ids if sites_change else tag.site_ids
        if teams_change:
            ensure_teams_within_sites(new_teams, allowed, team_outside_sites_detail)
        else:
            new_teams = prune_teams_to_sites(new_teams, allowed)
    if teams_change and set(team_ids_of(new_teams)) != set(tag.team_ids):
        outside = await count_projects_outside_teams(db, tag_id, new_teams)
        if outside:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=other_teams_conflict_detail(outside),
            )

    # Every check passed: apply.
    if name is not None:
        tag.name = name
    if tag_data.color is not None:
        tag.color = tag_data.color
    if group_changes:
        tag.sort_order = await _next_sort_order(db, new_group_id)
        tag.group_id = new_group_id
    if sites_change:
        tag.all_sites = new_all_sites
        tag.sites = new_sites
    if teams_change or sites_change:
        tag.teams = new_teams

    await _commit_tag(db)
    await db.refresh(tag)

    return tag


@router.delete("/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tag(
    tag_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("tags.manage")),
):
    """Delete a tag (``tags.manage``). Cascades to project_tags, tag_sites and tag_teams."""
    result = await db.execute(select(Tag).where(Tag.id == tag_id))
    tag = result.scalar_one_or_none()

    if not tag:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tag not found")

    await db.delete(tag)
    await db.commit()

    return None
