"""
Notification API tests.

The property that matters most here is scoping: every query must be pinned to
the session user, so one user can never read or clear another user's inbox.
"""

from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import CheckConstraint, Delete, MetaData, create_engine
from sqlalchemy.orm import Session

from app.database import Base
from app.models.notification import Notification
from app.services.notifications import READ_RETENTION_DAYS, purge_read_notifications
from tests.conftest import FakeUser


@pytest.mark.asyncio
async def test_unread_count_is_scoped_to_the_session_user(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))

    result = MagicMock()
    result.scalar.return_value = 3
    mock_db_session.execute.return_value = result

    response = await client.get("/api/notifications/unread-count")
    assert response.status_code == 200
    assert response.json() == {"count": 3}

    # The WHERE clause must mention the caller's id, not one from the request.
    rendered = str(mock_db_session.execute.call_args[0][0])
    assert "user_id" in rendered


@pytest.mark.asyncio
async def test_list_returns_the_users_notifications(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))

    row = Notification(
        user_id=7,
        type="assigned",
        actor_id=2,
        entity_type="phase",
        entity_id=1,
        project_id=1,
        title="You were assigned to Design",
        body="Booked at 80%.",
    )
    row.id = 1
    row.read_at = None

    result = MagicMock()
    result.all.return_value = [(row, "Alice", "Brown")]
    mock_db_session.execute.return_value = result

    response = await client.get("/api/notifications")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["title"] == "You were assigned to Design"
    assert body[0]["actor_name"] == "Alice Brown"


@pytest.mark.asyncio
async def test_cannot_mark_another_users_notification_read(authed_client, mock_db_session):
    """
    The query filters on (id, user_id), so someone else's id is
    indistinguishable from a non-existent one -- no probing.
    """
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))

    result = MagicMock()
    result.scalar_one_or_none.return_value = None
    mock_db_session.execute.return_value = result

    response = await client.put("/api/notifications/999/read")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_mark_read_sets_the_timestamp_once(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))

    row = Notification(user_id=7, type="comment", title="x")
    row.id = 5
    row.read_at = None

    result = MagicMock()
    result.scalar_one_or_none.return_value = row
    mock_db_session.execute.return_value = result

    assert (await client.put("/api/notifications/5/read")).status_code == 200
    assert row.read_at is not None
    first_read = row.read_at

    # Re-reading an already-read notification must not move the timestamp.
    assert (await client.put("/api/notifications/5/read")).status_code == 200
    assert row.read_at == first_read


@pytest.mark.asyncio
async def test_mark_all_read(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))

    response = await client.put("/api/notifications/read-all")
    assert response.status_code == 200
    assert response.json() == {"success": True}
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_limit_is_bounded(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))

    response = await client.get("/api/notifications?limit=5000")
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Delete one, clear all
# ---------------------------------------------------------------------------


def _deleted(count: int) -> MagicMock:
    result = MagicMock()
    result.rowcount = count
    return result


def _where_values(stmt) -> dict[str, object]:
    """``{column: bound value}`` of a DELETE's ANDed ``column <op> :param`` terms."""
    found: dict[str, object] = {}
    where = stmt.whereclause
    for clause in getattr(where, "clauses", [where]):
        right = clause.right
        found[f"{clause.left.key} {clause.operator.__name__}"] = getattr(right, "value", None)
    return found


@pytest.mark.asyncio
async def test_delete_own_notification_is_204(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))
    mock_db_session.execute.return_value = _deleted(1)

    response = await client.delete("/api/notifications/5")

    assert response.status_code == 204
    assert response.content == b""
    stmt = mock_db_session.execute.call_args[0][0]
    assert isinstance(stmt, Delete)
    assert _where_values(stmt) == {"id eq": 5, "user_id eq": 7}
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_delete_another_users_notification_is_404(authed_client, mock_db_session):
    """Pinned to (id, user_id): someone else's row matches nothing, like a missing one."""
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))
    mock_db_session.execute.return_value = _deleted(0)

    response = await client.delete("/api/notifications/999")

    assert response.status_code == 404
    assert _where_values(mock_db_session.execute.call_args[0][0])["user_id eq"] == 7
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_rejects_a_non_numeric_id(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))

    response = await client.delete("/api/notifications/abc")

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_clear_all_deletes_every_own_row_and_counts_them(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))
    mock_db_session.execute.return_value = _deleted(73)

    response = await client.delete("/api/notifications")

    assert response.status_code == 200
    assert response.json() == {"deleted": 73}
    stmt = mock_db_session.execute.call_args[0][0]
    assert isinstance(stmt, Delete)
    # Read and unread alike: the only criterion is the caller's id.
    assert _where_values(stmt) == {"user_id eq": 7}
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_delete_routes_need_a_session(app_client):
    assert (await app_client.delete("/api/notifications/5")).status_code == 401
    assert (await app_client.delete("/api/notifications")).status_code == 401


# ---------------------------------------------------------------------------
# Retention: read rows older than 30 days are purged when the inbox is listed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_purges_old_read_rows_first_and_commits(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))
    listing = MagicMock()
    listing.all.return_value = []
    mock_db_session.execute.side_effect = [_deleted(4), listing]
    now = datetime(2026, 10, 28, 9, 0, 0)

    with patch("app.services.notifications.utcnow_naive", return_value=now):
        response = await client.get("/api/notifications")

    assert response.status_code == 200
    purge, select_stmt = (c.args[0] for c in mock_db_session.execute.call_args_list)
    assert isinstance(purge, Delete)
    assert not isinstance(select_stmt, Delete)
    assert _where_values(purge) == {
        "user_id eq": 7,
        "read_at is_not": None,
        "read_at lt": now - timedelta(days=30),
    }
    mock_db_session.commit.assert_awaited_once()


def test_list_uses_the_committing_session():
    """``get_db_readonly`` never commits, so the purge would be thrown away."""
    from app.database import get_db, get_db_readonly
    from app.routers.notifications import router

    (route,) = (r for r in router.routes if r.path == "/notifications" and "GET" in r.methods)
    used = {dep.call for dep in route.dependant.dependencies}
    assert get_db in used
    assert get_db_readonly not in used


@pytest.fixture
def inbox():
    """A real (SQLite) notifications table for the purge predicate."""
    engine = create_engine("sqlite://")
    metadata = MetaData()
    for table in Base.metadata.sorted_tables:
        copy = table.to_metadata(metadata)
        for constraint in [c for c in copy.constraints if isinstance(c, CheckConstraint)]:
            copy.constraints.discard(constraint)
    metadata.create_all(engine, tables=[metadata.tables["notifications"]])
    with Session(engine) as session:
        yield session
    engine.dispose()


class _Async:
    def __init__(self, session: Session):
        self.session = session

    async def execute(self, statement):
        return self.session.execute(statement)


@pytest.mark.asyncio
async def test_purge_keeps_unread_and_recently_read_rows(inbox):
    now = datetime(2026, 10, 28, 9, 0, 0)
    old = now - timedelta(days=31)

    def row(row_id, user_id, read_at, created_at=old):
        return Notification(
            id=row_id,
            user_id=user_id,
            type="comment",
            title=f"n{row_id}",
            read_at=read_at,
            created_at=created_at,
        )

    inbox.add_all(
        [
            row(1, 7, None),  # unread, however old: kept
            row(2, 7, old),  # read 31 days ago: purged
            row(3, 7, now - timedelta(days=29)),  # read 29 days ago: kept
            row(4, 7, now - timedelta(days=30, seconds=1)),  # just past the bound: purged
            row(5, 8, old),  # someone else's: kept
        ]
    )
    inbox.commit()

    with patch("app.services.notifications.utcnow_naive", return_value=now):
        purged = await purge_read_notifications(_Async(inbox), 7)  # type: ignore[arg-type]
    inbox.commit()

    assert purged == 2
    kept = sorted(n.id for n in inbox.query(Notification).all())
    assert kept == [1, 3, 5]
    assert READ_RETENTION_DAYS == 30
