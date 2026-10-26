"""
An optional comment on a staff booking create (r9).

- Direct create with ``comment``: a ``CardComment`` by the actor on the
  booking's thread (card / project) in the booking's transaction, ``kanban.comment``
  checked before any write (403), mention / comment notifications without the
  booked person and the PM (their change notification carries the preview),
  the staged recipients passed to ``deliver`` as ``already_notified``.
- Approval mode: the comment is the request's ``note`` (no ``kanban.comment``
  needed); the approvers' ``approval_requested`` body is its preview.
- ``approve`` posts a create request's note as the requester's comment (only
  while they hold ``kanban.comment``), mentions notified with the requester as
  actor and never the approver; change requests, reject and cancel never post.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.responses import JSONResponse

from app.models.card_comment import CardComment
from app.models.notification import Notification
from app.models.rbac import ApprovalRequest
from app.services import approvals
from app.services.approvals import ACTION_CREATE, ACTION_UPDATE
from app.services.mentions import PREVIEW_MAX
from tests.conftest import FakeUser
from tests.support import (
    ADMIN_ID,
    PM_ID,
    REQUESTER_ID,
    ApprovalFakeDB,
    approvable_db,
    approval_context,
    approval_request,
    card_lock_result,
    pending_phase_row,
    scalars_result,
)
from tests.test_project_access_routes import _placement, _pm_result, _resolved, _scalar_result

ADMIN, PM, REQ = ADMIN_ID, PM_ID, REQUESTER_ID
ANN = 8  # the booked person
BOB = 9  # an assignee / a mentioned colleague
CAROL = 10

PROJECT_BOOKING = {
    "staff_id": ANN,
    "allocation": 60,
    "start_date": "2026-01-01",
    "end_date": "2026-01-31",
}
CARD_BOOKING = {"staff_id": ANN, "project_id": 1, "allocation": 40}
ROUTES = {
    "project": ("/api/projects/1/staff", PROJECT_BOOKING),
    "phase": ("/api/phases/11/staff", CARD_BOOKING),
    "subphase": ("/api/subphases/11/staff", CARD_BOOKING),
}

# A booker of others who may not comment: assignments.manage_others only.
BOOKER_NO_COMMENT = {"assignments.manage_others": "allow"}


def first(row):
    result = MagicMock()
    result.first.return_value = row
    return result


def context_row(name: str = "Design"):
    """``approvals.load_context``: project name, PM, site, target id / name, dates."""
    return first(("Alpha", PM, 1, 11, name, None, None))


def detail_row(level: str):
    """The created phase / subphase row with the staff details and the card's dates."""
    row = SimpleNamespace(
        id=70,
        phase_id=11,
        subphase_id=11,
        project_id=1,
        staff_id=ANN,
        allocation=40,
        start_date=None,
        end_date=None,
    )
    result = MagicMock()
    result.first.return_value = (row, "Ann", "Engineer", None, None)
    return result


def before_write(level: str) -> list:
    """The queries a create runs before its first write (an editor booking Ann)."""
    if level == "project":
        return [_pm_result(PM), _scalar_result(True), _scalar_result(None)]
    return [_resolved(), _scalar_result(True), card_lock_result(), _placement()]


def added(mock_db_session, model):
    objs = [c.args[0] for c in mock_db_session.add.call_args_list]
    for c in mock_db_session.add_all.call_args_list:
        objs.extend(c.args[0])
    return [o for o in objs if isinstance(o, model)]


@pytest.fixture
def comment_pushes():
    """The card_comment broadcast and the notification pushes after the commit."""
    with (
        patch("app.services.card_comments.broadcast_change", AsyncMock()) as broadcast,
        patch("app.services.card_comments.send_notification", AsyncMock()) as push,
    ):
        yield SimpleNamespace(broadcast=broadcast, push=push)


# ---------------------------------------------------------------------------
# Direct create with a comment
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("level", ["project", "phase", "subphase"])
async def test_direct_create_posts_the_comment_on_the_bookings_thread(
    level, authed_client, mock_db_session, change_intents, comment_pushes
):
    client, set_user = authed_client
    set_user(FakeUser(ADMIN, "admin"))
    path, body = ROUTES[level]
    after = [detail_row(level)] if level != "project" else []
    mock_db_session.execute.side_effect = [
        *before_write(level),
        context_row(),
        scalars_result([BOB, ANN, PM]),  # the mentioned users that exist
        scalars_result([ANN, BOB, CAROL, PM, ADMIN]),  # the thread's assignees
        *after,
    ]

    response = await client.post(
        path,
        json={**body, "comment": "  Welcome @[Ann](8), ask @[Bob](9) or @[Pm](7)  "},
    )

    assert response.status_code == 200
    (comment,) = added(mock_db_session, CardComment)
    thread = ("project", 1) if level == "project" else (level, 11)
    assert (comment.entity_type, comment.entity_id) == thread
    assert (comment.project_id, comment.author_id) == (1, ADMIN)
    # Stored stripped; mentions from the body, in body order.
    assert comment.body == "Welcome @[Ann](8), ask @[Bob](9) or @[Pm](7)"
    assert comment.parsed_mentions == [ANN, BOB, PM]
    assert comment.created_at == comment.updated_at

    # One notification per person: Bob and the PM their mention, Carol the
    # comment; Ann (booked) and the PM get the booking's change notification
    # instead; the actor nothing.
    rows = added(mock_db_session, Notification)
    assert {r.user_id: r.type for r in rows} == {BOB: "mention", PM: "mention", CAROL: "comment"}
    preview = "Welcome @Ann, ask @Bob or @Pm"
    assert {r.body for r in rows} == {preview}
    assert {r.title for r in rows} == {
        "Test User1 mentioned you on Design",
        "Test User1 commented on Design",
    }
    assert {(r.entity_type, r.entity_id, r.project_id) for r in rows} == {(*thread, 1)}
    mock_db_session.commit.assert_awaited_once()

    # deliver: the booked person's and the PM's lines carry the preview, and
    # the people notified of the comment are skipped.
    ((actor, intents, already),) = change_intents
    assert actor == ADMIN
    assert already == {BOB, PM, CAROL}
    for intent in intents:
        assert intent.body.endswith(f" — {preview}")
    person = next(i for i in intents if i.recipient == "person")
    assert person.user_id == ANN

    # The thread refreshes and the notifications are pushed after the commit.
    comment_pushes.broadcast.assert_awaited_once()
    kwargs = comment_pushes.broadcast.await_args.kwargs
    assert (kwargs["entity_type"], kwargs["action"], kwargs["project_id"]) == (
        "card_comment",
        "create",
        1,
    )
    assert {c.args[1] for c in comment_pushes.push.await_args_list} == {BOB, PM, CAROL}


@pytest.mark.parametrize("level", ["project", "phase", "subphase"])
async def test_direct_create_without_a_comment_is_unchanged(
    level, authed_client, mock_db_session, change_intents, comment_pushes
):
    client, set_user = authed_client
    set_user(FakeUser(ADMIN, "admin"))
    path, body = ROUTES[level]
    after = [detail_row(level)] if level != "project" else []
    mock_db_session.execute.side_effect = [*before_write(level), *after]

    response = await client.post(path, json={**body, "comment": "   "})

    assert response.status_code == 200
    assert added(mock_db_session, CardComment) == []
    assert added(mock_db_session, Notification) == []
    ((_actor, intents, already),) = change_intents
    assert already == set()
    assert " — " not in next(i for i in intents if i.recipient == "person").body
    comment_pushes.broadcast.assert_not_awaited()


@pytest.mark.parametrize("level", ["project", "phase", "subphase"])
async def test_a_comment_without_the_commenting_key_is_403_and_writes_nothing(
    level, authed_client, mock_db_session, change_intents
):
    client, set_user = authed_client
    set_user(FakeUser(9, "user", BOOKER_NO_COMMENT))
    path, body = ROUTES[level]
    mock_db_session.execute.side_effect = before_write(level)

    with patch.object(approvals, "apply_shrink", AsyncMock(return_value=[])) as shrink:
        response = await client.post(path, json={**body, "comment": "Welcome"})

    assert response.status_code == 403
    assert "kanban.comment" in response.json()["detail"]
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()
    shrink.assert_not_awaited()  # checked before the shortening of a booking
    assert change_intents == []


async def test_without_a_comment_the_commenting_key_is_not_needed(
    authed_client, mock_db_session, change_intents
):
    client, set_user = authed_client
    set_user(FakeUser(9, "user", BOOKER_NO_COMMENT))
    mock_db_session.execute.side_effect = before_write("project")

    response = await client.post("/api/projects/1/staff", json=PROJECT_BOOKING)

    assert response.status_code == 200


@pytest.mark.parametrize("level", ["project", "phase", "subphase"])
async def test_a_comment_over_the_limit_is_422(level, authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(ADMIN, "admin"))
    path, body = ROUTES[level]

    response = await client.post(path, json={**body, "comment": "x" * 4001})

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# Approval mode: the comment is the request's note
# ---------------------------------------------------------------------------

SELF_APPROVAL = {ACTION_CREATE: "approval"}  # no kanban.comment on purpose


@pytest.mark.parametrize("level", ["project", "phase", "subphase"])
async def test_a_request_carries_the_comment_as_its_note(level, authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(ANN, "user", SELF_APPROVAL))
    path, body = ROUTES[level]
    pending = JSONResponse(
        status_code=202, content={"success": True, "pending": True, "request_id": 5, "id": 6}
    )
    if level == "project":
        queries = [_pm_result(PM), _scalar_result(True), _scalar_result(None)]
    else:
        queries = [
            _resolved(),
            _pm_result(PM),
            _scalar_result(True),
            card_lock_result(),
            _placement(),
        ]
    mock_db_session.execute.side_effect = queries

    with patch.object(approvals, "submit_request", AsyncMock(return_value=pending)) as submit:
        response = await client.post(path, json={**body, "comment": " Can I join? @[Bob](9) "})

    assert response.status_code == 202
    assert response.json() == {"success": True, "pending": True, "request_id": 5, "id": 6}
    assert submit.await_args.kwargs["note"] == "Can I join? @[Bob](9)"
    assert submit.await_args.kwargs["action"] == ACTION_CREATE
    assert added(mock_db_session, CardComment) == []


async def test_a_request_without_a_comment_has_no_note(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(ANN, "user", SELF_APPROVAL))
    mock_db_session.execute.side_effect = [
        _pm_result(PM),
        _scalar_result(True),
        _scalar_result(None),
    ]
    pending = JSONResponse(status_code=202, content={"success": True})

    with patch.object(approvals, "submit_request", AsyncMock(return_value=pending)) as submit:
        await client.post("/api/projects/1/staff", json=PROJECT_BOOKING)

    assert submit.await_args.kwargs["note"] is None


@pytest.fixture
def pushes():
    with (
        patch.object(approvals, "broadcast_change", AsyncMock()) as broadcast,
        patch.object(approvals, "send_notification", AsyncMock()) as notify,
        patch.object(approvals, "send_user_event", AsyncMock()) as event,
    ):
        yield SimpleNamespace(broadcast=broadcast, notify=notify, event=event)


def _http():
    return MagicMock()


def requester() -> FakeUser:
    return FakeUser(REQ, "user", SELF_APPROVAL)


async def test_submitted_create_stores_the_note_and_previews_it_to_the_approvers(pushes):
    db = ApprovalFakeDB(context=[approval_context()], approvers=[ADMIN, PM])
    note = "Please, " + "x" * 200 + " @[Bob](9)"

    response = await approvals.submit_request(
        db,
        _http(),
        requester(),
        action=ACTION_CREATE,
        level="phase",
        project_id=1,
        target_id=11,
        values={"allocation": 80},
        note=note,
    )

    assert response.status_code == 202
    (request,) = (o for o in db.added if isinstance(o, ApprovalRequest))
    assert request.note == note
    assert {n.type for n in db.notifications} == {"approval_requested"}
    for row in db.notifications:
        assert row.body == ("Please, " + "x" * 200)[:PREVIEW_MAX]
    # Nothing is posted to the thread at request time.
    assert not any(isinstance(o, CardComment) for o in db.added)


async def test_submitted_change_previews_its_note_to_the_approvers(pushes):
    row = pending_phase_row(approval_status="approved", approval_request_id=None, allocation=60)
    db = ApprovalFakeDB(context=[approval_context()], approvers=[PM])

    await approvals.submit_request(
        db,
        _http(),
        requester(),
        action=ACTION_UPDATE,
        level="phase",
        project_id=1,
        row=row,
        values={"allocation": 80},
        note="Hi @[Pm](7)",
    )

    (notification,) = db.notifications
    assert notification.body == "Hi @Pm"


async def test_submitted_request_without_a_note_has_no_body(pushes):
    db = ApprovalFakeDB(context=[approval_context()], approvers=[PM])

    await approvals.submit_request(
        db,
        _http(),
        requester(),
        action=ACTION_CREATE,
        level="phase",
        project_id=1,
        target_id=11,
        values={"allocation": 80},
    )

    (notification,) = db.notifications
    assert notification.body is None


# ---------------------------------------------------------------------------
# Approve: the note is posted to the thread
# ---------------------------------------------------------------------------

COMMENTER = [(ACTION_CREATE, "approval"), ("kanban.comment", "allow")]
AUTHOR = [("user", "Rita", "Requester")]


def _approve_db(request, row, **extra):
    answers = {"perms": COMMENTER, "author": AUTHOR, **extra}
    return approvable_db(request, row, **answers)


async def test_approve_posts_the_note_as_the_requesters_comment():
    note = "Joining to help @[Bob](9) and @[Pm](7)"
    request, row = approval_request(note=note), pending_phase_row()
    db = _approve_db(request, row, mentioned=[BOB, PM])

    result = await approvals.approve(db, FakeUser(PM, "user"), 50, visible=frozenset({1}))

    assert result.conflict is None and row.approval_status == "approved"
    (comment,) = (o for o in db.added if isinstance(o, CardComment))
    assert (comment.entity_type, comment.entity_id, comment.project_id) == ("phase", 11, 1)
    assert (comment.author_id, comment.body) == (REQ, note)
    assert comment.parsed_mentions == [BOB, PM]
    assert result.effects.comments == [comment]

    # Bob is mentioned by the requester; the approver (the PM) never.
    mentions = [n for n in db.notifications if n.type == "mention"]
    assert [(n.user_id, n.actor_id) for n in mentions] == [(BOB, REQ)]
    (mention,) = mentions
    assert mention.title == "Rita Requester mentioned you on Design"
    assert mention.body == "Joining to help @Bob and @Pm"
    assert (mention.entity_type, mention.entity_id) == ("phase", 11)
    assert result.effects.notified_ids == {BOB}
    assert mention in result.effects.notifications
    # No comment notifications: the approval itself tells the people concerned.
    assert not any(n.type == "comment" for n in db.notifications)
    db.commit.assert_awaited_once()


async def test_approve_posts_a_project_requests_note_on_the_project_thread():
    request = approval_request(
        level="project",
        target_id=1,
        requested='{"allocation": 50, "end_date": "2026-01-30", "start_date": "2026-01-05"}',
        note="Hello",
    )
    row = pending_phase_row()
    db = _approve_db(request, row, context=[("Alpha", PM, 1, 1, "Alpha", None, None)])

    result = await approvals.approve(db, FakeUser(ADMIN, "admin"), 50, visible=None)

    (comment,) = result.effects.comments
    assert (comment.entity_type, comment.entity_id) == ("project", 1)
    assert db.queried("mentioned") == 0  # no token, no lookup
    assert result.effects.notified_ids == set()


async def test_approve_keeps_the_note_on_the_request_without_the_commenting_key():
    request, row = approval_request(note="Hello @[Bob](9)"), pending_phase_row()
    db = _approve_db(request, row, perms=[(ACTION_CREATE, "approval")], mentioned=[BOB])

    result = await approvals.approve(db, FakeUser(PM, "user"), 50, visible=frozenset({1}))

    assert result.conflict is None and row.approval_status == "approved"
    assert result.effects.comments == []
    assert not any(isinstance(o, CardComment) for o in db.added)
    assert db.queried("mentioned") == 0
    assert request.note == "Hello @[Bob](9)"


@pytest.mark.parametrize("note", [None, "", "   "])
async def test_approve_without_a_note_posts_nothing(note):
    request, row = approval_request(note=note), pending_phase_row()
    db = _approve_db(request, row)

    result = await approvals.approve(db, FakeUser(PM, "user"), 50, visible=frozenset({1}))

    assert result.effects.comments == []
    assert db.queried("author") == 0


async def test_approving_a_change_request_never_posts_its_note():
    row = pending_phase_row(approval_status="approved", allocation=60)
    request = approval_request(
        action=ACTION_UPDATE,
        requested='{"allocation": 90}',
        previous='{"allocation": 60}',
        note="More time please",
    )
    db = _approve_db(request, row, perms=[*COMMENTER, (ACTION_UPDATE, "approval")])

    result = await approvals.approve(db, FakeUser(PM, "user"), 50, visible=frozenset({1}))

    assert result.conflict is None and row.allocation == 90
    assert result.effects.comments == []
    assert db.queried("author") == 0


@pytest.mark.parametrize("decision", ["reject", "cancel"])
async def test_reject_and_cancel_keep_the_note_on_the_request(decision):
    request, row = approval_request(note="Please"), pending_phase_row()
    db = _approve_db(request, row)

    if decision == "reject":
        result = await approvals.reject(db, FakeUser(PM, "user"), 50, visible=frozenset({1}))
    else:
        result = await approvals.cancel(db, FakeUser(REQ, "user"), 50)

    assert result.effects.comments == []
    assert not any(isinstance(o, CardComment) for o in db.added)
    assert db.queried("author") == 0


async def test_publish_broadcasts_the_posted_note(pushes):
    comment = CardComment(id=33, project_id=1, entity_type="phase", entity_id=11)
    effects = approvals.ApprovalEffects(comments=[comment])

    await approvals.publish(_http(), FakeUser(PM, "user"), effects)

    (call,) = pushes.broadcast.await_args_list
    assert (
        call.kwargs["entity_type"],
        call.kwargs["entity_id"],
        call.kwargs["project_id"],
        call.kwargs["action"],
    ) == ("card_comment", 33, 1, "create")


async def test_the_approve_route_skips_the_mentioned_people_in_the_change_notifications(
    authed_client, mock_db_session, change_intents
):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    request = approval_request(status="approved")
    effects = approvals.ApprovalEffects(notified_ids={BOB, PM})
    decided = approvals.DecisionResult(request, effects)

    with (
        patch("app.routers.approvals.visible_site_ids", AsyncMock(return_value=None)),
        patch.object(approvals, "approve", AsyncMock(return_value=decided)),
        patch.object(approvals, "publish", AsyncMock()),
    ):
        response = await client.post("/api/approval-requests/50/approve")

    assert response.status_code == 200
    ((_actor, _intents, already),) = change_intents
    assert already == {REQ, BOB, PM}
