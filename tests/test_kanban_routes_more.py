"""
More route tests for /api/kanban: comment counts, the comment thread
(post / edit / delete with mention-derived notifications), the status-move
notification fan-out and the assign/unassign success paths.

Permission edges of moves and assignments are in tests/test_kanban_routes.py.
Mock-based, house style; ``broadcast_change``, ``send_notification`` and
``card_assignee_ids`` are patched at the router module so the tests can assert
what each write announces and to whom.
"""

from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.assignment import PhaseStaffAssignment, SubphaseStaffAssignment
from app.models.card_comment import CardComment
from app.models.notification import Notification
from app.models.user import User
from tests.conftest import FakeUser
from tests.support import scalar_result, scalars_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)


def make_card(project_id=3, status="todo", completion=None, name=None, type_="Design"):
    return SimpleNamespace(
        id=10, project_id=project_id, status=status, completion=completion, name=name, type=type_
    )


def make_comment(comment_id=50, author_id=5, mentions=None, edited=False):
    comment = CardComment(
        id=comment_id,
        entity_type="phase",
        entity_id=10,
        project_id=3,
        author_id=author_id,
        body="Old body",
        created_at=STAMP,
        updated_at=STAMP + timedelta(minutes=5) if edited else STAMP,
    )
    comment.set_mentions(mentions or [])
    return comment


def rows_result(rows):
    result = MagicMock()
    result.all.return_value = rows
    return result


def notifications(db) -> list[Notification]:
    found = [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], Notification)]
    for call in db.add_all.call_args_list:
        found.extend(r for r in call.args[0] if isinstance(r, Notification))
    return found


@pytest.fixture
def wires():
    """Patch the router's side channels; yields (broadcast, push, assignees)."""
    with (
        patch("app.routers.kanban.broadcast_change", new_callable=AsyncMock) as broadcast,
        patch("app.routers.kanban.send_notification", new_callable=AsyncMock) as push,
        patch("app.routers.kanban.card_assignee_ids", new_callable=AsyncMock) as assignees,
    ):
        assignees.return_value = []
        yield broadcast, push, assignees


@pytest.fixture
def db_stamps_comments(mock_db_session):
    async def refresh(obj):
        if getattr(obj, "id", None) is None:
            obj.id = 61
        if getattr(obj, "created_at", None) is None:
            obj.created_at = obj.updated_at = STAMP

    mock_db_session.refresh.side_effect = refresh
    return mock_db_session


# ---------------------------------------------------------------------------
# Comment counts
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_project_comment_counts_grouped_by_card(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.return_value = rows_result(
        [("phase", 10, 2), ("subphase", 11, 1), ("legacy", 1, 9)]
    )

    response = await client.get("/api/kanban/projects/3/comment-counts")

    assert response.status_code == 200
    assert response.json() == {"phase": {"10": 2}, "subphase": {"11": 1}}
    sql = str(mock_db_session.execute.await_args.args[0])
    assert "GROUP BY card_comments.entity_type, card_comments.entity_id" in sql


@pytest.mark.asyncio
async def test_site_comment_counts_join_projects(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.return_value = rows_result([("phase", 12, 4)])

    response = await client.get("/api/kanban/sites/1/comment-counts")

    assert response.status_code == 200
    assert response.json() == {"phase": {"12": 4}, "subphase": {}}
    sql = str(mock_db_session.execute.await_args.args[0])
    assert "JOIN projects ON card_comments.project_id = projects.id" in sql
    assert "projects.site_id" in sql


@pytest.mark.asyncio
async def test_comment_counts_require_authentication(app_client):
    assert (await app_client.get("/api/kanban/projects/3/comment-counts")).status_code == 401
    assert (await app_client.get("/api/kanban/sites/1/comment-counts")).status_code == 401


# ---------------------------------------------------------------------------
# Comment thread read
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_comment_thread_with_deleted_author(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.return_value = rows_result(
        [
            (make_comment(50, 5, mentions=[7], edited=True), "Ada", "Lovelace"),
            (make_comment(51, None), None, None),
        ]
    )

    response = await client.get("/api/kanban/cards/phase/10/comments")

    assert response.status_code == 200
    first, second = response.json()
    assert (first["author_name"], first["edited"], first["mentioned_user_ids"]) == (
        "Ada Lovelace",
        True,
        [7],
    )
    assert (second["author_id"], second["author_name"], second["edited"]) == (None, None, False)


# ---------------------------------------------------------------------------
# Post a comment
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_comment_notifies_mentions_and_assignees_once(
    authed_client, db_stamps_comments, wires
):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    broadcast, push, assignees = wires
    db = db_stamps_comments
    assignees.return_value = [7, 8, 5]  # 7 also mentioned; 5 is the author
    db.execute.side_effect = [
        scalar_result(make_card()),  # the card
        scalars_result([7]),  # mentioned ids that exist (9 does not)
    ]

    response = await client.post(
        "/api/kanban/cards/phase/10/comments",
        json={"body": "Ping @[Bob](7) and @[Ghost](9)", "mentioned_user_ids": [99]},
    )

    assert response.status_code == 201
    body = response.json()
    assert (body["id"], body["author_name"], body["mentioned_user_ids"]) == (
        61,
        "Test User5",
        [7],
    )
    (comment,) = (c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], CardComment))
    assert (comment.project_id, comment.author_id) == (3, 5)
    sent = {(n.user_id, n.type) for n in notifications(db)}
    assert sent == {(7, "mention"), (8, "comment")}  # mention wins; author skipped
    mention = next(n for n in notifications(db) if n.type == "mention")
    assert mention.title == "Test User5 mentioned you on Design"
    assert mention.body == "Ping @Bob and @Ghost"  # tokens stripped in the preview
    broadcast.assert_awaited_once()
    assert broadcast.await_args.kwargs["entity_type"] == "card_comment"
    assert broadcast.await_args.kwargs["summary"] == "commented on Design"
    assert sorted(c.args[1] for c in push.await_args_list) == [7, 8]


@pytest.mark.asyncio
async def test_post_comment_without_mentions_skips_user_lookup(
    authed_client, db_stamps_comments, wires
):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    _, push, _ = wires
    db_stamps_comments.execute.side_effect = [scalar_result(make_card(name="Sub A"))]

    response = await client.post(
        "/api/kanban/cards/subphase/10/comments", json={"body": "plain text"}
    )

    assert response.status_code == 201
    assert response.json()["entity_type"] == "subphase"
    assert db_stamps_comments.execute.await_count == 1
    assert notifications(db_stamps_comments) == []
    push.assert_not_awaited()


@pytest.mark.asyncio
async def test_post_comment_survives_a_failed_push(authed_client, db_stamps_comments, wires):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    _, push, assignees = wires
    assignees.return_value = [8]
    push.side_effect = RuntimeError("socket gone")
    db_stamps_comments.execute.side_effect = [scalar_result(make_card())]

    response = await client.post("/api/kanban/cards/phase/10/comments", json={"body": "hi"})

    assert response.status_code == 201
    push.assert_awaited_once()
    db_stamps_comments.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_post_comment_on_missing_card_404(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    broadcast, _, _ = wires
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.post("/api/kanban/cards/subphase/10/comments", json={"body": "hi"})

    assert response.status_code == 404
    assert response.json()["detail"] == "Subphase not found"
    mock_db_session.add.assert_not_called()
    broadcast.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("body", ["", "x" * 4001])
async def test_post_comment_validates_body(authed_client, mock_db_session, body):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))

    response = await client.post("/api/kanban/cards/phase/10/comments", json={"body": body})

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# Edit / delete a comment
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_edit_comment_notifies_only_new_mentions(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    broadcast, push, _ = wires
    comment = make_comment(50, 5, mentions=[7])
    mock_db_session.execute.side_effect = [scalar_result(comment), scalars_result([7, 8])]

    response = await client.put(
        "/api/kanban/comments/50", json={"body": "@[Bob](7) and now @[Cy](8)"}
    )

    assert response.status_code == 200
    assert comment.body == "@[Bob](7) and now @[Cy](8)"
    assert comment.parsed_mentions == [7, 8]
    assert comment.updated_at > STAMP
    assert response.json()["edited"] is True
    assert [(n.user_id, n.type) for n in notifications(mock_db_session)] == [(8, "mention")]
    assert broadcast.await_args.kwargs["action"] == "update"
    assert [c.args[1] for c in push.await_args_list] == [8]


@pytest.mark.asyncio
async def test_edit_someone_elses_comment_403(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))  # even admins only edit their own
    comment = make_comment(50, 5)
    mock_db_session.execute.side_effect = [scalar_result(comment)]

    response = await client.put("/api/kanban/comments/50", json={"body": "rewritten"})

    assert response.status_code == 403
    assert comment.body == "Old body"
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_edit_missing_comment_404(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.put("/api/kanban/comments/50", json={"body": "x"})

    assert response.status_code == 404
    assert response.json()["detail"] == "Comment not found"


@pytest.mark.asyncio
@pytest.mark.parametrize(("user_id", "role"), [(5, "user"), (1, "superuser"), (1, "admin")])
async def test_delete_comment_by_author_or_moderator(
    authed_client, mock_db_session, wires, user_id, role
):
    client, set_user = authed_client
    set_user(FakeUser(user_id, role))
    broadcast, _, _ = wires
    mock_db_session.execute.side_effect = [scalar_result(make_comment(50, 5)), MagicMock()]

    response = await client.delete("/api/kanban/comments/50")

    assert response.status_code == 200
    assert response.json() == {"success": True}
    delete_sql = str(mock_db_session.execute.await_args_list[1].args[0])
    assert delete_sql.startswith("DELETE FROM card_comments")
    assert broadcast.await_args.kwargs["project_id"] == 3
    assert broadcast.await_args.kwargs["action"] == "delete"


@pytest.mark.asyncio
async def test_delete_someone_elses_comment_as_user_403(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(FakeUser(9, "user"))
    broadcast, _, _ = wires
    mock_db_session.execute.side_effect = [scalar_result(make_comment(50, 5))]

    response = await client.delete("/api/kanban/comments/50")

    assert response.status_code == 403
    assert mock_db_session.execute.await_count == 1
    broadcast.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_missing_comment_404(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    assert (await client.delete("/api/kanban/comments/50")).status_code == 404
    mock_db_session.commit.assert_not_awaited()


# ---------------------------------------------------------------------------
# Status move fan-out
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_status_move_notifies_other_assignees(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    broadcast, push, assignees = wires
    assignees.return_value = [1, 7]
    card = make_card(status="todo", completion=0)
    mock_db_session.execute.side_effect = [scalar_result(card)]

    with patch("app.routers.kanban.require_card_status_write", new_callable=AsyncMock):
        response = await client.put("/api/kanban/cards/phase/10/status", json={"status": "done"})

    assert response.status_code == 200
    assert response.json() == {"success": True, "status": "done", "completion": 100}
    (row,) = notifications(mock_db_session)
    assert (row.user_id, row.type) == (7, "status_change")
    assert row.title == "Design moved to Done"
    assert row.body.startswith("Was ")
    assert broadcast.await_args.kwargs["summary"] == "Design -> Done"
    assert [c.args[1] for c in push.await_args_list] == [7]


@pytest.mark.asyncio
async def test_status_move_to_same_column_is_a_no_op(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    broadcast, _, _ = wires
    mock_db_session.execute.side_effect = [scalar_result(make_card(status="done", completion=100))]

    with patch("app.routers.kanban.require_card_status_write", new_callable=AsyncMock):
        response = await client.put("/api/kanban/cards/phase/10/status", json={"status": "done"})

    assert response.status_code == 200
    assert response.json()["completion"] == 100
    mock_db_session.commit.assert_not_awaited()
    broadcast.assert_not_awaited()


# ---------------------------------------------------------------------------
# Assign / unassign success paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("entity_type", "model"),
    [("phase", PhaseStaffAssignment), ("subphase", SubphaseStaffAssignment)],
)
async def test_assign_books_at_max_capacity(
    authed_client, mock_db_session, wires, entity_type, model
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    broadcast, push, _ = wires
    assignee = User(id=7, email="b@example.com", first_name="Bob", last_name="B", max_capacity=60)
    mock_db_session.execute.side_effect = [
        scalar_result(make_card()),
        scalar_result(assignee),
        scalar_result(None),  # not yet assigned
    ]

    async def refresh(obj):
        obj.id = 300

    mock_db_session.refresh.side_effect = refresh

    response = await client.post(
        f"/api/kanban/cards/{entity_type}/10/assignees", json={"staff_id": 7}
    )

    assert response.status_code == 201
    assert response.json() == {
        "success": True,
        "id": 300,
        "staff_id": 7,
        "staff_name": "Bob B",
        "allocation": 60,
    }
    (assignment,) = (c.args[0] for c in mock_db_session.add.call_args_list)
    assert isinstance(assignment, model)
    assert assignment.project_id == 3
    (row,) = notifications(mock_db_session)
    assert (row.user_id, row.type, row.body) == (
        7,
        "assigned",
        "Booked at 60% over the card's dates.",
    )
    assert broadcast.await_args.kwargs["summary"] == "Bob B assigned to Design"
    push.assert_awaited_once()


@pytest.mark.asyncio
async def test_assign_duplicate_is_409(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [
        scalar_result(make_card()),
        scalar_result(User(id=7, first_name="Bob", last_name="B")),
        scalar_result(PhaseStaffAssignment(id=1, staff_id=7)),
    ]

    response = await client.post("/api/kanban/cards/phase/10/assignees", json={"staff_id": 7})

    assert response.status_code == 409
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_assign_unknown_staff_is_404(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(make_card()), scalar_result(None)]

    response = await client.post("/api/kanban/cards/phase/10/assignees", json={"staff_id": 7})

    assert response.status_code == 404
    assert response.json()["detail"] == "Staff member not found"


@pytest.mark.asyncio
@pytest.mark.parametrize("entity_type", ["phase", "subphase"])
async def test_user_leaves_a_card(
    authed_client, mock_db_session, wires, entity_type, change_intents
):
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))  # removing themself needs no editor rights
    broadcast, _, _ = wires
    row = SimpleNamespace(
        id=300,
        project_id=1,
        staff_id=7,
        allocation=60,
        approval_status="approved",
        approval_request_id=None,
    )
    mock_db_session.execute.side_effect = [scalar_result(make_card()), scalar_result(row)]

    response = await client.delete(f"/api/kanban/cards/{entity_type}/10/assignees/7")

    assert response.status_code == 200
    assert response.json() == {"success": True}
    mock_db_session.delete.assert_awaited_once_with(row)
    assert broadcast.await_args.kwargs["entity_id"] == 300
    assert broadcast.await_args.kwargs["summary"] == "unassigned from Design"
    # The person left themself: only the PM is told (the actor is dropped at delivery).
    ((actor_id, intents, already),) = change_intents
    assert (actor_id, already) == (7, set())
    by = {i.recipient: i for i in intents}
    assert by["pm"].title == "Test User7 removed themself from Design"
    assert by["pm"].body == "Was at 60%"
    assert (by["pm"].entity_type, by["pm"].entity_id) == (entity_type, 10)


@pytest.mark.asyncio
async def test_unassign_missing_assignment_404(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(make_card()), scalar_result(None)]

    response = await client.delete("/api/kanban/cards/phase/10/assignees/7")

    assert response.status_code == 404
    assert response.json()["detail"] == "Assignment not found"
    mock_db_session.delete.assert_not_awaited()


# ---------------------------------------------------------------------------
# Permission keys: kanban.comment / kanban.moderate_comments
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_moderator_role_deletes_someone_elses_comment(
    authed_client, mock_db_session, wires
):
    client, set_user = authed_client
    set_user(FakeUser(9, "moderator", {"kanban.moderate_comments"}))
    mock_db_session.execute.side_effect = [scalar_result(make_comment(50, 5)), MagicMock()]

    response = await client.delete("/api/kanban/comments/50")

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_a_superuser_without_moderation_cannot_delete_others_comments(
    authed_client, mock_db_session, wires
):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser", {"kanban.comment"}))
    mock_db_session.execute.side_effect = [scalar_result(make_comment(50, 5))]

    response = await client.delete("/api/kanban/comments/50")

    assert response.status_code == 403
    assert response.json()["detail"] == "You can only delete your own comments"


@pytest.mark.asyncio
async def test_an_author_whose_role_cannot_comment_cannot_delete(
    authed_client, mock_db_session, wires
):
    client, set_user = authed_client
    set_user(FakeUser(5, "mute", set()))
    mock_db_session.execute.side_effect = [scalar_result(make_comment(50, 5))]

    response = await client.delete("/api/kanban/comments/50")

    assert response.status_code == 403
    assert response.json()["detail"] == "Permission required: kanban.comment"
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_editing_a_comment_needs_kanban_comment(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(FakeUser(5, "mute", set()))

    response = await client.put("/api/kanban/comments/50", json={"body": "x"})

    assert response.status_code == 403
    mock_db_session.execute.assert_not_awaited()
