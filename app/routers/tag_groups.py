"""
Tag groups API endpoints.

A tag group bundles project tags (e.g. "Project type"). A single-select group
allows at most one of its tags per project; at most one group "colours
projects" (the colour of the project's tag from that group tints its bar) and
such a group must be single-select. Every user can read groups; only admins
manage them.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import get_current_user, require_admin
from app.models.tag import Tag, TagGroup
from app.models.user import User
from app.schemas.tag import (
    TagGroupCreate,
    TagGroupReorder,
    TagGroupResponse,
    TagGroupUpdate,
)
from app.services.tag_rules import (
    count_projects_with_multiple_group_tags,
    multiple_tags_conflict_detail,
)

router = APIRouter(prefix="/tag-groups", tags=["tag-groups"])

DUPLICATE_NAME_DETAIL = "A tag group with this name already exists"
EMPTY_NAME_DETAIL = "Tag group name cannot be empty"
COLORS_NEED_SINGLE_SELECT_DETAIL = "A group that colours projects must be single-select"
NOT_FOUND_DETAIL = "Tag group not found"
COLORING_TAKEN_DETAIL = "Another group already colours projects"
COLORS_INDEX = "idx_tag_groups_colors_projects"


async def _name_taken(db: AsyncSession, name: str, exclude_id: int | None = None) -> bool:
    query = select(TagGroup.id).where(TagGroup.name == name)
    if exclude_id is not None:
        query = query.where(TagGroup.id != exclude_id)
    result = await db.execute(query)
    return result.scalar_one_or_none() is not None


async def _commit_group(db: AsyncSession) -> None:
    """
    Commit; a race lost to a concurrent write is a 409 when another group took
    the colouring flag first (partial unique index), else a duplicate-name 400.
    """
    try:
        await db.commit()
    except IntegrityError as e:
        await db.rollback()
        if COLORS_INDEX in str(e.orig):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail=COLORING_TAKEN_DETAIL
            ) from e
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=DUPLICATE_NAME_DETAIL
        ) from e


async def _clear_other_coloring_groups(db: AsyncSession, keep_id: int | None) -> None:
    """
    Take the "colours projects" flag off every other group, flushed before the
    caller sets it: the partial unique index allows only one such group.
    """
    query = update(TagGroup).where(TagGroup.colors_projects.is_(True))
    if keep_id is not None:
        query = query.where(TagGroup.id != keep_id)
    await db.execute(
        query.values(colors_projects=False).execution_options(synchronize_session="fetch")
    )
    await db.flush()


@router.get("", response_model=list[TagGroupResponse])
async def get_tag_groups(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get all tag groups in display order (every authenticated user)."""
    result = await db.execute(select(TagGroup).order_by(TagGroup.sort_order, TagGroup.id))
    return result.scalars().all()


@router.post("", response_model=TagGroupResponse, status_code=status.HTTP_201_CREATED)
async def create_tag_group(
    data: TagGroupCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Create a tag group, appended at the end (admin only)."""
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EMPTY_NAME_DETAIL)
    if await _name_taken(db, name):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=DUPLICATE_NAME_DETAIL)
    if data.colors_projects and not data.single_select:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=COLORS_NEED_SINGLE_SELECT_DETAIL
        )

    if data.colors_projects:
        await _clear_other_coloring_groups(db, keep_id=None)

    max_order = (await db.execute(select(func.max(TagGroup.sort_order)))).scalar()
    group = TagGroup(
        name=name,
        single_select=data.single_select,
        colors_projects=data.colors_projects,
        sort_order=(max_order + 1) if max_order is not None else 0,
    )
    db.add(group)
    await _commit_group(db)
    await db.refresh(group)
    return group


# Declared before the /{group_id} routes so "reorder" is not parsed as an id.
@router.put("/reorder")
async def reorder_tag_groups(
    data: TagGroupReorder,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Set each listed group's sort_order to its index (admin only)."""
    if data.group_order:
        result = await db.execute(select(TagGroup).where(TagGroup.id.in_(data.group_order)))
        by_id = {g.id: g for g in result.scalars().all()}
        for index, group_id in enumerate(data.group_order):
            if group_id in by_id:
                by_id[group_id].sort_order = index

    await db.commit()
    return {"success": True}


@router.put("/{group_id}", response_model=TagGroupResponse)
async def update_tag_group(
    group_id: int,
    data: TagGroupUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """
    Update a tag group (admin only, partial; rules checked on the merged state).

    Making a group single-select is refused with 409 while any project holds
    more than one of its tags. Making it the colouring group takes the flag
    off the previous one.
    """
    group = (await db.execute(select(TagGroup).where(TagGroup.id == group_id))).scalar_one_or_none()
    if group is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND_DETAIL)

    name: str | None = None
    if data.name is not None:
        name = data.name.strip()
        if not name:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EMPTY_NAME_DETAIL)
        if name != group.name and await _name_taken(db, name, exclude_id=group_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=DUPLICATE_NAME_DETAIL
            )

    single_select = data.single_select if data.single_select is not None else group.single_select
    colors_projects = (
        data.colors_projects if data.colors_projects is not None else group.colors_projects
    )
    if colors_projects and not single_select:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=COLORS_NEED_SINGLE_SELECT_DETAIL
        )

    if single_select and not group.single_select:
        conflicts = await count_projects_with_multiple_group_tags(db, group_id)
        if conflicts:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=multiple_tags_conflict_detail(conflicts),
            )

    # Before touching this group's attributes (autoflush would write them first).
    if colors_projects and not group.colors_projects:
        await _clear_other_coloring_groups(db, keep_id=group_id)

    if name is not None:
        group.name = name
    group.single_select = single_select
    group.colors_projects = colors_projects

    await _commit_group(db)
    await db.refresh(group)
    return group


@router.delete("/{group_id}")
async def delete_tag_group(
    group_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """
    Delete a tag group (admin only). Its tags stay, ungrouped (the FK is
    ON DELETE SET NULL; cleared here too so loaded tags are consistent).

    The ungrouped pool is renumbered 0..n-1 so the sort orders do not collide:
    the tags already ungrouped first, in their current order, then the tags of
    the deleted group, in their former order.
    """
    group = (await db.execute(select(TagGroup).where(TagGroup.id == group_id))).scalar_one_or_none()
    if group is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND_DETAIL)

    display_order = (Tag.sort_order, Tag.name, Tag.id)
    ungrouped = (
        (await db.execute(select(Tag).where(Tag.group_id.is_(None)).order_by(*display_order)))
        .scalars()
        .all()
    )
    moved = (
        (await db.execute(select(Tag).where(Tag.group_id == group_id).order_by(*display_order)))
        .scalars()
        .all()
    )
    for tag in moved:
        tag.group = None
        tag.group_id = None
    for index, tag in enumerate([*ungrouped, *moved]):
        tag.sort_order = index

    await db.delete(group)
    await db.commit()
    return {"success": True}
