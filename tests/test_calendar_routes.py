"""
Route-level tests for bank-holiday editing/import and multi-site company events.

Mock-based, following the house style: no live DB, dependencies overridden in
tests/conftest.py. FakeUser belongs to site 1 only, which drives the superuser
site-membership checks.
"""

from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.models.site import BankHoliday, CompanyEvent, CompanyEventSite
from app.routers.sites import _validate_range
from tests.conftest import FakeUser

STAMP = datetime(2026, 1, 1, 12, 0, 0)


def _sql(stmt) -> str:
    return str(stmt.compile(compile_kwargs={"literal_binds": True}))


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


def _links_result(pairs):
    """Rows of (event_id, site_id), as _event_site_ids reads them."""
    return _rows_result([SimpleNamespace(event_id=e, site_id=s) for e, s in pairs])


def _holiday(holiday_id=5, site_id=1, day=date(2026, 8, 1), name="Swiss National Day", custom=0):
    return BankHoliday(
        id=holiday_id,
        site_id=site_id,
        date=day,
        end_date=day,
        name=name,
        is_custom=custom,
        year=day.year,
        created_at=STAMP,
    )


def _event(event_id=5, site_id=1, day=date(2026, 3, 10), name="ISO audit", end=None, closure=False):
    return CompanyEvent(
        id=event_id,
        site_id=site_id,
        date=day,
        end_date=end,
        name=name,
        color="#f97316",
        counts_as_unavailable=closure,
        created_at=STAMP,
    )


def _added(db, model):
    found = [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], model)]
    for c in db.add_all.call_args_list:
        found.extend(obj for obj in c.args[0] if isinstance(obj, model))
    return found


@pytest.fixture
def db_assigns_ids(mock_db_session):
    """Simulate flush() assigning ids and refresh() loading created_at."""

    async def flush():
        next_id = 100
        for obj in _added(mock_db_session, CompanyEvent):
            if obj.id is None:
                obj.id = next_id
                next_id += 1

    async def refresh(obj):
        if getattr(obj, "created_at", None) is None:
            obj.created_at = STAMP

    mock_db_session.flush.side_effect = flush
    mock_db_session.refresh.side_effect = refresh
    return mock_db_session


# ---------------------------------------------------------
# Bank holidays: edit
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_editing_a_nager_holiday_makes_it_custom(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    holiday = _holiday(custom=0)
    mock_db_session.execute.return_value = _scalar_result(holiday)

    response = await client.put(
        "/api/sites/1/holidays/5", json={"name": "National Day", "date": "2027-08-02"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["is_custom"] == 1
    assert body["name"] == "National Day"
    # A single-day holiday moves as a whole, and year follows the date.
    assert (holiday.date, holiday.end_date, holiday.year) == (
        date(2027, 8, 2),
        date(2027, 8, 2),
        2027,
    )
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_holiday_edit_rejects_end_before_start(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = _scalar_result(_holiday())

    response = await client.put("/api/sites/1/holidays/5", json={"end_date": "2026-07-01"})

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_holiday_edit_rejects_a_span_over_366_days(authed_client, mock_db_session):
    """Longer spans used to be stored and silently truncated when expanded."""
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    holiday = _holiday()  # 2026-08-01
    mock_db_session.execute.return_value = _scalar_result(holiday)

    response = await client.put("/api/sites/1/holidays/5", json={"end_date": "2027-08-02"})

    assert response.status_code == 400
    assert response.json()["detail"] == "End date makes the range longer than 366 days"
    mock_db_session.commit.assert_not_awaited()


def test_validate_range_accepts_exactly_366_days():
    _validate_range(date(2028, 1, 1), date(2028, 12, 31))  # leap year, 366 days
    _validate_range(date(2026, 1, 1), None)
    with pytest.raises(HTTPException) as exc:
        _validate_range(date(2026, 1, 1), date(2027, 1, 2), label="Item 2: end date")
    assert exc.value.status_code == 400
    assert exc.value.detail == "Item 2: end date makes the range longer than 366 days"


@pytest.mark.asyncio
async def test_holiday_edit_unique_violation_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = _scalar_result(_holiday())
    mock_db_session.commit.side_effect = IntegrityError("UPDATE", {}, Exception("dup"))

    response = await client.put("/api/sites/1/holidays/5", json={"name": "Taken"})

    assert response.status_code == 400
    mock_db_session.rollback.assert_awaited()


@pytest.mark.asyncio
async def test_holiday_edit_unknown_holiday_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = _scalar_result(None)

    response = await client.put("/api/sites/1/holidays/5", json={"name": "X"})

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_superuser_cannot_edit_holidays_of_another_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))  # member of site 1 only
    mock_db_session.execute.return_value = _scalar_result(_holiday(site_id=2))

    response = await client.put("/api/sites/2/holidays/5", json={"name": "X"})

    assert response.status_code == 403
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_nager_holidays_can_be_deleted(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = _scalar_result(_holiday(custom=0))

    response = await client.delete("/api/sites/1/holidays/5")

    assert response.status_code == 200
    mock_db_session.delete.assert_awaited()


# ---------------------------------------------------------
# Bank holidays: import
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_holiday_import_dedups_against_site_and_batch(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.get.return_value = object()  # site exists
    mock_db_session.execute.return_value = _rows_result(
        [SimpleNamespace(date=date(2026, 1, 1), name="New Year's Day")]
    )

    response = await client.post(
        "/api/sites/1/holidays/import",
        json={
            "items": [
                {"date": "2026-01-01", "name": "New Year's Day"},  # already on the site
                {"date": "2026-12-24", "end_date": "2026-12-26", "name": "Christmas break"},
                {"date": "2026-12-24", "name": "Christmas break"},  # repeat in batch
                {"date": "2026-06-01", "name": "Founders Day"},
            ]
        },
    )

    assert response.status_code == 200
    assert response.json() == {"created": 2, "skipped": 2}
    added = _added(mock_db_session, BankHoliday)
    assert [(h.date, h.end_date, h.is_custom, h.year) for h in added] == [
        (date(2026, 12, 24), date(2026, 12, 26), 1, 2026),
        (date(2026, 6, 1), date(2026, 6, 1), 1, 2026),  # end_date defaults to date
    ]


@pytest.mark.asyncio
async def test_holiday_import_rejects_inverted_ranges(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.get.return_value = object()

    response = await client.post(
        "/api/sites/1/holidays/import",
        json={"items": [{"date": "2026-05-02", "end_date": "2026-05-01", "name": "X"}]},
    )

    assert response.status_code == 400
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_holiday_import_rejects_a_span_over_366_days(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.get.return_value = object()

    response = await client.post(
        "/api/sites/1/holidays/import",
        json={
            "items": [
                {"date": "2026-05-01", "name": "Fine"},
                {"date": "2026-01-01", "end_date": "2027-01-02", "name": "Too long"},
            ]
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Item 2: end date makes the range longer than 366 days"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_holiday_range_returns_holidays_overlapping_the_window(
    authed_client, mock_db_session
):
    """A multi-day holiday that started before the window still shows in it."""
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = _scalars_result([])

    response = await client.get("/api/holidays?siteId=1&startDate=2026-12-28&endDate=2027-01-03")

    assert response.status_code == 200
    query = _sql(mock_db_session.execute.await_args.args[0])
    assert "bank_holidays.date <= '2027-01-03'" in query
    assert "coalesce(bank_holidays.end_date, bank_holidays.date) >= '2026-12-28'" in query
    assert "bank_holidays.date >= " not in query


@pytest.mark.asyncio
async def test_superuser_cannot_import_into_another_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.get.return_value = object()

    response = await client.post(
        "/api/sites/2/holidays/import", json={"items": [{"date": "2026-05-01", "name": "X"}]}
    )

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_plain_users_cannot_write_holidays(authed_client):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    assert (await client.put("/api/sites/1/holidays/5", json={"name": "X"})).status_code == 403
    assert (
        await client.post("/api/sites/1/holidays/import", json={"items": []})
    ).status_code == 403


# ---------------------------------------------------------
# Company events: multi-site create / update
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_create_event_on_several_sites(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = db_assigns_ids
    db.execute.return_value = _scalars_result([1, 2])  # both sites exist

    response = await client.post(
        "/api/events",
        json={"date": "2026-03-10", "name": "ISO audit", "site_ids": [2, 1, 2]},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["site_ids"] == [1, 2]
    assert body["site_id"] == 1  # legacy field: first linked site
    assert body["id"] == 100
    assert body["counts_as_unavailable"] is False  # a plain event, not a closure
    links = _added(db, CompanyEventSite)
    assert sorted((link.event_id, link.site_id) for link in links) == [(100, 1), (100, 2)]
    (event,) = _added(db, CompanyEvent)
    assert event.site_id == 1
    assert event.counts_as_unavailable is False


@pytest.mark.asyncio
async def test_create_event_as_a_site_closure(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = db_assigns_ids
    db.execute.return_value = _scalars_result([1])

    response = await client.post(
        "/api/events",
        json={
            "date": "2026-12-24",
            "end_date": "2026-12-31",
            "name": "Christmas shutdown",
            "site_ids": [1],
            "counts_as_unavailable": True,
        },
    )

    assert response.status_code == 201
    assert response.json()["counts_as_unavailable"] is True
    (event,) = _added(db, CompanyEvent)
    assert event.counts_as_unavailable is True


@pytest.mark.asyncio
async def test_legacy_create_accepts_the_closure_flag(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    db = db_assigns_ids
    db.get.return_value = object()  # site exists

    response = await client.post(
        "/api/sites/1/events",
        json={"date": "2026-03-10", "name": "Inventory day", "counts_as_unavailable": True},
    )

    assert response.status_code == 200
    assert response.json()["counts_as_unavailable"] is True


@pytest.mark.asyncio
async def test_create_event_requires_a_site(authed_client):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.post(
        "/api/events", json={"date": "2026-03-10", "name": "X", "site_ids": []}
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_event_on_unknown_site_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = _scalars_result([1])

    response = await client.post(
        "/api/events", json={"date": "2026-03-10", "name": "X", "site_ids": [1, 9]}
    )

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_create_event_rejects_end_before_start(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = _scalars_result([1])

    response = await client.post(
        "/api/events",
        json={"date": "2026-03-10", "end_date": "2026-03-09", "name": "X", "site_ids": [1]},
    )

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_create_event_rejects_a_span_over_366_days(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = _scalars_result([1])

    response = await client.post(
        "/api/events",
        json={"date": "2026-03-10", "end_date": "2027-03-11", "name": "X", "site_ids": [1]},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "End date makes the range longer than 366 days"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("params", "present", "absent"),
    [
        (
            "&startDate=2026-03-01&endDate=2026-03-31",
            [
                "coalesce(company_events.end_date, company_events.date) >= '2026-03-01'",
                "company_events.date <= '2026-03-31'",
            ],
            ["company_events.date >= "],
        ),
        (
            "&startDate=2026-03-01",
            ["coalesce(company_events.end_date, company_events.date) >= '2026-03-01'"],
            ["company_events.date <= "],
        ),
        (
            "&endDate=2026-03-31",
            ["company_events.date <= '2026-03-31'"],
            ["coalesce("],
        ),
    ],
)
async def test_event_range_returns_events_overlapping_the_window(
    authed_client, mock_db_session, params, present, absent
):
    """A multi-day event that started before the window still shows in it."""
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = _scalars_result([])

    response = await client.get(f"/api/events?siteId=1{params}")

    assert response.status_code == 200
    query = _sql(mock_db_session.execute.await_args.args[0])
    assert "company_event_sites.site_id = 1" in query
    for fragment in present:
        assert fragment in query
    for fragment in absent:
        assert fragment not in query


@pytest.mark.asyncio
async def test_superuser_cannot_create_event_on_a_foreign_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = _scalars_result([1, 2])

    response = await client.post(
        "/api/events", json={"date": "2026-03-10", "name": "X", "site_ids": [1, 2]}
    )

    assert response.status_code == 403
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_update_event_adds_site_links(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = db_assigns_ids
    event = _event(5, site_id=1)
    db.get.return_value = event
    db.execute.side_effect = [_links_result([(5, 1)]), _scalars_result([1, 2])]

    response = await client.put(
        "/api/events/5", json={"name": "ISO 9001 audit", "site_ids": [1, 2], "color": None}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["site_ids"] == [1, 2]
    assert body["name"] == "ISO 9001 audit"
    assert body["color"] is None  # explicit null clears the colour
    links = _added(db, CompanyEventSite)
    assert [(link.event_id, link.site_id) for link in links] == [(5, 2)]
    assert db.execute.await_count == 2  # nothing removed, so no DELETE


@pytest.mark.asyncio
async def test_update_event_replaces_site_links(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = db_assigns_ids
    event = _event(5, site_id=1)
    db.get.return_value = event
    db.execute.side_effect = [_links_result([(5, 1)]), _scalars_result([2]), MagicMock()]

    response = await client.put("/api/events/5", json={"site_ids": [2]})

    assert response.status_code == 200
    assert response.json()["site_ids"] == [2]
    assert event.site_id == 2
    assert db.execute.await_count == 3  # the third call removes the site-1 link


@pytest.mark.asyncio
async def test_update_event_toggles_the_closure_flag(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    event = _event(5)
    mock_db_session.get.return_value = event
    mock_db_session.execute.return_value = _links_result([(5, 1)])

    response = await client.put("/api/events/5", json={"counts_as_unavailable": True})

    assert response.status_code == 200
    assert response.json()["counts_as_unavailable"] is True
    assert event.counts_as_unavailable is True

    # Edits that leave the flag out keep it.
    response = await client.put("/api/events/5", json={"name": "Shutdown"})

    assert response.status_code == 200
    assert response.json()["counts_as_unavailable"] is True
    assert event.counts_as_unavailable is True


@pytest.mark.asyncio
async def test_superuser_cannot_edit_an_event_shared_with_a_foreign_site(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.get.return_value = _event(5)
    mock_db_session.execute.side_effect = [_links_result([(5, 1), (5, 2)])]

    response = await client.put("/api/events/5", json={"name": "X"})

    assert response.status_code == 403
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_superuser_cannot_move_an_event_to_a_foreign_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.get.return_value = _event(5)
    mock_db_session.execute.side_effect = [_links_result([(5, 1)]), _scalars_result([2])]

    response = await client.put("/api/events/5", json={"site_ids": [2]})

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_delete_event_removes_it_everywhere(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.get.return_value = _event(5)
    mock_db_session.execute.side_effect = [_links_result([(5, 1), (5, 2)])]

    response = await client.delete("/api/events/5")

    assert response.status_code == 200
    mock_db_session.delete.assert_awaited()


# ---------------------------------------------------------
# Company events: legacy per-site routes
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_legacy_create_links_the_single_site(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    db = db_assigns_ids
    db.get.return_value = object()  # site exists

    response = await client.post(
        "/api/sites/1/events", json={"date": "2026-03-10", "name": "Town hall"}
    )

    assert response.status_code == 200
    assert response.json()["site_ids"] == [1]
    assert [(link.event_id, link.site_id) for link in _added(db, CompanyEventSite)] == [(100, 1)]


@pytest.mark.asyncio
async def test_legacy_delete_unlinks_a_shared_event(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    event = _event(5, site_id=1)
    mock_db_session.get.return_value = event
    mock_db_session.execute.side_effect = [_links_result([(5, 1), (5, 2)]), MagicMock()]

    response = await client.delete("/api/sites/1/events/5")

    assert response.status_code == 200
    mock_db_session.delete.assert_not_awaited()  # still linked to site 2
    assert mock_db_session.execute.await_count == 2  # link removal
    assert event.site_id == 2  # legacy column follows the remaining site


@pytest.mark.asyncio
async def test_legacy_delete_of_the_last_site_deletes_the_event(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.get.return_value = _event(5)
    mock_db_session.execute.side_effect = [_links_result([(5, 1)])]

    response = await client.delete("/api/sites/1/events/5")

    assert response.status_code == 200
    mock_db_session.delete.assert_awaited()


@pytest.mark.asyncio
async def test_legacy_delete_on_an_unlinked_site_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.get.return_value = _event(5)
    mock_db_session.execute.side_effect = [_links_result([(5, 2)])]

    response = await client.delete("/api/sites/1/events/5")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_site_events_list_reports_every_linked_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.side_effect = [
        _scalars_result(
            [_event(5, site_id=2), _event(6, site_id=1, name="Shutdown", closure=True)]
        ),
        _links_result([(5, 2), (5, 1), (6, 1)]),
    ]

    response = await client.get("/api/sites/1/events")

    assert response.status_code == 200
    assert [
        (e["id"], e["site_id"], e["site_ids"], e["counts_as_unavailable"]) for e in response.json()
    ] == [
        (5, 1, [1, 2], False),
        (6, 1, [1], True),
    ]


# ---------------------------------------------------------
# Company events: import
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_event_import_links_creates_and_skips(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = db_assigns_ids
    audit = _event(5, day=date(2026, 3, 10), name="ISO audit")  # on site 1 only
    shutdown = _event(6, day=date(2026, 12, 24), end=date(2026, 12, 31), name="Shutdown")
    db.execute.side_effect = [
        _scalars_result([1, 2]),  # target sites exist
        _scalars_result([audit, shutdown]),  # candidate existing events
        _links_result([(5, 1), (6, 1), (6, 2)]),
    ]

    response = await client.post(
        "/api/events/import",
        json={
            "site_ids": [1, 2],
            "color": "#22c55e",
            "items": [
                {"date": "2026-03-10", "name": "ISO audit"},  # gains site 2
                {"date": "2026-12-24", "end_date": "2026-12-31", "name": "Shutdown"},  # linked
                {"date": "2026-05-05", "name": "Open day"},  # new
                {"date": "2026-05-05", "end_date": "2026-05-05", "name": "Open day"},  # repeat
            ],
        },
    )

    assert response.status_code == 200
    assert response.json() == {"created": 1, "linked": 1, "skipped": 2}
    (created,) = _added(db, CompanyEvent)
    assert (created.name, created.color, created.site_id) == ("Open day", "#22c55e", 1)
    links = sorted((link.event_id, link.site_id) for link in _added(db, CompanyEventSite))
    assert links == [(5, 2), (100, 1), (100, 2)]
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_event_import_closure_flag_applies_to_new_events_only(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = db_assigns_ids
    audit = _event(5, day=date(2026, 3, 10), name="ISO audit")  # on site 1, not a closure
    db.execute.side_effect = [
        _scalars_result([1, 2]),  # target sites exist
        _scalars_result([audit]),  # candidate existing events
        _links_result([(5, 1)]),
    ]

    response = await client.post(
        "/api/events/import",
        json={
            "site_ids": [1, 2],
            "counts_as_unavailable": True,
            "items": [
                {"date": "2026-03-10", "name": "ISO audit"},  # reused: gains site 2
                {"date": "2026-12-24", "end_date": "2026-12-31", "name": "Shutdown"},  # new
            ],
        },
    )

    assert response.status_code == 200
    assert response.json() == {"created": 1, "linked": 1, "skipped": 0}
    (created,) = _added(db, CompanyEvent)
    assert (created.name, created.counts_as_unavailable) == ("Shutdown", True)
    assert audit.counts_as_unavailable is False  # the reused event keeps its flag


@pytest.mark.asyncio
async def test_superuser_cannot_import_events_into_a_foreign_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = _scalars_result([1, 2])

    response = await client.post(
        "/api/events/import",
        json={"site_ids": [1, 2], "items": [{"date": "2026-05-05", "name": "X"}]},
    )

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_superuser_import_does_not_link_an_event_of_a_foreign_site(
    authed_client, db_assigns_ids
):
    client, set_user = authed_client
    superuser = FakeUser(1, "superuser")
    superuser._site_ids = [2]  # site B only
    set_user(superuser)
    db = db_assigns_ids
    audit = _event(5, site_id=1, day=date(2026, 3, 10), name="ISO audit")  # site A only
    db.execute.side_effect = [
        _scalars_result([2]),  # target site exists
        _scalars_result([audit]),  # same (date, end, name) on site A
        _links_result([(5, 1)]),
    ]

    response = await client.post(
        "/api/events/import",
        json={"site_ids": [2], "items": [{"date": "2026-03-10", "name": "ISO audit"}]},
    )

    assert response.status_code == 200
    assert response.json() == {"created": 1, "linked": 0, "skipped": 0}
    (created,) = _added(db, CompanyEvent)
    assert (created.name, created.site_id) == ("ISO audit", 2)
    links = sorted((link.event_id, link.site_id) for link in _added(db, CompanyEventSite))
    assert links == [(100, 2)]  # the site-A event gains no link


@pytest.mark.asyncio
async def test_admin_import_links_an_event_of_another_site(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = db_assigns_ids
    audit = _event(5, site_id=1, day=date(2026, 3, 10), name="ISO audit")
    db.execute.side_effect = [
        _scalars_result([2]),
        _scalars_result([audit]),
        _links_result([(5, 1)]),
    ]

    response = await client.post(
        "/api/events/import",
        json={"site_ids": [2], "items": [{"date": "2026-03-10", "name": "ISO audit"}]},
    )

    assert response.status_code == 200
    assert response.json() == {"created": 0, "linked": 1, "skipped": 0}
    assert _added(db, CompanyEvent) == []
    links = [(link.event_id, link.site_id) for link in _added(db, CompanyEventSite)]
    assert links == [(5, 2)]


@pytest.mark.asyncio
async def test_superuser_import_skips_an_event_already_shown_on_the_target(
    authed_client, mock_db_session
):
    # Shared with a foreign site, so not reusable -- but site 2 already shows
    # it, so a new event would only be a visible duplicate.
    client, set_user = authed_client
    superuser = FakeUser(1, "superuser")
    superuser._site_ids = [2]
    set_user(superuser)
    shared = _event(5, site_id=1, day=date(2026, 3, 10), name="ISO audit")
    mock_db_session.execute.side_effect = [
        _scalars_result([2]),
        _scalars_result([shared]),
        _links_result([(5, 1), (5, 2)]),
    ]

    response = await client.post(
        "/api/events/import",
        json={"site_ids": [2], "items": [{"date": "2026-03-10", "name": "ISO audit"}]},
    )

    assert response.status_code == 200
    assert response.json() == {"created": 0, "linked": 0, "skipped": 1}
    mock_db_session.commit.assert_not_awaited()
