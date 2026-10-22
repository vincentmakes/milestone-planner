"""
Route-level tests for the Kanban and notification APIs.

Mock-based, following the house style: no live DB, dependencies overridden in
tests/conftest.py.
"""

from unittest.mock import MagicMock

import pytest

from app.routers.kanban import SEVERAL_BOOKINGS_DETAIL
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


def _pm_result(pm_id):
    """Result of the `SELECT projects.pm_id` lookup a plain user now costs."""
    result = MagicMock()
    result.first.return_value = (pm_id,)
    return result


def _staff_row(staff_id: int, project_id: int = 1):
    row = MagicMock()
    row.id = 1
    row.project_id = project_id
    row.staff_id = staff_id
    row.approval_status = "approved"
    row.approval_request_id = None
    return row


# ---------------------------------------------------------
# Authentication
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_move_requires_authentication(app_client):
    """No session -> 401, before any permission logic runs."""
    response = await app_client.put("/api/kanban/cards/phase/1/status", json={"status": "done"})
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
    response = await client.put("/api/kanban/cards/phase/1/status", json={"status": "nope"})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_unknown_entity_type_is_rejected(authed_client):
    client, _ = authed_client
    response = await client.put("/api/kanban/cards/widget/1/status", json={"status": "done"})
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
    # card load, pm lookup (not the PM), assignee lookup
    mock_db_session.execute.side_effect = [card_result, _pm_result(99), assignee_result]

    response = await client.put("/api/kanban/cards/phase/1/status", json={"status": "done"})
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
        _pm_result(99),
        assignee_result,
        assignees_result,
    ]

    response = await client.put("/api/kanban/cards/phase/1/status", json={"status": "done"})
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

    response = await client.put("/api/kanban/cards/phase/1/status", json={"status": "in_progress"})
    assert response.status_code == 200
    assert response.json()["completion"] == 50


@pytest.mark.asyncio
async def test_user_cannot_assign_someone_else(authed_client, mock_db_session):
    """Assigning others needs a project editor (superuser or the PM); joining
    a card yourself is covered in test_project_access_routes.py."""
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    # card load, then the pm lookup shows user 5 is not the PM
    mock_db_session.execute.side_effect = [_scalar_result(_card()), _pm_result(1)]

    response = await client.post("/api/kanban/cards/phase/1/assignees", json={"staff_id": 7})
    assert response.status_code == 403
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_missing_card_returns_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    mock_db_session.execute.return_value = _scalar_result(None)

    response = await client.put("/api/kanban/cards/phase/999/status", json={"status": "done"})
    assert response.status_code == 404


# ---------------------------------------------------------
# Allocation
# ---------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/phase-staff/1", "/api/subphase-staff/1"])
@pytest.mark.parametrize("allocation", [0, -10, 101, 1000])
async def test_allocation_outside_1_to_100_is_rejected(authed_client, path, allocation):
    """A single booking is a share of one person's time; it cannot exceed 100%."""
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    response = await client.put(path, json={"allocation": allocation})
    assert response.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/phase-staff/1", "/api/subphase-staff/1"])
async def test_allocation_edit_on_someone_elses_row_is_forbidden(
    authed_client, mock_db_session, path
):
    """Changing another person's booking edits the plan: editors only."""
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [_scalar_result(_staff_row(staff_id=7)), _pm_result(1)]

    response = await client.put(path, json={"allocation": 50})
    assert response.status_code == 403
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/phase-staff/1", "/api/subphase-staff/1"])
async def test_user_can_edit_their_own_allocation(authed_client, mock_db_session, path):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    row = _staff_row(staff_id=5)
    mock_db_session.execute.side_effect = [_scalar_result(row)]

    response = await client.put(path, json={"allocation": 50})
    assert response.status_code == 200
    assert row.allocation == 50


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/phase-staff/1", "/api/subphase-staff/1"])
async def test_pm_can_edit_anyones_allocation(authed_client, mock_db_session, path):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    row = _staff_row(staff_id=7)
    mock_db_session.execute.side_effect = [_scalar_result(row), _pm_result(5)]

    response = await client.put(path, json={"allocation": 50})
    assert response.status_code == 200
    assert row.allocation == 50


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
async def test_mentionable_users_query_covers_admins_and_members(authed_client, mock_db_session):
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


# ---------------------------------------------------------
# Clearing completion from the Gantt slider
# ---------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/phases/1", "/api/subphases/1"], ids=["phase", "subphase"])
async def test_explicit_null_completion_clears_to_todo(authed_client, mock_db_session, path):
    """`"completion": null` is a clear, not a no-op: 0 % and back to To Do."""
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    card = _card(status="in_progress", completion=60)
    mock_db_session.execute.side_effect = [_scalar_result(card)]

    response = await client.put(path, json={"completion": None})

    assert response.status_code == 200
    assert (card.completion, card.status) == (0, "todo")


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/phases/1", "/api/subphases/1"], ids=["phase", "subphase"])
async def test_omitted_completion_is_left_untouched(authed_client, mock_db_session, path):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    card = _card(status="blocked", completion=40)
    mock_db_session.execute.side_effect = [_scalar_result(card)]

    response = await client.put(path, json={"is_milestone": False})

    assert response.status_code == 200
    assert (card.completion, card.status) == (40, "blocked")


# ---------------------------------------------------------
# Permission keys: move_any / move_assigned, mentionable sites.view_all
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_a_custom_role_with_move_any_moves_any_card(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "mover", {"kanban.move_any"}))
    assignees_result = MagicMock()
    assignees_result.scalars.return_value.all.return_value = []
    # No pm lookup, no assignee lookup.
    mock_db_session.execute.side_effect = [_scalar_result(_card()), assignees_result]

    response = await client.put("/api/kanban/cards/phase/1/status", json={"status": "done"})

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_an_assignee_without_move_assigned_cannot_move(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "watcher", {"projects.manage_as_pm"}))
    # Card load, pm lookup (not the PM) -- the assignee lookup is never made.
    mock_db_session.execute.side_effect = [_scalar_result(_card()), _pm_result(99)]

    response = await client.put("/api/kanban/cards/phase/1/status", json={"status": "done"})

    assert response.status_code == 403
    assert response.json()["detail"] == (
        "Permission required: kanban.move_any or kanban.move_assigned"
    )
    assert mock_db_session.execute.await_count == 2


@pytest.mark.asyncio
async def test_the_pm_moves_any_card_of_their_project(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    assignees_result = MagicMock()
    assignees_result.scalars.return_value.all.return_value = []
    mock_db_session.execute.side_effect = [
        _scalar_result(_card()),
        _pm_result(5),
        assignees_result,
    ]

    response = await client.put("/api/kanban/cards/phase/1/status", json={"status": "done"})

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_joining_a_card_with_self_create_denied_is_403(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "watcher", {"projects.manage_as_pm"}))
    mock_db_session.execute.side_effect = [_scalar_result(_card()), _pm_result(99)]

    response = await client.post("/api/kanban/cards/phase/1/assignees", json={"staff_id": 5})

    assert response.status_code == 403
    assert response.json()["detail"] == "You are not allowed to book yourself on projects"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_mentionable_users_include_roles_seeing_every_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    result = MagicMock()
    result.scalars.return_value.unique.return_value.all.return_value = []
    mock_db_session.execute.return_value = result

    await client.get("/api/kanban/sites/1/mentionable-users")

    statement = mock_db_session.execute.call_args[0][0]
    rendered = " ".join(str(statement).split())
    assert "role_permissions.permission" in rendered
    assert "sites.view_all" in str(statement.compile(compile_kwargs={"literal_binds": True}))


# ---------------------------------------------------------
# Unassign: one booking per person, else one by one (1.17.0)
# ---------------------------------------------------------


def _rows_result(rows):
    result = MagicMock()
    result.scalars.return_value.all.return_value = rows
    return result


def _segment(row_id: int, staff_id: int = 5):
    row = _staff_row(staff_id)
    row.id = row_id
    row.allocation = 50
    row.start_date = None
    row.end_date = None
    return row


@pytest.mark.asyncio
@pytest.mark.parametrize("entity_type", ["phase", "subphase"])
@pytest.mark.parametrize(
    "user",
    [FakeUser(1, "admin"), FakeUser(5, "user", {"assignments.self_remove": "approval"})],
    ids=["editor", "self-in-approval-mode"],
)
async def test_unassign_of_a_person_with_several_segments_is_409(
    authed_client, mock_db_session, entity_type, user
):
    client, set_user = authed_client
    set_user(user)
    mock_db_session.execute.side_effect = [
        _scalar_result(_card()),
        _rows_result([_segment(1), _segment(2)]),
    ]

    response = await client.delete(f"/api/kanban/cards/{entity_type}/1/assignees/5")

    assert response.status_code == 409
    assert response.json()["detail"] == SEVERAL_BOOKINGS_DETAIL
    # Decided before the approval resolution: no request filed, nothing deleted.
    assert mock_db_session.execute.await_count == 2
    mock_db_session.add.assert_not_called()
    mock_db_session.delete.assert_not_awaited()
    mock_db_session.commit.assert_not_awaited()
    lookup = mock_db_session.execute.await_args_list[1].args[0]
    assert lookup._limit_clause.value == 2  # two rows are enough to tell


@pytest.mark.asyncio
async def test_unassign_of_a_person_with_one_booking_removes_it(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    row = _segment(7)
    mock_db_session.execute.side_effect = [_scalar_result(_card()), _rows_result([row])]

    response = await client.delete("/api/kanban/cards/phase/1/assignees/5")

    assert response.status_code == 200
    assert response.json() == {"success": True}
    mock_db_session.delete.assert_awaited_once_with(row)
    mock_db_session.commit.assert_awaited_once()


def test_several_bookings_detail_is_plain_words():
    assert SEVERAL_BOOKINGS_DETAIL == (
        "This person has several bookings on this card — remove them one by one"
    )
