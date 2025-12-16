"""
CustomColumn and CustomColumnValue models.
Implements user-definable columns for projects, phases, and subphases.
"""

import json
from datetime import datetime
from typing import TYPE_CHECKING, List, Optional

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.site import Site


class CustomColumn(Base):
    """
    Custom column definition.
    Defines a column that can be added to projects, phases, and subphases.
    Columns always apply to all entity types within their scope (site or global).
    """

    __tablename__ = "custom_columns"
    __table_args__ = (
        CheckConstraint(
            "column_type IN ('text', 'boolean', 'list')",
            name="custom_columns_type_check"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    column_type: Mapped[str] = mapped_column(
        String(20), nullable=False, default="text"
    )  # 'text', 'boolean', 'list'
    
    # For list type: JSON array of options ["Low", "Medium", "High"]
    list_options: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    
    # Scope: site_id = None means global (all sites)
    site_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("sites.id", ondelete="CASCADE"),
        nullable=True,
    )
    
    # Display configuration
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    width: Mapped[int] = mapped_column(Integer, default=120, nullable=False)
    
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    # Relationships
    site: Mapped[Optional["Site"]] = relationship("Site", back_populates="custom_columns")
    values: Mapped[List["CustomColumnValue"]] = relationship(
        "CustomColumnValue",
        back_populates="column",
        cascade="all, delete-orphan",
    )

    @property
    def parsed_list_options(self) -> List[str]:
        """Parse list_options from JSON string."""
        if self.list_options:
            try:
                return json.loads(self.list_options)
            except json.JSONDecodeError:
                return []
        return []

    def set_list_options(self, options: List[str]) -> None:
        """Set list_options as JSON string."""
        self.list_options = json.dumps(options) if options else None

    @property
    def is_global(self) -> bool:
        """Check if this column is global (applies to all sites)."""
        return self.site_id is None

    def __repr__(self) -> str:
        scope = "global" if self.is_global else f"site:{self.site_id}"
        return f"<CustomColumn {self.name} ({self.column_type}, {scope})>"


class CustomColumnValue(Base):
    """
    Custom column value for a specific entity (project, phase, or subphase).
    Uses a polymorphic approach with entity_type and entity_id.
    """

    __tablename__ = "custom_column_values"
    __table_args__ = (
        CheckConstraint(
            "entity_type IN ('project', 'phase', 'subphase')",
            name="custom_column_values_entity_type_check"
        ),
        # Unique constraint: one value per column per entity
        UniqueConstraint(
            "custom_column_id", "entity_type", "entity_id",
            name="uq_custom_column_value_entity"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    
    custom_column_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("custom_columns.id", ondelete="CASCADE"),
        nullable=False,
    )
    
    # Polymorphic reference to the entity
    entity_type: Mapped[str] = mapped_column(
        String(20), nullable=False
    )  # 'project', 'phase', 'subphase'
    entity_id: Mapped[int] = mapped_column(Integer, nullable=False)
    
    # Value stored as string, parsed based on column type
    # - text: stored as-is
    # - boolean: "true" or "false"
    # - list: stored as the selected option string
    value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    # Relationships
    column: Mapped["CustomColumn"] = relationship(
        "CustomColumn", back_populates="values"
    )

    @property
    def typed_value(self):
        """Get the value cast to the appropriate type based on column type."""
        if self.value is None:
            return None
        
        if self.column.column_type == "boolean":
            return self.value.lower() == "true"
        elif self.column.column_type == "list":
            # Return the string value for list type
            return self.value
        else:
            # text type
            return self.value

    def set_typed_value(self, val) -> None:
        """Set value from a typed input."""
        if val is None:
            self.value = None
        elif isinstance(val, bool):
            self.value = "true" if val else "false"
        else:
            self.value = str(val)

    def __repr__(self) -> str:
        return f"<CustomColumnValue col:{self.custom_column_id} {self.entity_type}:{self.entity_id}={self.value}>"
