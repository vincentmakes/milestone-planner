"""
Route-level tests for project-manager edit rights and self-assignment.

Mock-based, following the house style: no live DB, dependencies overridden in
tests/conftest.py. Each test lays out the exact sequence of `db.execute`
results the handler will consume, so a test also pins the query order (in
particular that privileged callers never pay for the `pm_id` lookup).
"""

from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.equipment import Equipment
from app.models.site import Site
from app.services.project_access import EDITOR_REQUIRED_DETAIL, OWN_ASSIGNMENT_DETAIL
from tests.conftest import FakeUser
from tests.support import card_lock_result, scalars_result

PM = 7  # id of the project manager of project 1
OTHER = 99


def _scalar_result(value):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    return result


def _pm_result(pm_id):
    """Result of the `SELECT projects.pm_id` lookup."""
    result = MagicMock()
    result.first.return_value = (pm_id,)
    return result


def _max_order_result(value=0):
    result = MagicMock()
    result.scalar.return_value = value
    return result


def _phase(project_id: int = 1):
    phase = MagicMock()
    phase.id = 1
    phase.project_id = project_id
    phase.type = "Design"
    phase.name = None
    return phase


def _subphase(project_id: int = 1, depth: int = 1):
    sp = MagicMock()
    sp.id = 2
    sp.project_id = project_id
    sp.name = "Sub"
    sp.depth = depth
    return sp


def _project(pm_id):
    project = MagicMock()
    project.id = 1
    project.site_id = 1  # the callers' site
    project.pm_id = pm_id
    project.name = "Project"
    return project


def _staff_row(staff_id: int, project_id: int = 1, **fields):
    row = MagicMock()
    row.id = 1
    row.project_id = project_id
    row.staff_id = staff_id
    row.allocation = fields.pop("allocation", 50)
    # An ordinary approved row without an open approval request.
    row.approval_status = fields.pop("approval_status", "approved")
    row.approval_request_id = fields.pop("approval_request_id", None)
    for name, value in fields.items():
        setattr(row, name, value)
    return row


def _project_site_result(site_id: int = 1):
    """Result of the `SELECT projects.site_id` lookup."""
    result = MagicMock()
    result.first.return_value = (site_id,)
    return result


def _equipment_at(*site_ids: int, equipment_id: int = 3):
    """A real Equipment row linked to the given sites (drives `site_ids`)."""
    sites = [Site(id=sid, name=f"Site {sid}") for sid in site_ids]
    return Equipment(
        id=equipment_id,
        name="HPLC",
        type="Analytical",
        site_id=site_ids[0] if site_ids else None,
        active=1,
        sites=sites,
    )


def _assign_id_on_refresh(mock_db_session, new_id: int = 42):
    """Give freshly added rows an id, as a real refresh() would."""
    mock_db_session.refresh.side_effect = lambda obj: setattr(obj, "id", new_id)


# ---------------------------------------------------------
# Phases and subphases: PM edits, outsider rejected, superuser unchanged
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_pm_can_update_a_phase_of_their_project(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    mock_db_session.execute.side_effect = [_scalar_result(_phase()), _pm_result(PM)]

    response = await client.put("/api/phases/1", json={"type": "Build"})
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_non_pm_user_cannot_update_a_phase(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [_scalar_result(_phase()), _pm_result(PM)]

    response = await client.put("/api/phases/1", json={"type": "Build"})
    assert response.status_code == 403
    assert response.json()["detail"] == EDITOR_REQUIRED_DETAIL
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_superuser_updates_a_phase_without_pm_lookup(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    mock_db_session.execute.side_effect = [_scalar_result(_phase())]

    response = await client.put("/api/phases/1", json={"type": "Build"})
    assert response.status_code == 200
    assert mock_db_session.execute.await_count == 1


@pytest.mark.asyncio
async def test_pm_can_delete_a_phase(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    no_children = MagicMock()
    no_children.all.return_value = []
    # phase load, pm lookup, subphase descendants, pending approval requests,
    # approved bookers, comment + column-value cleanup
    mock_db_session.execute.side_effect = [
        _scalar_result(_phase()),
        _pm_result(PM),
        no_children,
        MagicMock(),
        MagicMock(),
        MagicMock(),
        MagicMock(),
    ]

    response = await client.delete("/api/phases/1")
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_pm_can_add_a_phase(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    mock_db_session.execute.side_effect = [_pm_result(PM), _max_order_result(2)]

    response = await client.post(
        "/api/projects/1/phases",
        json={"type": "Test", "start_date": "2025-01-01", "end_date": "2025-01-31"},
    )
    assert response.status_code == 200
    assert mock_db_session.add.call_args[0][0].sort_order == 3


@pytest.mark.asyncio
async def test_add_phase_to_missing_project_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    missing = MagicMock()
    missing.first.return_value = None
    mock_db_session.execute.side_effect = [missing]

    response = await client.post(
        "/api/projects/1/phases",
        json={"type": "Test", "start_date": "2025-01-01", "end_date": "2025-01-31"},
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_subphase_create_uses_the_phases_project_not_the_bodys(
    authed_client, mock_db_session
):
    """A client could otherwise file a subphase under a project it cannot edit."""
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    mock_db_session.execute.side_effect = [
        _scalar_result(_phase(project_id=1)),
        _pm_result(PM),
        _max_order_result(0),
    ]

    response = await client.post(
        "/api/phases/1/subphases",
        json={
            "name": "Sub",
            "start_date": "2025-01-01",
            "end_date": "2025-01-10",
            "project_id": 999,
        },
    )
    assert response.status_code == 200
    added = mock_db_session.add.call_args[0][0]
    assert added.project_id == 1
    assert response.json()["project_id"] == 1


@pytest.mark.asyncio
async def test_child_subphase_uses_the_parents_project_not_the_bodys(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    mock_db_session.execute.side_effect = [
        _scalar_result(_subphase(project_id=1)),
        _max_order_result(0),
    ]

    response = await client.post(
        "/api/subphases/2/children",
        json={
            "name": "Child",
            "start_date": "2025-01-01",
            "end_date": "2025-01-10",
            "project_id": 999,
        },
    )
    assert response.status_code == 200
    assert mock_db_session.add.call_args[0][0].project_id == 1


@pytest.mark.asyncio
async def test_non_pm_user_cannot_add_a_subphase(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [_scalar_result(_phase()), _pm_result(PM)]

    response = await client.post(
        "/api/phases/1/subphases",
        json={"name": "Sub", "start_date": "2025-01-01", "end_date": "2025-01-10", "project_id": 1},
    )
    assert response.status_code == 403
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_delete_missing_subphase_is_404(authed_client, mock_db_session):
    """Used to silently return success and run the descendant cleanup anyway."""
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    mock_db_session.execute.side_effect = [_scalar_result(None)]

    response = await client.delete("/api/subphases/404")
    assert response.status_code == 404
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_pm_can_delete_a_subphase(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    no_children = MagicMock()
    no_children.all.return_value = []
    # target load, pm lookup, descendants, pending approval requests, approved
    # bookers, staff cleanup, comments, column values, row delete
    mock_db_session.execute.side_effect = [
        _scalar_result(_subphase()),
        _pm_result(PM),
        no_children,
        MagicMock(),
        MagicMock(),
        MagicMock(),
        MagicMock(),
        MagicMock(),
        MagicMock(),
    ]

    response = await client.delete("/api/subphases/2")
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_subphase_reorder_checks_the_parent_before_writing(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    parent_project = MagicMock()
    parent_project.first.return_value = (1,)
    mock_db_session.execute.side_effect = [parent_project, _pm_result(PM)]

    response = await client.put(
        "/api/subphases/1/reorder", json={"subphase_order": [3, 2], "parent_type": "phase"}
    )
    assert response.status_code == 403
    # Only the two lookups ran -- no sort_order update was issued.
    assert mock_db_session.execute.await_count == 2
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_pm_can_reorder_subphases(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    parent_project = MagicMock()
    parent_project.first.return_value = (1,)
    mock_db_session.execute.side_effect = [
        parent_project,
        _pm_result(PM),
        MagicMock(),
        MagicMock(),
    ]

    response = await client.put(
        "/api/subphases/5/reorder", json={"subphase_order": [3, 2], "parent_type": "subphase"}
    )
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_pm_can_reorder_phases(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    mock_db_session.execute.side_effect = [_pm_result(PM), MagicMock(), MagicMock()]

    response = await client.put("/api/projects/1/phases/reorder", json={"phase_order": [2, 1]})
    assert response.status_code == 200


# ---------------------------------------------------------
# Project itself: PM edits every field, but cannot delete
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_pm_can_update_the_project_and_hand_it_over(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    project = _project(pm_id=PM)
    # The project, then the existence check of the new manager (B2-16).
    mock_db_session.execute.side_effect = [_scalar_result(project), _scalar_result(8)]

    response = await client.put(
        "/api/projects/1", json={"name": "Renamed", "pm_id": 8, "archived": True}
    )
    assert response.status_code == 200
    assert project.name == "Renamed"
    assert project.pm_id == 8
    assert project.archived == 1


@pytest.mark.asyncio
async def test_non_pm_user_cannot_update_the_project(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [_scalar_result(_project(pm_id=PM))]

    response = await client.put("/api/projects/1", json={"name": "Renamed"})
    assert response.status_code == 403
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_pm_cannot_delete_the_project(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))

    response = await client.delete("/api/projects/1")
    assert response.status_code == 403
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_pm_cannot_create_projects(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))

    response = await client.post(
        "/api/projects",
        json={"name": "New", "site_id": 1, "start_date": "2025-01-01", "end_date": "2025-02-01"},
    )
    assert response.status_code == 403


# ---------------------------------------------------------
# Staff assignments: own rows for everyone, any row for editors
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_user_can_assign_themself_to_a_project(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    _assign_id_on_refresh(mock_db_session)
    # The project-existence lookup (the user is not its PM), the
    # staff-existence check, then the duplicate check.
    mock_db_session.execute.side_effect = [
        _pm_result(PM),
        _scalar_result(True),
        _scalar_result(None),
    ]

    response = await client.post(
        "/api/projects/1/staff",
        json={
            "staff_id": 5,
            "allocation": 60,
            "start_date": "2025-01-01",
            "end_date": "2025-01-31",
        },
    )
    assert response.status_code == 200
    assert response.json()["id"] == 42
    assert mock_db_session.execute.await_count == 3
    added = mock_db_session.add.call_args[0][0]
    assert (added.staff_id, added.allocation) == (5, 60)


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["user", "superuser"])
async def test_assigning_to_a_missing_project_is_404(authed_client, mock_db_session, role):
    """Own rows and privileged callers skip the permission query, but the project
    must still exist -- otherwise the insert dies on the FK as a 500."""
    client, set_user = authed_client
    set_user(FakeUser(5, role))
    missing = MagicMock()
    missing.first.return_value = None
    mock_db_session.execute.side_effect = [missing]

    response = await client.post(
        "/api/projects/999999/staff",
        json={
            "staff_id": 5,
            "allocation": 60,
            "start_date": "2025-01-01",
            "end_date": "2025-01-31",
        },
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Project not found"
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_user_cannot_assign_someone_else_to_a_project(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [_pm_result(PM)]

    response = await client.post(
        "/api/projects/1/staff",
        json={
            "staff_id": 8,
            "allocation": 60,
            "start_date": "2025-01-01",
            "end_date": "2025-01-31",
        },
    )
    assert response.status_code == 403
    assert response.json()["detail"] == OWN_ASSIGNMENT_DETAIL
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_pm_can_assign_anyone_to_their_project(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    _assign_id_on_refresh(mock_db_session)
    mock_db_session.execute.side_effect = [
        _pm_result(PM),
        _scalar_result(True),
        _scalar_result(None),
    ]

    response = await client.post(
        "/api/projects/1/staff",
        json={
            "staff_id": 8,
            "allocation": 50,
            "start_date": "2025-01-01",
            "end_date": "2025-01-31",
        },
    )
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_user_can_edit_their_own_project_assignment(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    row = _staff_row(staff_id=5)
    mock_db_session.execute.side_effect = [_scalar_result(row)]

    response = await client.put(
        "/api/assignments/1",
        json={"allocation": 30, "start_date": "2025-02-01", "end_date": "2025-02-28"},
    )
    assert response.status_code == 200
    assert row.allocation == 30
    assert row.start_date == date(2025, 2, 1)


@pytest.mark.asyncio
async def test_user_cannot_edit_someone_elses_project_assignment(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    row = _staff_row(staff_id=8)
    mock_db_session.execute.side_effect = [_scalar_result(row), _pm_result(PM)]

    response = await client.put(
        "/api/assignments/1",
        json={"allocation": 30, "start_date": "2025-02-01", "end_date": "2025-02-28"},
    )
    assert response.status_code == 403
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_user_can_remove_their_own_phase_assignment(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    row = _staff_row(staff_id=5)
    mock_db_session.execute.side_effect = [_scalar_result(row)]

    response = await client.delete("/api/phase-staff/1")
    assert response.status_code == 200
    mock_db_session.delete.assert_awaited_once_with(row)


@pytest.mark.asyncio
async def test_user_cannot_remove_someone_elses_subphase_assignment(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [_scalar_result(_staff_row(staff_id=8)), _pm_result(PM)]

    response = await client.delete("/api/subphase-staff/1")
    assert response.status_code == 403
    mock_db_session.delete.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path", ["/api/phases/1/staff", "/api/subphases/1/staff"], ids=["phase", "subphase"]
)
async def test_level_assignment_uses_the_servers_project_id(authed_client, mock_db_session, path):
    """The body's project_id is ignored; the phase/subphase decides."""
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    _assign_id_on_refresh(mock_db_session)
    resolved = MagicMock()
    resolved.first.return_value = (1,)
    mock_db_session.execute.side_effect = [
        resolved,
        _scalar_result(True),
        card_lock_result(),
        _placement(),  # no booking of the person on the card yet
        _detail_row(5),
    ]

    response = await client.post(path, json={"staff_id": 5, "project_id": 999, "allocation": 40})
    assert response.status_code == 200
    added = mock_db_session.add.call_args[0][0]
    assert added.project_id == 1
    assert added.allocation == 40


@pytest.mark.asyncio
async def test_level_assignment_on_missing_phase_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    missing = MagicMock()
    missing.first.return_value = None
    mock_db_session.execute.side_effect = [missing]

    response = await client.post(
        "/api/phases/1/staff", json={"staff_id": 5, "project_id": 1, "allocation": 40}
    )
    assert response.status_code == 404
    mock_db_session.add.assert_not_called()


# ---------------------------------------------------------
# Equipment bookings: project editors only, never self-service
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_user_cannot_book_equipment(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [_pm_result(PM)]

    response = await client.post(
        "/api/projects/1/equipment",
        json={"equipment_id": 3, "start_date": "2025-01-01", "end_date": "2025-01-05"},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "Permission required: equipment_bookings.manage"


@pytest.mark.asyncio
async def test_pm_can_book_equipment(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    _assign_id_on_refresh(mock_db_session)
    # pm lookup, project site, equipment row
    mock_db_session.execute.side_effect = [
        _pm_result(PM),
        _project_site_result(1),
        _scalar_result(_equipment_at(1)),
    ]

    response = await client.post(
        "/api/projects/1/equipment",
        json={"equipment_id": 3, "start_date": "2025-01-01", "end_date": "2025-01-05"},
    )
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_equipment_shared_with_the_projects_site_can_be_booked(
    authed_client, mock_db_session
):
    """Multi-site equipment: any linked site counts, not only the primary one."""
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    _assign_id_on_refresh(mock_db_session)
    mock_db_session.execute.side_effect = [
        _project_site_result(2),
        _scalar_result(_equipment_at(1, 2)),
    ]

    response = await client.post(
        "/api/projects/1/equipment",
        json={"equipment_id": 3, "start_date": "2025-01-01", "end_date": "2025-01-05"},
    )
    assert response.status_code == 200
    assert response.json()["id"] == 42
    added = mock_db_session.add.call_args[0][0]
    assert (added.project_id, added.equipment_id) == (1, 3)


@pytest.mark.asyncio
async def test_equipment_from_another_site_cannot_be_booked(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    mock_db_session.execute.side_effect = [
        _project_site_result(1),
        _scalar_result(_equipment_at(2)),
    ]

    response = await client.post(
        "/api/projects/1/equipment",
        json={"equipment_id": 3, "start_date": "2025-01-01", "end_date": "2025-01-05"},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Equipment is not available at this project's site"
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_booking_missing_equipment_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    mock_db_session.execute.side_effect = [_project_site_result(1), _scalar_result(None)]

    response = await client.post(
        "/api/projects/1/equipment",
        json={"equipment_id": 3, "start_date": "2025-01-01", "end_date": "2025-01-05"},
    )
    assert response.status_code == 404
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_pm_can_delete_an_equipment_booking(authed_client, mock_db_session, change_intents):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    booking = SimpleNamespace(
        id=1,
        project_id=1,
        equipment=SimpleNamespace(name="HPLC"),
        start_date=date(2025, 1, 1),
        end_date=date(2025, 1, 5),
    )
    mock_db_session.execute.side_effect = [_scalar_result(booking), _pm_result(PM)]

    response = await client.delete("/api/equipment-assignments/1")
    assert response.status_code == 200
    mock_db_session.delete.assert_awaited_once_with(booking)
    ((actor_id, (only,), _),) = change_intents
    assert actor_id == PM  # the PM's own change: dropped at delivery
    assert (only.recipient, only.type, only.user_id) == ("pm", "project_changed", None)
    assert only.title == f"Test User{PM} removed the HPLC booking from {{project}}"
    assert only.body == "Was from 2025-01-01 to 2025-01-05"
    assert (only.entity_type, only.entity_id, only.project_id) == ("project", 1, 1)


@pytest.mark.asyncio
async def test_user_cannot_delete_an_equipment_booking(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [
        _scalar_result(SimpleNamespace(id=1, project_id=1)),
        _pm_result(PM),
    ]

    response = await client.delete("/api/equipment-assignments/1")
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_user_cannot_update_an_equipment_booking(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [
        _scalar_result(SimpleNamespace(id=1, project_id=1)),
        _pm_result(PM),
    ]

    response = await client.put("/api/equipment-assignments/1", json={"end_date": "2025-03-01"})
    assert response.status_code == 403
    mock_db_session.commit.assert_not_awaited()


def _booking(equipment_id: int = 3, project_site_id: int = 1):
    """An equipment booking of project 1 with its (selectin-loaded) project."""
    return SimpleNamespace(
        id=1,
        project_id=1,
        project=SimpleNamespace(name="Project", site_id=project_site_id),
        equipment=SimpleNamespace(name="HPLC"),
        equipment_id=equipment_id,
        start_date=date(2025, 1, 1),
        end_date=date(2025, 1, 5),
        created_at=datetime(2025, 1, 1, 12, 0, 0),
    )


@pytest.mark.asyncio
async def test_rebooking_onto_equipment_from_another_site_is_rejected(
    authed_client, mock_db_session
):
    """PUT applies the same site rule as POST /projects/{id}/equipment."""
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    booking = _booking(equipment_id=3, project_site_id=1)
    mock_db_session.execute.side_effect = [
        _scalar_result(booking),
        _scalar_result(_equipment_at(2, equipment_id=4)),
    ]

    response = await client.put("/api/equipment-assignments/1", json={"equipment_id": 4})
    assert response.status_code == 400
    assert response.json()["detail"] == "Equipment is not available at this project's site"
    assert booking.equipment_id == 3
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_rebooking_onto_missing_equipment_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    mock_db_session.execute.side_effect = [_scalar_result(_booking()), _scalar_result(None)]

    response = await client.put("/api/equipment-assignments/1", json={"equipment_id": 4})
    assert response.status_code == 404
    assert response.json()["detail"] == "Equipment not found"
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_rebooking_onto_equipment_shared_with_the_projects_site(
    authed_client, mock_db_session, change_intents
):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    booking = _booking(equipment_id=3, project_site_id=2)
    reloaded = MagicMock()
    reloaded.scalar_one.return_value = booking
    other = _equipment_at(1, 2, equipment_id=4)
    other.name = "GC"
    mock_db_session.execute.side_effect = [
        _scalar_result(booking),
        _scalar_result(other),
        reloaded,
    ]

    response = await client.put("/api/equipment-assignments/1", json={"equipment_id": 4})
    assert response.status_code == 200
    assert response.json()["equipment_id"] == 4
    mock_db_session.commit.assert_awaited_once()
    ((_, (only,), _),) = change_intents
    assert only.title == "Test User9 changed the HPLC booking for {project}"
    assert only.body == "equipment HPLC → GC"


@pytest.mark.asyncio
async def test_updating_a_booking_on_the_same_equipment_skips_the_site_check(
    authed_client, mock_db_session, change_intents
):
    """Dates-only edits (or re-sending the current equipment_id) cost no equipment query."""
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    booking = _booking(equipment_id=3)
    reloaded = MagicMock()
    reloaded.scalar_one.return_value = booking
    mock_db_session.execute.side_effect = [_scalar_result(booking), reloaded]

    response = await client.put(
        "/api/equipment-assignments/1", json={"equipment_id": 3, "end_date": "2025-03-01"}
    )
    assert response.status_code == 200
    assert booking.end_date == date(2025, 3, 1)
    ((_, (only,), _),) = change_intents
    assert only.title == "Test User9 changed the HPLC booking for {project}"
    assert only.body == "dates 2025-01-01–2025-01-05 → 2025-01-01–2025-03-01"


# ---------------------------------------------------------
# Kanban: join and leave cards yourself
# ---------------------------------------------------------


def _card(project_id: int = 1):
    card = MagicMock()
    card.id = 1
    card.project_id = project_id
    card.type = "Design"
    card.name = None
    card.start_date, card.end_date = CARD_START, CARD_END
    return card


@pytest.mark.asyncio
async def test_user_can_join_a_card(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    _assign_id_on_refresh(mock_db_session)
    me = SimpleNamespace(id=5, full_name="Test User5", max_capacity=80, is_resource=True)
    # card load, assignee lookup, placement (not on the card yet)
    mock_db_session.execute.side_effect = [
        _scalar_result(_card()),
        _scalar_result(me),
        card_lock_result(),
        _placement(),
    ]

    response = await client.post("/api/kanban/cards/phase/1/assignees", json={"staff_id": 5})
    assert response.status_code == 201
    body = response.json()
    assert body["staff_id"] == 5
    assert body["allocation"] == 80  # defaults to the member's max_capacity
    # Not on the card yet: a linked booking over the card's dates.
    assert (body["linked"], body["start_date"], body["end_date"], body["adjusted"]) == (
        True,
        "2026-03-02T00:00:00.000Z",
        "2026-03-13T00:00:00.000Z",
        [],
    )


@pytest.mark.asyncio
async def test_user_can_leave_a_card(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    row = _staff_row(staff_id=5)
    mock_db_session.execute.side_effect = [_scalar_result(_card()), scalars_result([row])]

    response = await client.delete("/api/kanban/cards/subphase/1/assignees/5")
    assert response.status_code == 200
    mock_db_session.delete.assert_awaited_once_with(row)


@pytest.mark.asyncio
async def test_user_cannot_remove_someone_else_from_a_card(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [_scalar_result(_card()), _pm_result(PM)]

    response = await client.delete("/api/kanban/cards/phase/1/assignees/8")
    assert response.status_code == 403
    assert response.json()["detail"] == OWN_ASSIGNMENT_DETAIL


@pytest.mark.asyncio
async def test_pm_can_move_any_card_of_their_project(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    card = _card()
    card.status = "todo"
    card.completion = 0
    assignees_result = MagicMock()
    assignees_result.scalars.return_value.all.return_value = []
    # card load, pm lookup (editor -> no assignee check), notification recipients
    mock_db_session.execute.side_effect = [
        _scalar_result(card),
        _pm_result(PM),
        assignees_result,
    ]

    response = await client.put("/api/kanban/cards/phase/1/status", json={"status": "done"})
    assert response.status_code == 200
    assert response.json()["completion"] == 100


# ---------------------------------------------------------
# Permission keys: archive, the PM bundle, the self-booking modes
# ---------------------------------------------------------

PROJECT_STAFF = {
    "allocation": 60,
    "start_date": "2025-01-01",
    "end_date": "2025-01-31",
}


def _archivable_project(pm_id, archived=0):
    project = _project(pm_id)
    project.archived = archived
    return project


@pytest.mark.asyncio
async def test_archiving_needs_projects_archive(authed_client, mock_db_session):
    client, set_user = authed_client
    # Edits any project, but may not archive.
    set_user(FakeUser(5, "editor", {"projects.edit_any"}))
    project = _archivable_project(pm_id=PM)
    mock_db_session.execute.side_effect = [_scalar_result(project)]

    response = await client.put("/api/projects/1", json={"archived": True})

    assert response.status_code == 403
    assert response.json()["detail"] == "Permission required: projects.archive"
    assert project.archived == 0
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_archive_alone_needs_no_edit_rights(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "archivist", {"projects.archive"}))
    project = _archivable_project(pm_id=PM)
    mock_db_session.execute.side_effect = [_scalar_result(project)]

    response = await client.put("/api/projects/1", json={"archived": True})

    assert response.status_code == 200
    assert project.archived == 1


@pytest.mark.asyncio
async def test_archive_rights_do_not_edit_other_fields(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "archivist", {"projects.archive"}))
    project = _archivable_project(pm_id=PM)
    mock_db_session.execute.side_effect = [_scalar_result(project)]

    response = await client.put("/api/projects/1", json={"name": "X", "archived": True})

    assert response.status_code == 403
    assert response.json()["detail"] == EDITOR_REQUIRED_DETAIL
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_archive_rights_do_not_clear_the_manager(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "archivist", {"projects.archive"}))
    project = _archivable_project(pm_id=PM)
    mock_db_session.execute.side_effect = [_scalar_result(project)]

    response = await client.put("/api/projects/1", json={"pm_id": None, "archived": True})

    assert response.status_code == 403
    assert response.json()["detail"] == EDITOR_REQUIRED_DETAIL
    assert project.pm_id == PM
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_archive_with_a_null_manager_on_a_project_without_one(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "archivist", {"projects.archive"}))
    project = _archivable_project(pm_id=None)
    mock_db_session.execute.side_effect = [_scalar_result(project)]

    response = await client.put("/api/projects/1", json={"pm_id": None, "archived": True})

    assert response.status_code == 200
    assert (project.pm_id, project.archived) == (None, 1)


@pytest.mark.asyncio
async def test_resending_the_unchanged_archived_flag_needs_no_archive_key(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(5, "editor", {"projects.edit_any"}))
    project = _archivable_project(pm_id=PM, archived=0)
    mock_db_session.execute.side_effect = [_scalar_result(project)]

    response = await client.put("/api/projects/1", json={"name": "X", "archived": False})

    assert response.status_code == 200
    assert project.name == "X"


@pytest.mark.asyncio
async def test_the_pm_archives_through_the_bundle(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    project = _archivable_project(pm_id=PM)
    mock_db_session.execute.side_effect = [_scalar_result(project)]

    response = await client.put("/api/projects/1", json={"archived": True})

    assert response.status_code == 200
    assert project.archived == 1


@pytest.mark.asyncio
async def test_a_pm_whose_role_cannot_act_as_pm_cannot_edit(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "viewer", set()))
    mock_db_session.execute.side_effect = [_scalar_result(_project(pm_id=PM))]

    response = await client.put("/api/projects/1", json={"name": "Renamed"})

    assert response.status_code == 403
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_custom_role_with_create_creates_projects(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "planner", {"projects.create"}))

    response = await client.post(
        "/api/projects",
        json={"name": "New", "site_id": 1, "start_date": "2025-01-01", "end_date": "2025-02-01"},
    )

    assert response.status_code == 200
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_self_booking_denied_by_the_role_is_403(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "viewer", {"projects.manage_as_pm"}))
    mock_db_session.execute.side_effect = [_pm_result(PM)]

    response = await client.post("/api/projects/1/staff", json={"staff_id": 5, **PROJECT_STAFF})

    assert response.status_code == 403
    assert response.json()["detail"] == "You are not allowed to book yourself on projects"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_manage_others_books_anyone_without_the_pm_lookup(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "dispatcher", {"assignments.manage_others"}))
    _assign_id_on_refresh(mock_db_session)
    # Project existence (always), the staff and duplicate checks -- no editor lookup.
    mock_db_session.execute.side_effect = [
        _pm_result(PM),
        _scalar_result(True),
        _scalar_result(None),
    ]

    response = await client.post("/api/projects/1/staff", json={"staff_id": 8, **PROJECT_STAFF})

    assert response.status_code == 200
    assert mock_db_session.execute.await_count == 3


@pytest.mark.asyncio
async def test_removing_ones_own_phase_booking_follows_self_remove(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "sticky", {"assignments.self_create", "projects.manage_as_pm"}))
    phase_row = _staff_row(5)
    mock_db_session.execute.side_effect = [_scalar_result(phase_row), _pm_result(PM)]

    response = await client.delete("/api/phase-staff/1")

    assert response.status_code == 403
    assert response.json()["detail"] == "You are not allowed to book yourself on projects"
    mock_db_session.commit.assert_not_awaited()


# ---------------------------------------------------------
# The eleven self-booking routes: allow / approval (202) / deny (403)
# ---------------------------------------------------------

SELF_MODES = {
    "allow": FakeUser(5, "user"),  # shipped default: own bookings allowed
    "approval": FakeUser(
        5,
        "trainee",
        {
            "assignments.self_create": "approval",
            "assignments.self_update": "approval",
            "assignments.self_remove": "approval",
            "projects.manage_as_pm": "allow",
        },
    ),
    "deny": FakeUser(5, "viewer", {"projects.manage_as_pm": "allow"}),
}


def _resolved(project_id: int = 1):
    """Result of `project_id_for_phase` / `project_id_for_subphase`."""
    result = MagicMock()
    result.first.return_value = (project_id,)
    return result


CARD_START, CARD_END = date(2026, 3, 2), date(2026, 3, 13)


def _placement(*rows, start=CARD_START, end=CARD_END):
    """Result of ``approvals.plan_placement``: the person's rows on the card with its dates."""
    result = MagicMock()
    result.all.return_value = [(start, end, row) for row in rows]
    return result


def _detail_row(staff_id: int = 5, **fields):
    """The created phase / subphase row with the staff details and the card's dates."""
    row = _staff_row(staff_id, **{"start_date": None, "end_date": None, **fields})
    result = MagicMock()
    result.first.return_value = (row, "Test User5", "Engineer", CARD_START, CARD_END)
    return result


ME = SimpleNamespace(id=5, full_name="Test User5", max_capacity=80, is_resource=True)

# (id, method, path, body, action, level, results per mode). The results are
# the queries before the decision (plus, for "allow", what the direct write
# still reads); "pm" stands for the project-manager lookup the non-editor pays.
SELF_ROUTES = [
    (
        "project-create",
        "post",
        "/api/projects/1/staff",
        {"staff_id": 5, **PROJECT_STAFF},
        "assignments.self_create",
        "project",
        {
            "allow": lambda: [_pm_result(PM), _scalar_result(True), _scalar_result(None)],
            "approval": lambda: [_pm_result(PM), _scalar_result(True), _scalar_result(None)],
            "deny": lambda: [_pm_result(PM)],
        },
    ),
    (
        "project-update",
        "put",
        "/api/assignments/1",
        PROJECT_STAFF,
        "assignments.self_update",
        "project",
        {
            "allow": lambda: [_scalar_result(_staff_row(5))],
            "approval": lambda: [_scalar_result(_staff_row(5)), _pm_result(PM)],
            "deny": lambda: [_scalar_result(_staff_row(5)), _pm_result(PM)],
        },
    ),
    (
        "project-delete",
        "delete",
        "/api/assignments/1",
        None,
        "assignments.self_remove",
        "project",
        {
            "allow": lambda: [_scalar_result(_staff_row(5))],
            "approval": lambda: [_scalar_result(_staff_row(5)), _pm_result(PM)],
            "deny": lambda: [_scalar_result(_staff_row(5)), _pm_result(PM)],
        },
    ),
    (
        "phase-create",
        "post",
        "/api/phases/1/staff",
        {"staff_id": 5, "project_id": 1, "allocation": 40},
        "assignments.self_create",
        "phase",
        {
            "allow": lambda: [
                _resolved(),
                _scalar_result(True),
                card_lock_result(),
                _placement(),
                _detail_row(),
            ],
            "approval": lambda: [
                _resolved(),
                _pm_result(PM),
                _scalar_result(True),
                card_lock_result(),
                _placement(),
            ],
            "deny": lambda: [_resolved(), _pm_result(PM)],
        },
    ),
    (
        "phase-update",
        "put",
        "/api/phase-staff/1",
        {"allocation": 40},
        "assignments.self_update",
        "phase",
        {
            "allow": lambda: [_scalar_result(_staff_row(5))],
            "approval": lambda: [_scalar_result(_staff_row(5)), _pm_result(PM)],
            "deny": lambda: [_scalar_result(_staff_row(5)), _pm_result(PM)],
        },
    ),
    (
        "phase-delete",
        "delete",
        "/api/phase-staff/1",
        None,
        "assignments.self_remove",
        "phase",
        {
            "allow": lambda: [_scalar_result(_staff_row(5))],
            "approval": lambda: [_scalar_result(_staff_row(5)), _pm_result(PM)],
            "deny": lambda: [_scalar_result(_staff_row(5)), _pm_result(PM)],
        },
    ),
    (
        "subphase-create",
        "post",
        "/api/subphases/1/staff",
        {"staff_id": 5, "project_id": 1, "allocation": 40},
        "assignments.self_create",
        "subphase",
        {
            "allow": lambda: [
                _resolved(),
                _scalar_result(True),
                card_lock_result(),
                _placement(),
                _detail_row(),
            ],
            "approval": lambda: [
                _resolved(),
                _pm_result(PM),
                _scalar_result(True),
                card_lock_result(),
                _placement(),
            ],
            "deny": lambda: [_resolved(), _pm_result(PM)],
        },
    ),
    (
        "subphase-update",
        "put",
        "/api/subphase-staff/1",
        {"allocation": 40},
        "assignments.self_update",
        "subphase",
        {
            "allow": lambda: [_scalar_result(_staff_row(5))],
            "approval": lambda: [_scalar_result(_staff_row(5)), _pm_result(PM)],
            "deny": lambda: [_scalar_result(_staff_row(5)), _pm_result(PM)],
        },
    ),
    (
        "subphase-delete",
        "delete",
        "/api/subphase-staff/1",
        None,
        "assignments.self_remove",
        "subphase",
        {
            "allow": lambda: [_scalar_result(_staff_row(5))],
            "approval": lambda: [_scalar_result(_staff_row(5)), _pm_result(PM)],
            "deny": lambda: [_scalar_result(_staff_row(5)), _pm_result(PM)],
        },
    ),
    (
        "kanban-join",
        "post",
        "/api/kanban/cards/phase/1/assignees",
        {"staff_id": 5},
        "assignments.self_create",
        "phase",
        {
            "allow": lambda: [
                _scalar_result(_card()),
                _scalar_result(ME),
                card_lock_result(),
                _placement(),
            ],
            "approval": lambda: [
                _scalar_result(_card()),
                _pm_result(PM),
                _scalar_result(ME),
                card_lock_result(),
                _placement(),
            ],
            "deny": lambda: [_scalar_result(_card()), _pm_result(PM)],
        },
    ),
    (
        "kanban-leave",
        "delete",
        "/api/kanban/cards/subphase/1/assignees/5",
        None,
        "assignments.self_remove",
        "subphase",
        {
            "allow": lambda: [_scalar_result(_card()), scalars_result([_staff_row(5)])],
            "approval": lambda: [
                _scalar_result(_card()),
                scalars_result([_staff_row(5)]),
                _pm_result(PM),
            ],
            "deny": lambda: [
                _scalar_result(_card()),
                scalars_result([_staff_row(5)]),
                _pm_result(PM),
            ],
        },
    ),
]

_ROUTE_IDS = [route[0] for route in SELF_ROUTES]


async def _call(client, method, path, body):
    if body is None:
        return await getattr(client, method)(path)
    return await getattr(client, method)(path, json=body)


@pytest.fixture
def submit():
    """The approval path's service call, answering like the real one."""
    from fastapi.responses import JSONResponse

    response = JSONResponse(
        status_code=202, content={"success": True, "pending": True, "request_id": 50, "id": 70}
    )
    with patch("app.services.approvals.submit_request", AsyncMock(return_value=response)) as mocked:
        yield mocked


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("name", "method", "path", "body", "action", "level", "results"), SELF_ROUTES, ids=_ROUTE_IDS
)
async def test_self_route_in_allow_mode_writes_directly(
    authed_client,
    mock_db_session,
    submit,
    change_intents,
    name,
    method,
    path,
    body,
    action,
    level,
    results,
):
    client, set_user = authed_client
    set_user(SELF_MODES["allow"])
    _assign_id_on_refresh(mock_db_session)
    mock_db_session.execute.side_effect = results["allow"]()

    response = await _call(client, method, path, body)

    assert response.status_code in (200, 201)
    assert "pending" not in response.json()
    submit.assert_not_awaited()
    mock_db_session.commit.assert_awaited_once()
    # A direct write reports itself (the actor is dropped at delivery).
    ((actor_id, intents, _),) = change_intents
    assert actor_id == 5
    assert {i.recipient for i in intents} == {"person", "pm"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("name", "method", "path", "body", "action", "level", "results"), SELF_ROUTES, ids=_ROUTE_IDS
)
async def test_self_route_in_approval_mode_files_a_request(
    authed_client,
    mock_db_session,
    submit,
    change_intents,
    name,
    method,
    path,
    body,
    action,
    level,
    results,
):
    client, set_user = authed_client
    set_user(SELF_MODES["approval"])
    mock_db_session.execute.side_effect = results["approval"]()

    response = await _call(client, method, path, body)

    assert response.status_code == 202
    assert response.json() == {"success": True, "pending": True, "request_id": 50, "id": 70}
    assert change_intents == []  # a request changes no booking yet
    kwargs = submit.await_args.kwargs
    assert (kwargs["action"], kwargs["level"], kwargs["project_id"]) == (action, level, 1)
    if method == "post":
        assert kwargs["target_id"] == 1 and kwargs["values"]["allocation"] in (40, 60, 80)
    else:
        assert kwargs["row"].staff_id == 5
    mock_db_session.add.assert_not_called()  # nothing written by the route itself
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("name", "method", "path", "body", "action", "level", "results"), SELF_ROUTES, ids=_ROUTE_IDS
)
async def test_self_route_without_the_key_is_403(
    authed_client, mock_db_session, submit, name, method, path, body, action, level, results
):
    client, set_user = authed_client
    set_user(SELF_MODES["deny"])
    mock_db_session.execute.side_effect = results["deny"]()

    response = await _call(client, method, path, body)

    assert response.status_code == 403
    assert response.json()["detail"] == "You are not allowed to book yourself on projects"
    submit.assert_not_awaited()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_self_booking_in_approval_mode_answers_202_with_the_documented_body(
    authed_client, mock_db_session
):
    """End to end through the real submit_request: a pending row plus its request."""
    from app.models.assignment import PhaseStaffAssignment
    from app.models.rbac import ApprovalRequest

    client, set_user = authed_client
    set_user(SELF_MODES["approval"])
    added: list = []
    mock_db_session.add.side_effect = added.append

    async def flush():
        for index, obj in enumerate(added):
            if getattr(obj, "id", None) is None:
                obj.id = 60 + index

    mock_db_session.flush = AsyncMock(side_effect=flush)
    mock_db_session.execute.side_effect = [
        _resolved(),
        _pm_result(PM),
        _scalar_result(True),
        card_lock_result(),
        _placement(),
    ]
    with (
        patch(
            "app.services.approvals.load_context",
            AsyncMock(return_value=SimpleNamespace(pm_id=PM, site_id=1, target_name="Design")),
        ),
        patch("app.services.approvals.load_policy", AsyncMock(return_value=MagicMock())),
        patch("app.services.approvals.approver_user_ids", AsyncMock(return_value=[PM])),
        patch("app.services.approvals.publish", AsyncMock()) as publish,
    ):
        response = await client.post(
            "/api/phases/1/staff", json={"staff_id": 5, "project_id": 1, "allocation": 40}
        )

    assert response.status_code == 202
    request, row = added[0], added[1]
    assert isinstance(request, ApprovalRequest) and isinstance(row, PhaseStaffAssignment)
    assert response.json() == {
        "success": True,
        "pending": True,
        "request_id": request.id,
        "id": row.id,
    }
    assert row.approval_status == "pending" and row.approval_request_id == request.id
    mock_db_session.commit.assert_awaited_once()
    publish.assert_awaited_once()


# ---------------------------------------------------------
# Duplicates, pending rows and open requests on direct writes
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_booking_someone_twice_is_409(authed_client, mock_db_session):
    # Project level: the same dates twice. (On a phase / subphase a dateless
    # second booking is placed automatically, explicit overlapping dates are a
    # 409: tests/test_booking_segment_routes.py.)
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    existing = _staff_row(8)
    mock_db_session.execute.side_effect = [
        _pm_result(PM),
        _scalar_result(True),
        _scalar_result(existing),
    ]

    response = await client.post("/api/projects/1/staff", json={"staff_id": 8, **PROJECT_STAFF})

    assert response.status_code == 409
    assert response.json()["detail"] == "That staff member is already booked here"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_project_level_duplicate_compares_the_dates(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    _assign_id_on_refresh(mock_db_session)
    mock_db_session.execute.side_effect = [
        _pm_result(PM),
        _scalar_result(True),
        _scalar_result(None),
    ]

    response = await client.post("/api/projects/1/staff", json={"staff_id": 8, **PROJECT_STAFF})

    assert response.status_code == 200
    sql = str(
        mock_db_session.execute.await_args_list[2]
        .args[0]
        .compile(compile_kwargs={"literal_binds": True})
    )
    assert "project_assignments.start_date = '2025-01-01'" in sql
    assert "project_assignments.end_date = '2025-01-31'" in sql


@pytest.mark.asyncio
async def test_pending_booking_counts_as_a_duplicate(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(SELF_MODES["approval"])
    # The person's one booking on the card awaits approval: never split.
    pending = _staff_row(
        5, approval_status="pending", approval_request_id=50, start_date=None, end_date=None
    )
    mock_db_session.execute.side_effect = [
        _resolved(),
        _pm_result(PM),
        _scalar_result(True),
        card_lock_result(),
        _placement(pending),
    ]

    response = await client.post(
        "/api/phases/1/staff", json={"staff_id": 5, "project_id": 1, "allocation": 40}
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "This booking already awaits approval"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("put", "/api/assignments/1", PROJECT_STAFF),
        ("delete", "/api/assignments/1", None),
        ("put", "/api/phase-staff/1", {"allocation": 30}),
        ("delete", "/api/phase-staff/1", None),
        ("put", "/api/subphase-staff/1", {"allocation": 30}),
        ("delete", "/api/subphase-staff/1", None),
    ],
)
async def test_editor_write_on_a_pending_booking_is_409(
    authed_client, mock_db_session, method, path, body
):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    pending = _staff_row(5, approval_status="pending", approval_request_id=50)
    mock_db_session.execute.side_effect = [_scalar_result(pending)]

    response = await _call(client, method, path, body)

    assert response.status_code == 409
    assert response.json()["detail"] == (
        "This booking awaits approval — approve or reject it instead"
    )
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_editor_removing_a_pending_kanban_assignee_is_409(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    pending = _staff_row(5, approval_status="pending", approval_request_id=50)
    mock_db_session.execute.side_effect = [_scalar_result(_card()), scalars_result([pending])]

    response = await client.delete("/api/kanban/cards/phase/1/assignees/5")

    assert response.status_code == 409
    mock_db_session.delete.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("put", "/api/assignments/1", PROJECT_STAFF),
        ("delete", "/api/phase-staff/1", None),
        ("put", "/api/subphase-staff/1", {"allocation": 30}),
    ],
)
async def test_editor_write_overtakes_an_open_request(
    authed_client, mock_db_session, method, path, body
):
    from app.services.approvals import ApprovalEffects

    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    row = _staff_row(5, approval_request_id=50)
    mock_db_session.execute.side_effect = [_scalar_result(row)]
    effects = ApprovalEffects()
    with (
        patch("app.services.approvals.expire_overtaken", AsyncMock(return_value=effects)) as expire,
        patch("app.services.approvals.publish", AsyncMock()) as publish,
    ):
        response = await _call(client, method, path, body)

    assert response.status_code == 200
    assert expire.await_args.kwargs["row"] is row
    mock_db_session.commit.assert_awaited_once()
    publish.assert_awaited_once()
    assert publish.await_args.args[2] is effects


@pytest.mark.asyncio
async def test_editor_removing_a_kanban_assignee_overtakes_the_open_request(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    row = _staff_row(5, approval_request_id=50)
    mock_db_session.execute.side_effect = [_scalar_result(_card()), _scalar_result(row)]
    with (
        patch("app.services.approvals.expire_overtaken", AsyncMock()) as expire,
        patch("app.services.approvals.publish", AsyncMock()),
    ):
        response = await client.delete("/api/kanban/cards/phase/1/assignees/5")

    assert response.status_code == 200
    expire.assert_awaited_once()
