"""
app.services.tenant_data_migrations.run_data_migrations -- the runtime half of
the B2-8 / B2-14 / B2-20 schema changes, called from the tenant auto-migration
(and the single-tenant startup) with the same SQLAlchemy AsyncConnection.

Mock connection: each step's SQL is recognised by its text, so the tests pin
what runs, what is skipped, and that a failing step never stops the others.
"""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services import tenant_data_migrations as tdm
from app.services.dashboard_seed import ABSORPTION_WIDGET_TITLE, CAPACITY_DASHBOARD_NAME
from app.services.tenant_provisioner import (
    ABSORPTION_EXAMPLE_MARKER_KEY,
    ABSORPTION_EXAMPLE_MARKER_SQL,
    APPROVAL_REQUESTS_ORPHAN_CLEANUP_SQL,
    ASSIGNMENT_APPROVAL_TABLES,
    CAPACITY_DASHBOARD_FIND_SQL,
    CARD_COMMENTS_AUTHOR_FK_NEEDS_FIX_SQL,
    CARD_COMMENTS_AUTHOR_FK_SQL,
    CARD_COMMENTS_ORPHAN_CLEANUP_SQL,
    CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL,
    DASHBOARD_TOUCH_SQL,
    DASHBOARD_WIDGET_LAYOUTS_SQL,
    DASHBOARD_WIDGET_SEED_SQL,
    DASHBOARD_WIDGET_TITLE_PROBE_SQL,
    PENDING_ASSIGNMENT_ORPHAN_CLEANUP_SQL,
    PROJECTS_SITE_FK_NEEDS_FIX_SQL,
    PROJECTS_SITE_FK_SQL,
    RBAC_SEED_NEEDED_SQL,
    STALE_APPROVAL_POINTER_CLEANUP_SQL,
)


class FakeConn:
    """Records executed SQL; ``needs_fix`` / ``rowcounts`` / ``fail`` script results."""

    def __init__(self, needs_fix=None, rowcounts=None, fail=()):
        self.needs_fix = needs_fix or {}
        self.rowcounts = rowcounts or {}
        self.fail = set(fail)
        self.executed: list[str] = []
        self.commit = AsyncMock()
        self.rollback = AsyncMock()
        self.engine = MagicMock()
        self.engine.url.database = "milestone_test"

    async def execute(self, clause):
        sql = str(clause)
        self.executed.append(sql)
        if sql in self.fail:
            raise RuntimeError("boom")
        result = MagicMock()
        # The absorption marker is claimed (a row back) unless a test says otherwise.
        claim = ABSORPTION_EXAMPLE_MARKER_KEY if sql == ABSORPTION_EXAMPLE_MARKER_SQL else False
        result.scalar.return_value = self.needs_fix.get(sql, claim)
        result.rowcount = self.rowcounts.get(sql, 0)
        return result


@pytest.mark.asyncio
async def test_fk_rewrites_run_only_when_needed():
    conn = FakeConn(needs_fix={PROJECTS_SITE_FK_NEEDS_FIX_SQL: True})

    await tdm.run_data_migrations(conn)

    assert PROJECTS_SITE_FK_SQL in conn.executed
    assert CARD_COMMENTS_AUTHOR_FK_NEEDS_FIX_SQL in conn.executed
    assert CARD_COMMENTS_AUTHOR_FK_SQL not in conn.executed


@pytest.mark.asyncio
async def test_clean_database_only_checks_and_cleans():
    conn = FakeConn()

    await tdm.run_data_migrations(conn)

    assert conn.executed == [
        PROJECTS_SITE_FK_NEEDS_FIX_SQL,
        CARD_COMMENTS_AUTHOR_FK_NEEDS_FIX_SQL,
        RBAC_SEED_NEEDED_SQL,
        CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL,
        CARD_COMMENTS_ORPHAN_CLEANUP_SQL,
        APPROVAL_REQUESTS_ORPHAN_CLEANUP_SQL,
        *PENDING_ASSIGNMENT_ORPHAN_CLEANUP_SQL,
        *STALE_APPROVAL_POINTER_CLEANUP_SQL,
        # The absorption example: the marker claimed, no "Capacity and
        # flows" found.
        ABSORPTION_EXAMPLE_MARKER_SQL,
        CAPACITY_DASHBOARD_FIND_SQL,
    ]
    conn.rollback.assert_not_awaited()


@pytest.mark.asyncio
async def test_every_fix_is_committed():
    conn = FakeConn(
        needs_fix={
            PROJECTS_SITE_FK_NEEDS_FIX_SQL: True,
            CARD_COMMENTS_AUTHOR_FK_NEEDS_FIX_SQL: True,
        }
    )

    await tdm.run_data_migrations(conn)

    assert CARD_COMMENTS_AUTHOR_FK_SQL in conn.executed
    # Two FK fixes + nine cleanups + the absorption marker, each in its own transaction.
    assert conn.commit.await_count == 12


@pytest.mark.asyncio
async def test_a_failing_step_is_rolled_back_and_the_rest_still_run(caplog):
    conn = FakeConn(
        needs_fix={PROJECTS_SITE_FK_NEEDS_FIX_SQL: True},
        fail={PROJECTS_SITE_FK_SQL},
    )

    await tdm.run_data_migrations(conn)  # never raises

    conn.rollback.assert_awaited()
    assert CARD_COMMENTS_AUTHOR_FK_NEEDS_FIX_SQL in conn.executed
    assert CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL in conn.executed
    assert CARD_COMMENTS_ORPHAN_CLEANUP_SQL in conn.executed
    assert "warning for milestone_test" in caplog.text


@pytest.mark.asyncio
async def test_removed_orphans_are_logged(caplog):
    caplog.set_level("INFO", logger=tdm.__name__)
    conn = FakeConn(rowcounts={CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL: 12})

    await tdm.run_data_migrations(conn)

    assert "removed 12 orphaned custom-column value(s)" in caplog.text
    assert "card comment" not in caplog.text


def _norm(sql: str) -> str:
    return " ".join(sql.split())


def test_pending_rows_of_closed_requests_are_removed_per_table():
    assert len(PENDING_ASSIGNMENT_ORPHAN_CLEANUP_SQL) == len(ASSIGNMENT_APPROVAL_TABLES)
    for table, sql in zip(
        ASSIGNMENT_APPROVAL_TABLES, PENDING_ASSIGNMENT_ORPHAN_CLEANUP_SQL, strict=False
    ):
        assert _norm(sql) == (
            f"DELETE FROM {table} a WHERE a.approval_status = 'pending' "
            "AND NOT EXISTS (SELECT 1 FROM approval_requests r "
            "WHERE r.id = a.approval_request_id AND r.status = 'pending')"
        )


def test_approved_rows_stop_pointing_at_closed_requests_per_table():
    assert len(STALE_APPROVAL_POINTER_CLEANUP_SQL) == len(ASSIGNMENT_APPROVAL_TABLES)
    for table, sql in zip(
        ASSIGNMENT_APPROVAL_TABLES, STALE_APPROVAL_POINTER_CLEANUP_SQL, strict=False
    ):
        assert _norm(sql) == (
            f"UPDATE {table} a SET approval_request_id = NULL "
            "WHERE a.approval_status = 'approved' AND a.approval_request_id IS NOT NULL "
            "AND NOT EXISTS (SELECT 1 FROM approval_requests r "
            "WHERE r.id = a.approval_request_id AND r.status = 'pending')"
        )


@pytest.mark.asyncio
async def test_row_cleanups_run_after_the_request_expiry_and_log(caplog):
    caplog.set_level("INFO", logger=tdm.__name__)
    first = PENDING_ASSIGNMENT_ORPHAN_CLEANUP_SQL[0]
    conn = FakeConn(rowcounts={first: 2})

    await tdm.run_data_migrations(conn)

    expiry = conn.executed.index(APPROVAL_REQUESTS_ORPHAN_CLEANUP_SQL)
    assert conn.executed.index(first) > expiry
    assert "removed 2 orphaned pending booking(s)" in caplog.text


# --- The absorption example (2.6.0), once per instance -----------------------


class ExampleConn:
    """
    Answers the absorption step by SQL text: the marker claim (a row back
    unless the marker is already there, `marker`), the built-in
    dashboard's id, whether its widgets hold the title, and their layouts.
    Records every statement with its bound values.
    """

    def __init__(self, marker=False, dashboard_id=7, has_title=False, rows=(), fail=()):
        self.marker = marker
        self.dashboard_id = dashboard_id
        self.has_title = has_title
        self.rows = list(rows)
        self.fail = set(fail)
        self.executed: list[tuple[str, dict]] = []
        self.commit = AsyncMock()
        self.rollback = AsyncMock()
        self.engine = MagicMock()
        self.engine.url.database = "milestone_test"

    async def execute(self, clause):
        sql = str(clause)
        self.executed.append((sql, dict(clause.compile().params)))
        if sql in self.fail:
            raise RuntimeError("boom")
        result = MagicMock()
        result.rowcount = 0
        result.scalar.return_value = {
            ABSORPTION_EXAMPLE_MARKER_SQL: None if self.marker else ABSORPTION_EXAMPLE_MARKER_KEY,
            CAPACITY_DASHBOARD_FIND_SQL: self.dashboard_id,
            DASHBOARD_WIDGET_TITLE_PROBE_SQL: 1 if self.has_title else None,
        }.get(sql, False)
        result.all.return_value = self.rows if sql == DASHBOARD_WIDGET_LAYOUTS_SQL else []
        return result

    def sqls(self):
        return [sql for sql, _ in self.executed]

    def binds(self, sql):
        return [params for executed, params in self.executed if executed == sql]


EXISTING = [
    (
        json.dumps(
            {"lg": {"x": 0, "y": 0, "w": 12, "h": 4}, "md": {"x": 0, "y": 0, "w": 8, "h": 4}}
        ),
        0,
    ),
    (
        json.dumps(
            {"lg": {"x": 0, "y": 4, "w": 6, "h": 5}, "sm": {"x": 0, "y": 5, "w": 4, "h": 5}}
        ),
        2,
    ),
    ("not json", 1),
]


@pytest.mark.asyncio
async def test_the_example_is_added_below_the_existing_widgets_once():
    conn = ExampleConn(rows=EXISTING)

    assert await tdm.add_absorption_example(conn) is True

    # The marker is claimed first, in the same transaction as the widget.
    assert conn.sqls() == [
        ABSORPTION_EXAMPLE_MARKER_SQL,
        CAPACITY_DASHBOARD_FIND_SQL,
        DASHBOARD_WIDGET_TITLE_PROBE_SQL,
        DASHBOARD_WIDGET_LAYOUTS_SQL,
        DASHBOARD_WIDGET_SEED_SQL,
        DASHBOARD_TOUCH_SQL,
    ]
    assert conn.binds(CAPACITY_DASHBOARD_FIND_SQL) == [{"name": CAPACITY_DASHBOARD_NAME}]
    [widget] = conn.binds(DASHBOARD_WIDGET_SEED_SQL)
    assert widget["dashboard_id"] == 7 and widget["title"] == ABSORPTION_WIDGET_TITLE
    assert widget["sort_order"] == 3  # after the highest one (2)
    assert json.loads(widget["layout"]) == {
        "lg": {"x": 0, "y": 9, "w": 3, "h": 4},
        "md": {"x": 0, "y": 4, "w": 4, "h": 4},
        "sm": {"x": 0, "y": 10, "w": 4, "h": 4},
    }
    assert json.loads(widget["query"])["formula"]["terms"][1]["measure"] == "capacity_weeks"
    assert conn.binds(DASHBOARD_TOUCH_SQL) == [{"dashboard_id": 7}]
    assert conn.binds(ABSORPTION_EXAMPLE_MARKER_SQL) == [
        {"key": ABSORPTION_EXAMPLE_MARKER_KEY, "value": "1"}
    ]
    conn.commit.assert_awaited_once()
    conn.rollback.assert_not_awaited()
    # Every value bound: no JSON in the SQL text.
    assert all("{" not in sql for sql in conn.sqls())


@pytest.mark.asyncio
async def test_a_marker_already_claimed_adds_nothing():
    # Done on an earlier start, or claimed by another worker starting at the
    # same time: the claim returns no row and the step stops there.
    conn = ExampleConn(marker=True)

    assert await tdm.add_absorption_example(conn) is False

    assert conn.sqls() == [ABSORPTION_EXAMPLE_MARKER_SQL]
    conn.commit.assert_not_awaited()
    conn.rollback.assert_awaited_once()


@pytest.mark.asyncio
async def test_a_dashboard_that_has_the_widget_only_gets_the_marker():
    conn = ExampleConn(has_title=True)

    assert await tdm.add_absorption_example(conn) is False

    assert DASHBOARD_WIDGET_SEED_SQL not in conn.sqls()
    assert DASHBOARD_TOUCH_SQL not in conn.sqls()
    assert conn.sqls()[0] == ABSORPTION_EXAMPLE_MARKER_SQL
    conn.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_a_deleted_dashboard_is_not_recreated():
    conn = ExampleConn(dashboard_id=None)

    assert await tdm.add_absorption_example(conn) is False

    assert conn.sqls() == [ABSORPTION_EXAMPLE_MARKER_SQL, CAPACITY_DASHBOARD_FIND_SQL]
    conn.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_an_empty_dashboard_gets_the_widget_at_the_top(caplog):
    caplog.set_level("INFO", logger=tdm.__name__)
    conn = ExampleConn(rows=[])

    await tdm.run_data_migrations(conn)

    [widget] = conn.binds(DASHBOARD_WIDGET_SEED_SQL)
    assert widget["sort_order"] == 0
    assert json.loads(widget["layout"])["lg"] == {"x": 0, "y": 0, "w": 3, "h": 4}
    assert "added the absorption example on milestone_test" in caplog.text


@pytest.mark.asyncio
async def test_a_failing_example_step_is_rolled_back_without_the_marker(caplog):
    conn = ExampleConn(fail={DASHBOARD_WIDGET_SEED_SQL})

    await tdm.run_data_migrations(conn)  # never raises

    # The claim is rolled back with the widget: the next start tries again.
    conn.rollback.assert_awaited()
    assert conn.sqls().index(ABSORPTION_EXAMPLE_MARKER_SQL) < conn.sqls().index(
        DASHBOARD_WIDGET_SEED_SQL
    )
    assert DASHBOARD_TOUCH_SQL not in conn.sqls()
    assert "Data migration (absorption example) warning for milestone_test" in caplog.text


def test_the_example_sql_binds_every_value():
    from sqlalchemy import text

    assert set(text(ABSORPTION_EXAMPLE_MARKER_SQL).compile().params) == {"key", "value"}
    assert set(text(CAPACITY_DASHBOARD_FIND_SQL).compile().params) == {"name"}
    assert "owner_id IS NULL" in CAPACITY_DASHBOARD_FIND_SQL
    assert ABSORPTION_EXAMPLE_MARKER_SQL.endswith("ON CONFLICT (key) DO NOTHING RETURNING key")
    assert ABSORPTION_EXAMPLE_MARKER_KEY.startswith("_internal.")
