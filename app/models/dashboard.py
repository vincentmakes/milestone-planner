"""
Dashboards (2.1.0): KPI and chart dashboards over the planning data.

A ``Dashboard`` is instance-wide and owned by the person who created it
(``owner_id``, ``ON DELETE SET NULL``: NULL = admin-owned, like the seeded
base dashboard "Overview"). ``visibility`` decides who may open it:
``private`` (the owner), ``roles`` (holders of the roles in
``dashboard_roles``) or ``everyone`` (everyone who may open the view). At most
one dashboard is the default (``is_default``; partial unique index
``dashboards_one_default``). A ``DashboardWidget`` is one tile: its ``kind``
(``kpi``, ``bar``, ``line``, ``pie``, ``table``), a title, and three JSON
texts -- the metric ``query``, the display ``options`` and the grid ``layout``
per breakpoint. Widgets and role links go with their dashboard (ON DELETE
CASCADE); a role link also goes with its role.

The DDL lives in app/services/tenant_provisioner.py
(DASHBOARDS_SCHEMA_STATEMENTS); tests/test_dashboards_schema.py keeps the two
in step.
"""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    false,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.utils import utcnow_naive

DASHBOARD_VISIBILITIES: tuple[str, ...] = ("private", "roles", "everyone")
DASHBOARD_WIDGET_KINDS: tuple[str, ...] = ("kpi", "bar", "line", "pie", "table")


def _in(column: str, values: tuple[str, ...]) -> str:
    """CHECK text ``column IN ('a', 'b')``, spelled exactly as in the DDL."""
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


class Dashboard(Base):
    """A named set of widgets, private to its owner or shared with roles / everyone."""

    __tablename__ = "dashboards"
    __table_args__ = (
        CheckConstraint(
            _in("visibility", DASHBOARD_VISIBILITIES), name="dashboards_visibility_check"
        ),
        Index(
            "dashboards_one_default",
            "is_default",
            unique=True,
            postgresql_where=text("is_default"),
            sqlite_where=text("is_default"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    owner_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    visibility: Mapped[str] = mapped_column(String(10), nullable=False)
    is_default: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false(), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False
    )

    # Loaded with the dashboard (selectin) so responses never trigger a lazy
    # load. Rows go with the dashboard (ON DELETE CASCADE) and with the
    # collection (a save replaces the widgets wholesale).
    widgets: Mapped[list["DashboardWidget"]] = relationship(
        "DashboardWidget",
        lazy="selectin",
        order_by="DashboardWidget.sort_order, DashboardWidget.id",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    roles: Mapped[list["DashboardRole"]] = relationship(
        "DashboardRole",
        lazy="selectin",
        order_by="DashboardRole.role_id",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    @property
    def role_ids(self) -> list[int]:
        """Ids of the roles the dashboard is shared with, ascending."""
        return sorted(link.role_id for link in self.roles)

    def __repr__(self) -> str:
        return f"<Dashboard {self.name} ({self.visibility})>"


class DashboardRole(Base):
    """A role a ``roles``-visibility dashboard is shared with."""

    __tablename__ = "dashboard_roles"
    __table_args__ = (Index("idx_dashboard_roles_role", "role_id"),)

    dashboard_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("dashboards.id", ondelete="CASCADE"),
        primary_key=True,
    )
    role_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("roles.id", ondelete="CASCADE"),
        primary_key=True,
    )

    def __repr__(self) -> str:
        return f"<DashboardRole dashboard={self.dashboard_id} role={self.role_id}>"


class DashboardWidget(Base):
    """One tile of a dashboard: a metric query drawn as a KPI, chart or table."""

    __tablename__ = "dashboard_widgets"
    __table_args__ = (
        CheckConstraint(_in("kind", DASHBOARD_WIDGET_KINDS), name="dashboard_widgets_kind_check"),
        Index("idx_dashboard_widgets_dashboard", "dashboard_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    dashboard_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("dashboards.id", ondelete="CASCADE"),
        nullable=False,
    )
    kind: Mapped[str] = mapped_column(String(12), nullable=False)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    # JSON texts: the metric query, the display options ({} = defaults) and
    # the grid position per breakpoint ({lg: {x, y, w, h}, md: ..., sm: ...}).
    query: Mapped[str] = mapped_column(Text, nullable=False)
    options: Mapped[str] = mapped_column(Text, default="{}", server_default="{}", nullable=False)
    layout: Mapped[str] = mapped_column(Text, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    def __repr__(self) -> str:
        return f"<DashboardWidget {self.title} ({self.kind})>"
