"""
Approval workflow follow-ups (app/services/approvals.py):

- re-validation keeps an editor's or a PM's request valid without the self key,
  like ``resolve_self_booking`` (an ``assignments.manage_others`` holder books
  themself directly);
- ``expire_for_requester``: deactivating or deleting a requester closes their
  pending requests ``expired(requester_inactive)`` and releases the rows;
- the ``to_decide`` list holds the eligibility rule in SQL, so its ``limit``
  counts decidable rows only. That one is proven against a real (in-memory
  SQLite) database: a mock cannot show that a page is not cut short.
"""

from datetime import date, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import CheckConstraint, MetaData, create_engine
from sqlalchemy.orm import Session

from app.database import Base
from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.rbac import (
    ApprovalPolicy,
    ApprovalPolicyRole,
    ApprovalRequest,
    Role,
    RolePermission,
)
from app.models.user import User, UserSite
from app.services import approvals
from app.services.approvals import ACTION_CREATE, ACTION_UPDATE, Policy
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
    pending_phase_row,
)

ADMIN, REQ, PM = ADMIN_ID, REQUESTER_ID, PM_ID

# ---------------------------------------------------------
# Re-validation follows the resolver
# ---------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("perms", "context"),
    [
        # The role lost the self key but manages others' bookings outright.
        ([("assignments.manage_others", "allow")], approval_context()),
        # The role lost the self key, but the requester now manages the project.
        ([("projects.manage_as_pm", "allow")], approval_context(pm_id=REQ)),
    ],
)
async def test_an_editor_or_pm_requester_stays_valid_without_the_self_key(perms, context):
    request, row = approval_request(), pending_phase_row()
    db = approvable_db(request, row, perms=perms, context=[context])

    result = await approvals.approve(db, approval_admin(), 50, visible=None)

    assert result.conflict is None
    assert request.status == "approved" and row.approval_status == "approved"


@pytest.mark.asyncio
async def test_pm_bundle_does_not_help_on_another_project():
    request, row = approval_request(), pending_phase_row()
    db = approvable_db(request, row, perms=[("projects.manage_as_pm", "allow")])

    result = await approvals.approve(db, approval_admin(), 50, visible=None)

    assert result.conflict["close_reason"] == "permission_lost"


# ---------------------------------------------------------
# expire_for_requester
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_deactivating_a_requester_expires_their_requests():
    create = approval_request(id=50)
    update = approval_request(
        id=51, action=ACTION_UPDATE, assignment_id=72, previous='{"allocation": 60}'
    )
    pending_row = pending_phase_row()
    db = ApprovalFakeDB(
        request=[create, update],
        context=[approval_context()],
        policy=[],
        approvers=[ADMIN, PM],
        row=[pending_row],
    )

    effects = await approvals.expire_for_requester(db, approval_admin(), REQ)

    assert {create.status, update.status} == {"expired"}
    assert {create.close_reason, update.close_reason} == {"requester_inactive"}
    assert db.deleted == [pending_row]  # the pending create's row goes
    assert [n.user_id for n in effects.notifications] == [REQ, REQ]
    assert all(n.title.endswith(" expired") for n in effects.notifications)
    assert effects.notifications[0].body == "The requester's account is no longer active."
    assert all(n in db.added for n in effects.notifications)
    assert [e.action for e in effects.events] == ["update", "update"]
    assert effects.events[0].recipients == frozenset({REQ, ADMIN, PM})
    assert [c.action for c in effects.assignment_changes] == ["delete"]
    assert len(db.updates) == 1  # the approvers' notifications marked read
    db.commit.assert_not_awaited()  # staged: the caller commits
    sql = str(db.statements[0].compile(compile_kwargs={"literal_binds": True}))
    assert f"approval_requests.requester_id = {REQ}" in sql
    assert "approval_requests.status = 'pending'" in sql and "FOR UPDATE" in sql


@pytest.mark.asyncio
async def test_deleting_a_requester_notifies_nobody():
    request = approval_request()
    db = ApprovalFakeDB(
        request=[request], context=[approval_context()], approvers=[PM], row=[pending_phase_row()]
    )

    effects = await approvals.expire_for_requester(db, approval_admin(), REQ, deleted=True)

    assert request.status == "expired" and request.close_reason == "requester_inactive"
    assert not effects.notifications
    assert effects.events[0].action == "delete"


@pytest.mark.asyncio
async def test_a_requester_without_pending_requests_costs_one_query():
    db = ApprovalFakeDB()
    effects = await approvals.expire_for_requester(db, approval_admin(), REQ)
    assert not effects.events and not effects.notifications
    assert len(db.statements) == 1


@pytest.mark.asyncio
async def test_request_on_a_deleted_project_expires_without_project_link():
    request = approval_request()
    db = ApprovalFakeDB(request=[request], context=[], approvers=[ADMIN])

    effects = await approvals.expire_for_requester(db, approval_admin(), REQ)

    (note,) = effects.notifications
    assert note.project_id is None and note.title == "Your booking on a project expired"
    assert not effects.assignment_changes


# ---------------------------------------------------------
# to_decide: eligibility in SQL (real SQLite)
# ---------------------------------------------------------

_TABLES = [
    model.__table__
    for model in (
        Role,
        RolePermission,
        User,
        UserSite,
        Project,
        ProjectPhase,
        ProjectSubphase,
        ApprovalPolicy,
        ApprovalPolicyRole,
        ApprovalRequest,
    )
]


_DATES = {"start_date": date(2026, 10, 1), "end_date": date(2026, 12, 1)}


class _SyncSessionAdapter:
    """Just enough of AsyncSession for the read-only listing code."""

    def __init__(self, session: Session):
        self.session = session

    async def execute(self, statement):
        return self.session.execute(statement)


def _create_tables(engine) -> None:
    """The listing's tables, without their CHECKs (PostgreSQL regex syntax
    SQLite lacks). Every tenant table is copied so the foreign keys resolve;
    only the listing's ones are created (SQLite does not enforce the rest)."""
    metadata = MetaData()
    for table in Base.metadata.sorted_tables:
        copy = table.to_metadata(metadata)
        for constraint in [c for c in copy.constraints if isinstance(c, CheckConstraint)]:
            copy.constraints.discard(constraint)
    metadata.create_all(engine, tables=[metadata.tables[t.name] for t in _TABLES])


@pytest.fixture
def sqlite_db():
    engine = create_engine("sqlite://")
    _create_tables(engine)
    with Session(engine) as session:
        session.add_all(
            [
                Role(id=1, key="user", name="User"),
                Role(id=2, key="lead", name="Lead"),
                User(id=REQ, email="req@x", password="x", first_name="Rita", last_name="Req"),
                User(id=PM, email="pm@x", password="x", first_name="Pat", last_name="Pm"),
                User(id=8, email="lead@x", password="x", first_name="Lea", last_name="Lead"),
                User(id=9, email="other@x", password="x", first_name="Otto", last_name="O"),
                UserSite(user_id=PM, site_id=1),
                UserSite(user_id=8, site_id=1),
                Project(id=1, name="Mine", site_id=1, pm_id=PM, **_DATES),
                Project(id=2, name="Theirs", site_id=1, pm_id=9, **_DATES),
                ProjectPhase(id=11, project_id=1, type="Design", **_DATES),
                ProjectPhase(id=21, project_id=2, type="Build", **_DATES),
                # The PM does not approve updates; the lead role does.
                ApprovalPolicy(action=ACTION_CREATE, pm_approves=True),
                ApprovalPolicy(action=ACTION_UPDATE, pm_approves=False),
                ApprovalPolicyRole(action=ACTION_UPDATE, role_id=2),
            ]
        )

        def request(request_id, project_id, target_id, action=ACTION_CREATE, minute=0):
            return ApprovalRequest(
                id=request_id,
                requester_id=REQ,
                action=action,
                project_id=project_id,
                level="phase",
                target_id=target_id,
                requested='{"allocation": 50}',
                status="pending",
                created_at=datetime(2026, 10, 1, 9, minute),
                updated_at=datetime(2026, 10, 1, 9, minute),
            )

        session.add_all(
            [
                # Oldest: decidable by the PM.
                request(1, 1, 11, minute=0),
                request(2, 1, 11, minute=1),
                # Newer: someone else's project, and an update the PM may not
                # decide -- all ineligible for the PM, and they come first.
                request(3, 2, 21, minute=2),
                request(4, 2, 21, minute=3),
                request(5, 1, 11, action=ACTION_UPDATE, minute=4),
                request(6, 2, 21, minute=5),
            ]
        )
        session.commit()
        yield _SyncSessionAdapter(session)
    engine.dispose()


def _http():
    return SimpleNamespace(state=SimpleNamespace())


@pytest.mark.asyncio
async def test_to_decide_page_is_not_cut_short_by_ineligible_rows(sqlite_db):
    items = await approvals.list_requests(
        sqlite_db, _http(), FakeUser(PM, "user"), scope="to_decide", limit=2
    )
    assert [i["id"] for i in items] == [2, 1]
    assert all(i["can_decide"] for i in items)
    assert items[0]["requester_name"] == "Rita Req" and items[0]["target_name"] == "Design"


@pytest.mark.asyncio
async def test_to_decide_by_policy_role_and_for_an_admin(sqlite_db):
    lead = await approvals.list_requests(
        sqlite_db, _http(), FakeUser(8, "lead"), scope="to_decide", limit=10
    )
    assert [i["id"] for i in lead] == [5]  # the update, through the lead role

    everything = await approvals.list_requests(
        sqlite_db, _http(), FakeUser(ADMIN, "admin"), scope="to_decide", limit=3
    )
    assert [i["id"] for i in everything] == [6, 5, 4]


def test_my_todos_helper_is_gone():
    # Personal todos were removed in 2.0.0; My Work lists to_decide directly.
    assert not hasattr(approvals, "decidable_todo_items")
    assert not hasattr(approvals, "TODO_APPROVALS_LIMIT")


def test_decider_clause_mirrors_can_decide():
    policies = {ACTION_CREATE: Policy(), ACTION_UPDATE: Policy(False, frozenset({"lead"}))}
    assert approvals.decider_clause(approval_admin(), policies) is None

    def sql(user):
        clause = approvals.decider_clause(user, policies)
        return str(clause.compile(compile_kwargs={"literal_binds": True}))

    pm_only = sql(FakeUser(PM, "user"))
    assert f"projects.pm_id = {PM}" in pm_only
    assert f"approval_requests.action NOT IN ('{ACTION_UPDATE}')" in pm_only
    assert f"approval_requests.action IN ('{ACTION_UPDATE}')" in sql(FakeUser(8, "lead"))
    no_policies = approvals.decider_clause(FakeUser(PM, "user"), {})
    assert str(no_policies.compile(compile_kwargs={"literal_binds": True})) == (
        f"projects.pm_id = {PM}"
    )
