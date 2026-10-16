"""
Route-level tests for vacation absence types and POST /api/vacations/import.

Import follows the create rule (own user, or admin/superuser for anyone) and
skips (staff, start, end) duplicates, both against stored rows and within the
batch.
"""

from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.models.vacation import Vacation
from tests.conftest import FakeUser


def _scalar_result(value):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    return result


def _scalars_result(values):
    result = MagicMock()
    result.scalars.return_value.all.return_value = values
    return result


def _rows_result(rows):
    result = MagicMock()
    result.__iter__.return_value = iter(rows)
    return result


def _added(db, model):
    return [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], model)]


@pytest.mark.asyncio
async def test_user_cannot_import_for_someone_else(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.side_effect = [_scalar_result(object())]  # staff 2 exists

    response = await client.post(
        "/api/vacations/import",
        json={"staff_id": 2, "items": [{"start_date": "2026-07-01", "end_date": "2026-07-03"}]},
    )

    assert response.status_code == 403
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_superuser_can_import_for_someone_else(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [_scalar_result(object()), _rows_result([])]

    response = await client.post(
        "/api/vacations/import",
        json={"staff_id": 2, "items": [{"start_date": "2026-07-01", "end_date": "2026-07-03"}]},
    )

    assert response.status_code == 200
    assert response.json() == {"created": 1, "skipped": 0}


@pytest.mark.asyncio
async def test_import_skips_existing_and_in_batch_duplicates(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.side_effect = [
        _scalar_result(object()),  # staff lookup
        _scalars_result([3]),  # absence type 3 exists
        _rows_result([SimpleNamespace(start_date=date(2026, 7, 1), end_date=date(2026, 7, 3))]),
    ]

    response = await client.post(
        "/api/vacations/import",
        json={
            "staff_id": 1,
            "items": [
                {"start_date": "2026-07-01", "end_date": "2026-07-03"},  # already stored
                {"start_date": "2026-08-10", "end_date": "2026-08-10", "absence_type_id": 3},
                {"start_date": "2026-08-10", "end_date": "2026-08-10"},  # repeat in batch
                {"start_date": "2026-09-01", "end_date": "2026-09-02", "description": "Trip"},
            ],
        },
    )

    assert response.status_code == 200
    assert response.json() == {"created": 2, "skipped": 2}
    added = _added(mock_db_session, Vacation)
    assert [(v.start_date, v.absence_type_id, v.description) for v in added] == [
        (date(2026, 8, 10), 3, "Vacation"),
        (date(2026, 9, 1), None, "Trip"),
    ]
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_import_rejects_inverted_ranges(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.side_effect = [_scalar_result(object())]

    response = await client.post(
        "/api/vacations/import",
        json={"staff_id": 1, "items": [{"start_date": "2026-07-05", "end_date": "2026-07-01"}]},
    )

    assert response.status_code == 400
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_import_rejects_unknown_absence_types(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.side_effect = [_scalar_result(object()), _scalars_result([])]

    response = await client.post(
        "/api/vacations/import",
        json={
            "staff_id": 1,
            "items": [
                {"start_date": "2026-07-01", "end_date": "2026-07-01", "absence_type_id": 99}
            ],
        },
    )

    assert response.status_code == 400
    assert "99" in response.json()["detail"]


@pytest.mark.asyncio
async def test_import_is_capped(authed_client):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    item = {"start_date": "2026-07-01", "end_date": "2026-07-01"}

    response = await client.post(
        "/api/vacations/import", json={"staff_id": 1, "items": [item] * 1001}
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_rejects_unknown_absence_type(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.side_effect = [_scalar_result(object()), _scalars_result([])]

    response = await client.post(
        "/api/vacations",
        json={
            "staff_id": 1,
            "start_date": "2026-07-01",
            "end_date": "2026-07-01",
            "absence_type_id": 5,
        },
    )

    assert response.status_code == 400
    mock_db_session.add.assert_not_called()
