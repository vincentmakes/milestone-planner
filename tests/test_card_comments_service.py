"""
app/services/card_comments.py: the pieces shared by the comment route and the
two booking paths that post a comment (a direct staff booking with a
``comment``, an approved request's ``note``).
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.card_comment import CardComment
from app.services import card_comments
from app.services.card_comments import (
    author_name,
    booking_thread,
    build_comment_notifications,
    new_comment,
    stage_booking_comment,
    validate_mention_ids,
)
from tests.support import scalars_result

ACTOR = 1
BOOKED = 5
PM = 7
ANN = 8
BOB = 9


@pytest.mark.parametrize(
    ("level", "expected"),
    [("project", ("project", 1)), ("phase", ("phase", 11)), ("subphase", ("subphase", 11))],
)
def test_booking_thread_is_the_card_or_the_project(level, expected):
    assert booking_thread(level, 1, 11) == expected


def test_author_name_falls_back_to_someone():
    assert author_name(SimpleNamespace(first_name="Ada", last_name="Lovelace")) == "Ada Lovelace"
    assert author_name(SimpleNamespace(first_name=None, last_name="")) == "Someone"


def test_new_comment_has_one_instant_and_its_mentions():
    comment = new_comment(
        entity_type="phase",
        entity_id=11,
        project_id=1,
        author_id=ACTOR,
        body="hi @[Ann](8)",
        mentioned=[ANN],
    )

    assert isinstance(comment, CardComment)
    assert (comment.entity_type, comment.entity_id, comment.project_id) == ("phase", 11, 1)
    assert (comment.author_id, comment.body) == (ACTOR, "hi @[Ann](8)")
    assert comment.created_at == comment.updated_at
    assert comment.is_edited is False
    assert comment.parsed_mentions == [ANN]


def test_comment_notifications_drop_the_actor_and_prefer_the_mention():
    rows = build_comment_notifications(
        mentioned=[ANN, ACTOR],
        assignees=[ANN, BOB, ACTOR],
        actor_id=ACTOR,
        actor_name="Ada",
        entity_type="phase",
        entity_id=11,
        project_id=1,
        card_name="Design",
        preview="hi @Ann",
    )

    by_user = {row.user_id: row for row in rows}
    assert set(by_user) == {ANN, BOB}
    assert (by_user[ANN].type, by_user[ANN].title) == ("mention", "Ada mentioned you on Design")
    assert (by_user[BOB].type, by_user[BOB].title) == ("comment", "Ada commented on Design")
    for row in rows:
        assert (row.actor_id, row.entity_type, row.entity_id, row.project_id, row.body) == (
            ACTOR,
            "phase",
            11,
            1,
            "hi @Ann",
        )


async def test_validate_mention_ids_keeps_existing_users_in_body_order():
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalars_result([BOB, ANN]))

    assert await validate_mention_ids(db, "@[Bob](9) @[Gone](99) @[Ann](8)") == [BOB, ANN]

    (stmt,) = db.execute.await_args.args
    assert stmt.column_descriptions[0]["name"] == "mentioned_id"


async def test_validate_mention_ids_without_tokens_runs_no_query():
    db = MagicMock()
    db.execute = AsyncMock()

    assert await validate_mention_ids(db, "plain text") == []
    db.execute.assert_not_awaited()


async def _stage(body: str, *, mentioned: list[int], assignees: list[int], level="phase"):
    db = MagicMock()
    # No token in the body: no mention lookup, the assignees come first.
    lookups = [scalars_result(mentioned)] if "@[" in body else []
    db.execute = AsyncMock(side_effect=[*lookups, scalars_result(assignees)])
    actor = SimpleNamespace(id=ACTOR, first_name="Ada", last_name="Admin")
    staged = await stage_booking_comment(
        db,
        actor,
        level=level,
        project_id=1,
        target_id=11,
        booked_id=BOOKED,
        pm_id=PM,
        target_name="Design",
        body=body,
    )
    return db, staged


async def test_stage_booking_comment_adds_the_comment_on_the_card_thread():
    db, staged = await _stage("Welcome @[Ann](8)", mentioned=[ANN], assignees=[])

    db.add.assert_called_once_with(staged.comment)
    comment = staged.comment
    assert (comment.entity_type, comment.entity_id, comment.project_id) == ("phase", 11, 1)
    assert (comment.author_id, comment.body, comment.parsed_mentions) == (
        ACTOR,
        "Welcome @[Ann](8)",
        [ANN],
    )
    db.add_all.assert_called_once_with(staged.notifications)
    (row,) = staged.notifications
    assert (row.user_id, row.type, row.body) == (ANN, "mention", "Welcome @Ann")
    assert row.title == "Ada Admin mentioned you on Design"
    assert staged.recipient_ids == {ANN}


async def test_stage_booking_comment_on_a_project_booking_uses_the_project_thread():
    _db, staged = await _stage("Hello", mentioned=[], assignees=[BOB], level="project")

    assert (staged.comment.entity_type, staged.comment.entity_id) == ("project", 1)
    (row,) = staged.notifications
    assert (row.user_id, row.type, row.entity_type, row.entity_id) == (BOB, "comment", "project", 1)


async def test_stage_booking_comment_leaves_the_booked_person_and_the_pm_to_the_booking():
    # The booked person gets assignment_changed, the PM project_changed: one
    # notification per person. A mentioned PM still gets the mention (the
    # caller passes it as already_notified to deliver).
    _db, staged = await _stage(
        "@[Booked](5) @[Pm](7) @[Bob](9)",
        mentioned=[BOOKED, PM, BOB],
        assignees=[BOOKED, PM, ANN, ACTOR],
    )

    by_user = {row.user_id: row.type for row in staged.notifications}
    assert by_user == {PM: "mention", BOB: "mention", ANN: "comment"}


async def test_stage_booking_comment_queries_mentions_then_assignees():
    db, _staged = await _stage("@[Ann](8)", mentioned=[ANN], assignees=[])

    first, second = (call.args[0] for call in db.execute.await_args_list)
    assert first.column_descriptions[0]["name"] == "mentioned_id"
    assert second.column_descriptions[0]["name"] == "staff_id"


def test_module_reexported_by_the_comment_route():
    from app.routers import kanban

    assert kanban._validate_mention_ids is card_comments.validate_mention_ids


async def test_publish_staged_without_a_comment_does_nothing():
    with patch.object(card_comments, "broadcast_change", AsyncMock()) as broadcast:
        await card_comments.publish_staged(MagicMock(), SimpleNamespace(id=ACTOR), None)
    broadcast.assert_not_awaited()


async def test_publish_staged_survives_a_failed_push(caplog):
    _db, staged = await _stage("@[Ann](8)", mentioned=[ANN], assignees=[])

    with (
        patch.object(card_comments, "broadcast_change", AsyncMock()) as broadcast,
        patch.object(
            card_comments, "send_notification", AsyncMock(side_effect=RuntimeError("down"))
        ),
    ):
        await card_comments.publish_staged(MagicMock(), SimpleNamespace(id=ACTOR), staged)

    assert broadcast.await_args.kwargs["entity_type"] == "card_comment"
    assert "Notification push failed for user 8" in caplog.text
