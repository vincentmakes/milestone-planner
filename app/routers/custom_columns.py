"""
Custom Columns API router.
Endpoints for managing custom column definitions and values.
"""

import json
from collections.abc import Iterable

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import ColumnElement, and_, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import get_current_user, require_permission
from app.models.custom_column import CustomColumn, CustomColumnValue
from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.user import User
from app.schemas.custom_column import (
    CustomColumnCreate,
    CustomColumnReorderRequest,
    CustomColumnResponse,
    CustomColumnsWithValuesResponse,
    CustomColumnUpdate,
    CustomColumnValueBulkUpdate,
    CustomColumnValueCreate,
    CustomColumnValueResponse,
)
from app.services.permissions import permission_required_detail
from app.services.site_access import (
    ensure_project_visible,
    ensure_site_visible,
    visible_site_ids,
    visible_sites_clause,
)

router = APIRouter(prefix="/custom-columns", tags=["Custom Columns"])

# Maximum number of custom columns allowed
MAX_CUSTOM_COLUMNS = 10

SET_VALUES_KEY = "custom_columns.set_values"


async def _ensure_may_set_values(
    request: Request, db: AsyncSession, user: User, entities: Iterable[tuple[str, int]]
) -> None:
    """
    403 unless the user may write values on every given (entity_type, id).

    ``custom_columns.set_values`` writes on any project; without it, the PM
    bundle lends it on the projects the user manages: every entity must
    resolve to such a project. Either way the entities' projects must be at
    the user's visible sites (403). ``set_values`` with ``sites.view_all``
    needs no query; otherwise one query per entity type (phase, subphase)
    resolves the projects, one more reads the PM projects' managers, and
    ``ensure_project_visible`` checks each project's site.
    """
    permissions = user.permissions
    holds = permissions.has(SET_VALUES_KEY)
    denied = HTTPException(status_code=403, detail=permission_required_detail(SET_VALUES_KEY))
    if not holds and not permissions.has("projects.manage_as_pm"):
        raise denied
    scoped = await visible_site_ids(request, db, user) is not None
    if holds and not scoped:
        return

    wanted: dict[str, set[int]] = {}
    for entity_type, entity_id in entities:
        wanted.setdefault(entity_type, set()).add(entity_id)
    if not wanted:
        return
    if set(wanted) - {"project", "phase", "subphase"} and not holds:
        raise denied

    project_ids: set[int] = set(wanted.get("project", set()))
    for entity_type, model in (("phase", ProjectPhase), ("subphase", ProjectSubphase)):
        ids = wanted.get(entity_type)
        if not ids:
            continue
        rows = (await db.execute(select(model.id, model.project_id).where(model.id.in_(ids)))).all()
        if len(rows) != len(ids) and not holds:
            raise denied
        project_ids.update(project_id for _, project_id in rows)

    if not holds:
        rows = (
            await db.execute(select(Project.id, Project.pm_id).where(Project.id.in_(project_ids)))
        ).all()
        if len(rows) != len(project_ids) or not all(
            permissions.can(SET_VALUES_KEY, pm_id=pm_id, user_id=user.id) for _, pm_id in rows
        ):
            raise denied

    if scoped:
        for project_id in sorted(project_ids):
            await ensure_project_visible(request, db, user, project_id)


def _readable_values_clause(visible: frozenset[int] | None) -> ColumnElement[bool] | None:
    """Values whose project (directly, or through its phase/subphase) is at a visible site."""
    in_visible = visible_sites_clause(Project.site_id, visible)
    if in_visible is None:
        return None
    projects = select(Project.id).where(in_visible)
    return or_(
        and_(CustomColumnValue.entity_type == "project", CustomColumnValue.entity_id.in_(projects)),
        and_(
            CustomColumnValue.entity_type == "phase",
            CustomColumnValue.entity_id.in_(
                select(ProjectPhase.id).where(ProjectPhase.project_id.in_(projects))
            ),
        ),
        and_(
            CustomColumnValue.entity_type == "subphase",
            CustomColumnValue.entity_id.in_(
                select(ProjectSubphase.id).where(ProjectSubphase.project_id.in_(projects))
            ),
        ),
    )


# ---------------------------------------------------------
# Column Management Endpoints
# ---------------------------------------------------------


@router.get("", response_model=list[CustomColumnResponse])
async def get_custom_columns(
    request: Request,
    site_id: int | None = Query(None, description="Filter by site ID"),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """
    Get all custom columns for a site.
    Returns both site-specific columns and global columns.
    """
    # Build query for columns that are either:
    # 1. Global (site_id is NULL)
    # 2. Specific to the requested site
    if site_id:
        stmt = (
            select(CustomColumn)
            .where(or_(CustomColumn.site_id.is_(None), CustomColumn.site_id == site_id))
            .order_by(CustomColumn.display_order, CustomColumn.id)
        )
    else:
        # If no site_id provided, return only global columns
        stmt = (
            select(CustomColumn)
            .where(CustomColumn.site_id.is_(None))
            .order_by(CustomColumn.display_order, CustomColumn.id)
        )

    result = await db.execute(stmt)
    columns = result.scalars().all()

    # Convert to response format
    return [
        CustomColumnResponse(
            id=col.id,
            name=col.name,
            column_type=col.column_type,
            list_options=col.parsed_list_options if col.list_options else None,
            site_id=col.site_id,
            display_order=col.display_order,
            width=col.width,
            created_at=col.created_at,
            updated_at=col.updated_at,
        )
        for col in columns
    ]


@router.get("/with-values", response_model=CustomColumnsWithValuesResponse)
async def get_custom_columns_with_values(
    request: Request,
    site_id: int = Query(..., description="Site ID to get columns for"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get all custom columns and their values for a visible site (403 otherwise).
    This is the main endpoint for initial data loading.
    Returns columns and a flat dictionary of values keyed by "{column_id}-{entity_type}-{entity_id}",
    limited to the entities of projects at the user's visible sites.
    """
    await ensure_site_visible(request, db, user, site_id)
    # Get columns
    stmt = (
        select(CustomColumn)
        .where(or_(CustomColumn.site_id.is_(None), CustomColumn.site_id == site_id))
        .order_by(CustomColumn.display_order, CustomColumn.id)
    )

    result = await db.execute(stmt)
    columns = result.scalars().all()

    # Get column IDs
    column_ids = [col.id for col in columns]

    # Get all values for these columns
    values_dict = {}
    if column_ids:
        values_stmt = select(CustomColumnValue).where(
            CustomColumnValue.custom_column_id.in_(column_ids)
        )
        readable = _readable_values_clause(await visible_site_ids(request, db, user))
        if readable is not None:
            values_stmt = values_stmt.where(readable)
        values_result = await db.execute(values_stmt)
        values = values_result.scalars().all()

        for val in values:
            key = f"{val.custom_column_id}-{val.entity_type}-{val.entity_id}"
            values_dict[key] = val.value

    return CustomColumnsWithValuesResponse(
        columns=[
            CustomColumnResponse(
                id=col.id,
                name=col.name,
                column_type=col.column_type,
                list_options=col.parsed_list_options if col.list_options else None,
                site_id=col.site_id,
                display_order=col.display_order,
                width=col.width,
                created_at=col.created_at,
                updated_at=col.updated_at,
            )
            for col in columns
        ],
        values=values_dict,
    )


@router.post("", response_model=CustomColumnResponse)
async def create_custom_column(
    request: Request,
    data: CustomColumnCreate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_permission("custom_columns.manage")),
):
    """
    Create a new custom column.
    Only admins can create custom columns.
    """
    # Validate list_options for list type
    if data.column_type == "list":
        if not data.list_options or len(data.list_options) == 0:
            raise HTTPException(
                status_code=400, detail="list_options is required for list type columns"
            )

    # Check column limit
    if data.site_id:
        # Count columns for this site (including global)
        count_stmt = select(CustomColumn).where(
            or_(CustomColumn.site_id.is_(None), CustomColumn.site_id == data.site_id)
        )
    else:
        # Count global columns
        count_stmt = select(CustomColumn).where(CustomColumn.site_id.is_(None))

    result = await db.execute(count_stmt)
    existing_count = len(result.scalars().all())

    if existing_count >= MAX_CUSTOM_COLUMNS:
        raise HTTPException(
            status_code=400, detail=f"Maximum of {MAX_CUSTOM_COLUMNS} custom columns allowed"
        )

    # Get the next display order
    order_stmt = (
        select(CustomColumn.display_order).order_by(CustomColumn.display_order.desc()).limit(1)
    )
    order_result = await db.execute(order_stmt)
    max_order = order_result.scalar() or 0

    # Create the column
    column = CustomColumn(
        name=data.name,
        column_type=data.column_type,
        list_options=json.dumps(data.list_options) if data.list_options else None,
        site_id=data.site_id,
        display_order=max_order + 1,
        width=data.width,
    )

    db.add(column)
    await db.commit()
    await db.refresh(column)

    return CustomColumnResponse(
        id=column.id,
        name=column.name,
        column_type=column.column_type,
        list_options=column.parsed_list_options if column.list_options else None,
        site_id=column.site_id,
        display_order=column.display_order,
        width=column.width,
        created_at=column.created_at,
        updated_at=column.updated_at,
    )


# Registered before PATCH /{column_id}: Starlette matches routes in order, and
# "/reorder" would otherwise be captured by the parameterised route and fail
# the int conversion with a 422.
@router.patch("/reorder", response_model=list[CustomColumnResponse])
async def reorder_custom_columns(
    request: Request,
    data: CustomColumnReorderRequest,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_permission("custom_columns.manage")),
):
    """
    Reorder custom columns by providing a list of column IDs in the new order.
    """
    # Get all columns that need to be reordered
    stmt = select(CustomColumn).where(CustomColumn.id.in_(data.column_order))
    result = await db.execute(stmt)
    columns = {col.id: col for col in result.scalars().all()}

    # Update display_order based on position in the list
    for index, column_id in enumerate(data.column_order):
        if column_id in columns:
            columns[column_id].display_order = index

    await db.commit()

    # Return updated columns
    stmt = (
        select(CustomColumn)
        .where(CustomColumn.id.in_(data.column_order))
        .order_by(CustomColumn.display_order)
    )
    result = await db.execute(stmt)
    updated_columns = result.scalars().all()

    return [
        CustomColumnResponse(
            id=col.id,
            name=col.name,
            column_type=col.column_type,
            list_options=col.parsed_list_options if col.list_options else None,
            site_id=col.site_id,
            display_order=col.display_order,
            width=col.width,
            created_at=col.created_at,
            updated_at=col.updated_at,
        )
        for col in updated_columns
    ]


# ---------------------------------------------------------
# Value Management Endpoints
# ---------------------------------------------------------


@router.patch("/{column_id}", response_model=CustomColumnResponse)
async def update_custom_column(
    request: Request,
    column_id: int,
    data: CustomColumnUpdate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_permission("custom_columns.manage")),
):
    """
    Update a custom column.
    Note: column_type cannot be changed after creation.
    """
    stmt = select(CustomColumn).where(CustomColumn.id == column_id)
    result = await db.execute(stmt)
    column = result.scalar_one_or_none()

    if not column:
        raise HTTPException(status_code=404, detail="Custom column not found")

    # Update allowed fields
    if data.name is not None:
        column.name = data.name

    if data.list_options is not None:
        if column.column_type != "list":
            raise HTTPException(
                status_code=400, detail="list_options can only be set for list type columns"
            )
        column.list_options = json.dumps(data.list_options)

    if data.width is not None:
        column.width = data.width

    await db.commit()
    await db.refresh(column)

    return CustomColumnResponse(
        id=column.id,
        name=column.name,
        column_type=column.column_type,
        list_options=column.parsed_list_options if column.list_options else None,
        site_id=column.site_id,
        display_order=column.display_order,
        width=column.width,
        created_at=column.created_at,
        updated_at=column.updated_at,
    )


@router.delete("/{column_id}")
async def delete_custom_column(
    request: Request,
    column_id: int,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_permission("custom_columns.manage")),
):
    """
    Delete a custom column and all its values.
    Only admins can delete custom columns.
    """
    stmt = select(CustomColumn).where(CustomColumn.id == column_id)
    result = await db.execute(stmt)
    column = result.scalar_one_or_none()

    if not column:
        raise HTTPException(status_code=404, detail="Custom column not found")

    await db.delete(column)
    await db.commit()

    return {"success": True, "message": "Custom column deleted"}


def _validate_value(column: CustomColumn, value: str | None) -> None:
    """400 unless ``value`` fits the column type (null always clears)."""
    if value is None:
        return
    if column.column_type == "boolean" and value.lower() not in ("true", "false"):
        raise HTTPException(status_code=400, detail="Boolean values must be 'true' or 'false'")
    if column.column_type == "list":
        options = column.parsed_list_options
        if value not in options:
            raise HTTPException(
                status_code=400, detail=f"Value must be one of: {', '.join(options)}"
            )


@router.put("/values", response_model=CustomColumnValueResponse)
async def set_custom_column_value(
    request: Request,
    data: CustomColumnValueCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Set a custom column value for an entity.
    Creates or updates the value (upsert). ``custom_columns.set_values``, or
    the PM bundle on the entity's project.
    """
    await _ensure_may_set_values(request, db, user, [(data.entity_type, data.entity_id)])
    # Verify the column exists
    col_stmt = select(CustomColumn).where(CustomColumn.id == data.custom_column_id)
    col_result = await db.execute(col_stmt)
    column = col_result.scalar_one_or_none()

    if not column:
        raise HTTPException(status_code=404, detail="Custom column not found")

    _validate_value(column, data.value)

    # Check if value already exists
    stmt = select(CustomColumnValue).where(
        and_(
            CustomColumnValue.custom_column_id == data.custom_column_id,
            CustomColumnValue.entity_type == data.entity_type,
            CustomColumnValue.entity_id == data.entity_id,
        )
    )
    result = await db.execute(stmt)
    existing = result.scalar_one_or_none()

    if existing:
        # Update existing value
        existing.value = data.value
        value_obj = existing
    else:
        # Create new value
        value_obj = CustomColumnValue(
            custom_column_id=data.custom_column_id,
            entity_type=data.entity_type,
            entity_id=data.entity_id,
            value=data.value,
        )
        db.add(value_obj)

    await db.commit()
    await db.refresh(value_obj)

    return CustomColumnValueResponse(
        id=value_obj.id,
        custom_column_id=value_obj.custom_column_id,
        entity_type=value_obj.entity_type,
        entity_id=value_obj.entity_id,
        value=value_obj.value,
        created_at=value_obj.created_at,
        updated_at=value_obj.updated_at,
    )


@router.put("/values/batch", response_model=list[CustomColumnValueResponse])
async def set_custom_column_values_batch(
    request: Request,
    data: CustomColumnValueBulkUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Bulk update custom column values.
    Used for drag-fill and other multi-cell operations.

    Values are validated exactly like the single write (400 for the whole
    batch, nothing written); updates for a column that no longer exists are
    skipped, as before. At most MAX_BATCH_UPDATES updates per request
    (schema-enforced, 422); one query loads the columns and one query per
    column the existing values. A key repeated in the batch is written once
    (last one wins).
    """
    # Last write wins for a repeated (column, entity) key.
    updates: dict[tuple[int, str, int], str | None] = {}
    for item in data.updates:
        updates[(item.custom_column_id, item.entity_type, item.entity_id)] = item.value

    await _ensure_may_set_values(
        request, db, user, [(etype, eid) for (_cid, etype, eid) in updates]
    )

    column_ids = sorted({key[0] for key in updates})
    columns: dict[int, CustomColumn] = {}
    if column_ids:
        col_result = await db.execute(select(CustomColumn).where(CustomColumn.id.in_(column_ids)))
        columns = {col.id: col for col in col_result.scalars().all()}

    # Validate everything before writing anything.
    for (column_id, _entity_type, _entity_id), value in updates.items():
        column = columns.get(column_id)
        if column is not None:
            _validate_value(column, value)

    results: list[CustomColumnValue] = []
    for column_id in column_ids:
        if column_id not in columns:
            continue  # Skip invalid columns
        keys = [(etype, eid) for (cid, etype, eid) in updates if cid == column_id]
        existing_result = await db.execute(
            select(CustomColumnValue).where(
                CustomColumnValue.custom_column_id == column_id,
                tuple_(CustomColumnValue.entity_type, CustomColumnValue.entity_id).in_(keys),
            )
        )
        existing = {(v.entity_type, v.entity_id): v for v in existing_result.scalars().all()}

        for entity_type, entity_id in keys:
            value = updates[(column_id, entity_type, entity_id)]
            value_obj = existing.get((entity_type, entity_id))
            if value_obj is not None:
                value_obj.value = value
            else:
                value_obj = CustomColumnValue(
                    custom_column_id=column_id,
                    entity_type=entity_type,
                    entity_id=entity_id,
                    value=value,
                )
                db.add(value_obj)
            results.append(value_obj)

    # The session does not expire on commit and the timestamps are Python-side
    # defaults, so ids and timestamps are on the objects after the flush --
    # no per-row refresh.
    await db.flush()
    await db.commit()

    return [
        CustomColumnValueResponse(
            id=val.id,
            custom_column_id=val.custom_column_id,
            entity_type=val.entity_type,
            entity_id=val.entity_id,
            value=val.value,
            created_at=val.created_at,
            updated_at=val.updated_at,
        )
        for val in results
    ]


@router.delete("/values/{column_id}/{entity_type}/{entity_id}")
async def delete_custom_column_value(
    request: Request,
    column_id: int,
    entity_type: str,
    entity_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Delete a custom column value (same rule as setting one).
    """
    await _ensure_may_set_values(request, db, user, [(entity_type, entity_id)])
    stmt = select(CustomColumnValue).where(
        and_(
            CustomColumnValue.custom_column_id == column_id,
            CustomColumnValue.entity_type == entity_type,
            CustomColumnValue.entity_id == entity_id,
        )
    )
    result = await db.execute(stmt)
    value = result.scalar_one_or_none()

    if not value:
        raise HTTPException(status_code=404, detail="Custom column value not found")

    await db.delete(value)
    await db.commit()

    return {"success": True, "message": "Custom column value deleted"}
