"""
Routes of /api/approval-requests (app/routers/approvals.py).

The state machine itself is covered in tests/test_approvals_service.py; these
pin the HTTP contract: the list scopes and their gates, the detail's
visibility, the decision routes' 200 / 403 / 404 / 409 mapping, and that every
transition is published (broadcast + pushes).
"""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.models.rbac import ApprovalPolicy, ApprovalRequest, Role
from app.services import approvals
from app.services.approvals import (
    ACTION_CREATE,
    ACTION_UPDATE,
    ApprovalEffects,
    DecisionResult,
    RequestClosedError,
)
from app.services.permissions import permission_required_detail
from tests.conftest import FakeUser

REQ = 3
PM = 7
OTHER = 9


def _request(**fields) -> ApprovalRequest:
    values = {
        "id": 50,
        "requester_id": REQ,
        "action": ACTION_CREATE,
        "project_id": 1,
        "level": "phase",
        "target_id": 11,
        "assignment_id": 70,
        "requested": '{"allocation": 80}',
        "previous": None,
        "status": "pending",
        "created_at": datetime(2026, 10, 1, 9, 30),
        "updated_at": datetime(2026, 10, 1, 9, 30),
    }
    values.update(fields)
    return ApprovalRequest(**values)


def _row(request: ApprovalRequest, *, pm_id=PM, site_id=1):
    """One row of the list query: request, project name, pm, site, names."""
    return (request, "Alpha", pm_id, site_id, "Test User3", None, "Design")


def _rows_result(rows):
    result = MagicMock()
    result.all.return_value = rows
    result.first.return_value = rows[0] if rows else None
    return result


def _policies_result(policies=()):
    result = MagicMock()
    result.scalars.return_value.all.return_value = list(policies)
    return result


# ---------------------------------------------------------
# List scopes
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_mine_lists_the_callers_requests(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(REQ, "user"))
    mock_db_session.execute.side_effect = [_rows_result([_row(_request())]), _policies_result()]

    response = await client.get("/api/approval-requests")

    assert response.status_code == 200
    (item,) = response.json()
    assert item["id"] == 50 and item["status"] == "pending"
    assert item["requested"] == {"allocation": 80}
    assert item["project_name"] == "Alpha" and item["target_name"] == "Design"
    assert item["requester_name"] == "Test User3"
    assert item["created_at"] == "2026-10-01T09:30:00.000Z"
    assert item["can_decide"] is False  # never on one's own request
    sql = str(mock_db_session.execute.await_args_list[0].args[0])
    assert "approval_requests.requester_id = " in sql


@pytest.mark.asyncio
async def test_to_decide_keeps_only_requests_the_caller_may_decide(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    lead_policy = ApprovalPolicy(action=ACTION_UPDATE, pm_approves=False)
    lead_policy.roles = [Role(id=4, key="lead", name="Lead")]
    rows = [
        _row(_request(id=50)),  # PM of the project: decides (default policy)
        _row(_request(id=51), pm_id=OTHER),  # someone else's project
        _row(_request(id=52, action=ACTION_UPDATE)),  # policy without the PM
    ]
    # The policies come first: the eligibility rule is part of the query.
    mock_db_session.execute.side_effect = [_policies_result([lead_policy]), _rows_result(rows)]

    response = await client.get("/api/approval-requests?scope=to_decide")

    assert response.status_code == 200
    assert [(i["id"], i["can_decide"]) for i in response.json()] == [(50, True)]
    sql = str(mock_db_session.execute.await_args_list[1].args[0])
    assert "approval_requests.status = " in sql
    assert "projects.site_id IN" in sql  # limited to the visible sites
    assert "projects.pm_id = " in sql and "approval_requests.action NOT IN" in sql


@pytest.mark.asyncio
async def test_to_decide_with_a_closed_status_is_empty(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))

    response = await client.get("/api/approval-requests?scope=to_decide&status=approved")

    assert response.status_code == 200 and response.json() == []
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_all_needs_approvals_view_all(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))

    response = await client.get("/api/approval-requests?scope=all")

    assert response.status_code == 403
    assert response.json()["detail"] == permission_required_detail("approvals.view_all")


@pytest.mark.asyncio
async def test_all_with_status_filter_for_an_admin(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    rows = [_row(_request(status="approved", decided_by=1))]
    mock_db_session.execute.side_effect = [_rows_result(rows), _policies_result()]

    response = await client.get("/api/approval-requests?scope=all&status=approved")

    assert response.status_code == 200
    assert response.json()[0]["status"] == "approved"
    sql = str(mock_db_session.execute.await_args_list[0].args[0])
    assert "projects.site_id IN" not in sql  # the admin sees every site


@pytest.mark.asyncio
async def test_all_for_a_view_all_holder_stays_at_their_sites(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "auditor", {"approvals.view_all"}, site_ids=[2]))
    mock_db_session.execute.side_effect = [_rows_result([]), _policies_result()]

    response = await client.get("/api/approval-requests?scope=all")

    assert response.status_code == 200 and response.json() == []
    sql = str(mock_db_session.execute.await_args_list[0].args[0])
    assert "projects.site_id IN" in sql


@pytest.mark.asyncio
async def test_list_rejects_an_unknown_scope(authed_client, mock_db_session):
    client, _ = authed_client
    response = await client.get("/api/approval-requests?scope=everything")
    assert response.status_code == 422


# ---------------------------------------------------------
# Detail
# ---------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("user", "expected"),
    [
        (FakeUser(REQ, "user"), 200),  # the requester
        (FakeUser(PM, "user"), 200),  # an approver
        (FakeUser(1, "admin"), 200),
        (FakeUser(OTHER, "user"), 404),  # anyone else: not found
    ],
)
async def test_detail_visibility(authed_client, mock_db_session, user, expected):
    client, set_user = authed_client
    set_user(user)
    mock_db_session.execute.side_effect = [_rows_result([_row(_request())]), _policies_result()]

    response = await client.get("/api/approval-requests/50")

    assert response.status_code == expected


@pytest.mark.asyncio
async def test_detail_of_a_request_at_an_invisible_site_is_404_for_its_pm(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user", site_ids=[2]))
    mock_db_session.execute.side_effect = [_rows_result([_row(_request(), site_id=1)])]

    response = await client.get("/api/approval-requests/50")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_detail_of_a_missing_request_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [_rows_result([])]

    response = await client.get("/api/approval-requests/404")

    assert response.status_code == 404


# ---------------------------------------------------------
# Decisions
# ---------------------------------------------------------


def _decided(status: str, conflict=None) -> DecisionResult:
    effects = ApprovalEffects()
    effects.events.append(approvals.RequestEvent(50, 1, status, "update", "s", frozenset({REQ})))
    return DecisionResult(_request(status=status), effects, conflict)


@pytest.fixture
def published():
    with patch("app.routers.approvals.approvals.publish", AsyncMock()) as publish:
        yield publish


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("verb", "service", "status"),
    [
        ("approve", "approve", "approved"),
        ("reject", "reject", "rejected"),
        ("cancel", "cancel", "cancelled"),
    ],
)
async def test_decision_success_publishes(
    authed_client, mock_db_session, published, verb, service, status
):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    with patch.object(approvals, service, AsyncMock(return_value=_decided(status))) as decide:
        response = await client.post(f"/api/approval-requests/50/{verb}", json={"note": "fine"})

    assert response.status_code == 200
    assert response.json() == {"success": True, "id": 50, "status": status}
    assert decide.await_args.kwargs["note"] == "fine"
    published.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("approver", [FakeUser(1, "admin"), FakeUser(PM, "user")])
async def test_an_applied_approval_tells_the_pm_after_publishing(
    authed_client, mock_db_session, published, change_intents, approver
):
    """The router delivers the service's PM intent; the requester (approval_decided
    already) is excluded, and a PM approving is dropped as the actor at delivery."""
    from app.services.change_notifications import approval_intents

    client, set_user = authed_client
    set_user(approver)
    decided = _decided("approved")
    decided.effects.change_intents = approval_intents(
        approver,
        project_id=1,
        level="phase",
        target_id=11,
        target_name="Design",
        pm_id=PM,
        requester_id=REQ,
        action="assignments.self_create",
        requested={"allocation": 80},
        previous=None,
    )
    with patch.object(approvals, "approve", AsyncMock(return_value=decided)):
        response = await client.post("/api/approval-requests/50/approve")

    assert response.status_code == 200
    published.assert_awaited_once()
    ((actor_id, intents, already),) = change_intents
    assert actor_id == approver.id
    assert already == {REQ}
    assert intents == decided.effects.change_intents


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["reject", "cancel"])
async def test_reject_and_cancel_tell_nobody_else(
    authed_client, mock_db_session, published, change_intents, verb
):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    with patch.object(approvals, verb, AsyncMock(return_value=_decided("rejected"))):
        response = await client.post(f"/api/approval-requests/50/{verb}")

    assert response.status_code == 200
    assert [intents for _, intents, _ in change_intents] == [[]]


@pytest.mark.asyncio
async def test_decision_body_is_optional(authed_client, mock_db_session, published):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    with patch.object(approvals, "approve", AsyncMock(return_value=_decided("approved"))) as decide:
        response = await client.post("/api/approval-requests/50/approve")

    assert response.status_code == 200
    assert decide.await_args.kwargs["note"] is None
    assert decide.await_args.kwargs["visible"] == frozenset({1})


@pytest.mark.asyncio
async def test_approve_that_expires_the_request_is_409_with_the_reason(
    authed_client, mock_db_session, published
):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    conflict = {"detail": "Request expired: x", "status": "expired", "close_reason": "duplicate"}
    with patch.object(approvals, "approve", AsyncMock(return_value=_decided("expired", conflict))):
        response = await client.post("/api/approval-requests/50/approve")

    assert response.status_code == 409
    assert response.json() == conflict
    published.assert_awaited_once()  # the expiry is still announced


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["approve", "reject", "cancel"])
async def test_decision_on_a_closed_request_is_409(authed_client, mock_db_session, published, verb):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    with patch.object(approvals, verb, AsyncMock(side_effect=RequestClosedError("rejected"))):
        response = await client.post(f"/api/approval-requests/50/{verb}")

    assert response.status_code == 409
    assert response.json() == {"detail": "Request already rejected", "status": "rejected"}
    published.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("code", [403, 404])
async def test_decision_errors_pass_through(authed_client, mock_db_session, published, code):
    client, set_user = authed_client
    set_user(FakeUser(OTHER, "user"))
    with patch.object(approvals, "reject", AsyncMock(side_effect=HTTPException(code, "no"))):
        response = await client.post("/api/approval-requests/50/reject")

    assert response.status_code == code
    published.assert_not_awaited()


@pytest.mark.asyncio
async def test_decision_note_is_bounded(authed_client, mock_db_session):
    client, _ = authed_client
    response = await client.post("/api/approval-requests/50/reject", json={"note": "x" * 2001})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_decision_end_to_end_through_the_service(authed_client, mock_db_session):
    """Reject by the PM, through the real service: 200, row removed, broadcast."""
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    pending = _request()
    row = MagicMock(id=70, approval_status="pending", approval_request_id=50)

    def scalar(value):
        result = MagicMock()
        result.scalar_one_or_none.return_value = value
        result.scalars.return_value.all.return_value = [] if value is None else [value]
        return result

    context = MagicMock()
    context.first.return_value = ("Alpha", PM, 1, 11, "Design", None, None)
    mock_db_session.execute.side_effect = [
        scalar(pending),  # lock
        context,  # project + target
        scalar(None),  # policy: default (PM approves)
        scalar(row),  # the pending row
        scalar(None),  # approvers (scalars)
        MagicMock(),  # mark notifications read
    ]
    mock_db_session.delete = AsyncMock()
    with patch("app.services.approvals.broadcast_change", AsyncMock()) as broadcast:
        response = await client.post("/api/approval-requests/50/reject", json={"note": "no"})

    assert response.status_code == 200
    assert pending.status == "rejected"
    mock_db_session.delete.assert_awaited_once_with(row)
    assert {c.kwargs["entity_type"] for c in broadcast.await_args_list} == {
        "staff_assignment",
        "approval_request",
    }


@pytest.mark.asyncio
async def test_an_empty_list_skips_the_policy_lookup(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(REQ, "user"))
    mock_db_session.execute.side_effect = [_rows_result([])]

    response = await client.get("/api/approval-requests?status=pending")

    assert response.status_code == 200 and response.json() == []
    assert mock_db_session.execute.await_count == 1
