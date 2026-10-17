"""
GET /staff/{id}/availability and GET /equipment/{id}/availability.

Both build one entry per day on the event loop; an unbounded range let any
authenticated user stall the worker, and malformed dates were opaque 500s.
They now 400 on bad, inverted or > 366-day ranges and keep their response
shape for valid ones. Mock-based (no live DB).
"""

from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from tests.conftest import FakeUser

ENDPOINTS = ["/api/staff/1/availability", "/api/equipment/1/availability"]


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ENDPOINTS, ids=["staff", "equipment"])
@pytest.mark.parametrize(
    ("start", "end"),
    [
        ("foo", "2026-01-31"),
        ("2026-01-01", "2026-13-01"),
        ("2026-02-30", "2026-03-01"),
        ("01/01/2026", "2026-01-31"),
        ("2026-02-01", "2026-01-31"),  # inverted
        ("0001-01-01", "9999-12-31"),  # the DoS range
        ("2026-01-01", "2027-01-02"),  # 367 days
    ],
)
async def test_bad_ranges_are_rejected_without_a_query(
    authed_client, mock_db_session, path, start, end
):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    response = await client.get(path, params={"startDate": start, "endDate": end})

    assert response.status_code == 400
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ENDPOINTS, ids=["staff", "equipment"])
async def test_a_full_leap_year_is_allowed(authed_client, mock_db_session, path):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    result = MagicMock()
    result.all.return_value = []
    result.scalars.return_value.all.return_value = []
    mock_db_session.execute.return_value = result

    response = await client.get(path, params={"startDate": "2028-01-01", "endDate": "2028-12-31"})

    assert response.status_code == 200
    assert len(response.json()) == 366


@pytest.mark.asyncio
async def test_staff_availability_small_range(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    result = MagicMock()
    result.all.return_value = [(60, date(2026, 1, 2), date(2026, 1, 10))]
    mock_db_session.execute.return_value = result

    response = await client.get(
        "/api/staff/1/availability", params={"startDate": "2026-01-01", "endDate": "2026-01-03"}
    )

    assert response.status_code == 200
    assert response.json() == [
        {"date": "2026-01-01", "allocated": 0, "available": 100},
        {"date": "2026-01-02", "allocated": 60, "available": 40},
        {"date": "2026-01-03", "allocated": 60, "available": 40},
    ]


@pytest.mark.asyncio
async def test_equipment_availability_small_range(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    booking = SimpleNamespace(start_date=date(2026, 1, 2), end_date=date(2026, 1, 2))
    result = MagicMock()
    result.scalars.return_value.all.return_value = [booking]
    mock_db_session.execute.return_value = result

    response = await client.get(
        "/api/equipment/1/availability",
        params={"startDate": "2026-01-01", "endDate": "2026-01-02"},
    )

    assert response.status_code == 200
    assert response.json() == [
        {"date": "2026-01-01", "occupied": False, "available": True},
        {"date": "2026-01-02", "occupied": True, "available": False},
    ]


@pytest.mark.asyncio
async def test_single_day_range(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    result = MagicMock()
    result.all.return_value = []
    mock_db_session.execute.return_value = result

    response = await client.get(
        "/api/staff/1/availability", params={"startDate": "2026-01-05", "endDate": "2026-01-05"}
    )

    assert response.status_code == 200
    assert len(response.json()) == 1
