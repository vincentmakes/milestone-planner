"""
The approval workflow service (app/services/approvals.py).

Mock-only like the rest of the suite, but through a small statement-dispatching
fake session (``ApprovalFakeDB``): each query is answered by what it selects (the
request, the project context, the policy, the approvers, the requester, the
assignment row, a duplicate, ...), so the tests pin the state machine rather
than the query order.
"""

from datetime import date
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.models.assignment import (
    PhaseStaffAssignment,
    ProjectAssignment,
    SubphaseStaffAssignment,
)
from app.models.notification import Notification
from app.models.rbac import ApprovalPolicy, ApprovalRequest, Role
from app.services import approvals
from app.services.approvals import (
    ACTION_CREATE,
    ACTION_REMOVE,
    ACTION_UPDATE,
    ALREADY_PENDING_DETAIL,
    AWAITS_APPROVAL_DETAIL,
    CANCEL_FORBIDDEN_DETAIL,
    INVALID_VALUES_DETAIL,
    NOT_DECIDER_DETAIL,
    OWN_REQUEST_DETAIL,
    Policy,
    RequestClosedError,
)
from app.services.project_access import OWN_ASSIGNMENT_DETAIL, SELF_BOOKING_DENIED_DETAIL
from tests.conftest import FakeUser
from tests.support import (
    ADMIN_ID,
    PM_ID,
    REQUESTER_ID,
    ApprovalFakeDB,
    approvable_db,
    approval_admin,
    approval_context,
    approval_request,
    dispatch_result,
    pending_phase_row,
)

ADMIN, REQ, PM = ADMIN_ID, REQUESTER_ID, PM_ID
LEAD = 8
OTHER = 9

APPROVAL_MODES = {
    ACTION_CREATE: "approval",
    ACTION_UPDATE: "approval",
    ACTION_REMOVE: "approval",
    "projects.manage_as_pm": "allow",
}


def requester(user_id: int = REQ) -> FakeUser:
    return FakeUser(user_id, "user", APPROVAL_MODES)


# ---------------------------------------------------------
# Fake session
# ---------------------------------------------------------


@pytest.fixture
def pushes():
    """The broadcasts and per-user pushes publish() sends."""
    with (
        patch.object(approvals, "broadcast_change", AsyncMock()) as broadcast,
        patch.object(approvals, "send_notification", AsyncMock()) as notify,
        patch.object(approvals, "send_user_event", AsyncMock()) as event,
    ):
        yield MagicMock(broadcast=broadcast, notify=notify, event=event)


def _project_row(**fields) -> ProjectAssignment:
    values = {
        "id": 71,
        "project_id": 1,
        "staff_id": REQ,
        "allocation": 60,
        "start_date": date(2026, 1, 5),
        "end_date": date(2026, 1, 30),
        "approval_status": "approved",
        "approval_request_id": None,
    }
    values.update(fields)
    return ProjectAssignment(**values)


def _http():
    return MagicMock()


# ---------------------------------------------------------
# The decision point: editor / allow / approval / deny
# ---------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("user", "staff_id", "expected"),
    [
        (FakeUser(5, "superuser"), OTHER, "allow"),  # editor writes anyone's row
        (FakeUser(5, "superuser"), 5, "allow"),  # editor's own row: never approval
        (FakeUser(REQ, "user"), REQ, "allow"),  # shipped default: own rows allowed
        (requester(), REQ, "approval"),
    ],
)
async def test_resolve_row_write_matrix(user, staff_id, expected):
    db = ApprovalFakeDB(context=[approval_context(pm_id=None)])
    db.execute = AsyncMock(return_value=dispatch_result([(None,)]))  # pm_id lookup
    row = pending_phase_row(staff_id=staff_id, approval_status="approved", approval_request_id=None)

    outcome = await approvals.resolve_row_write(db, user, row=row, action=ACTION_UPDATE)

    assert outcome == expected


@pytest.mark.asyncio
async def test_resolve_row_write_denies_own_row_without_the_key():
    db = MagicMock()
    db.execute = AsyncMock(return_value=dispatch_result([(None,)]))
    user = FakeUser(REQ, "user", {"views.kanban": "allow"})
    row = pending_phase_row(approval_status="approved", approval_request_id=None)

    with pytest.raises(HTTPException) as exc:
        await approvals.resolve_row_write(db, user, row=row, action=ACTION_UPDATE)

    assert exc.value.status_code == 403
    assert exc.value.detail == SELF_BOOKING_DENIED_DETAIL


@pytest.mark.asyncio
async def test_resolve_row_write_others_row_without_editor_rights_is_403():
    db = MagicMock()
    db.execute = AsyncMock(return_value=dispatch_result([(None,)]))
    row = pending_phase_row(staff_id=OTHER, approval_status="approved", approval_request_id=None)

    with pytest.raises(HTTPException) as exc:
        await approvals.resolve_row_write(db, requester(), row=row, action=ACTION_REMOVE)

    assert exc.value.detail == OWN_ASSIGNMENT_DETAIL


@pytest.mark.asyncio
async def test_pending_create_goes_back_through_its_requester():
    db = MagicMock()
    # Even with allow mode or editor rights, the requester amends the request.
    for user in (requester(), FakeUser(REQ, "superuser")):
        outcome = await approvals.resolve_row_write(
            db, user, row=pending_phase_row(), action=ACTION_UPDATE
        )
        assert outcome == "approval"


@pytest.mark.asyncio
async def test_editor_write_on_pending_create_is_409():
    db = MagicMock()
    with pytest.raises(HTTPException) as exc:
        await approvals.resolve_row_write(
            db, FakeUser(5, "superuser"), row=pending_phase_row(), action=ACTION_REMOVE
        )
    assert exc.value.status_code == 409
    assert exc.value.detail == AWAITS_APPROVAL_DETAIL


@pytest.mark.asyncio
async def test_non_editor_write_on_someone_elses_pending_create_is_403_not_409():
    db = MagicMock()
    db.execute = AsyncMock(return_value=dispatch_result([(None,)]))
    with pytest.raises(HTTPException) as exc:
        await approvals.resolve_row_write(
            db, requester(OTHER), row=pending_phase_row(), action=ACTION_UPDATE
        )
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_precomputed_outcome_is_reused_without_a_query():
    db = MagicMock()
    db.execute = AsyncMock()
    row = pending_phase_row(staff_id=OTHER, approval_status="approved", approval_request_id=None)
    assert (
        await approvals.resolve_row_write(
            db, FakeUser(5, "superuser"), row=row, action=ACTION_REMOVE, outcome="allow"
        )
        == "allow"
    )
    with pytest.raises(HTTPException) as exc:
        await approvals.resolve_row_write(
            db,
            FakeUser(5, "superuser"),
            row=pending_phase_row(),
            action=ACTION_REMOVE,
            outcome="allow",
        )
    assert exc.value.status_code == 409
    db.execute.assert_not_awaited()


# ---------------------------------------------------------
# can_decide and approver resolution
# ---------------------------------------------------------


@pytest.mark.parametrize(
    ("user", "policy", "pm_id", "expected"),
    [
        (approval_admin(), Policy(pm_approves=False), None, True),  # admins always
        (approval_admin(REQ), Policy(), PM, False),  # ... but never their own request
        (FakeUser(PM, "user"), Policy(), PM, True),  # the PM
        (FakeUser(PM, "user"), Policy(pm_approves=False), PM, False),
        (FakeUser(LEAD, "lead"), Policy(role_keys=frozenset({"lead"})), None, True),
        (FakeUser(LEAD, "lead"), Policy(), PM, False),
        (FakeUser(REQ, "lead"), Policy(role_keys=frozenset({"lead"})), REQ, False),  # requester
    ],
)
def test_can_decide(user, policy, pm_id, expected):
    assert approvals.can_decide(user, approval_request(), policy, pm_id) is expected


def _compiled_where(db: ApprovalFakeDB) -> str:
    (stmt,) = (s for s in db.statements if ApprovalFakeDB.key(s) == "approvers")
    return str(stmt.compile(compile_kwargs={"literal_binds": True}))


@pytest.mark.asyncio
async def test_approvers_are_admins_pm_and_policy_roles_at_the_site_minus_the_requester():
    db = ApprovalFakeDB(approvers=[ADMIN, PM, LEAD])
    ids = await approvals.approver_user_ids(
        db,
        requester_id=REQ,
        pm_id=PM,
        site_id=4,
        policy=Policy(pm_approves=True, role_keys=frozenset({"lead"})),
    )
    assert ids == [ADMIN, PM, LEAD]
    sql = _compiled_where(db)
    assert "users.role = 'admin'" in sql
    assert "users.id = 7" in sql  # the PM
    assert "users.role IN ('lead')" in sql
    assert "user_sites.site_id = 4" in sql  # ... when they can see the site
    assert "'sites.view_all'" in sql
    assert "users.id != 3" in sql  # never the requester
    assert "users.active = 1" in sql


@pytest.mark.asyncio
async def test_without_pm_and_roles_only_admins_approve():
    db = ApprovalFakeDB(approvers=[ADMIN])
    await approvals.approver_user_ids(
        db, requester_id=REQ, pm_id=None, site_id=None, policy=Policy(pm_approves=True)
    )
    sql = _compiled_where(db)
    assert "users.role = 'admin'" in sql
    assert "users.role IN" not in sql
    assert "user_sites" not in sql


@pytest.mark.asyncio
async def test_policies_load_with_their_role_keys():
    stored = ApprovalPolicy(action=ACTION_CREATE, pm_approves=False)
    stored.roles = [Role(id=4, key="lead", name="Lead")]
    db = ApprovalFakeDB(policy=[stored])

    assert await approvals.load_policy(db, ACTION_CREATE) == Policy(False, frozenset({"lead"}))
    assert await approvals.load_policies(db) == {ACTION_CREATE: Policy(False, frozenset({"lead"}))}
    assert await approvals.load_policy(ApprovalFakeDB(), ACTION_UPDATE) == Policy()


@pytest.mark.asyncio
async def test_context_reports_missing_project_and_target():
    assert (
        await approvals.load_context(ApprovalFakeDB(), project_id=1, level="phase", target_id=11)
        is None
    )
    db = ApprovalFakeDB(context=[approval_context(target=False)])
    context = await approvals.load_context(db, project_id=1, level="subphase", target_id=11)
    assert context is not None
    assert context.target_exists is False
    assert context.target_name == "Alpha"
    db = ApprovalFakeDB(context=[("Alpha", PM, 1, 1, "Alpha", None, None)])
    context = await approvals.load_context(db, project_id=1, level="project", target_id=1)
    assert context.target_exists and context.pm_id == PM and context.site_id == 1


# ---------------------------------------------------------
# Duplicates
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_duplicate_create_is_409_and_a_pending_one_says_so():
    with pytest.raises(HTTPException) as exc:
        await approvals.ensure_no_duplicate(
            ApprovalFakeDB(duplicate=[pending_phase_row()]), "phase", 11, REQ
        )
    assert exc.value.status_code == 409
    assert exc.value.detail == ALREADY_PENDING_DETAIL

    with pytest.raises(HTTPException) as exc:
        await approvals.ensure_no_duplicate(
            ApprovalFakeDB(duplicate=[pending_phase_row(approval_status="approved")]),
            "phase",
            11,
            REQ,
            detail="taken",
        )
    assert exc.value.detail == "taken"

    await approvals.ensure_no_duplicate(ApprovalFakeDB(), "subphase", 12, REQ)


@pytest.mark.asyncio
async def test_project_level_duplicate_means_same_dates():
    db = ApprovalFakeDB()
    await approvals.find_duplicate(
        db,
        "project",
        1,
        REQ,
        start_date=date(2026, 1, 5),
        end_date=date(2026, 1, 30),
        exclude_id=71,
        approved_only=True,
    )
    sql = str(db.statements[0].compile(compile_kwargs={"literal_binds": True}))
    assert "project_assignments.start_date = '2026-01-05'" in sql
    assert "project_assignments.id != 71" in sql
    assert "project_assignments.approval_status = 'approved'" in sql


# ---------------------------------------------------------
# Submitting: create / update / remove and supersession
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_submit_create_inserts_a_pending_row_and_notifies_approvers(pushes):
    db = ApprovalFakeDB(context=[approval_context()], approvers=[ADMIN, PM])
    user = requester()

    response = await approvals.submit_request(
        db,
        _http(),
        user,
        action=ACTION_CREATE,
        level="phase",
        project_id=1,
        target_id=11,
        values={"allocation": 80},
    )

    assert response.status_code == 202
    request, row = db.added[0], db.added[1]
    assert isinstance(request, ApprovalRequest) and isinstance(row, PhaseStaffAssignment)
    assert response.body == (
        b'{"success":true,"pending":true,"request_id":%d,"id":%d}' % (request.id, row.id)
    )
    assert request.status == "pending" and request.requester_id == REQ
    assert request.assignment_id == row.id and row.approval_request_id == request.id
    assert row.approval_status == "pending" and row.allocation == 80 and row.phase_id == 11
    assert [n.user_id for n in db.notifications] == [ADMIN, PM]
    assert {n.type for n in db.notifications} == {"approval_requested"}
    assert db.notifications[0].title == "Test User3 asks to join Design at 80%"
    db.commit.assert_awaited_once()
    pushes.broadcast.assert_awaited_once()
    assert pushes.broadcast.await_args.kwargs["entity_type"] == "approval_request"
    pushed = {c.args[1] for c in pushes.event.await_args_list}
    assert pushed == {REQ, ADMIN, PM}
    assert pushes.event.await_args.args[2] == "approval:changed"


@pytest.mark.asyncio
async def test_submit_create_at_project_level_stores_the_dates(pushes):
    db = ApprovalFakeDB(context=[("Alpha", PM, 1, 1, "Alpha", None, None)], approvers=[ADMIN])
    await approvals.submit_request(
        db,
        _http(),
        requester(),
        action=ACTION_CREATE,
        level="project",
        project_id=1,
        target_id=1,
        values=approvals.booking_dict(50, date(2026, 2, 1), date(2026, 2, 27)),
    )
    row = db.added[1]
    assert isinstance(row, ProjectAssignment)
    assert (row.start_date, row.end_date) == (date(2026, 2, 1), date(2026, 2, 27))
    assert "from 2026-02-01 to 2026-02-27" in db.notifications[0].title


@pytest.mark.asyncio
async def test_submit_create_on_a_missing_project_is_404(pushes):
    with pytest.raises(HTTPException) as exc:
        await approvals.submit_request(
            ApprovalFakeDB(),
            _http(),
            requester(),
            action=ACTION_CREATE,
            level="subphase",
            project_id=1,
            target_id=12,
            values={"allocation": 10},
        )
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_submit_create_needs_values():
    with pytest.raises(ValueError):
        await approvals.submit_request(
            ApprovalFakeDB(),
            _http(),
            requester(),
            action=ACTION_CREATE,
            level="phase",
            project_id=1,
        )


@pytest.mark.asyncio
async def test_submit_update_stores_requested_and_previous_and_keeps_the_row(pushes):
    row = _project_row()
    db = ApprovalFakeDB(context=[("Alpha", PM, 1, 1, "Alpha", None, None)], approvers=[PM])
    values = approvals.booking_dict(80, date(2026, 1, 5), date(2026, 1, 30))

    response = await approvals.submit_request(
        db,
        _http(),
        requester(),
        action=ACTION_UPDATE,
        level="project",
        project_id=1,
        row=row,
        values=values,
    )

    assert response.status_code == 202
    (request,) = (o for o in db.added if isinstance(o, ApprovalRequest))
    assert approvals.parse_values(request.requested) == values
    assert approvals.parse_values(request.previous) == {
        "allocation": 60,
        "start_date": "2026-01-05",
        "end_date": "2026-01-30",
    }
    assert request.assignment_id == 71 and request.target_id == 1
    assert row.allocation == 60  # unchanged until approved
    assert row.approval_request_id == request.id
    assert db.notifications[0].title.endswith("allocation 60% → 80%")


@pytest.mark.asyncio
async def test_second_request_on_a_row_supersedes_the_open_one(pushes):
    old = approval_request(id=40, action=ACTION_UPDATE, level="phase", assignment_id=70)
    row = pending_phase_row(approval_status="approved", approval_request_id=40, allocation=60)
    db = ApprovalFakeDB(request=[old], context=[approval_context()], approvers=[PM])

    response = await approvals.submit_request(
        db, _http(), requester(), action=ACTION_REMOVE, level="phase", project_id=1, row=row
    )

    assert response.status_code == 202
    (new,) = (o for o in db.added if isinstance(o, ApprovalRequest))
    assert old.status == "superseded" and old.superseded_by_id == new.id
    assert new.status == "pending" and new.requested is None
    assert approvals.parse_values(new.previous) == {"allocation": 60}
    assert row.approval_request_id == new.id
    assert len(db.updates) == 1  # the old request's unread notifications marked read
    assert [n.user_id for n in db.notifications] == [PM]  # one notification, the new one
    statuses = [c.args[2] for c in pushes.event.await_args_list]
    assert statuses and all(s == "approval:changed" for s in statuses)


@pytest.mark.asyncio
async def test_update_back_to_the_current_values_withdraws_the_open_request(pushes):
    old = approval_request(id=40, action=ACTION_UPDATE)
    row = pending_phase_row(approval_status="approved", approval_request_id=40, allocation=60)
    db = ApprovalFakeDB(request=[old], context=[approval_context()], approvers=[PM])

    response = await approvals.submit_request(
        db,
        _http(),
        requester(),
        action=ACTION_UPDATE,
        level="phase",
        project_id=1,
        row=row,
        values={"allocation": 60},
    )

    assert response.status_code == 200
    assert old.status == "cancelled" and row.approval_request_id is None
    assert not [o for o in db.added if isinstance(o, ApprovalRequest)]
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_to_the_current_values_without_a_request_is_a_no_op(pushes):
    row = pending_phase_row(approval_status="approved", approval_request_id=None, allocation=60)
    db = ApprovalFakeDB(context=[approval_context()], approvers=[PM])
    response = await approvals.submit_request(
        db,
        _http(),
        requester(),
        action=ACTION_UPDATE,
        level="phase",
        project_id=1,
        row=row,
        values={"allocation": 60},
    )
    assert response.status_code == 200
    db.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_of_own_pending_create_edits_it_in_place(pushes):
    request = approval_request()
    row = pending_phase_row()
    db = ApprovalFakeDB(request=[request], context=[approval_context()], approvers=[PM])

    response = await approvals.submit_request(
        db,
        _http(),
        requester(),
        action=ACTION_UPDATE,
        level="phase",
        project_id=1,
        row=row,
        values={"allocation": 40},
    )

    assert response.status_code == 202
    assert row.allocation == 40
    assert approvals.parse_values(request.requested) == {"allocation": 40}
    assert request.status == "pending"
    assert not db.added  # no second request


@pytest.mark.asyncio
async def test_removal_of_own_pending_create_cancels_it(pushes):
    request = approval_request()
    row = pending_phase_row()
    db = ApprovalFakeDB(request=[request], context=[approval_context()], approvers=[PM])

    response = await approvals.submit_request(
        db, _http(), requester(), action=ACTION_REMOVE, level="phase", project_id=1, row=row
    )

    assert response.status_code == 200
    assert b'"cancelled":true' in response.body
    assert request.status == "cancelled" and request.decided_by == REQ
    assert db.deleted == [row]
    assert not db.notifications  # approvers are not notified of a withdrawal


@pytest.mark.asyncio
async def test_pending_row_whose_request_is_gone_is_409(pushes):
    db = ApprovalFakeDB(request=[approval_request(status="approved")], context=[approval_context()])
    with pytest.raises(HTTPException) as exc:
        await approvals.submit_request(
            db,
            _http(),
            requester(),
            action=ACTION_UPDATE,
            level="phase",
            project_id=1,
            row=pending_phase_row(),
            values={"allocation": 40},
        )
    assert exc.value.status_code == 409


# ---------------------------------------------------------
# Approve: re-validation branches
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_approve_create_activates_the_pending_row():
    request, row = approval_request(), pending_phase_row()
    db = approvable_db(request, row)

    result = await approvals.approve(
        db, FakeUser(PM, "user"), 50, note="ok", visible=frozenset({1})
    )

    assert result.conflict is None
    assert request.status == "approved" and request.decided_by == PM
    assert request.decision_note == "ok" and request.decided_at is not None
    assert row.approval_status == "approved" and row.approval_request_id is None
    (note,) = db.notifications
    assert note.user_id == REQ and note.type == "approval_decided"
    assert note.title == "Your booking on Design was approved by Test User7"
    db.commit.assert_awaited_once()
    change = result.effects.assignment_changes[0]
    assert (change.assignment_id, change.action) == (70, "create")
    assert result.effects.events[0].recipients == frozenset({REQ, ADMIN, PM})
    # The PM is told an approval was applied -- here the PM approved, so the
    # delivery drops them as the actor.
    (intent,) = result.effects.change_intents
    assert (intent.recipient, intent.type, intent.user_id, intent.person_id) == (
        "pm",
        "project_changed",
        PM,
        REQ,
    )
    assert intent.title == "Test User7 approved {person}'s request on Design"
    assert intent.body == "at 80%"
    assert (intent.project_id, intent.entity_type, intent.entity_id) == (1, "phase", 11)


@pytest.mark.asyncio
async def test_approve_update_writes_the_requested_values():
    row = _project_row(approval_request_id=50)
    request = approval_request(
        action=ACTION_UPDATE,
        level="project",
        target_id=1,
        assignment_id=71,
        requested='{"allocation": 90, "end_date": "2026-02-27", "start_date": "2026-02-02"}',
        previous='{"allocation": 60, "end_date": "2026-01-30", "start_date": "2026-01-05"}',
    )
    db = approvable_db(request, row, context=[("Alpha", PM, 1, 1, "Alpha", None, None)])

    result = await approvals.approve(db, approval_admin(), 50, visible=None)

    assert result.conflict is None
    assert (row.allocation, row.start_date, row.end_date) == (
        90,
        date(2026, 2, 2),
        date(2026, 2, 27),
    )
    assert row.approval_request_id is None
    # An admin approved: the PM gets the change line.
    (intent,) = result.effects.change_intents
    assert intent.user_id == PM and intent.person_id == REQ
    assert intent.title == "Test User1 approved {person}'s request on Alpha"
    assert intent.body == (
        "allocation 60% → 90%, dates 2026-01-05–2026-01-30 → 2026-02-02–2026-02-27"
    )
    assert (intent.entity_type, intent.entity_id) == ("project", 1)


@pytest.mark.asyncio
async def test_approve_remove_deletes_the_row():
    row = pending_phase_row(approval_status="approved", allocation=60)
    request = approval_request(action=ACTION_REMOVE, requested=None, previous='{"allocation": 60}')
    db = approvable_db(request, row)

    result = await approvals.approve(db, approval_admin(), 50, visible=None)

    assert db.deleted == [row]
    assert result.effects.assignment_changes[0].action == "delete"
    assert [i.body for i in result.effects.change_intents] == ["removal"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("answers", "reason"),
    [
        ({"context": [approval_context(target=False)]}, "target_deleted"),
        ({"context": []}, "target_deleted"),
        ({"requester": []}, "requester_inactive"),
        ({"requester": [(0, "user", True)]}, "requester_inactive"),
        ({"requester": [(1, "user", False)]}, "permission_lost"),  # no longer bookable
        ({"perms": []}, "permission_lost"),  # role no longer holds the key
        ({"member": []}, "permission_lost"),  # requester lost the project's site
        ({"context": [approval_context(site_id=None)]}, "permission_lost"),
        ({"duplicate": [pending_phase_row(id=99, approval_status="approved")]}, "duplicate"),
        ({"row": []}, "overtaken"),
    ],
)
async def test_approve_create_expires_when_revalidation_fails(answers, reason):
    request, row = approval_request(), pending_phase_row()
    db = approvable_db(request, row, **answers)

    result = await approvals.approve(db, approval_admin(), 50, visible=None)

    assert request.status == "expired" and request.close_reason == reason
    assert request.decided_by is None
    assert result.conflict["status"] == "expired"
    assert result.conflict["close_reason"] == reason
    assert result.conflict["detail"].startswith("Request expired: ")
    assert row.approval_status == "pending"  # never activated
    (note,) = db.notifications
    assert note.user_id == REQ and note.title.startswith("Your booking on ")
    assert note.title.endswith(" expired")
    db.commit.assert_awaited_once()
    assert result.effects.change_intents == []  # nothing was applied


@pytest.mark.asyncio
async def test_expired_create_deletes_its_pending_row():
    request, row = approval_request(), pending_phase_row()
    db = approvable_db(request, row, requester=[(0, "user", True)])
    result = await approvals.approve(db, approval_admin(), 50, visible=None)
    assert db.deleted == [row]
    assert result.effects.assignment_changes[0].action == "delete"


@pytest.mark.asyncio
async def test_requester_with_all_sites_needs_no_membership():
    request, row = approval_request(), pending_phase_row()
    db = approvable_db(
        request,
        row,
        member=[],
        perms=[(ACTION_CREATE, "allow"), ("sites.view_all", "allow")],
    )
    result = await approvals.approve(db, approval_admin(), 50, visible=None)
    assert result.conflict is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "row",
    [
        None,
        pending_phase_row(approval_status="approved", approval_request_id=50, allocation=70),
        pending_phase_row(approval_status="approved", approval_request_id=51, allocation=60),
    ],
)
async def test_approve_update_expires_when_overtaken(row):
    request = approval_request(action=ACTION_UPDATE, previous='{"allocation": 60}')
    db = approvable_db(request, row)

    result = await approvals.approve(db, approval_admin(), 50, visible=None)

    assert request.status == "expired" and request.close_reason == "overtaken"
    assert result.conflict["close_reason"] == "overtaken"
    assert not db.deleted


@pytest.mark.asyncio
async def test_approve_with_invalid_stored_values_is_409_and_stays_pending():
    request, row = approval_request(requested='{"allocation": 0}'), pending_phase_row()
    db = approvable_db(request, row)
    with pytest.raises(HTTPException) as exc:
        await approvals.approve(db, approval_admin(), 50, visible=None)
    assert exc.value.status_code == 409 and exc.value.detail == INVALID_VALUES_DETAIL
    assert request.status == "pending"
    db.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_decision_on_a_closed_request_is_409_with_its_status():
    db = approvable_db(approval_request(status="approved"), pending_phase_row())
    with pytest.raises(RequestClosedError) as exc:
        await approvals.approve(db, approval_admin(), 50, visible=None)
    assert exc.value.body == {"detail": "Request already approved", "status": "approved"}

    with pytest.raises(RequestClosedError):
        await approvals.reject(db, approval_admin(), 50, visible=None)


@pytest.mark.asyncio
async def test_requester_can_never_decide_their_own_request_admins_included():
    db = approvable_db(approval_request(requester_id=ADMIN), pending_phase_row())
    with pytest.raises(HTTPException) as exc:
        await approvals.approve(db, approval_admin(), 50, visible=None)
    assert exc.value.status_code == 403 and exc.value.detail == OWN_REQUEST_DETAIL


@pytest.mark.asyncio
async def test_non_approver_cannot_decide():
    db = approvable_db(approval_request(), pending_phase_row())
    for user, visible in (
        (FakeUser(OTHER, "user"), frozenset({1})),  # not PM, no policy role
        (FakeUser(PM, "user"), frozenset({2})),  # the PM, but cannot see the site
    ):
        with pytest.raises(HTTPException) as exc:
            await approvals.reject(db, user, 50, visible=visible)
        assert exc.value.detail == NOT_DECIDER_DETAIL


@pytest.mark.asyncio
async def test_unknown_request_is_404():
    with pytest.raises(HTTPException) as exc:
        await approvals.approve(ApprovalFakeDB(), approval_admin(), 50, visible=None)
    assert exc.value.status_code == 404


# ---------------------------------------------------------
# Reject / cancel
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_reject_create_deletes_the_pending_row_and_tells_the_requester():
    request, row = approval_request(), pending_phase_row()
    db = approvable_db(request, row)

    result = await approvals.reject(db, FakeUser(PM, "user"), 50, note="Full", visible=None)

    assert request.status == "rejected" and request.decision_note == "Full"
    assert db.deleted == [row]
    (note,) = db.notifications
    assert note.title == "Your booking on Design was rejected by Test User7"
    assert note.body == "Full"
    assert result.effects.assignment_changes[0].action == "delete"
    assert result.effects.change_intents == []


@pytest.mark.asyncio
async def test_reject_update_only_clears_the_pointer():
    row = pending_phase_row(approval_status="approved", allocation=60)
    request = approval_request(action=ACTION_UPDATE, previous='{"allocation": 60}')
    db = approvable_db(request, row)

    await approvals.reject(db, approval_admin(), 50, visible=None)

    assert row.approval_request_id is None and row.allocation == 60
    assert not db.deleted


@pytest.mark.asyncio
async def test_requester_cancels_without_notifying_anyone():
    request, row = approval_request(), pending_phase_row()
    db = approvable_db(request, row)

    result = await approvals.cancel(db, requester(), 50)

    assert request.status == "cancelled" and request.decided_by == REQ
    assert db.deleted == [row]
    assert not db.notifications
    assert result.effects.events[0].recipients == frozenset({REQ, ADMIN, PM})
    assert result.effects.change_intents == []


@pytest.mark.asyncio
async def test_admin_cancel_tells_the_requester():
    request, row = (
        approval_request(action=ACTION_REMOVE),
        pending_phase_row(approval_status="approved"),
    )
    db = approvable_db(request, row)

    await approvals.cancel(db, approval_admin(), 50, note="cleanup")

    (note,) = db.notifications
    assert note.title == "Your removal from Design was cancelled by Test User1"
    assert row.approval_request_id is None


@pytest.mark.asyncio
async def test_others_cannot_cancel_and_closed_requests_stay_closed():
    db = approvable_db(approval_request(), pending_phase_row())
    with pytest.raises(HTTPException) as exc:
        await approvals.cancel(db, FakeUser(PM, "superuser"), 50)
    assert exc.value.detail == CANCEL_FORBIDDEN_DETAIL

    db = approvable_db(approval_request(status="rejected"), pending_phase_row())
    with pytest.raises(RequestClosedError):
        await approvals.cancel(db, requester(), 50)


# ---------------------------------------------------------
# Expiry hooks
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_editor_write_without_open_request_costs_no_query():
    db = ApprovalFakeDB()
    row = pending_phase_row(approval_status="approved", approval_request_id=None)
    effects = await approvals.expire_overtaken(db, approval_admin(), level="phase", row=row)
    assert not db.statements and not effects.events


@pytest.mark.asyncio
async def test_editor_write_overtakes_the_open_request():
    request = approval_request(action=ACTION_UPDATE, previous='{"allocation": 60}')
    row = pending_phase_row(approval_status="approved")
    db = ApprovalFakeDB(request=[request], context=[approval_context()], approvers=[ADMIN, PM])

    effects = await approvals.expire_overtaken(db, FakeUser(PM, "user"), level="phase", row=row)

    assert request.status == "expired" and request.close_reason == "overtaken"
    assert row.approval_request_id is None
    (note,) = effects.notifications
    assert note.user_id == REQ and note.body == "Overtaken by an edit from Test User7."
    assert db.notifications == effects.notifications  # staged, the caller commits
    db.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_requesters_own_direct_write_cancels_their_request():
    request = approval_request(action=ACTION_REMOVE)
    row = pending_phase_row(approval_status="approved")
    db = ApprovalFakeDB(request=[request], context=[approval_context()], approvers=[PM])

    effects = await approvals.expire_overtaken(db, FakeUser(REQ, "user"), level="phase", row=row)

    assert request.status == "cancelled" and not effects.notifications


@pytest.mark.asyncio
async def test_stale_pointer_is_cleared_quietly():
    row = pending_phase_row(approval_status="approved")
    db = ApprovalFakeDB(request=[approval_request(status="approved")])
    effects = await approvals.expire_overtaken(db, approval_admin(), level="phase", row=row)
    assert row.approval_request_id is None and not effects.events


@pytest.mark.asyncio
async def test_deleting_a_card_expires_its_requests():
    first = approval_request(id=50)
    second = approval_request(id=51, level="subphase", target_id=12, requester_id=OTHER)
    db = ApprovalFakeDB(
        request=[first, second], context=[("Alpha", PM, 1, 1, "Alpha", None, None)], approvers=[PM]
    )

    effects = await approvals.cancel_for_entity(
        db, approval_admin(), project_id=1, phase_ids=[11], subphase_ids=[12]
    )

    assert {first.status, second.status} == {"expired"}
    assert {first.close_reason, second.close_reason} == {"target_deleted"}
    assert sorted(n.user_id for n in effects.notifications) == [REQ, OTHER]
    assert effects.notifications[0].title == "Your booking on Alpha expired"
    assert len(db.updates) == 1
    assert db.queried("approvers") == 1  # once per action
    sql = str(db.statements[0].compile(compile_kwargs={"literal_binds": True}))
    assert "approval_requests.target_id IN (11)" in sql and "IN (12)" in sql


@pytest.mark.asyncio
async def test_deleting_a_project_notifies_nobody():
    request = approval_request()
    db = ApprovalFakeDB(
        request=[request], context=[("Alpha", PM, 1, 1, "Alpha", None, None)], approvers=[PM]
    )
    effects = await approvals.cancel_for_entity(
        db, approval_admin(), project_id=1, whole_project=True
    )
    assert not effects.notifications and effects.events[0].action == "delete"
    assert effects.events[0].recipients == frozenset({REQ, PM})


@pytest.mark.asyncio
async def test_nothing_to_expire_costs_at_most_one_query():
    db = ApprovalFakeDB()
    assert not (await approvals.cancel_for_entity(db, approval_admin(), project_id=1)).events
    assert not db.statements
    assert not (
        await approvals.cancel_for_entity(db, approval_admin(), project_id=1, phase_ids=[1])
    ).events
    assert len(db.statements) == 1


# ---------------------------------------------------------
# Serialisation and texts
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_project_approval_index_keys_by_level_and_row():
    pending = approval_request(previous=None)
    db = ApprovalFakeDB(request=[pending], policy=[])

    index = await approvals.project_approval_index(db, FakeUser(PM, "user"), project_id=1, pm_id=PM)

    assert index == {
        ("phase", 70): {
            "request_id": 50,
            "action": ACTION_CREATE,
            "requester_id": REQ,
            "requested": {"allocation": 80},
            "previous": None,
            "created_at": None,
            "can_decide": True,
        }
    }
    assert (
        await approvals.project_approval_index(
            ApprovalFakeDB(), approval_admin(), project_id=1, pm_id=None
        )
        == {}
    )


def test_texts():
    assert approvals.pending_change_text(None) == ""
    assert approvals.pending_change_text(approval_request()) == "awaiting approval"
    assert (
        approvals.pending_change_text(approval_request(action=ACTION_REMOVE)) == "removal requested"
    )
    update = approval_request(
        action=ACTION_UPDATE,
        requested='{"allocation": 80, "start_date": "2026-01-01", "end_date": "2026-01-09"}',
        previous='{"allocation": 80, "start_date": "2026-01-02", "end_date": "2026-01-09"}',
    )
    assert approvals.pending_change_text(update) == (
        "dates 2026-01-02–2026-01-09 → 2026-01-01–2026-01-09"
    )
    assert approvals.pending_change_text(approval_request(status="approved")) == ""
    assert approvals.describe_change(ACTION_UPDATE, {}, {}) == "no change"
    assert approvals.parse_values("not json") is None
    assert approvals.parse_values("[1]") is None
    assert approvals.display_name(MagicMock(first_name="", last_name="", email="a@b")) == "a@b"


@pytest.mark.asyncio
async def test_publish_broadcasts_then_pushes():
    effects = approvals.ApprovalEffects(
        notifications=[Notification(id=1, user_id=REQ, type="approval_decided", title="t")],
        events=[approvals.RequestEvent(50, 1, "approved", "update", "s", frozenset({REQ, PM}))],
        assignment_changes=[approvals.AssignmentChange(70, 1, "create", "s")],
    )
    with (
        patch.object(approvals, "broadcast_change", AsyncMock()) as broadcast,
        patch.object(approvals, "send_notification", AsyncMock()) as notify,
        patch.object(approvals, "send_user_event", AsyncMock()) as event,
    ):
        await approvals.publish(_http(), approval_admin(), effects)

    assert [c.kwargs["entity_type"] for c in broadcast.await_args_list] == [
        "staff_assignment",
        "approval_request",
    ]
    notify.assert_awaited_once()
    assert [c.args[1] for c in event.await_args_list] == [REQ, PM]
    assert event.await_args.args[3] == {"id": 50, "status": "approved", "project_id": 1}


# ---------------------------------------------------------
# Small branches
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_submit_create_at_subphase_level(pushes):
    db = ApprovalFakeDB(context=[approval_context(name="Sub")], approvers=[ADMIN])
    response = await approvals.submit_request(
        db,
        _http(),
        requester(),
        action=ACTION_CREATE,
        level="subphase",
        project_id=1,
        target_id=12,
        values={"allocation": 30},
    )
    assert response.status_code == 202
    row = db.added[1]
    assert isinstance(row, SubphaseStaffAssignment) and row.subphase_id == 12
    assert approvals.row_target_id(row, "subphase") == 12
    assert approvals.assignment_model("subphase") is SubphaseStaffAssignment


@pytest.mark.parametrize(
    ("level", "values", "valid"),
    [
        ("phase", None, False),
        ("phase", {"allocation": 101}, False),
        ("phase", {"allocation": "50"}, False),
        ("project", {"allocation": 50, "start_date": "nope", "end_date": "2026-01-01"}, False),
        ("project", {"allocation": 50}, False),
        (
            "project",
            {"allocation": 50, "start_date": "2026-01-02", "end_date": "2026-01-01"},
            False,
        ),
        ("project", {"allocation": 50, "start_date": "2026-01-01", "end_date": "2026-01-01"}, True),
    ],
)
def test_values_validation(level, values, valid):
    assert approvals._values_valid(level, values) is valid


@pytest.mark.asyncio
async def test_helpers_skip_queries_when_there_is_nothing_to_do():
    db = ApprovalFakeDB()
    await approvals._mark_requests_read(db, [])
    assert await approvals._load_row(db, "phase", None) is None
    assert not db.statements
    # A create request whose row is no longer pending keeps it.
    approved = pending_phase_row(approval_status="approved")
    assert await approvals._release(db, approval_request(), approved) is None
    assert await approvals._release(db, approval_request(), None) is None
    # A change request that no longer owns the row leaves it alone.
    other = pending_phase_row(approval_status="approved", approval_request_id=99)
    assert await approvals._release(db, approval_request(action=ACTION_UPDATE), other) is None
    assert approvals.describe_change(ACTION_REMOVE, None, None) == "removal"


@pytest.mark.asyncio
async def test_amending_a_pending_create_needs_values(pushes):
    db = ApprovalFakeDB(request=[approval_request()], context=[approval_context()], approvers=[PM])
    with pytest.raises(ValueError):
        await approvals.submit_request(
            db,
            _http(),
            requester(),
            action=ACTION_UPDATE,
            level="phase",
            project_id=1,
            row=pending_phase_row(),
        )


@pytest.mark.asyncio
async def test_send_user_event_pushes_to_one_user():
    from app.websocket import broadcast

    http = MagicMock()
    http.scope = {"state": {"tenant_slug": "acme"}}
    with patch.object(broadcast.manager, "send_to_user", AsyncMock(return_value=1)) as send:
        await broadcast.send_user_event(http, 7, "approval:changed", {"id": 50})

    tenant, user_id, message = send.await_args.args
    assert (tenant, user_id) == ("acme", 7)
    assert message["type"] == "approval:changed" and message["payload"] == {"id": 50}
    assert message["timestamp"].endswith("Z")


# ---------------------------------------------------------
# Unlinked segments (1.17.0): card-level dates in requests
# ---------------------------------------------------------

SEG_START, SEG_END = date(2026, 3, 3), date(2026, 3, 5)
SEG_JSON = {"start_date": "2026-03-03", "end_date": "2026-03-05"}


def _card_context(start=date(2026, 3, 2), end=date(2026, 3, 13)) -> approvals.RequestContext:
    return approvals.RequestContext(
        project_name="Alpha",
        pm_id=PM,
        site_id=1,
        target_exists=True,
        target_name="Design",
        target_start=start,
        target_end=end,
    )


def _dumped(values: dict) -> str:
    return approvals._dump(values) or ""


def _duplicate_params(db: ApprovalFakeDB) -> list[dict]:
    """The bound parameters of every find_duplicate query the fake answered."""
    return [
        s.compile().params
        for s in db.statements
        if getattr(s, "is_select", False) and db.key(s) == "duplicate"
    ]


@pytest.mark.parametrize("level", ["phase", "subphase"])
@pytest.mark.parametrize(
    ("values", "valid"),
    [
        ({"allocation": 50}, True),  # linked (or dates unchanged)
        ({"allocation": 50, **SEG_JSON}, True),  # within the card
        ({"allocation": 50, "start_date": "2026-03-02", "end_date": "2026-03-13"}, True),  # edges
        ({"allocation": 50, "start_date": None, "end_date": None}, True),  # a relink
        ({"allocation": 50, "start_date": "2026-03-01", "end_date": "2026-03-05"}, False),
        ({"allocation": 50, "start_date": "2026-03-10", "end_date": "2026-03-14"}, False),
        ({"allocation": 50, "start_date": "2026-03-05", "end_date": "2026-03-03"}, False),
        ({"allocation": 50, "start_date": "2026-03-03", "end_date": None}, False),
        ({"allocation": 50, "start_date": "2026-03-03"}, False),
        ({"allocation": 50, "start_date": "nope", "end_date": "2026-03-05"}, False),
        ({"allocation": 0, **SEG_JSON}, False),
    ],
)
def test_segment_values_validation(level, values, valid):
    assert approvals._values_valid(level, values, _card_context()) is valid


def test_segment_values_without_a_context_check_only_the_order():
    assert approvals._values_valid("phase", {"allocation": 50, **SEG_JSON}) is True
    # A card whose dates are unknown cannot hold the segment.
    unknown = _card_context(start=None, end=None)
    assert approvals._values_valid("phase", {"allocation": 50, **SEG_JSON}, unknown) is False


@pytest.mark.asyncio
@pytest.mark.parametrize("level", ["phase", "subphase"])
async def test_context_carries_the_targets_dates(level):
    db = ApprovalFakeDB(context=[approval_context()])
    context = await approvals.load_context(db, project_id=1, level=level, target_id=11)
    assert (context.target_start, context.target_end) == (date(2026, 3, 2), date(2026, 3, 13))
    (stmt,) = db.statements
    table = "project_phases" if level == "phase" else "project_subphases"
    assert f"{table}.start_date" in str(stmt.compile())


def test_write_values_sets_clears_or_keeps_segment_dates():
    row = pending_phase_row(start_date=SEG_START, end_date=SEG_END)
    approvals._write_values(row, "phase", {"allocation": 40})
    assert (row.allocation, row.start_date, row.end_date) == (40, SEG_START, SEG_END)
    approvals._write_values(
        row, "phase", {"allocation": 40, "start_date": "2026-03-09", "end_date": "2026-03-11"}
    )
    assert (row.start_date, row.end_date) == (date(2026, 3, 9), date(2026, 3, 11))
    approvals._write_values(row, "phase", {"allocation": 40, "start_date": None, "end_date": None})
    assert (row.start_date, row.end_date) == (None, None)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("level", "model"), [("phase", PhaseStaffAssignment), ("subphase", SubphaseStaffAssignment)]
)
async def test_submit_create_of_a_segment_files_a_dated_pending_row(pushes, level, model):
    db = ApprovalFakeDB(context=[approval_context()], approvers=[ADMIN])

    await approvals.submit_request(
        db,
        _http(),
        requester(),
        action=ACTION_CREATE,
        level=level,
        project_id=1,
        target_id=11,
        values=approvals.booking_dict(50, SEG_START, SEG_END),
    )

    row = db.added[1]
    assert isinstance(row, model) and row.approval_status == "pending"
    assert (row.start_date, row.end_date) == (SEG_START, SEG_END)
    assert (
        db.notifications[0].title
        == "Test User3 asks to join Design at 50% from 2026-03-03 to 2026-03-05"
    )


@pytest.mark.asyncio
async def test_amending_a_pending_segment_to_follow_the_card_clears_its_dates(pushes):
    request = approval_request(requested=_dumped({"allocation": 80, **SEG_JSON}))
    row = pending_phase_row(start_date=SEG_START, end_date=SEG_END)
    db = ApprovalFakeDB(request=[request], context=[approval_context()], approvers=[PM])

    await approvals.submit_request(
        db,
        _http(),
        requester(),
        action=ACTION_UPDATE,
        level="phase",
        project_id=1,
        row=row,
        values=approvals.booking_dict(80, clear_dates=True),
    )

    assert (row.start_date, row.end_date) == (None, None)
    assert approvals.parse_values(request.requested) == {
        "allocation": 80,
        "start_date": None,
        "end_date": None,
    }


@pytest.mark.asyncio
async def test_approve_segment_create_checks_overlap_with_the_rows_own_dates():
    request = approval_request(requested=_dumped({"allocation": 80, **SEG_JSON}))
    row = pending_phase_row(start_date=SEG_START, end_date=SEG_END)
    db = approvable_db(request, row)

    result = await approvals.approve(db, approval_admin(), 50, visible=None)

    assert result.conflict is None
    assert row.approval_status == "approved"
    assert (row.start_date, row.end_date) == (SEG_START, SEG_END)
    (params,) = _duplicate_params(db)
    assert SEG_START in params.values() and SEG_END in params.values()
    assert 70 in params.values()  # the row itself is excluded
    assert [i.body for i in result.effects.change_intents] == [
        "at 80% from 2026-03-03 to 2026-03-05"
    ]


@pytest.mark.asyncio
async def test_approve_segment_create_expires_on_an_overlapping_approved_segment():
    request = approval_request(requested=_dumped({"allocation": 80, **SEG_JSON}))
    row = pending_phase_row(start_date=SEG_START, end_date=SEG_END)
    other = pending_phase_row(
        id=99, approval_status="approved", start_date=SEG_END, end_date=SEG_END
    )
    db = approvable_db(request, row, duplicate=[other])

    result = await approvals.approve(db, approval_admin(), 50, visible=None)

    assert request.status == "expired" and request.close_reason == "duplicate"
    assert result.conflict["close_reason"] == "duplicate"
    assert db.deleted == [row]


@pytest.mark.asyncio
async def test_approve_linked_create_checks_overlap_with_the_whole_card():
    request, row = approval_request(), pending_phase_row()
    db = approvable_db(request, row)

    await approvals.approve(db, approval_admin(), 50, visible=None)

    (params,) = _duplicate_params(db)
    # No own dates: the overlap is taken against the card's own columns.
    assert not any(isinstance(value, date) for value in params.values())


def _segment_update(requested: dict, previous: dict | None = None) -> ApprovalRequest:
    return approval_request(
        action=ACTION_UPDATE,
        requested=_dumped(requested),
        previous=_dumped(previous or {"allocation": 60, **SEG_JSON}),
    )


def _approved_segment(**fields) -> PhaseStaffAssignment:
    values = {
        "approval_status": "approved",
        "approval_request_id": 50,
        "allocation": 60,
        "start_date": SEG_START,
        "end_date": SEG_END,
        **fields,
    }
    return pending_phase_row(**values)


@pytest.mark.asyncio
async def test_approve_update_moves_a_segment():
    row = _approved_segment()
    moved = {"allocation": 60, "start_date": "2026-03-09", "end_date": "2026-03-11"}
    db = approvable_db(_segment_update(moved), row)

    result = await approvals.approve(db, approval_admin(), 50, visible=None)

    assert result.conflict is None
    assert (row.start_date, row.end_date) == (date(2026, 3, 9), date(2026, 3, 11))
    assert row.approval_request_id is None
    (params,) = _duplicate_params(db)  # new dates: checked against the person's other rows
    assert date(2026, 3, 9) in params.values()
    (intent,) = result.effects.change_intents
    assert intent.body == "dates 2026-03-03–2026-03-05 → 2026-03-09–2026-03-11"


@pytest.mark.asyncio
async def test_approve_update_relinks_a_segment():
    row = _approved_segment()
    relink = {"allocation": 60, "start_date": None, "end_date": None}
    db = approvable_db(_segment_update(relink), row)

    result = await approvals.approve(db, approval_admin(), 50, visible=None)

    assert result.conflict is None
    assert (row.start_date, row.end_date) == (None, None)
    (intent,) = result.effects.change_intents
    assert intent.body == "follows the phase dates again"


@pytest.mark.asyncio
async def test_approve_update_with_new_dates_expires_on_an_overlapping_segment():
    row = _approved_segment()
    moved = {"allocation": 60, "start_date": "2026-03-09", "end_date": "2026-03-11"}
    other = pending_phase_row(id=99, approval_status="approved")
    db = approvable_db(_segment_update(moved), row, duplicate=[other])

    result = await approvals.approve(db, approval_admin(), 50, visible=None)

    assert result.conflict["close_reason"] == "duplicate"
    assert (row.start_date, row.end_date) == (SEG_START, SEG_END)  # untouched
    assert row.approval_request_id is None
    assert not db.deleted


@pytest.mark.asyncio
async def test_approve_allocation_only_update_does_not_look_for_overlaps():
    row = _approved_segment()
    db = approvable_db(_segment_update({"allocation": 80, **SEG_JSON}), row)

    result = await approvals.approve(db, approval_admin(), 50, visible=None)

    assert result.conflict is None and row.allocation == 80
    assert (row.start_date, row.end_date) == (SEG_START, SEG_END)
    assert db.queried("duplicate") == 0


@pytest.mark.asyncio
async def test_approve_update_with_malformed_dates_is_invalid_values():
    row = _approved_segment()
    db = approvable_db(
        _segment_update({"allocation": 60, "start_date": "nope", "end_date": "2026-03-11"}), row
    )
    with pytest.raises(HTTPException) as exc:
        await approvals.approve(db, approval_admin(), 50, visible=None)
    assert exc.value.detail == INVALID_VALUES_DETAIL
    assert db.queried("duplicate") == 0


@pytest.mark.asyncio
async def test_approve_update_outside_the_card_is_invalid_values():
    row = _approved_segment()
    outside = {"allocation": 60, "start_date": "2026-03-12", "end_date": "2026-03-16"}
    db = approvable_db(_segment_update(outside), row)

    with pytest.raises(HTTPException) as exc:
        await approvals.approve(db, approval_admin(), 50, visible=None)

    assert exc.value.status_code == 409 and exc.value.detail == INVALID_VALUES_DETAIL
    assert (row.start_date, row.end_date) == (SEG_START, SEG_END)
    db.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_approve_update_is_overtaken_by_a_date_change():
    # The segment moved since the request was filed: its previous dates are stale.
    row = _approved_segment(start_date=date(2026, 3, 4), end_date=date(2026, 3, 6))
    db = approvable_db(_segment_update({"allocation": 80, **SEG_JSON}), row)

    result = await approvals.approve(db, approval_admin(), 50, visible=None)

    assert result.conflict["close_reason"] == "overtaken"
    assert row.allocation == 60


def test_relink_wording_in_titles_and_the_export():
    update = approval_request(
        action=ACTION_UPDATE,
        level="subphase",
        requested=_dumped({"allocation": 60, "start_date": None, "end_date": None}),
        previous=_dumped({"allocation": 60, **SEG_JSON}),
    )
    assert approvals.pending_change_text(update) == "follows the subphase dates again"
    assert approvals._request_title("Ann", update, "Sub") == (
        "Ann asks to change their booking on Sub: follows the subphase dates again"
    )
