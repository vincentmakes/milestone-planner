"""
Routes of /api/todos (app/routers/todos.py): My Todos.

Todos are private rows: every query is pinned to the caller (assignee or
creator) and anyone else gets 404. The tests pin the merge with the approval
items, the permission rules (``todos.manage_own`` for one's own todos,
``todos.assign_others`` -- outright or through the PM bundle -- for someone
else's), the ownership rules of PUT / DELETE, and the side effects: the
``todo_assigned`` notification and the per-user ``todo:changed`` pushes (never
a tenant-wide broadcast).
"""

from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.notification import Notification
from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.todo import Todo
from app.models.user import User
from app.services.permissions import permission_required_detail
from tests.conftest import FakeUser

ME = 3
OTHER = 9
PM = 7


def _todo(**fields) -> Todo:
    values = {
        "id": 40,
        "title": "Write report",
        "notes": None,
        "due_date": None,
        "assignee_id": ME,
        "created_by": ME,
        "status": "open",
        "project_id": None,
        "entity_type": None,
        "entity_id": None,
        "completed_at": None,
        "created_at": datetime(2026, 10, 1, 8, 0),
        "updated_at": datetime(2026, 10, 1, 8, 0),
    }
    values.update(fields)
    return Todo(**values)


def _result(rows: list) -> MagicMock:
    result = MagicMock()
    result.all.return_value = list(rows)
    result.first.return_value = rows[0] if rows else None
    result.scalar_one_or_none.return_value = rows[0] if rows else None
    return result


class TodoDB:
    """
    Answers each SELECT by what it selects: the joined todo rows (``rows``;
    the single-item read after a write returns the written todo), one pinned
    todo (``todo``), the assignee's ``active`` flag (``assignee``), a card's
    project (``phase`` / ``subphase``) and a project's ``pm_id`` (``project``).
    """

    def __init__(self, session, **answers):
        self.session = session
        self.answers = answers
        self.statements: list = []
        self.added: list = []
        self.deleted: list = []
        session.execute = AsyncMock(side_effect=self.execute)
        session.add = MagicMock(side_effect=self.added.append)
        session.add_all = MagicMock(side_effect=self.added.extend)
        session.flush = AsyncMock(side_effect=self.flush)
        session.delete = AsyncMock(side_effect=self.deleted.append)

    async def flush(self) -> None:
        for obj in self.added:
            if isinstance(obj, Todo) and obj.id is None:
                obj.id = 41

    @property
    def todos(self) -> list[Todo]:
        return [obj for obj in self.added if isinstance(obj, Todo)]

    @property
    def notifications(self) -> list[Notification]:
        return [obj for obj in self.added if isinstance(obj, Notification)]

    def sql(self, index: int = 0) -> str:
        return str(self.statements[index].compile(compile_kwargs={"literal_binds": True}))

    async def execute(self, stmt):
        self.statements.append(stmt)
        columns = stmt.column_descriptions
        entity = columns[0].get("entity")
        if entity is Todo and len(columns) > 1:
            if "todos.id =" in str(stmt):
                return _result([self._item_row()])
            return _result(self.answers.get("rows", []))
        key = {
            Todo: "todo",
            User: "assignee",
            ProjectPhase: "phase",
            ProjectSubphase: "subphase",
            Project: "project",
        }.get(entity)
        if key is None:
            raise AssertionError(f"unexpected query: {stmt}")
        return _result(self.answers.get(key, []))

    def _item_row(self):
        todo = self.todos[0] if self.todos else self.answers["todo"][0]
        return (todo, "Assignee Name", "Creator Name", "Alpha" if todo.project_id else None)


@pytest.fixture
def pushes():
    with (
        patch("app.routers.todos.send_user_event", AsyncMock()) as event,
        patch("app.routers.todos.send_notification", AsyncMock()) as notify,
    ):
        yield SimpleNamespace(event=event, notify=notify)


def _pushed_to(pushes) -> list[int]:
    return sorted(call.args[1] for call in pushes.event.await_args_list)


# ---------------------------------------------------------
# GET /todos/mine
# ---------------------------------------------------------


def _approval_item(request_id: int, minute: int) -> dict:
    return {
        "id": f"approval:{request_id}",
        "kind": "approval",
        "title": "Rita Req asks to join Design at 50%",
        "notes": None,
        "due_date": None,
        "status": "open",
        "assignee_id": ME,
        "assignee_name": None,
        "created_by": 5,
        "created_by_name": "Rita Req",
        "project_id": 1,
        "project_name": "Alpha",
        "entity_type": "phase",
        "entity_id": 11,
        "completed_at": None,
        "approval_request": {
            "id": request_id,
            "action": "assignments.self_create",
            "status": "pending",
            "requester_id": 5,
            "project_id": 1,
            "level": "phase",
            "target_id": 11,
            "can_decide": True,
        },
        "created_at": datetime(2026, 10, 1, 9, minute),
        "updated_at": datetime(2026, 10, 1, 9, minute),
    }


@pytest.mark.asyncio
async def test_mine_merges_tasks_and_approvals_open_first_then_due_then_created(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))
    rows = [
        (_todo(id=1, status="done", due_date=date(2026, 10, 2)), "Me", "Me", None),
        (_todo(id=2, due_date=None, created_at=datetime(2026, 10, 1, 7)), "Me", "Me", None),
        (_todo(id=3, due_date=date(2026, 10, 20), project_id=1), "Me", "Boss", "Alpha"),
        (_todo(id=4, due_date=date(2026, 10, 10), created_by=OTHER), "Me", "Boss", None),
        (_todo(id=5, assignee_id=OTHER, due_date=date(2026, 10, 10)), "Otto", "Me", None),
    ]
    TodoDB(mock_db_session, rows=rows)
    approvals_to_decide = AsyncMock(return_value=[_approval_item(8, 30)])

    with patch("app.routers.todos.approvals.decidable_todo_items", approvals_to_decide):
        response = await client.get("/api/todos/mine?status=all")

    assert response.status_code == 200
    items = response.json()
    # Open first; by due date (none last); then oldest first (task 4 is older than 5).
    assert [i["id"] for i in items] == [4, 5, 3, 2, "approval:8", 1]
    task = next(i for i in items if i["id"] == 3)
    assert task["kind"] == "task" and task["due_date"] == "2026-10-20"
    assert (task["created_by_name"], task["project_name"]) == ("Boss", "Alpha")
    assert task["created_at"] == "2026-10-01T08:00:00.000Z"
    approval = next(i for i in items if i["kind"] == "approval")
    assert approval["approval_request"]["id"] == 8 and approval["status"] == "open"


@pytest.mark.asyncio
async def test_mine_is_pinned_to_the_caller_and_open_by_default(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))
    db = TodoDB(mock_db_session)

    with patch("app.routers.todos.approvals.decidable_todo_items", AsyncMock(return_value=[])):
        response = await client.get("/api/todos/mine")

    assert response.status_code == 200 and response.json() == []
    sql = db.sql()
    assert f"todos.assignee_id = {ME} OR todos.created_by = {ME}" in sql
    assert "todos.status = 'open'" in sql


@pytest.mark.asyncio
async def test_mine_rejects_an_unknown_status(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))
    assert (await client.get("/api/todos/mine?status=done")).status_code == 422


@pytest.mark.asyncio
async def test_mine_reads_the_real_approval_items(authed_client, mock_db_session):
    """Without the patch: the approvals service's own query runs (no policies,
    no rows), so the route wires the caller and the request through."""
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))
    TodoDB(mock_db_session)

    with patch(
        "app.services.approvals._to_decide_rows", AsyncMock(return_value=([], {}, None))
    ) as rows:
        response = await client.get("/api/todos/mine")

    assert response.status_code == 200 and response.json() == []
    assert rows.await_args.args[2].id == ME


# ---------------------------------------------------------
# POST /todos
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_create_own_todo(authed_client, mock_db_session, pushes):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))
    db = TodoDB(mock_db_session)

    response = await client.post(
        "/api/todos", json={"title": "  Order reagents ", "due_date": "2026-11-02"}
    )

    assert response.status_code == 201
    (todo,) = db.todos
    assert (todo.title, todo.assignee_id, todo.created_by) == ("Order reagents", ME, ME)
    assert todo.due_date == date(2026, 11, 2) and todo.status == "open"
    assert not db.notifications
    mock_db_session.commit.assert_awaited_once()
    assert _pushed_to(pushes) == [ME]  # once, though assignee and creator
    assert pushes.event.await_args.args[2:] == (
        "todo:changed",
        {"id": 41, "kind": "task", "action": "create"},
    )
    pushes.notify.assert_not_awaited()
    body = response.json()
    assert body["id"] == 41 and body["kind"] == "task" and body["due_date"] == "2026-11-02"


@pytest.mark.asyncio
async def test_own_todo_needs_manage_own(authed_client, mock_db_session, pushes):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user", set()))
    db = TodoDB(mock_db_session)

    response = await client.post("/api/todos", json={"title": "Mine"})

    assert response.status_code == 403
    assert response.json()["detail"] == permission_required_detail("todos.manage_own")
    assert not db.statements and not db.todos


@pytest.mark.asyncio
async def test_todo_for_someone_else_needs_assign_others(authed_client, mock_db_session, pushes):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))
    db = TodoDB(mock_db_session, assignee=[1])

    response = await client.post("/api/todos", json={"title": "Yours", "assignee_id": OTHER})

    assert response.status_code == 403
    assert response.json()["detail"] == permission_required_detail("todos.assign_others")
    assert not db.todos
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_todo_for_someone_else_notifies_and_pushes_both(
    authed_client, mock_db_session, pushes
):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    db = TodoDB(mock_db_session, assignee=[1])

    response = await client.post(
        "/api/todos", json={"title": "Prepare QC checklist", "assignee_id": OTHER}
    )

    assert response.status_code == 201
    (todo,) = db.todos
    assert (todo.assignee_id, todo.created_by) == (OTHER, 5)
    (note,) = db.notifications
    assert (note.user_id, note.type, note.actor_id) == (OTHER, "todo_assigned", 5)
    assert (note.entity_type, note.entity_id) == ("todo", 41)
    assert note.title == "Test User5 assigned you a task: Prepare QC checklist"
    assert _pushed_to(pushes) == [5, OTHER]
    pushes.notify.assert_awaited_once()
    assert pushes.notify.await_args.args[1] == OTHER


@pytest.mark.asyncio
async def test_project_manager_assigns_on_their_project(authed_client, mock_db_session, pushes):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))  # holds projects.manage_as_pm by default
    db = TodoDB(mock_db_session, assignee=[1], project=[(PM,)])

    response = await client.post(
        "/api/todos", json={"title": "Check pH", "assignee_id": OTHER, "project_id": 1}
    )

    assert response.status_code == 201
    assert db.todos[0].project_id == 1
    assert response.json()["project_name"] == "Alpha"


@pytest.mark.asyncio
async def test_project_manager_bundle_stops_at_other_projects(
    authed_client, mock_db_session, pushes
):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    TodoDB(mock_db_session, assignee=[1], project=[(OTHER,)])

    response = await client.post(
        "/api/todos", json={"title": "Check pH", "assignee_id": OTHER, "project_id": 1}
    )

    assert response.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("assignee", "status_code", "detail"),
    [
        ([], 404, "User not found"),
        ([0], 400, "Cannot assign a todo to an inactive user"),
    ],
)
async def test_assignee_must_exist_and_be_active(
    authed_client, mock_db_session, pushes, assignee, status_code, detail
):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    TodoDB(mock_db_session, assignee=assignee)

    response = await client.post("/api/todos", json={"title": "X", "assignee_id": OTHER})

    assert response.status_code == status_code and response.json()["detail"] == detail


@pytest.mark.asyncio
async def test_assignee_outside_the_callers_sites_is_404(
    authed_client, mock_db_session, pushes, site_links
):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser", site_ids=[1]))
    site_links.people[OTHER] = [2]
    TodoDB(mock_db_session, assignee=[1])

    response = await client.post("/api/todos", json={"title": "X", "assignee_id": OTHER})

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_card_link_resolves_its_project(authed_client, mock_db_session, pushes):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))
    db = TodoDB(mock_db_session, subphase=[(1,)], project=[(PM,)])

    response = await client.post(
        "/api/todos", json={"title": "Sample", "entity_type": "subphase", "entity_id": 12}
    )

    assert response.status_code == 201
    todo = db.todos[0]
    assert (todo.project_id, todo.entity_type, todo.entity_id) == (1, "subphase", 12)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("body", "answers", "status_code"),
    [
        # The card belongs to another project.
        ({"project_id": 2, "entity_type": "phase", "entity_id": 11}, {"phase": [(1,)]}, 400),
        ({"entity_type": "phase", "entity_id": 11}, {}, 404),  # unknown card
        ({"project_id": 2}, {}, 404),  # unknown project
        ({"entity_type": "phase"}, {}, 422),  # half a card link
        ({"title": "   "}, {}, 422),  # blank title
    ],
)
async def test_create_rejects_bad_links_and_titles(
    authed_client, mock_db_session, pushes, body, answers, status_code
):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))
    db = TodoDB(mock_db_session, **answers)

    response = await client.post("/api/todos", json={"title": "Task", **body})

    assert response.status_code == status_code
    assert not db.todos


@pytest.mark.asyncio
async def test_project_at_an_invisible_site_is_403(
    authed_client, mock_db_session, pushes, site_links
):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user", site_ids=[1]))
    site_links.projects[2] = 5
    TodoDB(mock_db_session, project=[(PM,)])

    response = await client.post("/api/todos", json={"title": "Task", "project_id": 2})

    assert response.status_code == 403


# ---------------------------------------------------------
# PUT /todos/{id}
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_update_is_pinned_to_assignee_or_creator(authed_client, mock_db_session, pushes):
    client, set_user = authed_client
    set_user(FakeUser(OTHER, "admin"))
    db = TodoDB(mock_db_session)  # the pinned lookup finds nothing

    response = await client.put("/api/todos/40", json={"status": "done"})

    assert response.status_code == 404 and response.json()["detail"] == "Todo not found"
    sql = db.sql()
    assert "todos.id = 40" in sql
    assert f"todos.assignee_id = {OTHER} OR todos.created_by = {OTHER}" in sql
    pushes.event.assert_not_awaited()


@pytest.mark.asyncio
async def test_assignee_completes_and_reopens(authed_client, mock_db_session, pushes):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))
    todo = _todo(created_by=OTHER)
    TodoDB(mock_db_session, todo=[todo])

    response = await client.put("/api/todos/40", json={"status": "done"})

    assert response.status_code == 200
    assert todo.status == "done" and todo.completed_at is not None
    assert response.json()["status"] == "done"
    assert _pushed_to(pushes) == [ME, OTHER]
    assert pushes.event.await_args.args[3] == {"id": 40, "kind": "task", "action": "update"}

    response = await client.put("/api/todos/40", json={"status": "open"})
    assert todo.status == "open" and todo.completed_at is None


@pytest.mark.asyncio
async def test_update_edits_fields_and_clears_explicit_nulls(
    authed_client, mock_db_session, pushes
):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))
    todo = _todo(notes="old", due_date=date(2026, 10, 9), project_id=1, entity_type="phase")
    todo.entity_id = 11
    TodoDB(mock_db_session, todo=[todo])

    response = await client.put(
        "/api/todos/40",
        json={"title": "Renamed", "notes": None, "due_date": None, "project_id": None},
    )

    assert response.status_code == 200
    assert (todo.title, todo.notes, todo.due_date) == ("Renamed", None, None)
    # Leaving the project drops the card link too.
    assert (todo.project_id, todo.entity_type, todo.entity_id) == (None, None, None)


@pytest.mark.asyncio
async def test_assignee_without_manage_own_cannot_update(authed_client, mock_db_session, pushes):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user", set()))
    TodoDB(mock_db_session, todo=[_todo()])

    response = await client.put("/api/todos/40", json={"status": "done"})

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_creator_of_someone_elses_todo_needs_assign_others(
    authed_client, mock_db_session, pushes
):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))  # lost todos.assign_others since creating it
    TodoDB(mock_db_session, todo=[_todo(assignee_id=OTHER)])

    response = await client.put("/api/todos/40", json={"title": "Edited"})

    assert response.status_code == 403
    assert response.json()["detail"] == permission_required_detail("todos.assign_others")


@pytest.mark.asyncio
async def test_reassigning_notifies_the_new_assignee_and_pushes_everyone(
    authed_client, mock_db_session, pushes
):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    todo = _todo(assignee_id=ME, created_by=5)
    db = TodoDB(mock_db_session, todo=[todo], assignee=[1])

    response = await client.put("/api/todos/40", json={"assignee_id": OTHER})

    assert response.status_code == 200
    assert todo.assignee_id == OTHER
    (note,) = db.notifications
    assert (note.user_id, note.type, note.entity_id) == (OTHER, "todo_assigned", 40)
    assert _pushed_to(pushes) == [ME, 5, OTHER]  # old assignee, creator, new assignee


@pytest.mark.asyncio
async def test_handing_ones_own_todo_to_someone_else_needs_assign_others(
    authed_client, mock_db_session, pushes
):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))
    TodoDB(mock_db_session, todo=[_todo()], assignee=[1])

    response = await client.put("/api/todos/40", json={"assignee_id": OTHER})

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_update_rejects_bad_input(authed_client, mock_db_session, pushes):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))
    TodoDB(mock_db_session, todo=[_todo()])

    assert (await client.put("/api/todos/40", json={"status": "later"})).status_code == 422
    assert (await client.put("/api/todos/40", json={"title": ""})).status_code == 422


@pytest.mark.asyncio
async def test_moving_a_todo_to_a_card_resolves_its_project(authed_client, mock_db_session, pushes):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))
    todo = _todo()
    TodoDB(mock_db_session, todo=[todo], phase=[(1,)], project=[(PM,)])

    response = await client.put("/api/todos/40", json={"entity_type": "phase", "entity_id": 11})

    assert response.status_code == 200
    assert (todo.project_id, todo.entity_type, todo.entity_id) == (1, "phase", 11)


# ---------------------------------------------------------
# DELETE /todos/{id}
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_creator_deletes(authed_client, mock_db_session, pushes):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    todo = _todo(assignee_id=OTHER, created_by=5)
    db = TodoDB(mock_db_session, todo=[todo])

    response = await client.delete("/api/todos/40")

    assert response.status_code == 200 and response.json() == {"success": True, "id": 40}
    assert db.deleted == [todo]
    mock_db_session.commit.assert_awaited_once()
    assert _pushed_to(pushes) == [5, OTHER]
    assert pushes.event.await_args.args[3]["action"] == "delete"


@pytest.mark.asyncio
async def test_assignee_cannot_delete_someone_elses_todo(authed_client, mock_db_session, pushes):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))
    db = TodoDB(mock_db_session, todo=[_todo(created_by=OTHER)])

    response = await client.delete("/api/todos/40")

    assert response.status_code == 403
    assert response.json()["detail"] == "Only the creator can delete this todo"
    assert not db.deleted


@pytest.mark.asyncio
async def test_assignee_deletes_once_the_creator_is_gone(authed_client, mock_db_session, pushes):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))
    todo = _todo(created_by=None)
    db = TodoDB(mock_db_session, todo=[todo])

    assert (await client.delete("/api/todos/40")).status_code == 200
    assert db.deleted == [todo]


@pytest.mark.asyncio
async def test_strangers_get_404_on_delete(authed_client, mock_db_session, pushes):
    client, set_user = authed_client
    set_user(FakeUser(OTHER, "superuser"))
    db = TodoDB(mock_db_session)

    assert (await client.delete("/api/todos/40")).status_code == 404
    assert not db.deleted


@pytest.mark.asyncio
async def test_todo_writes_are_never_broadcast_tenant_wide(authed_client, mock_db_session, pushes):
    client, set_user = authed_client
    set_user(FakeUser(ME, "user"))
    TodoDB(mock_db_session)

    with patch("app.middleware.broadcast.manager.broadcast_to_tenant", AsyncMock()) as broadcast:
        assert (await client.post("/api/todos", json={"title": "Quiet"})).status_code == 201

    broadcast.assert_not_awaited()


@pytest.mark.asyncio
async def test_creator_with_the_pm_bundle_edits_the_todo_they_assigned(
    authed_client, mock_db_session, pushes
):
    """The link is unchanged: the project's manager is read to apply the bundle;
    an explicit null title keeps the title."""
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    todo = _todo(assignee_id=OTHER, created_by=PM, project_id=1)
    db = TodoDB(mock_db_session, todo=[todo], project=[(PM,)])

    response = await client.put("/api/todos/40", json={"title": None, "due_date": "2026-11-20"})

    assert response.status_code == 200
    assert todo.title == "Write report" and todo.due_date == date(2026, 11, 20)
    assert "projects.pm_id" in db.sql(1)
