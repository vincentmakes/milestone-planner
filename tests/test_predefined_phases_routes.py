"""
Route tests for /api/predefined-phases — template reads, create, update and
delete (reorder lives in tests/test_predefined_phases.py).

Mock-based, house style (tests/conftest.py).
"""

from datetime import datetime

import pytest

from app.models.settings import PredefinedPhase
from tests.conftest import FakeUser
from tests.support import scalar_result, scalars_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)


def make_phase(phase_id: int, name: str, sort_order: int = 0, is_active: int = 1):
    return PredefinedPhase(
        id=phase_id, name=name, sort_order=sort_order, is_active=is_active, created_at=STAMP
    )


@pytest.fixture
def db_assigns_ids(mock_db_session):
    async def refresh(obj):
        if getattr(obj, "id", None) is None:
            obj.id = 30
        obj.created_at = obj.created_at or STAMP

    mock_db_session.refresh.side_effect = refresh
    return mock_db_session


def sql(db, index: int = -1) -> str:
    stmt = db.execute.await_args_list[index].args[0]
    return str(stmt.compile(compile_kwargs={"literal_binds": True}))


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_active_phases_for_any_user(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = scalars_result(
        [make_phase(1, "Design", 0), make_phase(2, "Build", 1)]
    )

    response = await client.get("/api/predefined-phases")

    assert response.status_code == 200
    assert [(p["id"], p["name"], p["is_active"]) for p in response.json()] == [
        (1, "Design", 1),
        (2, "Build", 1),
    ]
    query = sql(mock_db_session)
    assert "predefined_phases.is_active = 1" in query
    assert "ORDER BY predefined_phases.sort_order" in query


@pytest.mark.asyncio
async def test_all_phases_include_inactive_for_superuser(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = scalars_result(
        [make_phase(1, "Design"), make_phase(3, "Retired", 2, is_active=0)]
    )

    response = await client.get("/api/predefined-phases/all")

    assert response.status_code == 200
    assert [p["is_active"] for p in response.json()] == [1, 0]
    assert "WHERE" not in sql(mock_db_session)  # no is_active filter


@pytest.mark.asyncio
async def test_all_phases_forbidden_for_plain_user(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    response = await client.get("/api/predefined-phases/all")

    assert response.status_code == 403
    mock_db_session.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_appends_after_highest_sort_order(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    db = db_assigns_ids
    db.execute.return_value = scalar_result(4)

    response = await client.post("/api/predefined-phases", json={"name": "  Validation  "})

    assert response.status_code == 201
    body = response.json()
    assert (body["id"], body["name"], body["sort_order"], body["is_active"]) == (
        30,
        "Validation",
        5,
        1,
    )
    (phase,) = (c.args[0] for c in db.add.call_args_list)
    assert phase.name == "Validation"  # stripped
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_first_phase_starts_at_zero(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db_assigns_ids.execute.return_value = scalar_result(None)  # empty table

    response = await client.post("/api/predefined-phases", json={"name": "Design"})

    assert response.status_code == 201
    assert response.json()["sort_order"] == 0


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Known bug: create_predefined_phase computes `max(sort_order) or -1`, "
        "which reads an existing maximum of 0 as 'no rows', so the second "
        "template is created with sort_order 0 again instead of 1. Fix the "
        "None check in app/routers/predefined_phases.py and drop this marker."
    ),
)
@pytest.mark.asyncio
async def test_create_after_single_phase_at_zero_gets_sort_order_one(authed_client, db_assigns_ids):
    """A template added after one at sort_order 0 must get sort_order 1."""
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db_assigns_ids.execute.return_value = scalar_result(0)

    response = await client.post("/api/predefined-phases", json={"name": "Second"})

    assert response.status_code == 201
    assert response.json()["sort_order"] == 1


@pytest.mark.asyncio
async def test_create_duplicate_name_is_400_and_rolled_back(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = scalar_result(1)
    mock_db_session.commit.side_effect = RuntimeError(
        'duplicate key value violates unique constraint "predefined_phases_name_key"'
    )

    response = await client.post("/api/predefined-phases", json={"name": "Design"})

    assert response.status_code == 400
    assert response.json()["detail"] == "A phase with this name already exists"
    mock_db_session.rollback.assert_awaited()


@pytest.mark.asyncio
async def test_create_other_db_error_is_opaque_500(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = scalar_result(1)
    mock_db_session.commit.side_effect = RuntimeError("connection reset by peer")

    response = await client.post("/api/predefined-phases", json={"name": "Design"})

    assert response.status_code == 500
    assert response.json()["detail"] == "Could not save the changes"
    assert "connection reset" not in response.text
    mock_db_session.rollback.assert_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [{}, {"name": ""}, {"name": "x" * 101}])
async def test_create_validates_name(authed_client, mock_db_session, payload):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))

    response = await client.post("/api/predefined-phases", json=payload)

    assert response.status_code == 422
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_create_forbidden_for_plain_user(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    response = await client.post("/api/predefined-phases", json={"name": "Design"})

    assert response.status_code == 403
    mock_db_session.add.assert_not_called()


# ---------------------------------------------------------------------------
# Update
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_renames_and_deactivates(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    phase = make_phase(4, "Old", 3)
    db_assigns_ids.execute.return_value = scalar_result(phase)

    response = await client.put(
        "/api/predefined-phases/4", json={"name": " New ", "is_active": False}
    )

    assert response.status_code == 200
    assert (phase.name, phase.is_active, phase.sort_order) == ("New", 0, 3)
    assert response.json()["is_active"] == 0
    db_assigns_ids.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_reactivates(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    phase = make_phase(4, "Old", is_active=0)
    db_assigns_ids.execute.return_value = scalar_result(phase)

    response = await client.put("/api/predefined-phases/4", json={"is_active": True})

    assert response.status_code == 200
    assert (phase.name, phase.is_active) == ("Old", 1)


@pytest.mark.asyncio
async def test_update_rejects_whitespace_only_name(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    phase = make_phase(4, "Old")
    mock_db_session.execute.return_value = scalar_result(phase)

    response = await client.put("/api/predefined-phases/4", json={"name": "   "})

    assert response.status_code == 400
    assert response.json()["detail"] == "Phase name cannot be empty"
    assert phase.name == "Old"
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_duplicate_name_is_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = scalar_result(make_phase(4, "Old"))
    mock_db_session.commit.side_effect = RuntimeError("UNIQUE constraint failed")

    response = await client.put("/api/predefined-phases/4", json={"name": "Taken"})

    assert response.status_code == 400
    mock_db_session.rollback.assert_awaited()


@pytest.mark.asyncio
async def test_update_other_db_error_is_500(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = scalar_result(make_phase(4, "Old"))
    mock_db_session.commit.side_effect = RuntimeError("deadlock detected")

    response = await client.put("/api/predefined-phases/4", json={"name": "New"})

    assert response.status_code == 500
    assert "deadlock" not in response.text
    mock_db_session.rollback.assert_awaited()


@pytest.mark.asyncio
async def test_update_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.put("/api/predefined-phases/4", json={"name": "New"})

    assert response.status_code == 404
    assert response.json()["detail"] == "Predefined phase not found"
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_forbidden_for_plain_user(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    response = await client.put("/api/predefined-phases/4", json={"name": "New"})

    assert response.status_code == 403
    mock_db_session.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_phase(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    phase = make_phase(4, "Old")
    mock_db_session.execute.return_value = scalar_result(phase)

    response = await client.delete("/api/predefined-phases/4")

    assert response.status_code == 200
    assert response.json() == {"success": True}
    mock_db_session.delete.assert_awaited_once_with(phase)
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_delete_phase_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.delete("/api/predefined-phases/4")

    assert response.status_code == 404
    mock_db_session.delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_phase_forbidden_for_plain_user(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    assert (await client.delete("/api/predefined-phases/4")).status_code == 403
    mock_db_session.delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_reorder_skips_unknown_ids(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    known = make_phase(2, "Build", 5)
    mock_db_session.execute.side_effect = [scalar_result(None), scalar_result(known)]

    response = await client.put("/api/predefined-phases/reorder", json={"phase_order": [99, 2]})

    assert response.status_code == 200
    assert response.json() == {"success": True}
    assert known.sort_order == 1  # position in the submitted list, gaps kept
    mock_db_session.commit.assert_awaited_once()
