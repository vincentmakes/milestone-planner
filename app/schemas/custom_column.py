"""
Pydantic schemas for CustomColumns and CustomColumnValues.
"""

from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.base import DateTimeJS

# ---------------------------------------------------------
# Custom Column Schemas
# ---------------------------------------------------------


class CustomColumnBase(BaseModel):
    """Base schema for custom columns."""

    name: str = Field(..., min_length=1, max_length=100)
    column_type: Literal["text", "boolean", "list"] = "text"
    list_options: list[str] | None = None
    width: int = Field(default=120, ge=60, le=400)


class CustomColumnCreate(CustomColumnBase):
    """Request model for creating a custom column."""

    site_id: int | None = None  # None = global (all sites)

    @field_validator("list_options")
    @classmethod
    def validate_list_options(cls, v, info):
        """Ensure list_options is provided for list type columns."""
        # Note: We can't easily access other fields in Pydantic v2 validators
        # This validation is done in the router instead
        return v


class CustomColumnUpdate(BaseModel):
    """Request model for updating a custom column."""

    name: str | None = Field(None, min_length=1, max_length=100)
    list_options: list[str] | None = None
    width: int | None = Field(None, ge=60, le=400)
    # Note: column_type cannot be changed after creation


class CustomColumnResponse(CustomColumnBase):
    """Response model for custom columns."""

    id: int
    site_id: int | None = None
    display_order: int
    created_at: DateTimeJS
    updated_at: DateTimeJS

    class Config:
        from_attributes = True


class CustomColumnReorderRequest(BaseModel):
    """Request model for reordering custom columns."""

    column_order: list[int]  # List of column IDs in new order


# ---------------------------------------------------------
# Custom Column Value Schemas
# ---------------------------------------------------------


class CustomColumnValueBase(BaseModel):
    """Base schema for custom column values."""

    custom_column_id: int
    entity_type: Literal["project", "phase", "subphase"]
    entity_id: int
    value: str | None = None


class CustomColumnValueCreate(CustomColumnValueBase):
    """Request model for creating/updating a custom column value."""

    pass


class CustomColumnValueResponse(CustomColumnValueBase):
    """Response model for custom column values."""

    id: int
    created_at: DateTimeJS
    updated_at: DateTimeJS

    class Config:
        from_attributes = True


class CustomColumnValueBulkUpdate(BaseModel):
    """Request model for bulk updating custom column values (drag-fill)."""

    updates: list[CustomColumnValueCreate]


class CustomColumnValueBatchRequest(BaseModel):
    """Request model for getting values for multiple entities."""

    entity_type: Literal["project", "phase", "subphase"]
    entity_ids: list[int]


# ---------------------------------------------------------
# Combined Response Schemas (for efficient loading)
# ---------------------------------------------------------


class CustomColumnsWithValuesResponse(BaseModel):
    """
    Response containing all custom columns and their values for a site.
    Used for initial data loading.
    """

    columns: list[CustomColumnResponse]
    values: dict[str, str]  # Key format: "{column_id}-{entity_type}-{entity_id}"

    class Config:
        from_attributes = True
