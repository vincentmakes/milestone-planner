"""
Route tests for /api/vacations — single-absence reads and writes with the
self-vs-other permission rule (plain users manage only their own absences;
superusers/admins manage anyone's).

The list scope is covered in tests/test_domain_routes_misc.py and the bulk
import in tests/test_vacation_import.py. Mock-based, house style.
"""

from datetime import date, datetime
from unittest.mock import MagicMock

import pytest

from app.models.user import User
from app.models.vacation import Vacation
from tests.conftest import FakeUser
from tests.support import scalar_result, scalars_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)


def make_staff(user_id: int = 5) -> User:
    return User(id=user_id, email=f"u{user_id}@example.com", first_name="Ada", last_name="Lovelace")


def make_vacation(vacation_id: int = 40, staff_id: int = 5, *, staff=True, type_id=None):
    vacation = Vacation(
        id=vacation_id,
        staff_id=staff_id,
        start_date=date(2026, 7, 1),
        end_date=date(2026, 7, 10),
        description="Summer",
        absence_type_id=type_id,
        created_at=STAMP,
    )
    vacation.staff = make_staff(staff_id) if staff else None
    return vacation


def type_ids_result(ids):
    """``select(AbsenceType.id)`` read with ``scalars().all()``."""
    return scalars_result(list(ids))


def sql(db, index: int = -1) -> str:
    stmt = db.execute.await_args_list[index].args[0]
    return str(stmt.compile(compile_kwargs={"literal_binds": True}))


@pytest.fixture
def db_assigns_ids(mock_db_session):
    async def refresh(obj):
        if getattr(obj, "id", None) is None:
            obj.id = 41
        obj.created_at = obj.created_at or STAMP

    mock_db_session.refresh.side_effect = refresh
    return mock_db_session


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_by_site_marks_only_own_rows_editable(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user", site_ids=[2]))
    mock_db_session.execute.return_value = scalars_result(
        [make_vacation(40, 5), make_vacation(41, 6, staff=False)]
    )

    response = await client.get("/api/vacations?siteId=2")

    assert response.status_code == 200
    body = response.json()
    assert [(v["id"], v["canEdit"], v["staff_name"]) for v in body] == [
        (40, True, "Ada Lovelace"),
        (41, False, ""),
    ]
    assert body[0]["start_date"].startswith("2026-0")  # Node-style ISO datetime
    query = sql(mock_db_session)
    assert "JOIN user_sites" in query
    assert "user_sites.site_id = 2" in query


@pytest.mark.asyncio
async def test_list_for_superuser_marks_every_row_editable(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = scalars_result([make_vacation(40, 5)])

    response = await client.get("/api/vacations?siteId=1")

    assert response.status_code == 200
    assert response.json()[0]["canEdit"] is True


@pytest.mark.asyncio
async def test_get_own_vacation(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.return_value = scalar_result(make_vacation(40, 5, type_id=3))

    response = await client.get("/api/vacations/40")

    assert response.status_code == 200
    body = response.json()
    assert (body["id"], body["staff_id"], body["absence_type_id"], body["canEdit"]) == (
        40,
        5,
        3,
        True,
    )
    assert body["description"] == "Summer"


@pytest.mark.asyncio
async def test_get_colleague_vacation_is_read_only(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "user"))
    mock_db_session.execute.return_value = scalar_result(make_vacation(40, 5))

    response = await client.get("/api/vacations/40")

    assert response.status_code == 200
    assert response.json()["canEdit"] is False
    # The read is scoped to own + visible-site absences, like the list.
    query = sql(mock_db_session)
    assert "vacations.id = 40" in query
    assert "vacations.staff_id = 9" in query
    assert "vacations.staff_id IN (SELECT user_sites.user_id" in query
    assert "user_sites.site_id IN (1)" in query


@pytest.mark.asyncio
async def test_get_non_colleague_vacation_is_404(authed_client, mock_db_session):
    """A plain user cannot read an absence of someone sharing no site with them.

    The scoped query finds nothing, so the answer is 404 (not 403): the id
    must not reveal that the absence exists.
    """
    client, set_user = authed_client
    set_user(FakeUser(9, "user"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.get("/api/vacations/40")

    assert response.status_code == 404
    assert response.json()["detail"] == "Vacation not found"
    assert "vacations.staff_id IN (SELECT user_sites.user_id" in sql(mock_db_session)


@pytest.mark.asyncio
async def test_get_vacation_is_unscoped_with_view_all(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(make_vacation(40, 5))

    response = await client.get("/api/vacations/40")

    assert response.status_code == 200
    assert response.json()["canEdit"] is True
    query = sql(mock_db_session)
    assert "vacations.id = 40" in query
    assert "user_sites" not in query


@pytest.mark.asyncio
async def test_get_vacation_is_scoped_to_visible_sites_for_superusers(
    authed_client, mock_db_session
):
    # Since RBAC decision 6 a superuser reads absences at their visible sites only.
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = scalar_result(make_vacation(40, 5))

    response = await client.get("/api/vacations/40")

    assert response.status_code == 200
    assert response.json()["canEdit"] is True
    assert "user_sites.site_id IN (1)" in sql(mock_db_session)


@pytest.mark.asyncio
async def test_get_vacation_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.get("/api/vacations/40")

    assert response.status_code == 404
    assert response.json()["detail"] == "Vacation not found"


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


def _create_body(**overrides):
    body = {"staff_id": 5, "start_date": "2026-07-01", "end_date": "2026-07-10"}
    body.update(overrides)
    return body


@pytest.mark.asyncio
async def test_user_creates_own_vacation_with_type(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    db = db_assigns_ids
    db.execute.side_effect = [scalar_result(make_staff(5)), type_ids_result([3])]

    response = await client.post(
        "/api/vacations", json=_create_body(description="Trip", absence_type_id=3)
    )

    assert response.status_code == 201
    body = response.json()
    assert (body["id"], body["staff_name"], body["canEdit"], body["absence_type_id"]) == (
        41,
        "Ada Lovelace",
        True,
        3,
    )
    (vacation,) = (c.args[0] for c in db.add.call_args_list)
    assert (vacation.staff_id, vacation.description) == (5, "Trip")
    assert vacation.start_date == date(2026, 7, 1)
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_blank_description_defaults_to_vacation(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    db_assigns_ids.execute.side_effect = [scalar_result(make_staff(5))]

    response = await client.post("/api/vacations", json=_create_body(description=""))

    assert response.status_code == 201
    assert response.json()["description"] == "Vacation"
    assert db_assigns_ids.execute.await_count == 1  # no absence-type lookup without a type


@pytest.mark.asyncio
async def test_superuser_creates_vacation_for_someone_else(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    db_assigns_ids.execute.side_effect = [scalar_result(make_staff(5))]

    response = await client.post("/api/vacations", json=_create_body())

    assert response.status_code == 201
    assert response.json()["staff_id"] == 5


@pytest.mark.asyncio
async def test_user_cannot_create_vacation_for_someone_else(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "user"))
    mock_db_session.execute.side_effect = [scalar_result(make_staff(5))]

    response = await client.post("/api/vacations", json=_create_body())

    assert response.status_code == 403
    assert response.json()["detail"] == "You can only create vacations for yourself"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_create_for_unknown_staff_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.post("/api/vacations", json=_create_body())

    assert response.status_code == 404
    assert response.json()["detail"] == "Staff member not found"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_create_with_unknown_absence_type_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [scalar_result(make_staff(5)), type_ids_result([])]

    response = await client.post("/api/vacations", json=_create_body(absence_type_id=77))

    assert response.status_code == 400
    assert response.json()["detail"] == "Unknown absence type: 77"
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        _create_body(end_date="2026-06-01"),  # inverted range
        _create_body(description="x" * 201),
        {"staff_id": 5, "start_date": "2026-07-01"},
    ],
)
async def test_create_validates_body(authed_client, mock_db_session, body):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))

    response = await client.post("/api/vacations", json=body)

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# Update
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_user_updates_own_vacation(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    vacation = make_vacation(40, 5)
    db_assigns_ids.execute.side_effect = [scalar_result(vacation), type_ids_result([2])]

    response = await client.put(
        "/api/vacations/40",
        json={"end_date": "2026-07-20", "description": "Longer", "absence_type_id": 2},
    )

    assert response.status_code == 200
    assert (vacation.start_date, vacation.end_date) == (date(2026, 7, 1), date(2026, 7, 20))
    assert (vacation.description, vacation.absence_type_id) == ("Longer", 2)
    assert response.json()["canEdit"] is True
    db_assigns_ids.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_explicit_null_clears_absence_type(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    vacation = make_vacation(40, 5, type_id=3)
    db_assigns_ids.execute.side_effect = [scalar_result(vacation)]

    response = await client.put("/api/vacations/40", json={"absence_type_id": None})

    assert response.status_code == 200
    assert vacation.absence_type_id is None
    assert db_assigns_ids.execute.await_count == 1  # null needs no type lookup


@pytest.mark.asyncio
async def test_update_without_type_field_keeps_it(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    vacation = make_vacation(40, 5, type_id=3)
    db_assigns_ids.execute.side_effect = [scalar_result(vacation)]

    response = await client.put("/api/vacations/40", json={"start_date": "2026-06-30"})

    assert response.status_code == 200
    assert vacation.absence_type_id == 3
    assert vacation.start_date == date(2026, 6, 30)


@pytest.mark.asyncio
async def test_update_merged_range_must_stay_ordered(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [scalar_result(make_vacation(40, 5))]

    # Only start_date sent: valid on its own, inverted against the stored end.
    response = await client.put("/api/vacations/40", json={"start_date": "2026-08-01"})

    assert response.status_code == 422
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_unknown_absence_type_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [scalar_result(make_vacation(40, 5)), type_ids_result([])]

    response = await client.put("/api/vacations/40", json={"absence_type_id": 8})

    assert response.status_code == 400
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_user_cannot_update_someone_elses_vacation(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "user"))
    vacation = make_vacation(40, 5)
    mock_db_session.execute.side_effect = [scalar_result(vacation)]

    response = await client.put("/api/vacations/40", json={"description": "Hijacked"})

    assert response.status_code == 403
    assert vacation.description == "Summer"
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_vacation_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.put("/api/vacations/40", json={"description": "x"})

    assert response.status_code == 404
    mock_db_session.commit.assert_not_awaited()


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(("user_id", "role"), [(5, "user"), (1, "superuser"), (1, "admin")])
async def test_delete_vacation_by_owner_or_privileged(
    authed_client, mock_db_session, user_id, role
):
    client, set_user = authed_client
    set_user(FakeUser(user_id, role))
    vacation = make_vacation(40, 5)
    mock_db_session.execute.return_value = scalar_result(vacation)

    response = await client.delete("/api/vacations/40")

    assert response.status_code == 200
    assert response.json() == {"success": True}
    mock_db_session.delete.assert_awaited_once_with(vacation)
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_user_cannot_delete_someone_elses_vacation(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "user"))
    mock_db_session.execute.return_value = scalar_result(make_vacation(40, 5))

    response = await client.delete("/api/vacations/40")

    assert response.status_code == 403
    assert response.json()["detail"] == "You can only delete your own vacations"
    mock_db_session.delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_vacation_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.delete("/api/vacations/40")

    assert response.status_code == 404
    mock_db_session.delete.assert_not_awaited()


# ---------------------------------------------------------------------------
# Import permission edge
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_import_for_unknown_staff_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.post(
        "/api/vacations/import",
        json={"staff_id": 5, "items": [{"start_date": "2026-01-01", "end_date": "2026-01-02"}]},
    )

    assert response.status_code == 404
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_import_only_duplicates_does_not_commit(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    existing = MagicMock()
    existing.__iter__.return_value = iter(
        [MagicMock(start_date=date(2026, 1, 1), end_date=date(2026, 1, 2))]
    )
    mock_db_session.execute.side_effect = [scalar_result(make_staff(5)), existing]

    response = await client.post(
        "/api/vacations/import",
        json={"staff_id": 5, "items": [{"start_date": "2026-01-01", "end_date": "2026-01-02"}]},
    )

    assert response.status_code == 200
    assert response.json() == {"created": 0, "skipped": 1}
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()


# ---------------------------------------------------------------------------
# Permission keys: absences.manage_own / absences.manage_others
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_custom_role_with_manage_others_creates_for_someone_else(
    authed_client, db_assigns_ids
):
    client, set_user = authed_client
    set_user(FakeUser(1, "team_lead", {"absences.manage_others"}))
    db_assigns_ids.execute.side_effect = [scalar_result(make_staff(5))]

    response = await client.post("/api/vacations", json=_create_body())

    assert response.status_code == 201


@pytest.mark.asyncio
async def test_a_role_without_manage_own_cannot_create_its_own_absence(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(5, "kiosk", {"absences.view_others"}))
    mock_db_session.execute.side_effect = [scalar_result(make_staff(5))]

    response = await client.post("/api/vacations", json=_create_body())

    assert response.status_code == 403
    assert response.json()["detail"] == "Permission required: absences.manage_own"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_a_superuser_without_manage_others_cannot_delete_someone_elses(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser", {"absences.manage_own"}))
    mock_db_session.execute.side_effect = [scalar_result(make_vacation(40, 5))]

    response = await client.delete("/api/vacations/40")

    assert response.status_code == 403
    assert response.json()["detail"] == "You can only delete your own vacations"


@pytest.mark.asyncio
async def test_can_edit_follows_the_absence_keys(authed_client, mock_db_session):
    client, set_user = authed_client
    # Manages others' absences but not their own.
    set_user(FakeUser(5, "odd", {"absences.manage_others", "absences.view_others"}, site_ids=[2]))
    mock_db_session.execute.return_value = scalars_result(
        [make_vacation(40, 5), make_vacation(41, 6)]
    )

    response = await client.get("/api/vacations?siteId=2")

    assert [(v["id"], v["canEdit"]) for v in response.json()] == [(40, False), (41, True)]
