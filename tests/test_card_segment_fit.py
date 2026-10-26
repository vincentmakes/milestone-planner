"""
Unlinked segments follow their card (1.17.0): the phase / subphase PUT fits
the card's dated bookings with ``fit_segments_to_card`` -- translated on a
move, clamped on a shrink -- in the same transaction
(``approvals.fit_card_bookings``). Linked rows are untouched (they follow the
card by definition); pending rows are fitted too, and so are the segment
dates stored in the rows' open requests. The service runs against a real
SQLite database (``card_db`` from tests/test_booking_segment_routes.py), the
routes with the usual mocks.
"""

import json
from datetime import date
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select

from app.models.assignment import PhaseStaffAssignment, SubphaseStaffAssignment
from app.models.project import ProjectPhase, ProjectSubphase
from app.models.rbac import ApprovalRequest
from app.services import approvals
from app.services.approvals import ACTION_CREATE, ACTION_UPDATE
from tests import test_booking_segment_routes as segment_routes
from tests.conftest import FakeUser
from tests.support import scalar_result, scalars_result
from tests.test_booking_segment_routes import STAFF, _book, _SyncSessionAdapter

# Card 1 (phase and subphase) 2026-03-02..13 on SQLite, shared with Task 1's tests.
card_db = segment_routes.card_db

LEVELS = ["phase", "subphase"]
D = date
CARD = (D(2026, 3, 2), D(2026, 3, 13))
FIRST = (D(2026, 3, 3), D(2026, 3, 5))
SECOND = (D(2026, 3, 9), D(2026, 3, 11))


def _model(level: str):
    return PhaseStaffAssignment if level == "phase" else SubphaseStaffAssignment


def _dates(session, level: str) -> dict[int, tuple]:
    model = _model(level)
    session.expire_all()
    return {
        row.id: (row.start_date, row.end_date)
        for row in session.execute(select(model)).scalars().all()
    }


async def _fit(session, level: str, new: tuple, old: tuple = CARD) -> None:
    await approvals.fit_card_bookings(_SyncSessionAdapter(session), level, 1, old, new)
    session.commit()


def _two_segments_and_a_linked_row(session, level: str) -> None:
    _book(session, level, row_id=10, dates=FIRST)
    _book(session, level, row_id=11, dates=SECOND)
    _book(session, level, row_id=12, staff=6)  # linked: follows the card


# ---------------------------------------------------------------------------
# The service, on a real database
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("level", LEVELS)
async def test_a_moved_card_translates_its_segments(card_db, level):
    _two_segments_and_a_linked_row(card_db, level)

    await _fit(card_db, level, (D(2026, 3, 9), D(2026, 3, 20)))

    assert _dates(card_db, level) == {
        10: (D(2026, 3, 10), D(2026, 3, 12)),
        11: (D(2026, 3, 16), D(2026, 3, 18)),
        12: (None, None),  # linked rows are never given dates
    }


@pytest.mark.parametrize("level", LEVELS)
async def test_a_shortened_card_clamps_its_segments(card_db, level):
    _two_segments_and_a_linked_row(card_db, level)

    await _fit(card_db, level, (D(2026, 3, 2), D(2026, 3, 10)))

    assert _dates(card_db, level) == {
        10: FIRST,
        11: (D(2026, 3, 9), D(2026, 3, 10)),  # cut at the new end
        12: (None, None),
    }


@pytest.mark.parametrize("level", LEVELS)
async def test_a_segment_left_outside_moves_against_the_edge(card_db, level):
    _book(card_db, level, row_id=10, dates=SECOND)

    await _fit(card_db, level, (D(2026, 3, 2), D(2026, 3, 6)))

    assert _dates(card_db, level) == {10: (D(2026, 3, 4), D(2026, 3, 6))}


@pytest.mark.parametrize("level", LEVELS)
async def test_a_one_day_card_keeps_one_day_segments_even_when_they_now_overlap(card_db, level):
    # Ruling: the fit is written as is -- two segments of one person may end
    # up on the same day; the next edit of either resolves it.
    _two_segments_and_a_linked_row(card_db, level)

    await _fit(card_db, level, (D(2026, 3, 5), D(2026, 3, 5)))

    day = (D(2026, 3, 5), D(2026, 3, 5))
    assert _dates(card_db, level) == {10: day, 11: day, 12: (None, None)}


@pytest.mark.parametrize("level", LEVELS)
async def test_only_this_cards_segments_are_fitted(card_db, level):
    _book(card_db, level, row_id=10, dates=FIRST)
    if level == "phase":
        _book(card_db, level, row_id=11, card=2, dates=FIRST)  # another card

    await _fit(card_db, level, (D(2026, 3, 9), D(2026, 3, 20)))

    dates = _dates(card_db, level)
    assert dates[10] == (D(2026, 3, 10), D(2026, 3, 12))
    if level == "phase":
        assert dates[11] == FIRST


async def test_unchanged_dates_cost_no_query():
    db = MagicMock()
    db.execute = AsyncMock()

    await approvals.fit_card_bookings(db, "phase", 1, CARD, CARD)

    db.execute.assert_not_awaited()


def _request(session, request_id: int, row_id: int, **fields) -> None:
    values = {
        "id": request_id,
        "requester_id": STAFF,
        "action": ACTION_UPDATE,
        "project_id": 1,
        "level": "phase",
        "target_id": 1,
        "assignment_id": row_id,
        "status": "pending",
        **fields,
    }
    session.add(ApprovalRequest(**values))
    session.commit()


def _point(session, level: str, row_id: int, request_id: int) -> None:
    row = session.get(_model(level), row_id)
    row.approval_request_id = request_id
    session.commit()


def _stored(session, request_id: int) -> tuple:
    session.expire_all()
    request = session.get(ApprovalRequest, request_id)
    parse = approvals.parse_values
    return parse(request.requested), parse(request.previous)


def _seg(dates: tuple, allocation: int = 50) -> dict:
    return approvals.booking_dict(allocation, *dates)


@pytest.mark.parametrize("level", LEVELS)
async def test_a_pending_segment_and_its_request_follow_the_card(card_db, level):
    _book(card_db, level, row_id=10, dates=FIRST, status="pending")
    _request(card_db, 50, 10, action=ACTION_CREATE, level=level, requested=json.dumps(_seg(FIRST)))
    _point(card_db, level, 10, 50)

    await _fit(card_db, level, (D(2026, 3, 9), D(2026, 3, 20)))

    moved = (D(2026, 3, 10), D(2026, 3, 12))
    assert _dates(card_db, level) == {10: moved}
    assert _stored(card_db, 50) == (_seg(moved), None)


@pytest.mark.parametrize("level", LEVELS)
async def test_an_open_update_request_follows_the_card_and_stays_valid(card_db, level):
    _book(card_db, level, row_id=10, dates=FIRST)
    _request(
        card_db,
        50,
        10,
        level=level,
        requested=json.dumps(_seg(SECOND, 80)),
        previous=json.dumps(_seg(FIRST)),
    )
    _point(card_db, level, 10, 50)

    await _fit(card_db, level, (D(2026, 3, 9), D(2026, 3, 20)))

    moved = (D(2026, 3, 10), D(2026, 3, 12))
    assert _dates(card_db, level) == {10: moved}
    requested, previous = _stored(card_db, 50)
    # previous still matches the row (not overtaken), requested moved along.
    assert previous == _seg(moved)
    assert requested == _seg((D(2026, 3, 16), D(2026, 3, 18)), 80)


@pytest.mark.parametrize("level", LEVELS)
async def test_requests_are_fitted_only_where_they_hold_segment_dates(card_db, level):
    # A linked row asking to be unlinked (its request is fitted, the row is
    # not), a relink (explicit nulls kept) and a removal; a closed request on
    # another row is never touched.
    _book(card_db, level, row_id=10)
    _request(card_db, 50, 10, level=level, requested=json.dumps(_seg(SECOND)),
             previous=json.dumps({"allocation": 50}))  # fmt: skip
    _point(card_db, level, 10, 50)
    _book(card_db, level, row_id=11, staff=6, dates=FIRST)
    relink = approvals.booking_dict(50, clear_dates=True)
    _request(card_db, 51, 11, level=level, requested=json.dumps(relink),
             previous=json.dumps(_seg(FIRST)))  # fmt: skip
    _point(card_db, level, 11, 51)
    _book(card_db, level, row_id=12, staff=1)
    _request(card_db, 52, 12, level=level, action=approvals.ACTION_REMOVE,
             previous=json.dumps({"allocation": 50}))  # fmt: skip
    _point(card_db, level, 12, 52)
    _request(card_db, 53, 99, level=level, status="rejected", previous=json.dumps(_seg(FIRST)))

    await _fit(card_db, level, (D(2026, 3, 9), D(2026, 3, 20)))

    assert _dates(card_db, level)[10] == (None, None)
    assert _stored(card_db, 50) == (_seg((D(2026, 3, 16), D(2026, 3, 18))), {"allocation": 50})
    assert _stored(card_db, 51) == (relink, _seg((D(2026, 3, 10), D(2026, 3, 12))))
    assert _stored(card_db, 52) == (None, {"allocation": 50})
    assert _stored(card_db, 53) == (None, _seg(FIRST))


def test_malformed_stored_dates_are_kept_as_they_are():
    def fit(start, end):
        raise AssertionError("never called")

    bad = {"allocation": 50, "start_date": "nope", "end_date": "2026-03-05"}
    assert approvals._fit_request_values(bad, fit) == bad
    assert approvals._fit_request_values(None, fit) is None


# ---------------------------------------------------------------------------
# PUT /phases/{id}, PUT /subphases/{id}
# ---------------------------------------------------------------------------


def _card(level: str, card_id: int):
    model = ProjectPhase if level == "phase" else ProjectSubphase
    name = {"type": "Design"} if level == "phase" else {"name": "Design"}
    return model(
        id=card_id,
        project_id=1,
        start_date=CARD[0],
        end_date=CARD[1],
        is_milestone=0,
        completion=0,
        status="todo",
        **name,
    )


def _segment(row_id: int, dates: tuple, **fields):
    return SimpleNamespace(
        id=row_id,
        start_date=dates[0],
        end_date=dates[1],
        approval_request_id=None,
        **fields,
    )


def _path(level: str, card_id: int) -> str:
    return f"/api/{level}s/{card_id}"


@pytest.fixture
def broadcast():
    with patch("app.routers.projects.broadcast_change", new_callable=AsyncMock) as mock:
        yield mock


@pytest.mark.parametrize("level", LEVELS)
async def test_moving_a_card_moves_its_segments_before_the_commit(
    authed_client, mock_db_session, broadcast, change_intents, level
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    card = _card(level, 10)
    first, second = _segment(1, FIRST), _segment(2, SECOND)
    bookers = MagicMock()
    bookers.all.return_value = [(5, 60)]
    mock_db_session.execute.side_effect = [
        scalar_result(card),
        bookers,
        scalars_result([first, second]),
    ]
    order: list[str] = []
    mock_db_session.commit.side_effect = lambda: order.append(f"commit {first.start_date}")

    response = await client.put(
        _path(level, 10), json={"start_date": "2026-03-09", "end_date": "2026-03-20"}
    )

    assert response.status_code == 200
    assert response.json() == {"success": True}  # unchanged response
    assert (first.start_date, first.end_date) == (D(2026, 3, 10), D(2026, 3, 12))
    assert (second.start_date, second.end_date) == (D(2026, 3, 16), D(2026, 3, 18))
    assert order == ["commit 2026-03-10"]  # written in the PUT's transaction
    fit_sql = str(mock_db_session.execute.await_args_list[2].args[0])
    assert f"{level}_staff_assignments.start_date IS NOT NULL" in fit_sql
    # The move still tells the booked people and the PM.
    ((_, intents, _),) = change_intents
    assert [i.recipient for i in intents] == ["person", "pm"]


@pytest.mark.parametrize("level", LEVELS)
async def test_shortening_a_card_clamps_its_segments(
    authed_client, mock_db_session, broadcast, level
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    first, second = _segment(1, FIRST), _segment(2, SECOND)
    mock_db_session.execute.side_effect = [
        scalar_result(_card(level, 10)),
        MagicMock(),
        scalars_result([first, second]),
    ]

    response = await client.put(_path(level, 10), json={"end_date": "2026-03-04"})

    assert response.status_code == 200
    assert (first.start_date, first.end_date) == (D(2026, 3, 3), D(2026, 3, 4))
    assert (second.start_date, second.end_date) == (D(2026, 3, 2), D(2026, 3, 4))


@pytest.mark.parametrize("level", LEVELS)
async def test_a_card_put_without_a_date_change_fits_nothing(
    authed_client, mock_db_session, broadcast, change_intents, level
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(_card(level, 10))]

    response = await client.put(
        _path(level, 10), json={"start_date": "2026-03-02", "end_date": "2026-03-13"}
    )

    assert response.status_code == 200
    assert mock_db_session.execute.await_count == 1  # no bookers, no segments
    ((_, intents, _),) = change_intents
    assert intents == []


@pytest.mark.parametrize("level", LEVELS)
async def test_an_inverted_card_range_fits_nothing(authed_client, mock_db_session, level):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(_card(level, 10))]

    response = await client.put(_path(level, 10), json={"start_date": "2026-03-20"})

    assert response.status_code == 422
    assert mock_db_session.execute.await_count == 1
    mock_db_session.commit.assert_not_awaited()
