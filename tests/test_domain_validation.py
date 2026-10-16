"""
Domain validation that used to end in a 500 (or silently store nonsense):

- B2-13: allocation is 1..100 on every staff booking (project / phase /
  subphase, create and update, Kanban assignees) -- 0 and 101 are 422.
- B2-17: ``end_date >= start_date`` on projects, phases, subphases,
  project-level assignments, equipment bookings and vacations (422), both on
  the request body and on a partial update merged onto the stored row.
- B2-16: unknown references (pm_id, site_id, site_ids, skill_ids, staff_id)
  are 400/404 instead of an FK violation.
- B2-18: date query strings go through date_range.parse_day (400, not 500).
- B1-22: new/changed tenant passwords need 8 characters.

Mock-based (tests/conftest.py): invalid bodies never reach the database, and
for the rest each test lays out the `db.execute` results in order.
"""

from datetime import date
from unittest.mock import MagicMock

import pytest

from tests.conftest import FakeUser


def _scalar_result(value):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    return result


class _ScalarList(list):
    """What `Result.scalars()` returns: iterable, with `.all()`."""

    def all(self):
        return list(self)


def _scalars_result(values):
    result = MagicMock()
    result.scalars.return_value = _ScalarList(values)
    return result


def _row(**fields):
    row = MagicMock()
    for key, value in fields.items():
        setattr(row, key, value)
    return row


INVERTED = {"start_date": "2026-03-10", "end_date": "2026-03-01"}


# ---------------------------------------------------------------------------
# B2-13 allocation bounds
# ---------------------------------------------------------------------------

ALLOCATION_ROUTES = [
    (
        "post",
        "/api/projects/1/staff",
        {"staff_id": 5, "start_date": "2026-01-01", "end_date": "2026-01-31"},
    ),
    ("put", "/api/assignments/1", {"start_date": "2026-01-01", "end_date": "2026-01-31"}),
    ("post", "/api/phases/1/staff", {"staff_id": 5, "project_id": 1}),
    ("put", "/api/phase-staff/1", {}),
    ("post", "/api/subphases/1/staff", {"staff_id": 5, "project_id": 1}),
    ("put", "/api/subphase-staff/1", {}),
    ("post", "/api/kanban/cards/phase/1/assignees", {"staff_id": 5}),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("allocation", [0, -5, 101])
async def test_allocation_outside_1_to_100_is_422(authed_client, mock_db_session, allocation):
    # One app for every route (building the app dominates this test's runtime).
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    for method, path, body in ALLOCATION_ROUTES:
        response = await getattr(client, method)(path, json={**body, "allocation": allocation})
        assert response.status_code == 422, (method, path, response.text)

    mock_db_session.execute.assert_not_awaited()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_allocation_bounds_are_inclusive(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    row = _row(id=1, project_id=1, staff_id=5, allocation=50)
    for allocation in (1, 100):
        mock_db_session.execute.side_effect = [_scalar_result(row)]
        response = await client.put("/api/phase-staff/1", json={"allocation": allocation})
        assert response.status_code == 200, response.text
        assert row.allocation == allocation


@pytest.mark.asyncio
async def test_phase_assignment_without_allocation_still_defaults_to_100(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    resolved = MagicMock()
    resolved.first.return_value = (1,)
    detail = MagicMock()
    detail.first.return_value = (
        _row(id=3, phase_id=1, project_id=1, staff_id=5, allocation=100),
        "A B",
        None,
    )
    mock_db_session.execute.side_effect = [resolved, _scalar_result(5), detail]

    response = await client.post(
        "/api/phases/1/staff", json={"staff_id": 5, "project_id": 1, "allocation": None}
    )

    assert response.status_code == 200, response.text
    assert mock_db_session.add.call_args[0][0].allocation == 100


# ---------------------------------------------------------------------------
# B2-17 date order -- request bodies
# ---------------------------------------------------------------------------

DATE_BODY_ROUTES = [
    ("post", "/api/projects", {"name": "P"}),
    ("put", "/api/projects/1", {}),
    ("post", "/api/projects/1/phases", {"type": "Design"}),
    ("put", "/api/phases/1", {}),
    ("post", "/api/phases/1/subphases", {"name": "S", "project_id": 1}),
    ("put", "/api/subphases/1", {}),
    ("post", "/api/projects/1/staff", {"staff_id": 5}),
    ("put", "/api/assignments/1", {"allocation": 50}),
    ("post", "/api/projects/1/equipment", {"equipment_id": 7}),
    ("put", "/api/equipment-assignments/1", {}),
    ("post", "/api/vacations", {"staff_id": 1}),
    ("put", "/api/vacations/1", {}),
]


@pytest.mark.asyncio
async def test_inverted_date_range_in_the_body_is_422(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    for method, path, body in DATE_BODY_ROUTES:
        response = await getattr(client, method)(path, json={**body, **INVERTED})
        assert response.status_code == 422, (method, path, response.text)
        assert "end_date must be on or after start_date" in response.text, (method, path)

    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_inverted_phase_inside_a_new_project_is_422(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.post(
        "/api/projects",
        json={
            "name": "P",
            "start_date": "2026-01-01",
            "end_date": "2026-12-31",
            "phases": [{"type": "Design", **INVERTED}],
        },
    )

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_single_day_ranges_are_fine(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    phase = _row(
        id=1, project_id=1, type="Design", start_date=date(2026, 1, 1), end_date=date(2026, 1, 9)
    )
    mock_db_session.execute.side_effect = [_scalar_result(phase)]

    response = await client.put(
        "/api/phases/1", json={"start_date": "2026-01-05", "end_date": "2026-01-05"}
    )

    assert response.status_code == 200, response.text


# ---------------------------------------------------------------------------
# B2-17 date order -- partial updates merged onto the stored row
# ---------------------------------------------------------------------------


def _dated(**extra):
    return _row(start_date=date(2026, 3, 1), end_date=date(2026, 3, 31), **extra)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path", "row", "body"),
    [
        ("/api/projects/1", _dated(id=1, pm_id=None, name="P"), {"end_date": "2026-02-01"}),
        ("/api/phases/1", _dated(id=1, project_id=1, type="Design"), {"start_date": "2026-04-15"}),
        ("/api/subphases/1", _dated(id=1, project_id=1, name="S"), {"end_date": "2026-02-27"}),
    ],
)
async def test_partial_update_that_inverts_the_stored_range_is_422(
    authed_client, mock_db_session, path, row, body
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [_scalar_result(row)]

    response = await client.put(path, json=body)

    assert response.status_code == 422, response.text
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_partial_vacation_update_that_inverts_the_range_is_422(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    vacation = _dated(id=1, staff_id=5)
    mock_db_session.execute.side_effect = [_scalar_result(vacation)]

    response = await client.put("/api/vacations/1", json={"end_date": "2026-02-01"})

    assert response.status_code == 422
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_partial_update_without_dates_does_not_check_the_stored_range(
    authed_client, mock_db_session
):
    """Rows that are already inverted (old data) stay editable."""
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    phase = _row(
        id=1, project_id=1, type="Design", start_date=date(2026, 5, 1), end_date=date(2026, 4, 1)
    )
    mock_db_session.execute.side_effect = [_scalar_result(phase)]

    response = await client.put("/api/phases/1", json={"type": "Renamed"})

    assert response.status_code == 200, response.text


# ---------------------------------------------------------------------------
# B2-16 unknown references
# ---------------------------------------------------------------------------

PROJECT_BODY = {"name": "P", "start_date": "2026-01-01", "end_date": "2026-02-01"}


@pytest.mark.asyncio
async def test_create_project_with_unknown_site_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [_scalar_result(None)]

    response = await client.post("/api/projects", json={**PROJECT_BODY, "site_id": 999})

    assert response.status_code == 404
    assert response.json()["detail"] == "Site not found"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_create_project_with_unknown_manager_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [_scalar_result(1), _scalar_result(None)]

    response = await client.post("/api/projects", json={**PROJECT_BODY, "site_id": 1, "pm_id": 999})

    assert response.status_code == 404
    assert response.json()["detail"] == "Project manager not found"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_update_project_to_unknown_manager_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    project = _dated(id=1, pm_id=7, name="P")
    mock_db_session.execute.side_effect = [_scalar_result(project), _scalar_result(None)]

    response = await client.put("/api/projects/1", json={"pm_id": 999})

    assert response.status_code == 404
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_resending_the_unchanged_manager_needs_no_lookup(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    project = _dated(id=1, pm_id=7, name="P")
    mock_db_session.execute.side_effect = [_scalar_result(project)]

    response = await client.put("/api/projects/1", json={"pm_id": 7, "name": "Q"})

    assert response.status_code == 200, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path", "body", "lookups"),
    [
        ("/api/projects/1/staff", {"start_date": "2026-01-01", "end_date": "2026-01-02"}, "pm"),
        ("/api/phases/1/staff", {"project_id": 1}, "parent"),
        ("/api/subphases/1/staff", {"project_id": 1}, "parent"),
    ],
)
async def test_assigning_an_unknown_staff_member_is_404(
    authed_client, mock_db_session, path, body, lookups
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    first = MagicMock()
    first.first.return_value = (None,) if lookups == "pm" else (1,)
    mock_db_session.execute.side_effect = [first, _scalar_result(None)]

    response = await client.post(path, json={**body, "staff_id": 999, "allocation": 50})

    assert response.status_code == 404
    assert response.json()["detail"] == "Staff member not found"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_create_note_with_unknown_site_or_staff_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    body = {"site_id": 999, "date": "2026-01-05", "text": "Hi"}

    mock_db_session.execute.side_effect = [_scalar_result(None)]
    response = await client.post("/api/notes", json=body)
    assert response.status_code == 404
    assert response.json()["detail"] == "Site not found"

    mock_db_session.execute.side_effect = [_scalar_result(1), _scalar_result(None)]
    response = await client.post("/api/notes", json={**body, "site_id": 1, "staff_id": 999})
    assert response.status_code == 404
    assert response.json()["detail"] == "Staff member not found"
    mock_db_session.add.assert_not_called()


def _none_found():
    return _scalars_result([])


@pytest.mark.asyncio
async def test_create_user_with_unknown_site_or_skill_is_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    body = {
        "email": "new@example.com",
        "password": "long-enough",
        "first_name": "N",
        "last_name": "U",
    }
    mock_db_session.execute.side_effect = [_scalar_result(None), _none_found()]

    response = await client.post("/api/users", json={**body, "site_ids": [998, 999]})
    assert response.status_code == 400
    assert response.json()["detail"] == "Unknown site: 998, 999"

    mock_db_session.execute.side_effect = [_scalar_result(None), _none_found()]
    response = await client.post("/api/users", json={**body, "skill_ids": [5]})
    assert response.status_code == 400
    assert response.json()["detail"] == "Unknown skill: 5"
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_user_links_each_site_once(authed_client, mock_db_session):
    from datetime import datetime

    from app.models.site import Site
    from app.models.user import User, UserSite

    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    site = Site(id=2, name="Basel")
    mock_db_session.execute.side_effect = [_scalar_result(None), _scalars_result([site])]

    async def flush():
        for call in mock_db_session.add.call_args_list:
            obj = call.args[0]
            if isinstance(obj, User):
                obj.id = 50
                obj.created_at = datetime(2026, 1, 1)
                obj.is_system = 0

    mock_db_session.flush.side_effect = flush

    response = await client.post(
        "/api/users",
        json={
            "email": "new@example.com",
            "password": "long-enough",
            "first_name": "N",
            "last_name": "U",
            "site_ids": [2, 2],
        },
    )

    assert response.status_code == 201, response.text
    links = [
        c.args[0] for c in mock_db_session.add.call_args_list if isinstance(c.args[0], UserSite)
    ]
    assert [(link.user_id, link.site_id) for link in links] == [(50, 2)]


# ---------------------------------------------------------------------------
# B2-18 date query strings
# ---------------------------------------------------------------------------


MALFORMED_DATE_QUERIES = [
    "/api/holidays?siteId=1&startDate=foo&endDate=2026-01-01",
    "/api/holidays?siteId=1&startDate=2026-01-01&endDate=2026-13-01",
    "/api/events?siteId=1&startDate=yesterday",
    "/api/events?siteId=1&endDate=2026-02-30",
    "/api/notes?siteId=1&startDate=foo",
    "/api/notes?siteId=1&endDate=01.02.2026",
]


@pytest.mark.asyncio
async def test_malformed_date_query_is_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    for path in MALFORMED_DATE_QUERIES:
        response = await client.get(path)
        assert response.status_code == 400, (path, response.text)
        assert "must be a valid date (YYYY-MM-DD)" in response.json()["detail"], path

    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_note_date_filters_are_bound_as_dates(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = _scalars_result([])

    response = await client.get("/api/notes?siteId=1&startDate=2026-01-01&endDate=2026-01-31")

    assert response.status_code == 200
    stmt = mock_db_session.execute.await_args.args[0]
    values = [b.value for b in stmt.compile().binds.values()]
    assert date(2026, 1, 1) in values and date(2026, 1, 31) in values


def test_parse_day_helper():
    from fastapi import HTTPException

    from app.services.date_range import ensure_date_order, parse_day

    assert parse_day("2026-02-28", "startDate") == date(2026, 2, 28)
    with pytest.raises(HTTPException) as exc:
        parse_day("2026-02-29", "startDate")
    assert exc.value.status_code == 400
    assert "startDate" in exc.value.detail
    ensure_date_order(date(2026, 1, 1), date(2026, 1, 1))
    ensure_date_order(None, date(2026, 1, 1))
    with pytest.raises(HTTPException) as exc:
        ensure_date_order(date(2026, 1, 2), date(2026, 1, 1))
    assert exc.value.status_code == 422


# ---------------------------------------------------------------------------
# B1-22 password length (new / changed passwords only)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_new_user_password_needs_8_characters(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.post(
        "/api/users",
        json={"email": "n@example.com", "password": "1234567", "first_name": "N", "last_name": "U"},
    )

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_changed_user_password_needs_8_characters(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.put("/api/users/7", json={"password": "short"})

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()
