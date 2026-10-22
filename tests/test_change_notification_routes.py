"""
Which change notifications each write route asks for (the trigger matrix).

The autouse ``change_intents`` fixture (tests/conftest.py) records every
``change_notifications.deliver`` call as ``(actor_id, intents,
already_notified)``; the delivery itself (recipients, the actor, coalescing)
is tests/test_change_notifications.py. Here: the right intents, with the
right texts, built from the values before the change -- and none for a no-op
PUT, a reorder, a rename or a dependency edit, the 202 approval path and the
withdrawal of one's own pending booking.
"""

from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.equipment import Equipment
from app.models.project import Project, ProjectPhase
from app.models.site import Site
from app.services import change_notifications as cn
from tests.conftest import FakeUser

# The real function, captured at import (the autouse change_intents fixture
# replaces it for every test).
REAL_DELIVER = cn.deliver

ADMIN = 1
PM = 7
ANN = 8


def admin() -> FakeUser:
    return FakeUser(ADMIN, "admin")


def scalar(value):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    result.scalar.return_value = value
    return result


def first(row):
    result = MagicMock()
    result.first.return_value = row
    return result


def staff_row(staff_id: int = ANN, **fields):
    values = {
        "id": 1,
        "project_id": 1,
        "phase_id": 11,
        "subphase_id": 12,
        "staff_id": staff_id,
        "allocation": 50,
        "start_date": date(2026, 1, 1),
        "end_date": date(2026, 1, 31),
        "approval_status": "approved",
        "approval_request_id": None,
    }
    values.update(fields)
    return SimpleNamespace(**values)


def only_call(change_intents):
    ((actor_id, intents, already),) = change_intents
    return actor_id, intents, already


def by_recipient(intents):
    return {i.recipient: i for i in intents}


# ---------------------------------------------------------------------------
# Staff bookings written directly
# ---------------------------------------------------------------------------


async def test_booking_someone_on_a_project(authed_client, mock_db_session, change_intents):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [first((PM,)), scalar(ANN), scalar(None)]

    response = await client.post(
        "/api/projects/1/staff",
        json={
            "staff_id": ANN,
            "allocation": 60,
            "start_date": "2026-01-01",
            "end_date": "2026-01-31",
        },
    )

    assert response.status_code == 200
    actor_id, intents, already = only_call(change_intents)
    assert (actor_id, already) == (ADMIN, set())
    out = by_recipient(intents)
    assert (out["person"].user_id, out["person"].type) == (ANN, "assignment_changed")
    assert out["person"].title == "Test User1 booked you on {target}"
    assert out["person"].body == "at 60% from 2026-01-01 to 2026-01-31"
    assert (out["pm"].user_id, out["pm"].person_id, out["pm"].type) == (
        None,
        ANN,
        "project_changed",
    )
    assert out["pm"].title == "Test User1 booked {person} on {target}"
    for i in intents:
        assert (i.project_id, i.entity_type, i.entity_id, i.coalesce) == (1, "project", 1, True)


BOOKING = {"staff_id": ANN, "allocation": 60, "start_date": "2026-01-01", "end_date": "2026-01-31"}


def give_id(assignment_id: int):
    def refresh(obj):
        obj.id = assignment_id

    return refresh


async def test_notifications_are_delivered_after_the_commit(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [first((PM,)), scalar(ANN), scalar(None)]
    log: list[str] = []
    mock_db_session.commit.side_effect = lambda: log.append("commit")

    async def deliver(*_args, **_kwargs):
        log.append("deliver")

    with patch.object(cn, "deliver", side_effect=deliver):
        response = await client.post("/api/projects/1/staff", json=BOOKING)

    assert response.status_code == 200
    assert log[:2] == ["commit", "deliver"]


async def test_a_failed_delivery_keeps_the_committed_booking(
    authed_client, mock_db_session, caplog
):
    """
    Regression: deliver used to roll back the route's session on a failure,
    which expires the new row; the route then read ``assignment.id``
    (MissingGreenlet on an AsyncSession -> 500 for a committed change).
    """
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [first((PM,)), scalar(ANN), scalar(None)]
    mock_db_session.refresh.side_effect = give_id(42)
    own = AsyncMock()

    class Factory:
        def __call__(self):
            class _Open:
                async def __aenter__(self):
                    return own

                async def __aexit__(self, *exc):
                    return False

            return _Open()

    row = cn._Row(
        user_id=ANN,
        type=cn.ASSIGNMENT_CHANGED,
        project_id=1,
        project_name="Alpha",
        entity_type="project",
        entity_id=1,
        title="Test User1 booked you on Alpha",
        body=None,
        coalesce=True,
    )
    with (
        patch.object(cn, "deliver", REAL_DELIVER),
        patch.object(cn, "resolve_tenant_session_factory", return_value=Factory()),
        patch.object(cn, "_resolve", AsyncMock(return_value=([row], "Test User1"))),
        patch.object(cn, "_coalesce", AsyncMock(side_effect=RuntimeError("CHECK violation"))),
    ):
        response = await client.post("/api/projects/1/staff", json=BOOKING)

    assert response.status_code == 200
    assert response.json() == {"id": 42, "success": True}
    own.rollback.assert_awaited_once()
    own.commit.assert_not_awaited()
    # The route's session saw its own commit only: never a rollback.
    mock_db_session.commit.assert_awaited_once()
    mock_db_session.rollback.assert_not_awaited()
    assert "Change notifications failed" in caplog.text


@pytest.mark.parametrize("level", ["phase", "subphase"])
async def test_booking_someone_on_a_card(authed_client, mock_db_session, change_intents, level):
    client, set_user = authed_client
    set_user(admin())
    details = first((staff_row(), "Ann Lee", "Chemist"))
    mock_db_session.execute.side_effect = [first((1,)), scalar(ANN), scalar(None), details]

    response = await client.post(
        f"/api/{level}s/11/staff", json={"staff_id": ANN, "project_id": 1, "allocation": 40}
    )

    assert response.status_code == 200
    _, intents, _ = only_call(change_intents)
    out = by_recipient(intents)
    assert out["person"].body == "at 40%"
    assert all((i.entity_type, i.entity_id) == (level, 11) for i in intents)


@pytest.mark.parametrize(
    ("path", "level", "target"),
    [("/api/phase-staff/1", "phase", 11), ("/api/subphase-staff/1", "subphase", 12)],
)
async def test_changing_someones_allocation(
    authed_client, mock_db_session, change_intents, path, level, target
):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [scalar(staff_row())]

    response = await client.put(path, json={"allocation": 80})

    assert response.status_code == 200
    _, intents, _ = only_call(change_intents)
    out = by_recipient(intents)
    assert out["person"].title == "Test User1 changed your booking on {target}"
    assert out["pm"].title == "Test User1 changed {person}'s booking on {target}"
    assert out["person"].body == out["pm"].body == "allocation 50% → 80%"
    assert all((i.entity_type, i.entity_id) == (level, target) for i in intents)


async def test_changing_project_booking_dates(authed_client, mock_db_session, change_intents):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [scalar(staff_row())]

    response = await client.put(
        "/api/assignments/1",
        json={"allocation": 50, "start_date": "2026-01-05", "end_date": "2026-01-31"},
    )

    assert response.status_code == 200
    _, intents, _ = only_call(change_intents)
    assert by_recipient(intents)["person"].body == (
        "dates 2026-01-01–2026-01-31 → 2026-01-05–2026-01-31"
    )


@pytest.mark.parametrize(
    ("path", "body"),
    [
        (
            "/api/assignments/1",
            {"allocation": 50, "start_date": "2026-01-01", "end_date": "2026-01-31"},
        ),
        ("/api/phase-staff/1", {"allocation": 50}),
        ("/api/subphase-staff/1", {"allocation": 50}),
    ],
)
async def test_a_put_that_changes_nothing_notifies_nobody(
    authed_client, mock_db_session, change_intents, path, body
):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [scalar(staff_row())]

    response = await client.put(path, json=body)

    assert response.status_code == 200
    assert only_call(change_intents)[1] == []


@pytest.mark.parametrize(
    ("path", "level", "was"),
    [
        ("/api/assignments/1", "project", "Was at 50% from 2026-01-01 to 2026-01-31"),
        ("/api/phase-staff/1", "phase", "Was at 50%"),
        ("/api/subphase-staff/1", "subphase", "Was at 50%"),
    ],
)
async def test_removing_someone(authed_client, mock_db_session, change_intents, path, level, was):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [scalar(staff_row())]

    response = await client.delete(path)

    assert response.status_code == 200
    _, intents, _ = only_call(change_intents)
    out = by_recipient(intents)
    assert out["person"].title == "Test User1 removed you from {target}"
    assert out["pm"].title == "Test User1 removed {person} from {target}"
    assert out["person"].body == out["pm"].body == was
    assert out["person"].entity_type == level


async def test_withdrawing_ones_own_pending_booking_notifies_nobody(
    authed_client, mock_db_session, change_intents
):
    from fastapi.responses import JSONResponse

    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    pending = staff_row(5, approval_status="pending", approval_request_id=50)
    mock_db_session.execute.side_effect = [scalar(pending)]
    cancelled = JSONResponse({"success": True, "cancelled": True, "request_id": 50, "id": 1})

    with patch("app.services.approvals.submit_request", AsyncMock(return_value=cancelled)):
        response = await client.delete("/api/phase-staff/1")

    assert response.json()["cancelled"] is True
    assert change_intents == []


# ---------------------------------------------------------------------------
# Kanban assignees
# ---------------------------------------------------------------------------


def _card():
    card = MagicMock()
    card.id = 11
    card.project_id = 1
    card.type = "Design"
    card.name = None
    return card


async def test_assigning_someone_to_a_card_keeps_their_assigned_notification(
    authed_client, mock_db_session, change_intents
):
    client, set_user = authed_client
    set_user(admin())
    assignee = SimpleNamespace(id=ANN, full_name="Ann Lee", max_capacity=80)
    mock_db_session.execute.side_effect = [scalar(_card()), scalar(assignee), scalar(None)]
    mock_db_session.refresh.side_effect = lambda obj: setattr(obj, "id", 70)

    response = await client.post("/api/kanban/cards/phase/11/assignees", json={"staff_id": ANN})

    assert response.status_code == 201
    actor_id, intents, already = only_call(change_intents)
    assert (actor_id, already) == (ADMIN, {ANN})  # Ann has her "assigned" row
    pm = by_recipient(intents)["pm"]
    assert pm.title == "Test User1 booked Ann Lee on Design"
    assert pm.body == "at 80%"
    assert (pm.entity_type, pm.entity_id) == ("phase", 11)


async def test_removing_someone_from_a_card(authed_client, mock_db_session, change_intents):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [scalar(_card()), scalar(staff_row(allocation=30))]

    response = await client.delete(f"/api/kanban/cards/phase/11/assignees/{ANN}")

    assert response.status_code == 200
    _, intents, already = only_call(change_intents)
    assert already == set()
    out = by_recipient(intents)
    assert out["person"].title == "Test User1 removed you from Design"
    assert out["person"].body == "Was at 30%"
    assert out["pm"].title == "Test User1 removed {person} from Design"


# ---------------------------------------------------------------------------
# Equipment bookings
# ---------------------------------------------------------------------------


async def test_booking_equipment_tells_the_pm(authed_client, mock_db_session, change_intents):
    client, set_user = authed_client
    set_user(admin())
    hplc = Equipment(id=3, name="HPLC", type="Analytical", site_id=1, active=1)
    hplc.sites = [Site(id=1, name="Site 1")]
    mock_db_session.execute.side_effect = [first((1,)), scalar(hplc)]

    response = await client.post(
        "/api/projects/1/equipment",
        json={"equipment_id": 3, "start_date": "2026-02-01", "end_date": "2026-02-05"},
    )

    assert response.status_code == 200
    _, (only,), _ = only_call(change_intents)
    assert (only.recipient, only.type, only.user_id) == ("pm", "project_changed", None)
    assert only.title == "Test User1 booked HPLC for {project}"
    assert only.body == "from 2026-02-01 to 2026-02-05"
    assert (only.entity_type, only.entity_id, only.project_id) == ("project", 1, 1)


async def test_an_equipment_put_without_change_notifies_nobody(
    authed_client, mock_db_session, change_intents
):
    client, set_user = authed_client
    set_user(admin())
    booking = SimpleNamespace(
        id=1,
        project_id=1,
        project=SimpleNamespace(name="Alpha", site_id=1),
        equipment=SimpleNamespace(name="HPLC"),
        equipment_id=3,
        start_date=date(2026, 2, 1),
        end_date=date(2026, 2, 5),
        created_at=datetime(2026, 1, 1, 12, 0, 0),
    )
    reloaded = MagicMock()
    reloaded.scalar_one.return_value = booking
    mock_db_session.execute.side_effect = [scalar(booking), reloaded]

    response = await client.put(
        "/api/equipment-assignments/1", json={"equipment_id": 3, "end_date": "2026-02-05"}
    )

    assert response.status_code == 200
    assert only_call(change_intents)[1] == []


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------


def _project(**fields) -> Project:
    values = {
        "id": 1,
        "name": "Alpha",
        "site_id": 1,
        "pm_id": PM,
        "customer": "Acme",
        "sales_pm": "Sam",
        "confirmed": 0,
        "volume": 10,
        "archived": 0,
        "notes": "n",
        "start_date": date(2026, 1, 1),
        "end_date": date(2026, 6, 30),
    }
    values.update(fields)
    return Project(**values)


# What the Gantt sends on every save: every field, unchanged.
ECHO = {
    "name": "Alpha",
    "customer": "Acme",
    "pm_id": PM,
    "sales_pm": "Sam",
    "confirmed": False,
    "volume": 10,
    "start_date": "2026-01-01",
    "end_date": "2026-06-30",
    "notes": "n",
}


async def test_a_project_put_echoing_every_field_notifies_nobody(
    authed_client, mock_db_session, change_intents
):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [scalar(_project())]

    response = await client.put("/api/projects/1", json=ECHO)

    assert response.status_code == 200
    assert only_call(change_intents)[1] == []


async def test_notes_and_sales_pm_never_notify(authed_client, mock_db_session, change_intents):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [scalar(_project())]

    response = await client.put("/api/projects/1", json={"notes": "new", "sales_pm": "Kim"})

    assert response.status_code == 200
    assert only_call(change_intents)[1] == []


async def test_a_real_project_change_tells_the_pm(authed_client, mock_db_session, change_intents):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [scalar(_project())]

    response = await client.put(
        "/api/projects/1",
        json={**ECHO, "name": "Beta", "confirmed": True, "end_date": "2026-07-31"},
    )

    assert response.status_code == 200
    _, (only,), _ = only_call(change_intents)
    assert (only.recipient, only.user_id) == ("pm", PM)
    assert only.title == "Test User1 changed Beta"
    assert only.body == (
        "name Alpha → Beta; dates 2026-01-01–2026-06-30 → 2026-01-01–2026-07-31; confirmed"
    )


async def test_archiving_tells_the_pm(authed_client, mock_db_session, change_intents):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [scalar(_project())]

    response = await client.put("/api/projects/1", json={"archived": True})

    assert response.status_code == 200
    _, (only,), _ = only_call(change_intents)
    assert only.body == "archived"


async def test_handing_a_project_over_tells_the_old_and_the_new_pm(
    authed_client, mock_db_session, change_intents
):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [scalar(_project()), scalar(ANN)]

    response = await client.put("/api/projects/1", json={**ECHO, "pm_id": ANN})

    assert response.status_code == 200
    _, intents, _ = only_call(change_intents)
    by_user = {i.user_id: i for i in intents}
    assert set(by_user) == {PM, ANN}
    assert by_user[PM].title == "Test User1 handed Alpha over to {person}"
    assert by_user[PM].person_id == ANN
    assert by_user[ANN].title == "Test User1 made you the manager of Alpha"
    assert all(i.body is None and i.type == "project_changed" for i in intents)


async def test_creating_a_project_for_another_pm_tells_them(
    authed_client, mock_db_session, change_intents
):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.add.side_effect = lambda obj: setattr(obj, "id", 42)
    mock_db_session.execute.side_effect = [scalar(1), scalar(ANN)]  # site, PM exist

    response = await client.post(
        "/api/projects",
        json={
            "name": "New",
            "site_id": 1,
            "pm_id": ANN,
            "start_date": "2026-01-01",
            "end_date": "2026-02-01",
        },
    )

    assert response.status_code == 200
    _, (only,), _ = only_call(change_intents)
    assert (only.recipient, only.user_id, only.project_id) == ("pm", ANN, 42)
    assert only.title == "Test User1 made you the manager of New"


async def test_creating_a_project_without_pm_tells_nobody(
    authed_client, mock_db_session, change_intents
):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [scalar(1)]  # the site exists

    response = await client.post(
        "/api/projects",
        json={"name": "New", "site_id": 1, "start_date": "2026-01-01", "end_date": "2026-02-01"},
    )

    assert response.status_code == 200
    assert change_intents == []  # no delivery at all


async def test_creating_ones_own_project_runs_no_delivery(
    authed_client, mock_db_session, change_intents
):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.add.side_effect = lambda obj: setattr(obj, "id", 42)
    mock_db_session.execute.side_effect = [scalar(1), scalar(ADMIN)]  # site, PM exist

    response = await client.post(
        "/api/projects",
        json={
            "name": "Mine",
            "site_id": 1,
            "pm_id": ADMIN,
            "start_date": "2026-01-01",
            "end_date": "2026-02-01",
        },
    )

    assert response.status_code == 200
    # The only recipient would be the actor: no context load, user query or commit.
    assert change_intents == []
    mock_db_session.commit.assert_awaited_once()  # the project's own


# ---------------------------------------------------------------------------
# Phases and subphases
# ---------------------------------------------------------------------------


async def test_adding_a_phase_tells_the_pm(authed_client, mock_db_session, change_intents):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.add.side_effect = lambda obj: setattr(obj, "id", 11)
    mock_db_session.execute.side_effect = [scalar(2)]  # max sort order

    response = await client.post(
        "/api/projects/1/phases",
        json={"type": "Design", "start_date": "2026-01-01", "end_date": "2026-01-31"},
    )

    assert response.status_code == 200
    _, (only,), _ = only_call(change_intents)
    assert (only.recipient, only.user_id) == ("pm", None)
    assert only.title == "Test User1 added Design to {project}"
    assert only.body == "from 2026-01-01 to 2026-01-31"
    assert (only.entity_type, only.entity_id, only.project_id) == ("phase", 11, 1)


@pytest.mark.parametrize("path", ["/api/phases/11/subphases", "/api/subphases/12/children"])
async def test_adding_a_subphase_tells_the_pm(authed_client, mock_db_session, change_intents, path):
    client, set_user = authed_client
    set_user(admin())
    parent = MagicMock(id=12, project_id=1, depth=1)
    mock_db_session.add.side_effect = lambda obj: setattr(obj, "id", 13)
    mock_db_session.execute.side_effect = [scalar(parent), scalar(0)]

    response = await client.post(
        path,
        json={
            "name": "Trial",
            "project_id": 1,
            "start_date": "2026-01-02",
            "end_date": "2026-01-09",
        },
    )

    assert response.status_code == 200
    _, (only,), _ = only_call(change_intents)
    assert only.title == "Test User1 added Trial to {project}"
    assert (only.entity_type, only.entity_id, only.project_id) == ("subphase", 13, 1)


def _phase() -> ProjectPhase:
    return ProjectPhase(
        id=11,
        project_id=1,
        type="Design",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 1, 31),
        is_milestone=0,
        completion=0,
        status="todo",
    )


@pytest.mark.parametrize(
    "body",
    [
        {"type": "Renamed"},
        {"dependencies": [{"id": 9, "type": "FS"}]},
        {"status": "done"},
        {"completion": 50},
        {"is_milestone": True},
        {"start_date": "2026-01-01", "end_date": "2026-01-31"},  # the same dates again
    ],
    ids=["rename", "dependencies", "status", "completion", "milestone", "same-dates"],
)
async def test_a_phase_put_without_a_move_notifies_nobody(
    authed_client, mock_db_session, change_intents, body
):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [scalar(_phase())]  # no booking lookup either

    response = await client.put("/api/phases/11", json=body)

    assert response.status_code == 200
    assert only_call(change_intents)[1] == []


async def test_reordering_notifies_nobody(authed_client, mock_db_session, change_intents):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [MagicMock(), MagicMock()]

    response = await client.put("/api/projects/1/phases/reorder", json={"phase_order": [2, 1]})

    assert response.status_code == 200
    assert change_intents == []
