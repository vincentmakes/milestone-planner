"""
Route-level tests for the Kanban and notification APIs.

Mock-based, following the house style: no live DB, dependencies overridden in
tests/conftest.py.
"""

from unittest.mock import MagicMock

import pytest

from tests.conftest import FakeUser


def _card(project_id: int = 1, status: str = "todo", completion=None):
    """A phase-shaped ORM stand-in that apply_status can mutate."""
    card = MagicMock()
    card.id = 1
    card.project_id = project_id
    card.status = status
    card.completion = completion
    card.type = "Design"
    card.name = None
    return card


def _scalar_result(value):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    return result


# ---------------------------------------------------------
# Authentication
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_move_requires_authentication(app_client):
    """No session -> 401, before any permission logic runs."""
    response = await app_client.put(
        "/api/kanban/cards/phase/1/status", json={"status": "done"}
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_notifications_require_authentication(app_client):
    assert (await app_client.get("/api/notifications")).status_code == 401
    assert (await app_client.get("/api/notifications/unread-count")).status_code == 401


# ---------------------------------------------------------
# Validation
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_unknown_status_is_rejected(authed_client):
    client, _ = authed_client
    response = await client.put(
        "/api/kanban/cards/phase/1/status", json={"status": "nope"}
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_unknown_entity_type_is_rejected(authed_client):
    client, _ = authed_client
    response = await client.put(
        "/api/kanban/cards/widget/1/status", json={"status": "done"}
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_completion_above_100_is_rejected(authed_client):
    """PUT /phases/{id} accepted any integer before the Kanban work."""
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    response = await client.put("/api/phases/1", json={"completion": 150})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_negative_completion_is_rejected(authed_client):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    response = await client.put("/api/phases/1", json={"completion": -1})
    assert response.status_code == 422


# ---------------------------------------------------------
# Permissions
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_non_assignee_cannot_move_a_card(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))

    card_result = _scalar_result(_card())
    assignee_result = MagicMock()
    assignee_result.first.return_value = None  # not assigned
    mock_db_session.execute.side_effect = [card_result, assignee_result]

    response = await client.put(
        "/api/kanban/cards/phase/1/status", json={"status": "done"}
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_assignee_can_move_their_card(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))

    card = _card(status="todo", completion=0)
    assignee_result = MagicMock()
    assignee_result.first.return_value = (42,)  # assigned
    assignees_result = MagicMock()
    assignees_result.scalars.return_value.all.return_value = [5]

    mock_db_session.execute.side_effect = [
        _scalar_result(card),
        assignee_result,
        assignees_result,
    ]

    response = await client.put(
        "/api/kanban/cards/phase/1/status", json={"status": "done"}
    )
    assert response.status_code == 200
    body = response.json()
    # The server echoes the derived pair so the client can reconcile.
    assert body["status"] == "done"
    assert body["completion"] == 100


@pytest.mark.asyncio
async def test_superuser_can_move_any_card(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))

    card = _card(status="todo", completion=None)
    assignees_result = MagicMock()
    assignees_result.scalars.return_value.all.return_value = []

    mock_db_session.execute.side_effect = [_scalar_result(card), assignees_result]

    response = await client.put(
        "/api/kanban/cards/phase/1/status", json={"status": "in_progress"}
    )
    assert response.status_code == 200
    assert response.json()["completion"] == 50


@pytest.mark.asyncio
async def test_assigning_requires_superuser(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))

    response = await client.post(
        "/api/kanban/cards/phase/1/assignees", json={"staff_id": 7}
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_missing_card_returns_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    mock_db_session.execute.return_value = _scalar_result(None)

    response = await client.put(
        "/api/kanban/cards/phase/999/status", json={"status": "done"}
    )
    assert response.status_code == 404


# ---------------------------------------------------------
# Mentionable users
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_mentionable_users_requires_authentication(app_client):
    response = await app_client.get("/api/kanban/sites/1/mentionable-users")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_mentionable_users_open_to_plain_users(authed_client, mock_db_session):
    """Anyone may comment, so anyone may see who they can mention."""
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))

    result = MagicMock()
    result.scalars.return_value.unique.return_value.all.return_value = []
    result.scalars.return_value.all.return_value = []
    mock_db_session.execute.return_value = result

    response = await client.get("/api/kanban/sites/1/mentionable-users")
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_mentionable_users_query_covers_admins_and_members(
    authed_client, mock_db_session
):
    """Admins span every site, so membership alone would hide them."""
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))

    result = MagicMock()
    result.scalars.return_value.all.return_value = []
    mock_db_session.execute.return_value = result

    await client.get("/api/kanban/sites/1/mentionable-users")

    rendered = str(mock_db_session.execute.call_args[0][0])
    assert "user_sites" in rendered  # site membership
    assert "role" in rendered  # ... OR is an admin
    assert "active" in rendered  # inactive users cannot be notified
