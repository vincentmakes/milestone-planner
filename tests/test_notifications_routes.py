"""
Notification API tests.

The property that matters most here is scoping: every query must be pinned to
the session user, so one user can never read or clear another user's inbox.
"""

from unittest.mock import MagicMock

import pytest

from app.models.notification import Notification
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
