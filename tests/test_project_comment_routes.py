"""
Project comment threads (2.0.0) and the comment read gates.

A project carries its own thread (``entity_type = 'project'``, ``entity_id`` =
the project id), shown in the booking dialog of its project-level bookings;
cards keep theirs. Reading a thread and the mention picker need no key (project
or site visibility only), posting keeps ``kanban.comment``, the comment counts
keep ``views.kanban``. A post on a project thread notifies the mentioned users
and the project's approved project-level assignees.
"""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.card_comment import CardComment
from app.models.notification import Notification
from app.services.notifications import card_assignee_ids
from app.services.permissions import default_modes, permission_required_detail
from tests.conftest import FakeUser
from tests.support import card_target_result, scalar_result, scalars_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)


def make_project(project_id=3, name="Bioprocess Scale-Up", archived=False):
    return SimpleNamespace(id=project_id, name=name, site_id=1, archived=archived)


def make_card(project_id=3):
    return SimpleNamespace(id=10, project_id=project_id, name=None, type="Design")


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


def without_kanban_view(user_id=5) -> FakeUser:
    modes = {k: m for k, m in default_modes("user").items() if k != "views.kanban"}
    return FakeUser(user_id, "user", modes, site_ids=[1])


# ---------------------------------------------------------------------------
# Read a project thread
# ---------------------------------------------------------------------------


async def test_project_thread_is_read_without_the_kanban_key(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(without_kanban_view())
    comment = CardComment(
        id=70,
        entity_type="project",
        entity_id=3,
        project_id=3,
        author_id=7,
        body="Kick-off on Monday",
        created_at=STAMP,
        updated_at=STAMP,
    )
    mock_db_session.execute.side_effect = [
        scalar_result(make_project()),
        rows_result([(comment, "Ada", "Lovelace")]),
    ]

    response = await client.get("/api/kanban/cards/project/3/comments")

    assert response.status_code == 200
    (item,) = response.json()
    assert (item["entity_type"], item["entity_id"], item["project_id"]) == ("project", 3, 3)
    assert (item["author_name"], item["body"]) == ("Ada Lovelace", "Kick-off on Monday")
    target_sql = str(mock_db_session.execute.await_args_list[0].args[0])
    assert "FROM projects" in target_sql
    thread_sql = mock_db_session.execute.await_args_list[1].args[0]
    params = thread_sql.compile().params
    assert "project" in params.values() and 3 in params.values()


async def test_unknown_project_thread_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.get("/api/kanban/cards/project/99/comments")

    assert response.status_code == 404
    assert response.json()["detail"] == "Project not found"
    assert mock_db_session.execute.await_count == 1


async def test_card_thread_always_loads_its_card(authed_client, mock_db_session):
    # Even with sites.view_all (no visibility query), an unknown card is a 404.
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [card_target_result(None)]

    response = await client.get("/api/kanban/cards/phase/99/comments")

    assert response.status_code == 404
    assert response.json()["detail"] == "Phase not found"


async def test_project_thread_outside_the_visible_sites_is_403(
    authed_client, mock_db_session, site_links
):
    client, set_user = authed_client
    set_user(FakeUser(5, "user", site_ids=[1]))
    site_links.projects[3] = 2
    mock_db_session.execute.side_effect = [scalar_result(make_project())]

    response = await client.get("/api/kanban/cards/project/3/comments")

    assert response.status_code == 403
    assert mock_db_session.execute.await_count == 1  # never reads the thread


def without_archived_view(user_id=5) -> FakeUser:
    modes = {k: m for k, m in default_modes("user").items() if k != "views.archived"}
    return FakeUser(user_id, "user", modes, site_ids=[1])


async def test_an_archived_project_thread_needs_views_archived(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(without_archived_view())
    mock_db_session.execute.side_effect = [scalar_result(make_project(archived=True))]

    response = await client.get("/api/kanban/cards/project/3/comments")

    assert response.status_code == 403
    assert response.json()["detail"] == permission_required_detail("views.archived")
    assert mock_db_session.execute.await_count == 1  # never reads the thread


async def test_an_archived_card_thread_needs_views_archived(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(without_archived_view())
    mock_db_session.execute.side_effect = [card_target_result(make_card(), archived=True)]

    response = await client.get("/api/kanban/cards/phase/10/comments")

    assert response.status_code == 403
    assert response.json()["detail"] == permission_required_detail("views.archived")
    target_sql = str(mock_db_session.execute.await_args_list[0].args[0])
    assert "JOIN projects" in target_sql and "projects.archived" in target_sql


async def test_an_archived_thread_reads_with_views_archived(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user", site_ids=[1]))  # the shipped user role holds views.archived
    mock_db_session.execute.side_effect = [
        card_target_result(make_card(), archived=True),
        rows_result([]),
    ]

    response = await client.get("/api/kanban/cards/phase/10/comments")

    assert response.status_code == 200
    assert response.json() == []


@pytest.mark.parametrize("entity_type", ["task", "todo", "projects"])
async def test_unknown_entity_type_is_422(authed_client, mock_db_session, entity_type):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    get = await client.get(f"/api/kanban/cards/{entity_type}/3/comments")
    post = await client.post(f"/api/kanban/cards/{entity_type}/3/comments", json={"body": "hi"})

    assert (get.status_code, post.status_code) == (422, 422)
    mock_db_session.execute.assert_not_awaited()


async def test_comment_threads_require_authentication(app_client):
    assert (await app_client.get("/api/kanban/cards/project/3/comments")).status_code == 401


# ---------------------------------------------------------------------------
# Post on a project thread
# ---------------------------------------------------------------------------


async def test_post_on_a_project_thread_notifies_mentions_and_project_assignees(
    authed_client, db_stamps_comments, wires
):
    client, set_user = authed_client
    set_user(without_kanban_view())
    broadcast, push, assignees = wires
    db = db_stamps_comments
    assignees.return_value = [7, 8, 5]  # 7 also mentioned; 5 is the author
    db.execute.side_effect = [scalar_result(make_project()), scalars_result([7])]

    response = await client.post(
        "/api/kanban/cards/project/3/comments", json={"body": "Ping @[Bob](7)"}
    )

    assert response.status_code == 201
    body = response.json()
    assert (body["entity_type"], body["entity_id"], body["project_id"]) == ("project", 3, 3)
    assert body["mentioned_user_ids"] == [7]
    assignees.assert_awaited_once()
    assert assignees.await_args.args[1:] == ("project", 3)
    (comment,) = (c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], CardComment))
    assert (comment.entity_type, comment.entity_id, comment.project_id) == ("project", 3, 3)
    sent = notifications(db)
    assert {(n.user_id, n.type) for n in sent} == {(7, "mention"), (8, "comment")}
    for row in sent:
        assert (row.entity_type, row.entity_id, row.project_id) == ("project", 3, 3)
    by_type = {n.type: n for n in sent}
    assert by_type["mention"].title == "Test User5 mentioned you on Bioprocess Scale-Up"
    assert by_type["comment"].title == "Test User5 commented on Bioprocess Scale-Up"
    assert broadcast.await_args.kwargs["entity_type"] == "card_comment"
    assert broadcast.await_args.kwargs["project_id"] == 3
    assert broadcast.await_args.kwargs["summary"] == "commented on Bioprocess Scale-Up"
    assert sorted(c.args[1] for c in push.await_args_list) == [7, 8]


async def test_post_on_an_unknown_project_is_404(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    broadcast, _, _ = wires
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.post("/api/kanban/cards/project/99/comments", json={"body": "hi"})

    assert response.status_code == 404
    assert response.json()["detail"] == "Project not found"
    mock_db_session.add.assert_not_called()
    broadcast.assert_not_awaited()


async def test_post_on_a_project_thread_needs_kanban_comment(authed_client, mock_db_session):
    client, set_user = authed_client
    modes = {k: m for k, m in default_modes("user").items() if k != "kanban.comment"}
    set_user(FakeUser(5, "user", modes, site_ids=[1]))

    response = await client.post("/api/kanban/cards/project/3/comments", json={"body": "hi"})

    assert response.status_code == 403
    assert response.json()["detail"] == "Permission required: kanban.comment"
    mock_db_session.execute.assert_not_awaited()


async def test_post_on_a_project_outside_the_visible_sites_is_403(
    authed_client, mock_db_session, site_links, wires
):
    client, set_user = authed_client
    set_user(FakeUser(5, "user", site_ids=[1]))
    site_links.projects[3] = 2
    mock_db_session.execute.side_effect = [scalar_result(make_project())]

    response = await client.post("/api/kanban/cards/project/3/comments", json={"body": "hi"})

    assert response.status_code == 403
    mock_db_session.add.assert_not_called()


# ---------------------------------------------------------------------------
# The card routes stay card-only
# ---------------------------------------------------------------------------


async def test_status_and_assignees_do_not_take_a_project(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = rows_result([])

    status = await client.put("/api/kanban/cards/project/3/status", json={"status": "done"})
    assign = await client.post("/api/kanban/cards/project/3/assignees", json={"staff_id": 5})
    counts = await client.get("/api/kanban/projects/3/comment-counts")

    assert (status.status_code, assign.status_code) == (422, 422)
    assert counts.status_code == 200
    mock_db_session.execute.assert_awaited_once()  # the counts query only


async def test_comment_counts_leave_project_threads_out(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.return_value = rows_result([("phase", 10, 2), ("project", 3, 4)])

    response = await client.get("/api/kanban/projects/3/comment-counts")

    assert response.json() == {"phase": {"10": 2}, "subphase": {}}


# ---------------------------------------------------------------------------
# card_assignee_ids
# ---------------------------------------------------------------------------


def _db(ids):
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalars_result(ids))
    return db


async def test_project_assignees_are_the_approved_project_level_bookings():
    db = _db([8, 7, 8])

    assert await card_assignee_ids(db, "project", 3) == [8, 7]

    sql = str(db.execute.await_args.args[0])
    assert "FROM project_assignments" in sql
    assert "project_assignments.project_id" in sql
    assert "project_assignments.approval_status" in sql


@pytest.mark.parametrize(
    ("entity_type", "table"),
    [("phase", "phase_staff_assignments"), ("subphase", "subphase_staff_assignments")],
)
async def test_card_assignees_read_their_own_table(entity_type, table):
    db = _db([5])

    assert await card_assignee_ids(db, entity_type, 10) == [5]

    assert f"FROM {table}" in str(db.execute.await_args.args[0])


async def test_an_unknown_type_never_falls_through_to_subphases():
    db = _db([5])

    with pytest.raises(ValueError, match="Unknown comment entity type"):
        await card_assignee_ids(db, "task", 10)

    db.execute.assert_not_awaited()
