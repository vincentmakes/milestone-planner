"""
Booking enforcement of the "Bookable as a resource" flag (``users.is_resource``).

- ``GET /staff`` lists bookable users only (no role literal any more);
- the four create routes (project / phase / subphase staff POSTs and the Kanban
  assignee POST) answer 404 for an unknown person and 400 for one who is not
  bookable -- before any approval request is filed;
- an own-booking request of someone no longer bookable expires on approve
  (``requester_not_bookable``).
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql

from app.services import approvals
from app.services.approvals import CLOSE_REASON_DETAILS, RequestContext, _requester_problem
from app.services.project_access import (
    NOT_BOOKABLE_DETAIL,
    STAFF_NOT_FOUND_DETAIL,
    require_bookable_staff,
)
from tests.conftest import FakeUser
from tests.support import (
    REQUESTER_ID,
    ApprovalFakeDB,
    approvable_db,
    approval_admin,
    approval_request,
    pending_phase_row,
    scalar_result,
)
from tests.test_project_access_routes import (
    PM,
    PROJECT_STAFF,
    SELF_MODES,
    _card,
    _detail_row,
    _pm_result,
    _resolved,
)

STAFF = 8


def _compiled(stmt) -> str:
    return str(stmt.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))


def _assignee(is_resource: bool):
    return SimpleNamespace(id=STAFF, full_name="Ann Lee", max_capacity=80, is_resource=is_resource)


# ---------------------------------------------------------
# GET /staff
# ---------------------------------------------------------


async def test_staff_list_filters_on_is_resource_not_on_the_role(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    empty = MagicMock()
    empty.unique.return_value.all.return_value = []
    mock_db_session.execute.return_value = empty

    response = await client.get("/api/staff")

    assert response.status_code == 200
    assert response.json() == []
    ((stmt,), _) = mock_db_session.execute.await_args
    # The outer WHERE (the role_name column is a correlated subquery of its own).
    where = " ".join(str(stmt.compile()).split()).rsplit(" WHERE ", 1)[1]
    assert "users.is_resource IS true" in where
    assert "users.role" not in where
    assert "'admin'" not in _compiled(stmt)


# ---------------------------------------------------------
# require_bookable_staff
# ---------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "status", "detail"),
    [(None, 404, STAFF_NOT_FOUND_DETAIL), (False, 400, NOT_BOOKABLE_DETAIL)],
)
async def test_require_bookable_staff_rejects(value, status, detail):
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalar_result(value))

    with pytest.raises(HTTPException) as exc:
        await require_bookable_staff(db, STAFF)

    assert (exc.value.status_code, exc.value.detail) == (status, detail)
    (stmt,) = db.execute.await_args.args
    assert "users.is_resource" in str(stmt.compile())


async def test_require_bookable_staff_passes_a_bookable_person():
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalar_result(True))

    assert await require_bookable_staff(db, STAFF) is None
    db.execute.assert_awaited_once()


def test_the_details_are_plain_words():
    assert NOT_BOOKABLE_DETAIL == "This person is not bookable as a resource"
    assert STAFF_NOT_FOUND_DETAIL == "Staff member not found"


# ---------------------------------------------------------
# The four create routes, booking someone else (admin: no editor lookup)
# ---------------------------------------------------------

# (id, path, body, results before the staff lookup, results after it on success)
CREATES = [
    (
        "project",
        "/api/projects/1/staff",
        {"staff_id": STAFF, **PROJECT_STAFF},
        lambda: [_pm_result(PM)],
        lambda: [scalar_result(None)],
    ),
    (
        "phase",
        "/api/phases/1/staff",
        {"staff_id": STAFF, "project_id": 1, "allocation": 40},
        lambda: [_resolved()],
        lambda: [scalar_result(None), _detail_row(STAFF)],
    ),
    (
        "subphase",
        "/api/subphases/1/staff",
        {"staff_id": STAFF, "project_id": 1, "allocation": 40},
        lambda: [_resolved()],
        lambda: [scalar_result(None), _detail_row(STAFF)],
    ),
    (
        "kanban",
        "/api/kanban/cards/phase/1/assignees",
        {"staff_id": STAFF},
        lambda: [scalar_result(_card())],
        lambda: [scalar_result(None)],
    ),
]
_IDS = [c[0] for c in CREATES]


def _lookup(name: str, is_resource: bool | None):
    """The staff lookup: ``is_resource`` (assignments) or the user row (Kanban)."""
    if name == "kanban":
        return scalar_result(None if is_resource is None else _assignee(is_resource))
    return scalar_result(is_resource)


@pytest.mark.parametrize(("name", "path", "body", "before", "after"), CREATES, ids=_IDS)
async def test_booking_a_non_bookable_person_is_400(
    authed_client, mock_db_session, change_intents, name, path, body, before, after
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [*before(), _lookup(name, False)]

    response = await client.post(path, json=body)

    assert response.status_code == 400
    assert response.json()["detail"] == NOT_BOOKABLE_DETAIL
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()
    assert change_intents == []


@pytest.mark.parametrize(("name", "path", "body", "before", "after"), CREATES, ids=_IDS)
async def test_booking_an_unknown_person_is_404(
    authed_client, mock_db_session, change_intents, name, path, body, before, after
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [*before(), _lookup(name, None)]

    response = await client.post(path, json=body)

    assert response.status_code == 404
    assert response.json()["detail"] == STAFF_NOT_FOUND_DETAIL
    mock_db_session.add.assert_not_called()
    assert change_intents == []


@pytest.mark.parametrize(("name", "path", "body", "before", "after"), CREATES, ids=_IDS)
async def test_booking_a_bookable_person_succeeds(
    authed_client, mock_db_session, change_intents, name, path, body, before, after
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.refresh.side_effect = lambda obj: setattr(obj, "id", 42)
    mock_db_session.execute.side_effect = [*before(), _lookup(name, True), *after()]

    response = await client.post(path, json=body)

    assert response.status_code in (200, 201), response.text
    mock_db_session.commit.assert_awaited_once()
    ((actor_id, intents, _),) = change_intents
    assert actor_id == 1
    assert any(i.user_id == STAFF for i in intents)


# ---------------------------------------------------------
# Own booking in approval mode: no request for a non-bookable person
# ---------------------------------------------------------

SELF = 5
SELF_CREATES = [
    (
        "project",
        "/api/projects/1/staff",
        {"staff_id": SELF, **PROJECT_STAFF},
        lambda: [_pm_result(PM)],
    ),
    (
        "phase",
        "/api/phases/1/staff",
        {"staff_id": SELF, "project_id": 1, "allocation": 40},
        lambda: [_resolved(), _pm_result(PM)],
    ),
    (
        "subphase",
        "/api/subphases/1/staff",
        {"staff_id": SELF, "project_id": 1, "allocation": 40},
        lambda: [_resolved(), _pm_result(PM)],
    ),
    (
        "kanban",
        "/api/kanban/cards/phase/1/assignees",
        {"staff_id": SELF},
        lambda: [scalar_result(_card()), _pm_result(PM)],
    ),
]


@pytest.mark.parametrize(
    ("name", "path", "body", "before"), SELF_CREATES, ids=[c[0] for c in SELF_CREATES]
)
async def test_self_booking_in_approval_mode_of_a_non_bookable_user_files_nothing(
    authed_client, mock_db_session, change_intents, name, path, body, before
):
    client, set_user = authed_client
    set_user(SELF_MODES["approval"])
    lookup = (
        scalar_result(SimpleNamespace(id=SELF, full_name="Me", max_capacity=80, is_resource=False))
        if name == "kanban"
        else scalar_result(False)
    )
    mock_db_session.execute.side_effect = [*before(), lookup]

    with (
        patch.object(approvals, "submit_request", AsyncMock()) as submit,
        patch.object(approvals, "ensure_no_duplicate", AsyncMock()) as duplicate,
    ):
        response = await client.post(path, json=body)

    assert response.status_code == 400
    assert response.json()["detail"] == NOT_BOOKABLE_DETAIL
    submit.assert_not_awaited()
    duplicate.assert_not_awaited()
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()
    assert change_intents == []


# ---------------------------------------------------------
# Approve: a requester no longer bookable expires the request
# ---------------------------------------------------------


def _context() -> RequestContext:
    return RequestContext(
        project_name="Alpha", pm_id=PM, site_id=1, target_exists=True, target_name="Design"
    )


async def test_requester_problem_reports_a_non_bookable_requester():
    db = ApprovalFakeDB(requester=[(1, "user", False)])

    assert await _requester_problem(db, approval_request(), _context()) == "requester_not_bookable"
    # Decided before the permission checks: no role matrix read.
    assert db.queried("perms") == 0
    (stmt,) = db.statements
    assert "users.is_resource" in str(stmt.compile())


async def test_an_inactive_requester_stays_requester_inactive():
    db = ApprovalFakeDB(requester=[(0, "user", False)])

    assert await _requester_problem(db, approval_request(), _context()) == "requester_inactive"


async def test_a_bookable_requester_goes_on_to_the_permission_checks():
    db = ApprovalFakeDB(
        requester=[(1, "user", True)],
        perms=[("assignments.self_create", "approval")],
        member=[(REQUESTER_ID,)],
    )

    assert await _requester_problem(db, approval_request(), _context()) is None
    assert db.queried("perms") == 1


async def test_approving_the_request_of_a_non_bookable_requester_is_409_expired():
    request, row = approval_request(), pending_phase_row()
    db = approvable_db(request, row, requester=[(1, "user", False)])

    result = await approvals.approve(db, approval_admin(), 50, visible=None)

    assert request.status == "expired"
    assert request.close_reason == "requester_not_bookable"
    assert result.conflict == {
        "detail": "Request expired: the requester is no longer bookable as a resource",
        "status": "expired",
        "close_reason": "requester_not_bookable",
    }
    assert row.approval_status == "pending"  # never applied
    assert db.deleted == [row]  # the pending create's row is released


def test_close_reason_detail_is_plain_words():
    assert (
        CLOSE_REASON_DETAILS["requester_not_bookable"]
        == "the requester is no longer bookable as a resource"
    )
