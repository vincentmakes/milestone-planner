"""
Custom Columns API router.
Endpoints for managing custom column definitions and values.
"""

import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import get_current_user, require_admin
from app.models.custom_column import CustomColumn, CustomColumnValue
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

router = APIRouter(prefix="/custom-columns", tags=["Custom Columns"])

# Maximum number of custom columns allowed
MAX_CUSTOM_COLUMNS = 10


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
    _user=Depends(get_current_user),
):
    """
    Get all custom columns and their values for a site.
    This is the main endpoint for initial data loading.
    Returns columns and a flat dictionary of values keyed by "{column_id}-{entity_type}-{entity_id}".
    """
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
    _user=Depends(require_admin),
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


@router.patch("/{column_id}", response_model=CustomColumnResponse)
async def update_custom_column(
    request: Request,
    column_id: int,
    data: CustomColumnUpdate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_admin),
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
    _user=Depends(require_admin),
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


@router.patch("/reorder", response_model=list[CustomColumnResponse])
async def reorder_custom_columns(
    request: Request,
    data: CustomColumnReorderRequest,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_admin),
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


@router.put("/values", response_model=CustomColumnValueResponse)
async def set_custom_column_value(
    request: Request,
    data: CustomColumnValueCreate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """
    Set a custom column value for an entity.
    Creates or updates the value (upsert).
    """
    # Verify the column exists
    col_stmt = select(CustomColumn).where(CustomColumn.id == data.custom_column_id)
    col_result = await db.execute(col_stmt)
    column = col_result.scalar_one_or_none()

    if not column:
        raise HTTPException(status_code=404, detail="Custom column not found")

    # Validate value for boolean type
    if column.column_type == "boolean" and data.value is not None:
        if data.value.lower() not in ("true", "false"):
            raise HTTPException(status_code=400, detail="Boolean values must be 'true' or 'false'")

    # Validate value for list type
    if column.column_type == "list" and data.value is not None:
        options = column.parsed_list_options
        if data.value not in options:
            raise HTTPException(
                status_code=400, detail=f"Value must be one of: {', '.join(options)}"
            )

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
    _user=Depends(get_current_user),
):
    """
    Bulk update custom column values.
    Used for drag-fill and other multi-cell operations.
    """
    results = []

    for update in data.updates:
        # Verify the column exists
        col_stmt = select(CustomColumn).where(CustomColumn.id == update.custom_column_id)
        col_result = await db.execute(col_stmt)
        column = col_result.scalar_one_or_none()

        if not column:
            continue  # Skip invalid columns

        # Check if value already exists
        stmt = select(CustomColumnValue).where(
            and_(
                CustomColumnValue.custom_column_id == update.custom_column_id,
                CustomColumnValue.entity_type == update.entity_type,
                CustomColumnValue.entity_id == update.entity_id,
            )
        )
        result = await db.execute(stmt)
        existing = result.scalar_one_or_none()

        if existing:
            existing.value = update.value
            value_obj = existing
        else:
            value_obj = CustomColumnValue(
                custom_column_id=update.custom_column_id,
                entity_type=update.entity_type,
                entity_id=update.entity_id,
                value=update.value,
            )
            db.add(value_obj)

        await db.flush()
        results.append(value_obj)

    await db.commit()

    # Refresh all objects
    for obj in results:
        await db.refresh(obj)

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
    _user=Depends(get_current_user),
):
    """
    Delete a custom column value.
    """
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
