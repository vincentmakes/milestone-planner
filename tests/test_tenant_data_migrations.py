"""
app.services.tenant_data_migrations.run_data_migrations -- the runtime half of
the B2-8 / B2-14 / B2-20 schema changes, called from the tenant auto-migration
(and the single-tenant startup) with the same SQLAlchemy AsyncConnection.

Mock connection: each step's SQL is recognised by its text, so the tests pin
what runs, what is skipped, and that a failing step never stops the others.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services import tenant_data_migrations as tdm
from app.services.tenant_provisioner import (
    CARD_COMMENTS_AUTHOR_FK_NEEDS_FIX_SQL,
    CARD_COMMENTS_AUTHOR_FK_SQL,
    CARD_COMMENTS_ORPHAN_CLEANUP_SQL,
    CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL,
    PROJECTS_SITE_FK_NEEDS_FIX_SQL,
    PROJECTS_SITE_FK_SQL,
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
        result.scalar.return_value = self.needs_fix.get(sql, False)
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
        CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL,
        CARD_COMMENTS_ORPHAN_CLEANUP_SQL,
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
    # Two FK fixes + two cleanups, each in its own transaction.
    assert conn.commit.await_count == 4


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
