"""
The approval workflow service (app/services/approvals.py).

Mock-only like the rest of the suite, but through a small statement-dispatching
fake session (``FakeDB``): each query is answered by what it selects (the
request, the project context, the policy, the approvers, the requester, the
assignment row, a duplicate, ...), so the tests pin the state machine rather
than the query order.
"""

from datetime import date
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy.sql.dml import Update

from app.models.assignment import (
    PhaseStaffAssignment,
    ProjectAssignment,
    SubphaseStaffAssignment,
)
from app.models.notification import Notification
from app.models.project import Project
from app.models.rbac import ApprovalPolicy, ApprovalRequest, Role, RolePermission
from app.models.user import User, UserSite
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

ADMIN = 1
REQ = 3
PM = 7
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


def admin(user_id: int = ADMIN) -> FakeUser:
    return FakeUser(user_id, "admin")


# ---------------------------------------------------------
# Fake session
# ---------------------------------------------------------


def _result(values: list) -> MagicMock:
    result = MagicMock()
    result.scalar_one_or_none.return_value = values[0] if values else None
    result.scalars.return_value.all.return_value = list(values)
    result.first.return_value = values[0] if values else None
    result.all.return_value = list(values)
    return result


_ASSIGNMENT_MODELS = (ProjectAssignment, PhaseStaffAssignment, SubphaseStaffAssignment)


class FakeDB:
    """Answers each SELECT by what it selects; records writes."""

    def __init__(self, **answers):
        self.answers: dict[str, list] = {key: list(value) for key, value in answers.items()}
        self.added: list = []
        self.deleted: list = []
        self.updates: list = []
        self.statements: list = []
        self.commit = AsyncMock()
        self._next_id = 100

    def add(self, obj) -> None:
        self.added.append(obj)

    def add_all(self, objs) -> None:
        self.added.extend(objs)

    async def delete(self, obj) -> None:
        self.deleted.append(obj)

    async def flush(self) -> None:
        for obj in self.added:
            if getattr(obj, "id", None) is None:
                obj.id = self._next_id
                self._next_id += 1

    @staticmethod
    def key(stmt) -> str:
        first = stmt.column_descriptions[0]
        entity, name = first.get("entity"), first.get("name")
        if entity is ApprovalRequest:
            return "request"
        if entity is Project:
            return "context"
        if entity is ApprovalPolicy:
            return "policy"
        if entity is User:
            return "approvers" if name == "id" else "requester"
        if entity is UserSite:
            return "member"
        if entity is RolePermission:
            return "perms"
        if entity in _ASSIGNMENT_MODELS:
            return "row" if stmt._for_update_arg is not None else "duplicate"
        raise AssertionError(f"unexpected query: {stmt}")

    async def execute(self, stmt):
        self.statements.append(stmt)
        if isinstance(stmt, Update):
            self.updates.append(stmt)
            return MagicMock()
        return _result(self.answers.get(self.key(stmt), []))

    def queried(self, key: str) -> int:
        return sum(1 for s in self.statements if not isinstance(s, Update) and self.key(s) == key)

    @property
    def notifications(self) -> list[Notification]:
        return [obj for obj in self.added if isinstance(obj, Notification)]


@pytest.fixture
def pushes():
    """The broadcasts and per-user pushes publish() sends."""
    with (
        patch.object(approvals, "broadcast_change", AsyncMock()) as broadcast,
        patch.object(approvals, "send_notification", AsyncMock()) as notify,
        patch.object(approvals, "send_user_event", AsyncMock()) as event,
    ):
        yield MagicMock(broadcast=broadcast, notify=notify, event=event)


def _context(*, pm_id=PM, site_id=1, target=True, name="Design"):
    return ("Alpha", pm_id, site_id, 11 if target else None, name if target else None)


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
    }
    values.update(fields)
    return ApprovalRequest(**values)


def _phase_row(**fields) -> PhaseStaffAssignment:
    values = {
        "id": 70,
        "project_id": 1,
        "phase_id": 11,
        "staff_id": REQ,
        "allocation": 80,
        "approval_status": "pending",
        "approval_request_id": 50,
    }
    values.update(fields)
    return PhaseStaffAssignment(**values)


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
    db = FakeDB(context=[_context(pm_id=None)])
    db.execute = AsyncMock(return_value=_result([(None,)]))  # pm_id lookup
    row = _phase_row(staff_id=staff_id, approval_status="approved", approval_request_id=None)

    outcome = await approvals.resolve_row_write(db, user, row=row, action=ACTION_UPDATE)

    assert outcome == expected


@pytest.mark.asyncio
async def test_resolve_row_write_denies_own_row_without_the_key():
    db = MagicMock()
    db.execute = AsyncMock(return_value=_result([(None,)]))
    user = FakeUser(REQ, "user", {"views.kanban": "allow"})
    row = _phase_row(approval_status="approved", approval_request_id=None)

    with pytest.raises(HTTPException) as exc:
        await approvals.resolve_row_write(db, user, row=row, action=ACTION_UPDATE)

    assert exc.value.status_code == 403
    assert exc.value.detail == SELF_BOOKING_DENIED_DETAIL


@pytest.mark.asyncio
async def test_resolve_row_write_others_row_without_editor_rights_is_403():
    db = MagicMock()
    db.execute = AsyncMock(return_value=_result([(None,)]))
    row = _phase_row(staff_id=OTHER, approval_status="approved", approval_request_id=None)

    with pytest.raises(HTTPException) as exc:
        await approvals.resolve_row_write(db, requester(), row=row, action=ACTION_REMOVE)

    assert exc.value.detail == OWN_ASSIGNMENT_DETAIL


@pytest.mark.asyncio
async def test_pending_create_goes_back_through_its_requester():
    db = MagicMock()
    # Even with allow mode or editor rights, the requester amends the request.
    for user in (requester(), FakeUser(REQ, "superuser")):
        outcome = await approvals.resolve_row_write(
            db, user, row=_phase_row(), action=ACTION_UPDATE
        )
        assert outcome == "approval"


@pytest.mark.asyncio
async def test_editor_write_on_pending_create_is_409():
    db = MagicMock()
    with pytest.raises(HTTPException) as exc:
        await approvals.resolve_row_write(
            db, FakeUser(5, "superuser"), row=_phase_row(), action=ACTION_REMOVE
        )
    assert exc.value.status_code == 409
    assert exc.value.detail == AWAITS_APPROVAL_DETAIL


@pytest.mark.asyncio
async def test_non_editor_write_on_someone_elses_pending_create_is_403_not_409():
    db = MagicMock()
    db.execute = AsyncMock(return_value=_result([(None,)]))
    with pytest.raises(HTTPException) as exc:
        await approvals.resolve_row_write(
            db, requester(OTHER), row=_phase_row(), action=ACTION_UPDATE
        )
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_precomputed_outcome_is_reused_without_a_query():
    db = MagicMock()
    db.execute = AsyncMock()
    row = _phase_row(staff_id=OTHER, approval_status="approved", approval_request_id=None)
    assert (
        await approvals.resolve_row_write(
            db, FakeUser(5, "superuser"), row=row, action=ACTION_REMOVE, outcome="allow"
        )
        == "allow"
    )
    with pytest.raises(HTTPException) as exc:
        await approvals.resolve_row_write(
            db, FakeUser(5, "superuser"), row=_phase_row(), action=ACTION_REMOVE, outcome="allow"
        )
    assert exc.value.status_code == 409
    db.execute.assert_not_awaited()


# ---------------------------------------------------------
# can_decide and approver resolution
# ---------------------------------------------------------


@pytest.mark.parametrize(
    ("user", "policy", "pm_id", "expected"),
    [
        (admin(), Policy(pm_approves=False), None, True),  # admins always
        (admin(REQ), Policy(), PM, False),  # ... but never their own request
        (FakeUser(PM, "user"), Policy(), PM, True),  # the PM
        (FakeUser(PM, "user"), Policy(pm_approves=False), PM, False),
        (FakeUser(LEAD, "lead"), Policy(role_keys=frozenset({"lead"})), None, True),
        (FakeUser(LEAD, "lead"), Policy(), PM, False),
        (FakeUser(REQ, "lead"), Policy(role_keys=frozenset({"lead"})), REQ, False),  # requester
    ],
)
def test_can_decide(user, policy, pm_id, expected):
    assert approvals.can_decide(user, _request(), policy, pm_id) is expected


def _compiled_where(db: FakeDB) -> str:
    (stmt,) = (s for s in db.statements if FakeDB.key(s) == "approvers")
    return str(stmt.compile(compile_kwargs={"literal_binds": True}))


@pytest.mark.asyncio
async def test_approvers_are_admins_pm_and_policy_roles_at_the_site_minus_the_requester():
    db = FakeDB(approvers=[ADMIN, PM, LEAD])
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
    db = FakeDB(approvers=[ADMIN])
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
    db = FakeDB(policy=[stored])

    assert await approvals.load_policy(db, ACTION_CREATE) == Policy(False, frozenset({"lead"}))
    assert await approvals.load_policies(db) == {ACTION_CREATE: Policy(False, frozenset({"lead"}))}
    assert await approvals.load_policy(FakeDB(), ACTION_UPDATE) == Policy()


@pytest.mark.asyncio
async def test_context_reports_missing_project_and_target():
    assert await approvals.load_context(FakeDB(), project_id=1, level="phase", target_id=11) is None
    db = FakeDB(context=[_context(target=False)])
    context = await approvals.load_context(db, project_id=1, level="subphase", target_id=11)
    assert context is not None
    assert context.target_exists is False
    assert context.target_name == "Alpha"
    db = FakeDB(context=[("Alpha", PM, 1, 1, "Alpha")])
    context = await approvals.load_context(db, project_id=1, level="project", target_id=1)
    assert context.target_exists and context.pm_id == PM and context.site_id == 1


# ---------------------------------------------------------
# Duplicates
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_duplicate_create_is_409_and_a_pending_one_says_so():
    with pytest.raises(HTTPException) as exc:
        await approvals.ensure_no_duplicate(FakeDB(duplicate=[_phase_row()]), "phase", 11, REQ)
    assert exc.value.status_code == 409
    assert exc.value.detail == ALREADY_PENDING_DETAIL

    with pytest.raises(HTTPException) as exc:
        await approvals.ensure_no_duplicate(
            FakeDB(duplicate=[_phase_row(approval_status="approved")]),
            "phase",
            11,
            REQ,
            detail="taken",
        )
    assert exc.value.detail == "taken"

    await approvals.ensure_no_duplicate(FakeDB(), "subphase", 12, REQ)


@pytest.mark.asyncio
async def test_project_level_duplicate_means_same_dates():
    db = FakeDB()
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
    db = FakeDB(context=[_context()], approvers=[ADMIN, PM])
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
    db = FakeDB(context=[("Alpha", PM, 1, 1, "Alpha")], approvers=[ADMIN])
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
            FakeDB(),
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
            FakeDB(), _http(), requester(), action=ACTION_CREATE, level="phase", project_id=1
        )


@pytest.mark.asyncio
async def test_submit_update_stores_requested_and_previous_and_keeps_the_row(pushes):
    row = _project_row()
    db = FakeDB(context=[("Alpha", PM, 1, 1, "Alpha")], approvers=[PM])
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
    old = _request(id=40, action=ACTION_UPDATE, level="phase", assignment_id=70)
    row = _phase_row(approval_status="approved", approval_request_id=40, allocation=60)
    db = FakeDB(request=[old], context=[_context()], approvers=[PM])

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
    old = _request(id=40, action=ACTION_UPDATE)
    row = _phase_row(approval_status="approved", approval_request_id=40, allocation=60)
    db = FakeDB(request=[old], context=[_context()], approvers=[PM])

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
    row = _phase_row(approval_status="approved", approval_request_id=None, allocation=60)
    db = FakeDB(context=[_context()], approvers=[PM])
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
    request = _request()
    row = _phase_row()
    db = FakeDB(request=[request], context=[_context()], approvers=[PM])

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
    request = _request()
    row = _phase_row()
    db = FakeDB(request=[request], context=[_context()], approvers=[PM])

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
    db = FakeDB(request=[_request(status="approved")], context=[_context()])
    with pytest.raises(HTTPException) as exc:
        await approvals.submit_request(
            db,
            _http(),
            requester(),
            action=ACTION_UPDATE,
            level="phase",
            project_id=1,
            row=_phase_row(),
            values={"allocation": 40},
        )
    assert exc.value.status_code == 409


# ---------------------------------------------------------
# Approve: re-validation branches
# ---------------------------------------------------------


def _approvable_db(pending, assignment, /, **extra):
    answers = {
        "request": [pending],
        "context": [_context()],
        "requester": [(1, "user")],
        "perms": [(pending.action, "approval")],
        "member": [(REQ,)],
        "row": [assignment] if assignment is not None else [],
        "approvers": [ADMIN, PM],
    }
    answers.update(extra)
    return FakeDB(**answers)


@pytest.mark.asyncio
async def test_approve_create_activates_the_pending_row():
    request, row = _request(), _phase_row()
    db = _approvable_db(request, row)

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


@pytest.mark.asyncio
async def test_approve_update_writes_the_requested_values():
    row = _project_row(approval_request_id=50)
    request = _request(
        action=ACTION_UPDATE,
        level="project",
        target_id=1,
        assignment_id=71,
        requested='{"allocation": 90, "end_date": "2026-02-27", "start_date": "2026-02-02"}',
        previous='{"allocation": 60, "end_date": "2026-01-30", "start_date": "2026-01-05"}',
    )
    db = _approvable_db(request, row, context=[("Alpha", PM, 1, 1, "Alpha")])

    result = await approvals.approve(db, admin(), 50, visible=None)

    assert result.conflict is None
    assert (row.allocation, row.start_date, row.end_date) == (
        90,
        date(2026, 2, 2),
        date(2026, 2, 27),
    )
    assert row.approval_request_id is None


@pytest.mark.asyncio
async def test_approve_remove_deletes_the_row():
    row = _phase_row(approval_status="approved", allocation=60)
    request = _request(action=ACTION_REMOVE, requested=None, previous='{"allocation": 60}')
    db = _approvable_db(request, row)

    result = await approvals.approve(db, admin(), 50, visible=None)

    assert db.deleted == [row]
    assert result.effects.assignment_changes[0].action == "delete"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("answers", "reason"),
    [
        ({"context": [_context(target=False)]}, "target_deleted"),
        ({"context": []}, "target_deleted"),
        ({"requester": []}, "requester_inactive"),
        ({"requester": [(0, "user")]}, "requester_inactive"),
        ({"perms": []}, "permission_lost"),  # role no longer holds the key
        ({"member": []}, "permission_lost"),  # requester lost the project's site
        ({"context": [_context(site_id=None)]}, "permission_lost"),
        ({"duplicate": [_phase_row(id=99, approval_status="approved")]}, "duplicate"),
        ({"row": []}, "overtaken"),
    ],
)
async def test_approve_create_expires_when_revalidation_fails(answers, reason):
    request, row = _request(), _phase_row()
    db = _approvable_db(request, row, **answers)

    result = await approvals.approve(db, admin(), 50, visible=None)

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


@pytest.mark.asyncio
async def test_expired_create_deletes_its_pending_row():
    request, row = _request(), _phase_row()
    db = _approvable_db(request, row, requester=[(0, "user")])
    result = await approvals.approve(db, admin(), 50, visible=None)
    assert db.deleted == [row]
    assert result.effects.assignment_changes[0].action == "delete"


@pytest.mark.asyncio
async def test_requester_with_all_sites_needs_no_membership():
    request, row = _request(), _phase_row()
    db = _approvable_db(
        request,
        row,
        member=[],
        perms=[(ACTION_CREATE, "allow"), ("sites.view_all", "allow")],
    )
    result = await approvals.approve(db, admin(), 50, visible=None)
    assert result.conflict is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "row",
    [
        None,
        _phase_row(approval_status="approved", approval_request_id=50, allocation=70),
        _phase_row(approval_status="approved", approval_request_id=51, allocation=60),
    ],
)
async def test_approve_update_expires_when_overtaken(row):
    request = _request(action=ACTION_UPDATE, previous='{"allocation": 60}')
    db = _approvable_db(request, row)

    result = await approvals.approve(db, admin(), 50, visible=None)

    assert request.status == "expired" and request.close_reason == "overtaken"
    assert result.conflict["close_reason"] == "overtaken"
    assert not db.deleted


@pytest.mark.asyncio
async def test_approve_with_invalid_stored_values_is_409_and_stays_pending():
    request, row = _request(requested='{"allocation": 0}'), _phase_row()
    db = _approvable_db(request, row)
    with pytest.raises(HTTPException) as exc:
        await approvals.approve(db, admin(), 50, visible=None)
    assert exc.value.status_code == 409 and exc.value.detail == INVALID_VALUES_DETAIL
    assert request.status == "pending"
    db.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_decision_on_a_closed_request_is_409_with_its_status():
    db = _approvable_db(_request(status="approved"), _phase_row())
    with pytest.raises(RequestClosedError) as exc:
        await approvals.approve(db, admin(), 50, visible=None)
    assert exc.value.body == {"detail": "Request already approved", "status": "approved"}

    with pytest.raises(RequestClosedError):
        await approvals.reject(db, admin(), 50, visible=None)


@pytest.mark.asyncio
async def test_requester_can_never_decide_their_own_request_admins_included():
    db = _approvable_db(_request(requester_id=ADMIN), _phase_row())
    with pytest.raises(HTTPException) as exc:
        await approvals.approve(db, admin(), 50, visible=None)
    assert exc.value.status_code == 403 and exc.value.detail == OWN_REQUEST_DETAIL


@pytest.mark.asyncio
async def test_non_approver_cannot_decide():
    db = _approvable_db(_request(), _phase_row())
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
        await approvals.approve(FakeDB(), admin(), 50, visible=None)
    assert exc.value.status_code == 404


# ---------------------------------------------------------
# Reject / cancel
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_reject_create_deletes_the_pending_row_and_tells_the_requester():
    request, row = _request(), _phase_row()
    db = _approvable_db(request, row)

    result = await approvals.reject(db, FakeUser(PM, "user"), 50, note="Full", visible=None)

    assert request.status == "rejected" and request.decision_note == "Full"
    assert db.deleted == [row]
    (note,) = db.notifications
    assert note.title == "Your booking on Design was rejected by Test User7"
    assert note.body == "Full"
    assert result.effects.assignment_changes[0].action == "delete"


@pytest.mark.asyncio
async def test_reject_update_only_clears_the_pointer():
    row = _phase_row(approval_status="approved", allocation=60)
    request = _request(action=ACTION_UPDATE, previous='{"allocation": 60}')
    db = _approvable_db(request, row)

    await approvals.reject(db, admin(), 50, visible=None)

    assert row.approval_request_id is None and row.allocation == 60
    assert not db.deleted


@pytest.mark.asyncio
async def test_requester_cancels_without_notifying_anyone():
    request, row = _request(), _phase_row()
    db = _approvable_db(request, row)

    result = await approvals.cancel(db, requester(), 50)

    assert request.status == "cancelled" and request.decided_by == REQ
    assert db.deleted == [row]
    assert not db.notifications
    assert result.effects.events[0].recipients == frozenset({REQ, ADMIN, PM})


@pytest.mark.asyncio
async def test_admin_cancel_tells_the_requester():
    request, row = _request(action=ACTION_REMOVE), _phase_row(approval_status="approved")
    db = _approvable_db(request, row)

    await approvals.cancel(db, admin(), 50, note="cleanup")

    (note,) = db.notifications
    assert note.title == "Your removal from Design was cancelled by Test User1"
    assert row.approval_request_id is None


@pytest.mark.asyncio
async def test_others_cannot_cancel_and_closed_requests_stay_closed():
    db = _approvable_db(_request(), _phase_row())
    with pytest.raises(HTTPException) as exc:
        await approvals.cancel(db, FakeUser(PM, "superuser"), 50)
    assert exc.value.detail == CANCEL_FORBIDDEN_DETAIL

    db = _approvable_db(_request(status="rejected"), _phase_row())
    with pytest.raises(RequestClosedError):
        await approvals.cancel(db, requester(), 50)


# ---------------------------------------------------------
# Expiry hooks
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_editor_write_without_open_request_costs_no_query():
    db = FakeDB()
    row = _phase_row(approval_status="approved", approval_request_id=None)
    effects = await approvals.expire_overtaken(db, admin(), level="phase", row=row)
    assert not db.statements and not effects.events


@pytest.mark.asyncio
async def test_editor_write_overtakes_the_open_request():
    request = _request(action=ACTION_UPDATE, previous='{"allocation": 60}')
    row = _phase_row(approval_status="approved")
    db = FakeDB(request=[request], context=[_context()], approvers=[ADMIN, PM])

    effects = await approvals.expire_overtaken(db, FakeUser(PM, "user"), level="phase", row=row)

    assert request.status == "expired" and request.close_reason == "overtaken"
    assert row.approval_request_id is None
    (note,) = effects.notifications
    assert note.user_id == REQ and note.body == "Overtaken by an edit from Test User7."
    assert db.notifications == effects.notifications  # staged, the caller commits
    db.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_requesters_own_direct_write_cancels_their_request():
    request = _request(action=ACTION_REMOVE)
    row = _phase_row(approval_status="approved")
    db = FakeDB(request=[request], context=[_context()], approvers=[PM])

    effects = await approvals.expire_overtaken(db, FakeUser(REQ, "user"), level="phase", row=row)

    assert request.status == "cancelled" and not effects.notifications


@pytest.mark.asyncio
async def test_stale_pointer_is_cleared_quietly():
    row = _phase_row(approval_status="approved")
    db = FakeDB(request=[_request(status="approved")])
    effects = await approvals.expire_overtaken(db, admin(), level="phase", row=row)
    assert row.approval_request_id is None and not effects.events


@pytest.mark.asyncio
async def test_deleting_a_card_expires_its_requests():
    first = _request(id=50)
    second = _request(id=51, level="subphase", target_id=12, requester_id=OTHER)
    db = FakeDB(request=[first, second], context=[("Alpha", PM, 1, 1, "Alpha")], approvers=[PM])

    effects = await approvals.cancel_for_entity(
        db, admin(), project_id=1, phase_ids=[11], subphase_ids=[12]
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
    request = _request()
    db = FakeDB(request=[request], context=[("Alpha", PM, 1, 1, "Alpha")], approvers=[PM])
    effects = await approvals.cancel_for_entity(db, admin(), project_id=1, whole_project=True)
    assert not effects.notifications and effects.events[0].action == "delete"
    assert effects.events[0].recipients == frozenset({REQ, PM})


@pytest.mark.asyncio
async def test_nothing_to_expire_costs_at_most_one_query():
    db = FakeDB()
    assert not (await approvals.cancel_for_entity(db, admin(), project_id=1)).events
    assert not db.statements
    assert not (await approvals.cancel_for_entity(db, admin(), project_id=1, phase_ids=[1])).events
    assert len(db.statements) == 1


# ---------------------------------------------------------
# Serialisation and texts
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_project_approval_index_keys_by_level_and_row():
    pending = _request(previous=None)
    db = FakeDB(request=[pending], policy=[])

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
    assert await approvals.project_approval_index(FakeDB(), admin(), project_id=1, pm_id=None) == {}


def test_texts():
    assert approvals.pending_change_text(None) == ""
    assert approvals.pending_change_text(_request()) == "awaiting approval"
    assert approvals.pending_change_text(_request(action=ACTION_REMOVE)) == "removal requested"
    update = _request(
        action=ACTION_UPDATE,
        requested='{"allocation": 80, "start_date": "2026-01-01", "end_date": "2026-01-09"}',
        previous='{"allocation": 80, "start_date": "2026-01-02", "end_date": "2026-01-09"}',
    )
    assert approvals.pending_change_text(update) == (
        "dates 2026-01-02–2026-01-09 → 2026-01-01–2026-01-09"
    )
    assert approvals.pending_change_text(_request(status="approved")) == ""
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
        await approvals.publish(_http(), admin(), effects)

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
    db = FakeDB(context=[_context(name="Sub")], approvers=[ADMIN])
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
    db = FakeDB()
    await approvals._mark_requests_read(db, [])
    assert await approvals._load_row(db, "phase", None) is None
    assert not db.statements
    # A create request whose row is no longer pending keeps it.
    approved = _phase_row(approval_status="approved")
    assert await approvals._release(db, _request(), approved) is None
    assert await approvals._release(db, _request(), None) is None
    # A change request that no longer owns the row leaves it alone.
    other = _phase_row(approval_status="approved", approval_request_id=99)
    assert await approvals._release(db, _request(action=ACTION_UPDATE), other) is None
    assert approvals.describe_change(ACTION_REMOVE, None, None) == "removal"


@pytest.mark.asyncio
async def test_amending_a_pending_create_needs_values(pushes):
    db = FakeDB(request=[_request()], context=[_context()], approvers=[PM])
    with pytest.raises(ValueError):
        await approvals.submit_request(
            db,
            _http(),
            requester(),
            action=ACTION_UPDATE,
            level="phase",
            project_id=1,
            row=_phase_row(),
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
