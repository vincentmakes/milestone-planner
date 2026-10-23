"""
Unlinked phase / subphase bookings (1.17.0): own dates on the booking routes.

A booking with ``start_date`` / ``end_date`` is an unlinked segment inside its
card (400 outside, both or neither 422); without, it is linked and follows the
card. A person may hold several segments on a card as long as their effective
dates do not overlap (409). Responses carry the effective dates and ``linked``;
on a PUT an explicit ``null`` on both dates relinks. The overlap predicate is
checked on a real SQLite database, the routes with the usual mocks.
"""

from datetime import date
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy import CheckConstraint, MetaData, create_engine
from sqlalchemy.orm import Session

from app.database import Base
from app.models.assignment import PhaseStaffAssignment, SubphaseStaffAssignment
from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.rbac import ApprovalRequest, Role
from app.models.user import User
from app.services import approvals
from app.services.approvals import (
    ALREADY_BOOKED_DETAIL,
    ALREADY_BOOKED_OVERLAP_DETAIL,
    ALREADY_PENDING_DETAIL,
    CARD_FULL_DETAIL,
    booking_dict,
    booking_values,
    describe_change,
)
from app.services.project_access import SEGMENT_OUTSIDE_CARD_DETAIL
from tests.conftest import FakeUser
from tests.test_project_access_routes import (
    CARD_END,
    CARD_START,
    PM,
    SELF_MODES,
    _detail_row,
    _placement,
    _pm_result,
    _resolved,
    _scalar_result,
    _staff_row,
)

LEVELS = ["phase", "subphase"]
ADMIN = FakeUser(1, "admin")
STAFF = 5
SEG = {"start_date": "2026-03-03", "end_date": "2026-03-05"}


@pytest.fixture
def submit():
    """The approval path's service call, answering like the real one."""
    from fastapi.responses import JSONResponse

    response = JSONResponse(
        status_code=202, content={"success": True, "pending": True, "request_id": 50, "id": 70}
    )
    with patch("app.services.approvals.submit_request", AsyncMock(return_value=response)) as mocked:
        yield mocked


def _card_dates(start: date = CARD_START, end: date = CARD_END):
    """Result of the card-dates lookup of require_segment_within_card."""
    result = MagicMock()
    result.first.return_value = (start, end)
    return result


def _row(level: str, **fields):
    """An approved phase / subphase booking of STAFF on card 1 (linked unless dated)."""
    fields = {"start_date": None, "end_date": None, **fields}
    return _staff_row(STAFF, phase_id=1, subphase_id=1, **fields)


def _post_path(level: str) -> str:
    return f"/api/{level}s/1/staff"


def _put_path(level: str) -> str:
    return f"/api/{level}-staff/1"


def _assign_id(mock_db_session) -> None:
    mock_db_session.refresh.side_effect = lambda obj: setattr(obj, "id", 42)


# ---------------------------------------------------------------------------
# Booking values and texts
# ---------------------------------------------------------------------------


def test_booking_dict_dates_only_when_given_or_cleared():
    assert booking_dict(40) == {"allocation": 40}
    assert booking_dict(40, date(2026, 3, 3), date(2026, 3, 5)) == {
        "allocation": 40,
        "start_date": "2026-03-03",
        "end_date": "2026-03-05",
    }
    # A relink: explicit nulls, where "no dates" would mean "unchanged".
    assert booking_dict(40, clear_dates=True) == {
        "allocation": 40,
        "start_date": None,
        "end_date": None,
    }


@pytest.mark.parametrize("level", LEVELS)
def test_booking_values_carry_a_segments_own_dates(level):
    assert booking_values(_row(level), level) == {"allocation": 50}
    dated = _row(level, start_date=date(2026, 3, 3), end_date=date(2026, 3, 5))
    assert booking_values(dated, level) == {"allocation": 50, **SEG}


def test_describe_change_words_a_link_and_an_unlink():
    unlinked = {"allocation": 50, **SEG}
    relinked = {"allocation": 50, "start_date": None, "end_date": None}
    # A relink names the card when the level is known.
    assert describe_change(approvals.ACTION_UPDATE, relinked, unlinked) == (
        "follows the card dates again"
    )
    assert describe_change(approvals.ACTION_UPDATE, relinked, unlinked, "phase") == (
        "follows the phase dates again"
    )
    assert describe_change(
        approvals.ACTION_UPDATE, {**relinked, "allocation": 60}, unlinked, "subphase"
    ) == ("allocation 50% → 60%, follows the subphase dates again")
    assert describe_change(approvals.ACTION_UPDATE, unlinked, {"allocation": 50}) == (
        "dates follow the card → 2026-03-03–2026-03-05"
    )
    assert describe_change(approvals.ACTION_CREATE, unlinked, None) == (
        "at 50% from 2026-03-03 to 2026-03-05"
    )


def test_the_details_are_plain_words():
    assert ALREADY_BOOKED_OVERLAP_DETAIL == (
        "This person is already booked on this card for overlapping dates"
    )
    assert SEGMENT_OUTSIDE_CARD_DETAIL.format(level="phase") == (
        "Booking dates must lie within the phase"
    )
    assert CARD_FULL_DETAIL == (
        "This person's bookings already cover the whole card — shorten one of them first"
    )
    assert ALREADY_PENDING_DETAIL == "This booking already awaits approval"


# ---------------------------------------------------------------------------
# ensure_no_duplicate: the detail per level
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("level", "existing", "detail", "expected"),
    [
        ("project", "approved", None, ALREADY_BOOKED_DETAIL),
        ("phase", "approved", None, ALREADY_BOOKED_OVERLAP_DETAIL),
        ("subphase", "approved", None, ALREADY_BOOKED_OVERLAP_DETAIL),
        ("phase", "pending", None, ALREADY_PENDING_DETAIL),
        # Kanban's own wording wins.
        ("phase", "approved", "Already on this card", "Already on this card"),
    ],
)
async def test_ensure_no_duplicate_detail(level, existing, detail, expected):
    db = MagicMock()

    async def execute(stmt):
        return _scalar_result(SimpleNamespace(approval_status=existing))

    db.execute = execute
    with pytest.raises(HTTPException) as exc:
        await approvals.ensure_no_duplicate(db, level, 1, STAFF, detail=detail)
    assert (exc.value.status_code, exc.value.detail) == (409, expected)


# ---------------------------------------------------------------------------
# find_duplicate: effective-date overlap in SQL (real SQLite)
# ---------------------------------------------------------------------------

_TABLES = [
    model.__table__
    for model in (
        Role,
        User,
        Project,
        ProjectPhase,
        ProjectSubphase,
        ApprovalRequest,
        PhaseStaffAssignment,
        SubphaseStaffAssignment,
    )
]


class _SyncSessionAdapter:
    def __init__(self, session: Session):
        self.session = session

    async def execute(self, statement):
        return self.session.execute(statement)


def _create_tables(engine) -> None:
    # Without the CHECKs (PostgreSQL syntax SQLite may lack); FKs not enforced.
    metadata = MetaData()
    for table in Base.metadata.sorted_tables:
        copy = table.to_metadata(metadata)
        for constraint in [c for c in copy.constraints if isinstance(c, CheckConstraint)]:
            copy.constraints.discard(constraint)
    metadata.create_all(engine, tables=[metadata.tables[t.name] for t in _TABLES])


@pytest.fixture
def card_db():
    """Card 1 (phase and subphase) 2026-03-02..13; STAFF holds one row on each, built per test."""
    engine = create_engine("sqlite://")
    _create_tables(engine)
    with Session(engine) as session:
        session.add_all(
            [
                Role(id=1, key="user", name="User"),
                User(id=STAFF, email="s@x", password="x", first_name="S", last_name="T"),
                User(id=6, email="o@x", password="x", first_name="O", last_name="T"),
                Project(id=1, name="P", start_date=CARD_START, end_date=CARD_END),
                ProjectPhase(
                    id=1, project_id=1, type="Design", start_date=CARD_START, end_date=CARD_END
                ),
                ProjectPhase(
                    id=2, project_id=1, type="Build", start_date=CARD_START, end_date=CARD_END
                ),
                ProjectSubphase(
                    id=1,
                    project_id=1,
                    parent_id=1,
                    parent_type="phase",
                    name="Sub",
                    start_date=CARD_START,
                    end_date=CARD_END,
                ),
            ]
        )
        session.commit()
        yield session
    engine.dispose()


def _book(session: Session, level: str, *, row_id=10, staff=STAFF, card=1, dates=None, status=None):
    model = PhaseStaffAssignment if level == "phase" else SubphaseStaffAssignment
    target = {"phase_id": card} if level == "phase" else {"subphase_id": card}
    start, end = dates or (None, None)
    session.add(
        model(
            id=row_id,
            project_id=1,
            staff_id=staff,
            allocation=50,
            start_date=start,
            end_date=end,
            approval_status=status or "approved",
            **target,
        )
    )
    session.commit()


D = date  # short for the case table below

# (name, existing row dates (None = linked), new dates (None = linked), conflicts)
OVERLAP_ROWS = [
    ("new segment vs existing linked", None, (D(2026, 3, 3), D(2026, 3, 5)), True),
    ("second linked booking", None, None, True),
    ("new linked vs existing segment", (D(2026, 3, 3), D(2026, 3, 5)), None, True),
    ("segments overlapping", (D(2026, 3, 3), D(2026, 3, 5)), (D(2026, 3, 4), D(2026, 3, 9)), True),
    ("segments touching", (D(2026, 3, 3), D(2026, 3, 5)), (D(2026, 3, 5), D(2026, 3, 9)), True),
    ("adjacent days", (D(2026, 3, 3), D(2026, 3, 5)), (D(2026, 3, 6), D(2026, 3, 9)), False),
    ("adjacent, before", (D(2026, 3, 6), D(2026, 3, 9)), (D(2026, 3, 3), D(2026, 3, 5)), False),
]  # fmt: skip


@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize(
    ("name", "existing", "new", "conflicts"), OVERLAP_ROWS, ids=[r[0] for r in OVERLAP_ROWS]
)
async def test_find_duplicate_by_effective_overlap(card_db, level, name, existing, new, conflicts):
    _book(card_db, level, dates=existing)
    start, end = new or (None, None)

    found = await approvals.find_duplicate(
        _SyncSessionAdapter(card_db), level, 1, STAFF, start_date=start, end_date=end
    )

    assert (found is not None) is conflicts
    if conflicts:
        assert found.id == 10


@pytest.mark.parametrize("level", LEVELS)
async def test_find_duplicate_ignores_the_row_itself_others_and_other_cards(card_db, level):
    _book(card_db, level, row_id=10)  # linked, STAFF, card 1
    _book(card_db, level, row_id=11, staff=6)  # someone else
    if level == "phase":
        _book(card_db, level, row_id=12, card=2)  # another card
    db = _SyncSessionAdapter(card_db)

    assert await approvals.find_duplicate(db, level, 1, STAFF, exclude_id=10) is None
    assert (await approvals.find_duplicate(db, level, 1, 6)).id == 11


@pytest.mark.parametrize("level", LEVELS)
async def test_find_duplicate_approved_only_skips_pending_rows(card_db, level):
    _book(card_db, level, status="pending")
    db = _SyncSessionAdapter(card_db)

    assert await approvals.find_duplicate(db, level, 1, STAFF, approved_only=True) is None
    assert (await approvals.find_duplicate(db, level, 1, STAFF)).approval_status == "pending"


# ---------------------------------------------------------------------------
# POST /phases/{id}/staff, /subphases/{id}/staff
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("level", LEVELS)
async def test_create_with_dates_is_an_unlinked_segment(
    authed_client, mock_db_session, change_intents, level
):
    client, set_user = authed_client
    set_user(ADMIN)
    _assign_id(mock_db_session)
    detail = _detail_row(STAFF, start_date=date(2026, 3, 3), end_date=date(2026, 3, 5))
    mock_db_session.execute.side_effect = [
        _resolved(),
        _scalar_result(True),  # bookable
        _card_dates(),  # inside the card
        _scalar_result(None),  # no overlapping booking
        detail,
    ]

    response = await client.post(
        _post_path(level), json={"staff_id": STAFF, "project_id": 1, "allocation": 40, **SEG}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["linked"] is False
    assert (body["start_date"], body["end_date"]) == (
        "2026-03-03T00:00:00.000Z",
        "2026-03-05T00:00:00.000Z",
    )
    added = mock_db_session.add.call_args[0][0]
    assert (added.start_date, added.end_date) == (date(2026, 3, 3), date(2026, 3, 5))
    ((_, intents, _),) = change_intents
    assert {i.body for i in intents} == {"at 40% from 2026-03-03 to 2026-03-05"}


@pytest.mark.parametrize("level", LEVELS)
async def test_create_without_dates_is_linked_with_the_cards_dates(
    authed_client, mock_db_session, change_intents, level
):
    client, set_user = authed_client
    set_user(ADMIN)
    _assign_id(mock_db_session)
    mock_db_session.execute.side_effect = [
        _resolved(),
        _scalar_result(True),
        _placement(),  # the person holds no booking on the card
        _detail_row(STAFF),
    ]

    response = await client.post(
        _post_path(level), json={"staff_id": STAFF, "project_id": 1, "allocation": 40}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["linked"] is True
    assert (body["start_date"], body["end_date"]) == (
        "2026-03-02T00:00:00.000Z",
        "2026-03-13T00:00:00.000Z",
    )
    assert body["adjusted"] == []
    added = mock_db_session.add.call_args[0][0]
    assert (added.start_date, added.end_date) == (None, None)
    ((_, intents, _),) = change_intents
    assert {i.body for i in intents} == {"at 40%"}
    # The placement query locks the person's rows on the card.
    placement_query = mock_db_session.execute.await_args_list[2].args[0]
    assert placement_query._for_update_arg is not None


@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize(
    "dates",
    [
        {"start_date": "2026-03-03"},
        {"end_date": "2026-03-05"},
        {"start_date": "2026-03-03", "end_date": None},
        {"start_date": "2026-03-06", "end_date": "2026-03-05"},  # inverted
    ],
    ids=["start-only", "end-only", "end-null", "inverted"],
)
async def test_create_with_half_or_inverted_dates_is_422(
    authed_client, mock_db_session, level, dates
):
    client, set_user = authed_client
    set_user(ADMIN)

    response = await client.post(
        _post_path(level), json={"staff_id": STAFF, "project_id": 1, **dates}
    )

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.parametrize("level", LEVELS)
async def test_create_with_one_date_names_the_rule(authed_client, mock_db_session, level):
    client, set_user = authed_client
    set_user(ADMIN)

    response = await client.post(
        _post_path(level), json={"staff_id": STAFF, "project_id": 1, "start_date": "2026-03-03"}
    )

    assert response.status_code == 422
    assert "Give both dates or neither" in response.text


@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize(
    "dates",
    [
        {"start_date": "2026-02-27", "end_date": "2026-03-01"},  # before the card
        {"start_date": "2026-03-14", "end_date": "2026-03-16"},  # after it
        {"start_date": "2026-03-01", "end_date": "2026-03-14"},  # straddling both edges
        {"start_date": "2026-03-10", "end_date": "2026-03-14"},  # past the end
    ],
    ids=["before", "after", "straddling", "past-the-end"],
)
async def test_create_outside_the_card_is_400(
    authed_client, mock_db_session, change_intents, level, dates
):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [_resolved(), _scalar_result(True), _card_dates()]

    response = await client.post(
        _post_path(level), json={"staff_id": STAFF, "project_id": 1, **dates}
    )

    assert response.status_code == 400
    assert response.json()["detail"] == f"Booking dates must lie within the {level}"
    mock_db_session.add.assert_not_called()
    assert change_intents == []


@pytest.mark.parametrize("level", LEVELS)
async def test_create_on_the_cards_edges_is_inside(authed_client, mock_db_session, level):
    client, set_user = authed_client
    set_user(ADMIN)
    _assign_id(mock_db_session)
    mock_db_session.execute.side_effect = [
        _resolved(),
        _scalar_result(True),
        _card_dates(),
        _scalar_result(None),
        _detail_row(STAFF, start_date=CARD_START, end_date=CARD_END),
    ]

    response = await client.post(
        _post_path(level),
        json={
            "staff_id": STAFF,
            "project_id": 1,
            "start_date": "2026-03-02",
            "end_date": "2026-03-13",
        },
    )

    assert response.status_code == 200, response.text
    # Own dates equal to the card's are still own dates (unlinked).
    assert response.json()["linked"] is False


@pytest.mark.parametrize("level", LEVELS)
async def test_create_overlapping_another_booking_is_409(
    authed_client, mock_db_session, change_intents, level
):
    client, set_user = authed_client
    set_user(ADMIN)
    existing = _row(level)
    mock_db_session.execute.side_effect = [
        _resolved(),
        _scalar_result(True),
        _card_dates(),
        _scalar_result(existing),
    ]

    response = await client.post(
        _post_path(level), json={"staff_id": STAFF, "project_id": 1, **SEG}
    )

    assert response.status_code == 409
    assert response.json()["detail"] == ALREADY_BOOKED_OVERLAP_DETAIL
    mock_db_session.add.assert_not_called()
    assert change_intents == []


@pytest.mark.parametrize("level", LEVELS)
async def test_create_in_approval_mode_files_the_dates(
    authed_client, mock_db_session, submit, level
):
    client, set_user = authed_client
    set_user(SELF_MODES["approval"])
    mock_db_session.execute.side_effect = [
        _resolved(),
        _pm_result(PM),
        _scalar_result(True),
        _card_dates(),
        _scalar_result(None),
    ]

    response = await client.post(
        _post_path(level), json={"staff_id": STAFF, "project_id": 1, "allocation": 40, **SEG}
    )

    assert response.status_code == 202
    assert submit.await_args.kwargs["values"] == {"allocation": 40, **SEG}
    mock_db_session.add.assert_not_called()


@pytest.mark.parametrize("level", LEVELS)
async def test_create_outside_the_card_in_approval_mode_files_nothing(
    authed_client, mock_db_session, submit, level
):
    client, set_user = authed_client
    set_user(SELF_MODES["approval"])
    mock_db_session.execute.side_effect = [
        _resolved(),
        _pm_result(PM),
        _scalar_result(True),
        _card_dates(),
    ]

    response = await client.post(
        _post_path(level),
        json={
            "staff_id": STAFF,
            "project_id": 1,
            "start_date": "2026-03-12",
            "end_date": "2026-03-20",
        },
    )

    assert response.status_code == 400
    submit.assert_not_awaited()


async def test_within_card_check_on_a_vanished_card_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    gone = MagicMock()
    gone.first.return_value = None
    mock_db_session.execute.side_effect = [_resolved(), _scalar_result(True), gone]

    response = await client.post(
        "/api/subphases/1/staff", json={"staff_id": STAFF, "project_id": 1, **SEG}
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Subphase not found"


# ---------------------------------------------------------------------------
# PUT /phase-staff/{id}, /subphase-staff/{id}
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("level", LEVELS)
async def test_update_relinks_with_null_dates(
    authed_client, mock_db_session, change_intents, level
):
    client, set_user = authed_client
    set_user(ADMIN)
    row = _row(level, start_date=date(2026, 3, 3), end_date=date(2026, 3, 5))
    mock_db_session.execute.side_effect = [
        _scalar_result(row),
        _scalar_result(None),  # linked spans the card: no other booking of the person
    ]

    response = await client.put(_put_path(level), json={"start_date": None, "end_date": None})

    assert response.status_code == 200, response.text
    assert response.json() == {"success": True, "linked": True}
    assert (row.start_date, row.end_date, row.allocation) == (None, None, 50)
    ((_, intents, _),) = change_intents
    assert {i.body for i in intents} == {f"follows the {level} dates again"}


@pytest.mark.parametrize("level", LEVELS)
async def test_update_relinking_onto_another_segment_is_409(
    authed_client, mock_db_session, change_intents, level
):
    client, set_user = authed_client
    set_user(ADMIN)
    row = _row(level, start_date=date(2026, 3, 3), end_date=date(2026, 3, 5))
    other = _row(level, id=2, start_date=date(2026, 3, 9), end_date=date(2026, 3, 11))
    mock_db_session.execute.side_effect = [_scalar_result(row), _scalar_result(other)]

    response = await client.put(_put_path(level), json={"start_date": None, "end_date": None})

    assert response.status_code == 409
    assert response.json()["detail"] == ALREADY_BOOKED_OVERLAP_DETAIL
    assert row.start_date == date(2026, 3, 3)
    mock_db_session.commit.assert_not_awaited()
    assert change_intents == []


@pytest.mark.parametrize("level", LEVELS)
async def test_update_gives_a_linked_booking_its_own_dates(
    authed_client, mock_db_session, change_intents, level
):
    client, set_user = authed_client
    set_user(ADMIN)
    row = _row(level)
    mock_db_session.execute.side_effect = [
        _scalar_result(row),
        _card_dates(),
        _scalar_result(None),
    ]

    response = await client.put(_put_path(level), json=SEG)

    assert response.status_code == 200, response.text
    assert response.json() == {"success": True, "linked": False}
    assert (row.start_date, row.end_date) == (date(2026, 3, 3), date(2026, 3, 5))
    assert row.allocation == 50  # left out = unchanged
    ((_, intents, _),) = change_intents
    assert {i.body for i in intents} == {"dates follow the card → 2026-03-03–2026-03-05"}
    # The duplicate check excluded the row itself.
    dup = mock_db_session.execute.await_args_list[2].args[0]
    assert "!=" in str(dup.compile()) or "<>" in str(dup.compile())


@pytest.mark.parametrize("level", LEVELS)
async def test_update_dates_outside_the_card_is_400(
    authed_client, mock_db_session, change_intents, level
):
    client, set_user = authed_client
    set_user(ADMIN)
    row = _row(level, start_date=date(2026, 3, 3), end_date=date(2026, 3, 5))
    mock_db_session.execute.side_effect = [_scalar_result(row), _card_dates()]

    response = await client.put(
        _put_path(level), json={"start_date": "2026-03-12", "end_date": "2026-03-15"}
    )

    assert response.status_code == 400
    assert response.json()["detail"] == f"Booking dates must lie within the {level}"
    assert row.start_date == date(2026, 3, 3)
    mock_db_session.commit.assert_not_awaited()
    assert change_intents == []


@pytest.mark.parametrize("level", LEVELS)
async def test_update_with_one_date_is_422(authed_client, mock_db_session, level):
    client, set_user = authed_client
    set_user(ADMIN)

    response = await client.put(_put_path(level), json={"start_date": None})

    assert response.status_code == 422
    assert "Give both dates or neither" in response.text
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.parametrize("level", LEVELS)
async def test_update_allocation_only_keeps_the_segment(
    authed_client, mock_db_session, change_intents, level
):
    client, set_user = authed_client
    set_user(ADMIN)
    row = _row(level, start_date=date(2026, 3, 3), end_date=date(2026, 3, 5))
    mock_db_session.execute.side_effect = [_scalar_result(row)]  # no date checks

    response = await client.put(_put_path(level), json={"allocation": 80})

    assert response.status_code == 200, response.text
    assert response.json() == {"success": True, "linked": False}
    assert (row.allocation, row.start_date, row.end_date) == (
        80,
        date(2026, 3, 3),
        date(2026, 3, 5),
    )
    ((_, intents, _),) = change_intents
    assert {i.body for i in intents} == {"allocation 50% → 80%"}


@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize(
    ("dates", "body"),
    [
        ((date(2026, 3, 3), date(2026, 3, 5)), {"allocation": 50, **SEG}),
        ((date(2026, 3, 3), date(2026, 3, 5)), {}),
        ((None, None), {"start_date": None, "end_date": None}),
        ((None, None), {"allocation": 50}),
    ],
    ids=["same-segment", "empty", "relink-a-linked-row", "same-allocation"],
)
async def test_a_put_that_changes_nothing_notifies_nobody(
    authed_client, mock_db_session, change_intents, level, dates, body
):
    client, set_user = authed_client
    set_user(ADMIN)
    start, end = dates
    mock_db_session.execute.side_effect = [
        _scalar_result(_row(level, start_date=start, end_date=end))
    ]

    response = await client.put(_put_path(level), json=body)

    assert response.status_code == 200, response.text
    ((_, intents, _),) = change_intents
    assert intents == []


@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize(
    ("row_dates", "body", "values", "extra_results"),
    [
        # Unlink: the requested dates go into the request.
        ((None, None), SEG, {"allocation": 50, **SEG}, 2),
        # Relink: explicit nulls, so the request says "follow the card".
        (
            (date(2026, 3, 3), date(2026, 3, 5)),
            {"start_date": None, "end_date": None},
            {"allocation": 50, "start_date": None, "end_date": None},
            1,
        ),
        # Allocation only on a segment: the segment's dates stay in the values.
        ((date(2026, 3, 3), date(2026, 3, 5)), {"allocation": 70}, {"allocation": 70, **SEG}, 0),
    ],
    ids=["unlink", "relink", "allocation"],
)
async def test_update_in_approval_mode_files_the_requested_values(
    authed_client, mock_db_session, submit, level, row_dates, body, values, extra_results
):
    client, set_user = authed_client
    set_user(SELF_MODES["approval"])
    start, end = row_dates
    checks = [_card_dates(), _scalar_result(None)][-extra_results:] if extra_results else []
    mock_db_session.execute.side_effect = [
        _scalar_result(_row(level, start_date=start, end_date=end)),
        _pm_result(PM),
        *checks,
    ]

    response = await client.put(_put_path(level), json=body)

    assert response.status_code == 202
    assert submit.await_args.kwargs["values"] == values
    mock_db_session.commit.assert_not_awaited()


# ---------------------------------------------------------------------------
# GET /projects/{id}: an unlinked row carries its own dates
# ---------------------------------------------------------------------------


async def test_project_detail_marks_unlinked_bookings(authed_client, mock_db_session):
    from tests.support import scalars_result
    from tests.test_projects_routes_more import (
        _assignment,
        _phase,
        _subphase,
        first_result,
        make_project,
        rows_result,
    )

    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    own = {"start_date": date(2026, 1, 12), "end_date": date(2026, 1, 14)}
    mock_db_session.execute.side_effect = [
        first_result((make_project(1), "Winterthur", "Alice Martin")),
        scalars_result([_phase(10, 0)]),
        scalars_result([_subphase(20, 10, "phase", 1)]),
        rows_result(
            [
                (_assignment(30, 7, phase_id=10, **own), "Alice Martin", None),
                (_assignment(33, 7, phase_id=10), "Alice Martin", None),
            ]
        ),
        rows_result([(_assignment(31, 8, subphase_id=20, **own), "Bob Brown", None)]),
        rows_result([]),
        rows_result([]),
        scalars_result([]),
        rows_result([]),  # project-field values
        rows_result([]),  # project-field selections
    ]

    response = await client.get("/api/projects/1")

    assert response.status_code == 200, response.text
    phase = response.json()["phases"][0]
    segment, linked = phase["staffAssignments"]
    assert (segment["linked"], segment["start_date"], segment["end_date"]) == (
        False,
        "2026-01-12T00:00:00.000Z",
        "2026-01-14T00:00:00.000Z",
    )
    assert (linked["linked"], linked["start_date"], linked["end_date"]) == (
        True,
        "2026-01-05T00:00:00.000Z",
        "2026-02-05T00:00:00.000Z",
    )
    (sub_booking,) = phase["children"][0]["staffAssignments"]
    assert sub_booking["linked"] is False
    assert sub_booking["start_date"] == "2026-01-12T00:00:00.000Z"


# ---------------------------------------------------------------------------
# A dateless second booking is placed automatically (2.0.0)
# ---------------------------------------------------------------------------


def _create(level: str, allocation: int = 40) -> dict:
    return {"staff_id": STAFF, "project_id": 1, "allocation": allocation}


@pytest.fixture
def published():
    """approvals.publish's channels: the shortened row's broadcast and pushes."""
    with (
        patch("app.services.approvals.broadcast_change", AsyncMock()) as broadcast,
        patch("app.services.approvals.send_notification", AsyncMock()) as notify,
        patch("app.services.approvals.send_user_event", AsyncMock()) as event,
    ):
        yield SimpleNamespace(broadcast=broadcast, notify=notify, event=event)


@pytest.mark.parametrize("level", LEVELS)
async def test_second_booking_splits_a_full_span_booking(
    authed_client, mock_db_session, change_intents, published, level
):
    client, set_user = authed_client
    set_user(ADMIN)
    _assign_id(mock_db_session)
    linked = _row(level, id=7)
    mock_db_session.execute.side_effect = [
        _resolved(),
        _scalar_result(True),
        _placement(linked),
        _detail_row(STAFF, start_date=date(2026, 3, 8), end_date=date(2026, 3, 13)),
    ]

    response = await client.post(_post_path(level), json=_create(level))

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["linked"], body["start_date"], body["end_date"]) == (
        False,
        "2026-03-08T00:00:00.000Z",
        "2026-03-13T00:00:00.000Z",
    )
    assert body["adjusted"] == [
        {
            "id": 7,
            "start_date": "2026-03-02T00:00:00.000Z",
            "end_date": "2026-03-07T00:00:00.000Z",
            "linked": False,
        }
    ]
    # The existing booking keeps the first half, the new one the second.
    assert (linked.start_date, linked.end_date) == (date(2026, 3, 2), date(2026, 3, 7))
    added = mock_db_session.add.call_args[0][0]
    assert (added.start_date, added.end_date) == (date(2026, 3, 8), date(2026, 3, 13))
    mock_db_session.commit.assert_awaited_once()  # both rows in one transaction
    # One create and one update, both for the same person (merged by deliver).
    ((_, intents, _),) = change_intents
    assert [(i.recipient, i.user_id, i.body) for i in intents] == [
        ("person", STAFF, "at 40% from 2026-03-08 to 2026-03-13"),
        ("pm", None, "at 40% from 2026-03-08 to 2026-03-13"),
        ("person", STAFF, "dates follow the card → 2026-03-02–2026-03-07"),
        ("pm", None, "dates follow the card → 2026-03-02–2026-03-07"),
    ]
    # The shortened row's update goes out through approvals.publish.
    kwargs = published.broadcast.await_args.kwargs
    assert (kwargs["entity_type"], kwargs["entity_id"], kwargs["action"]) == (
        "staff_assignment",
        7,
        "update",
    )


@pytest.mark.parametrize("level", LEVELS)
async def test_second_booking_splits_an_unlinked_full_span_booking(
    authed_client, mock_db_session, published, level
):
    client, set_user = authed_client
    set_user(ADMIN)
    _assign_id(mock_db_session)
    whole = _row(level, id=7, start_date=CARD_START, end_date=CARD_END)
    mock_db_session.execute.side_effect = [
        _resolved(),
        _scalar_result(True),
        _placement(whole),
        _detail_row(STAFF, start_date=date(2026, 3, 8), end_date=date(2026, 3, 13)),
    ]

    response = await client.post(_post_path(level), json=_create(level))

    assert response.status_code == 200, response.text
    assert (whole.start_date, whole.end_date) == (date(2026, 3, 2), date(2026, 3, 7))
    assert [a["id"] for a in response.json()["adjusted"]] == [7]


@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize(
    ("existing", "expected"),
    [
        # One booking at the start: the rest of the card.
        ([(date(2026, 3, 2), date(2026, 3, 4))], (date(2026, 3, 5), date(2026, 3, 13))),
        # Gaps before (1 day), between (3) and after (2): the largest.
        (
            [(date(2026, 3, 3), date(2026, 3, 5)), (date(2026, 3, 9), date(2026, 3, 11))],
            (date(2026, 3, 6), date(2026, 3, 8)),
        ),
    ],
    ids=["rest-of-the-card", "largest-gap"],
)
async def test_second_booking_fills_the_largest_free_stretch(
    authed_client, mock_db_session, change_intents, published, level, existing, expected
):
    client, set_user = authed_client
    set_user(ADMIN)
    _assign_id(mock_db_session)
    rows = [
        _row(level, id=7 + n, start_date=start, end_date=end)
        for n, (start, end) in enumerate(existing)
    ]
    mock_db_session.execute.side_effect = [
        _resolved(),
        _scalar_result(True),
        _placement(*rows),
        _detail_row(STAFF, start_date=expected[0], end_date=expected[1]),
    ]

    response = await client.post(_post_path(level), json=_create(level))

    assert response.status_code == 200, response.text
    assert response.json()["adjusted"] == []
    added = mock_db_session.add.call_args[0][0]
    assert (added.start_date, added.end_date) == expected
    assert [(r.start_date, r.end_date) for r in rows] == existing  # untouched
    published.broadcast.assert_not_awaited()
    ((_, intents, _),) = change_intents
    assert len(intents) == 2  # the create only


@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize(
    ("rows", "detail"),
    [
        (
            [
                {"id": 7, "start_date": date(2026, 3, 2), "end_date": date(2026, 3, 7)},
                {"id": 8, "start_date": date(2026, 3, 8), "end_date": date(2026, 3, 13)},
            ],
            CARD_FULL_DETAIL,
        ),
        (
            [{"id": 7, "approval_status": "pending", "approval_request_id": 50}],
            ALREADY_PENDING_DETAIL,
        ),
    ],
    ids=["card-covered", "full-span-pending"],
)
async def test_second_booking_without_room_is_409(
    authed_client, mock_db_session, change_intents, level, rows, detail
):
    client, set_user = authed_client
    set_user(ADMIN)
    existing = [_row(level, **fields) for fields in rows]
    mock_db_session.execute.side_effect = [
        _resolved(),
        _scalar_result(True),
        _placement(*existing),
    ]

    response = await client.post(_post_path(level), json=_create(level))

    assert response.status_code == 409
    assert response.json()["detail"] == detail
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()
    assert change_intents == []


@pytest.mark.parametrize("level", LEVELS)
async def test_second_booking_overtakes_an_open_request_on_the_split_booking(
    authed_client, mock_db_session, published, level
):
    client, set_user = authed_client
    set_user(ADMIN)
    _assign_id(mock_db_session)
    linked = _row(level, id=7, approval_request_id=60)
    overtaken = approvals.ApprovalEffects(
        events=[approvals.RequestEvent(60, 1, "expired", "update", "overtaken", frozenset({STAFF}))]
    )
    mock_db_session.execute.side_effect = [
        _resolved(),
        _scalar_result(True),
        _placement(linked),
        _detail_row(STAFF, start_date=date(2026, 3, 8), end_date=date(2026, 3, 13)),
    ]

    with patch(
        "app.services.approvals.expire_overtaken", AsyncMock(return_value=overtaken)
    ) as expire:
        response = await client.post(_post_path(level), json=_create(level))

    assert response.status_code == 200, response.text
    assert expire.await_args.kwargs["row"] is linked
    # Published after the commit: the shortened row, then the closed request.
    broadcasts = [
        (c.kwargs["entity_type"], c.kwargs["entity_id"])
        for c in published.broadcast.await_args_list
    ]
    assert broadcasts == [("staff_assignment", 7), ("approval_request", 60)]
    published.event.assert_awaited_once()


@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize(
    ("existing", "values"),
    [
        # The planned half: the full-span booking stays untouched until approved.
        (
            {"id": 7},
            {
                "allocation": 40,
                "start_date": "2026-03-08",
                "end_date": "2026-03-13",
                "placement": "auto",
            },
        ),
        # No booking on the card: linked, still marked.
        (None, {"allocation": 40, "placement": "auto"}),
    ],
    ids=["split-planned", "linked"],
)
async def test_second_booking_in_approval_mode_files_the_planned_dates(
    authed_client, mock_db_session, submit, change_intents, level, existing, values
):
    client, set_user = authed_client
    set_user(SELF_MODES["approval"])
    rows = [] if existing is None else [_row(level, **existing)]
    mock_db_session.execute.side_effect = [
        _resolved(),
        _pm_result(PM),
        _scalar_result(True),
        _placement(*rows),
    ]

    response = await client.post(_post_path(level), json=_create(level))

    assert response.status_code == 202
    assert submit.await_args.kwargs["values"] == values
    for row in rows:
        assert (row.start_date, row.end_date) == (None, None)
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()
    assert change_intents == []
