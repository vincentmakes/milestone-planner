"""
The optional note of an equipment booking (r9): ``equipment_assignments.note``.

Create and PUT accept ``note`` (<= 2000 chars, blank = none; on PUT left out
keeps it, ``null`` or blank clears it), the responses, the equipment's booking
list and the project tree carry it, and the PM's notification of a new
booking shows its preview. A note-only edit notifies nobody. Equipment
bookings are project-level: there is no phase / subphase equipment route.
"""

from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.models.equipment import Equipment, EquipmentAssignment
from app.models.site import Site
from tests.conftest import FakeUser

ADMIN = 1


def scalar(value):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    return result


def first(row):
    result = MagicMock()
    result.first.return_value = row
    return result


def hplc() -> Equipment:
    equipment = Equipment(id=3, name="HPLC", type="Analytical", site_id=1, active=1)
    equipment.sites = [Site(id=1, name="Site 1")]
    return equipment


def booking(**fields):
    values = {
        "id": 1,
        "project_id": 1,
        "project": SimpleNamespace(name="Alpha", site_id=1),
        "equipment": SimpleNamespace(name="HPLC"),
        "equipment_id": 3,
        "start_date": date(2026, 2, 1),
        "end_date": date(2026, 2, 5),
        "note": "Bring the column",
        "created_at": datetime(2026, 1, 1, 12, 0, 0),
    }
    values.update(fields)
    return SimpleNamespace(**values)


def added(mock_db_session) -> EquipmentAssignment:
    (row,) = (
        c.args[0]
        for c in mock_db_session.add.call_args_list
        if isinstance(c.args[0], EquipmentAssignment)
    )
    return row


BODY = {"equipment_id": 3, "start_date": "2026-02-01", "end_date": "2026-02-05"}


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


async def test_create_stores_the_note_and_shows_it_to_the_pm(
    authed_client, mock_db_session, change_intents
):
    client, set_user = authed_client
    set_user(FakeUser(ADMIN, "admin"))
    mock_db_session.execute.side_effect = [first((1,)), scalar(hplc())]

    response = await client.post(
        "/api/projects/1/equipment",
        json={**BODY, "note": "  Needs the @[Bob](9) column  "},
    )

    assert response.status_code == 200
    assert added(mock_db_session).note == "Needs the @[Bob](9) column"
    ((_actor, (intent,), _already),) = change_intents
    assert intent.body == "from 2026-02-01 to 2026-02-05 — Needs the @Bob column"


@pytest.mark.parametrize("note", [None, "", "   "])
async def test_create_without_a_note_stores_none(
    note, authed_client, mock_db_session, change_intents
):
    client, set_user = authed_client
    set_user(FakeUser(ADMIN, "admin"))
    mock_db_session.execute.side_effect = [first((1,)), scalar(hplc())]

    response = await client.post("/api/projects/1/equipment", json={**BODY, "note": note})

    assert response.status_code == 200
    assert added(mock_db_session).note is None
    ((_actor, (intent,), _already),) = change_intents
    assert intent.body == "from 2026-02-01 to 2026-02-05"


async def test_create_with_a_note_over_the_limit_is_422(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(ADMIN, "admin"))

    response = await client.post("/api/projects/1/equipment", json={**BODY, "note": "x" * 2001})

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.parametrize("level", ["phases", "subphases"])
async def test_there_is_no_phase_or_subphase_equipment_route(level, authed_client):
    client, set_user = authed_client
    set_user(FakeUser(ADMIN, "admin"))

    response = await client.post(f"/api/{level}/1/equipment", json=BODY)

    assert response.status_code in (404, 405)


# ---------------------------------------------------------------------------
# Update
# ---------------------------------------------------------------------------


async def _put(client, mock_db_session, row, body):
    reloaded = MagicMock()
    reloaded.scalar_one.return_value = row
    mock_db_session.execute.side_effect = [scalar(row), reloaded]
    return await client.put("/api/equipment-assignments/1", json=body)


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"note": "New note"}, "New note"),
        ({"note": "  New note  "}, "New note"),
        ({"note": None}, None),
        ({"note": ""}, None),
        ({"note": "   "}, None),
        ({"end_date": "2026-02-05"}, "Bring the column"),  # left out: kept
    ],
    ids=["set", "stripped", "null-clears", "empty-clears", "blank-clears", "absent-keeps"],
)
async def test_put_sets_clears_or_keeps_the_note(
    body, expected, authed_client, mock_db_session, change_intents
):
    client, set_user = authed_client
    set_user(FakeUser(ADMIN, "admin"))
    row = booking()

    response = await _put(client, mock_db_session, row, body)

    assert response.status_code == 200
    assert row.note == expected
    assert response.json()["note"] == expected


async def test_a_note_only_edit_notifies_nobody(authed_client, mock_db_session, change_intents):
    client, set_user = authed_client
    set_user(FakeUser(ADMIN, "admin"))

    response = await _put(client, mock_db_session, booking(), {"note": "Changed"})

    assert response.status_code == 200
    ((_actor, intents, _already),) = change_intents
    assert intents == []


async def test_put_with_a_note_over_the_limit_is_422(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(ADMIN, "admin"))

    response = await client.put("/api/equipment-assignments/1", json={"note": "x" * 2001})

    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


async def test_the_equipment_booking_list_carries_the_note(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(ADMIN, "admin"))
    row = booking()
    listed = MagicMock()
    listed.scalars.return_value.all.return_value = [row]
    mock_db_session.execute.side_effect = [listed]  # an admin sees every site: no site query

    response = await client.get("/api/equipment/3/assignments")

    assert response.status_code == 200
    assert [b["note"] for b in response.json()] == ["Bring the column"]


def test_the_orm_column_is_nullable_text():
    column = EquipmentAssignment.__table__.c.note
    assert column.nullable is True
    assert str(column.type) == "TEXT"


def test_the_project_tree_serialises_the_note():
    from app.schemas.project import EquipmentAssignmentInProject

    item = EquipmentAssignmentInProject(
        id=1,
        equipment_id=3,
        project_id=1,
        start_date=date(2026, 2, 1),
        end_date=date(2026, 2, 5),
        note="Bring the column",
        created_at=datetime(2026, 1, 1),
    )
    dumped = item.model_dump()
    assert dumped["note"] == "Bring the column"
    assert "notes" not in dumped
