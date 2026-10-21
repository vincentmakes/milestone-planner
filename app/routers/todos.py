"""
Todos API (My Todos): personal and assigned tasks, plus the approvals to decide.

Private like notifications: every query is pinned to the caller -- a todo is
seen by its assignee and its creator only, and anyone else gets 404 (never
403), so ids cannot be probed. Writes are never broadcast tenant-wide
(``/api/todos`` is in ``BroadcastMiddleware.SKIP_PATTERNS``): the assignee and
the creator get a per-user ``todo:changed`` push instead, and a new assignee
other than the actor a ``todo_assigned`` notification.

- ``GET /todos/mine?status=open|all`` -- the caller's tasks (assigned to or
  created by them; ``kind: 'task'``) merged with the pending approval requests
  they may decide (``kind: 'approval'``, id ``approval:<n>``, resolved live by
  app/services/approvals.py); open first, then by due date (none last), then
  oldest first.
- ``POST /todos`` -- the assignee defaults to the caller. One's own todo needs
  ``todos.manage_own``; a todo for someone else ``todos.assign_others``,
  outright or through the PM bundle on its ``project_id``, and the assignee
  must be an active person the caller can see.
- ``PUT /todos/{id}`` -- partial update (``status`` included) by the assignee
  or the creator, under the same rule, checked for the todo as it is and as
  it becomes.
- ``DELETE /todos/{id}`` -- the creator (or the assignee once the creator's
  account is gone); the assignee of someone else's todo gets 403.
"""

import logging
from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.database import get_db, get_db_readonly
from app.middleware.auth import get_current_user
from app.models.notification import Notification
from app.models.project import Project
from app.models.todo import Todo
from app.models.user import User
from app.schemas.todo import (
    TodoCreate,
    TodoDeleteResponse,
    TodoItem,
    TodoListStatus,
    TodoUpdate,
)
from app.services import approvals
from app.services.notifications import build_notifications, notification_payload
from app.services.permissions import permission_required_detail
from app.services.project_access import (
    project_id_for_phase,
    project_id_for_subphase,
    project_pm_id,
    user_can,
)
from app.services.site_access import ensure_project_visible, person_is_visible
from app.utils import utcnow_naive
from app.websocket.broadcast import send_notification, send_user_event

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/todos", tags=["todos"])

MANAGE_OWN_KEY = "todos.manage_own"
ASSIGN_OTHERS_KEY = "todos.assign_others"

TODO_NOT_FOUND_DETAIL = "Todo not found"
ASSIGNEE_NOT_FOUND_DETAIL = "User not found"
ASSIGNEE_INACTIVE_DETAIL = "Cannot assign a todo to an inactive user"
CREATOR_ONLY_DETAIL = "Only the creator can delete this todo"
CARD_PROJECT_MISMATCH_DETAIL = "The card does not belong to that project"

_TITLE_MAX = 200

_assignee = aliased(User)
_creator = aliased(User)


# ---------------------------------------------------------
# Reading
# ---------------------------------------------------------


def _mine(user_id: int) -> Any:
    """The pin every todo query carries: assigned to or created by the caller."""
    return or_(Todo.assignee_id == user_id, Todo.created_by == user_id)


def _rows_query() -> Any:
    """Todos with their assignee's, creator's and project's names (one query)."""
    return (
        select(
            Todo,
            (_assignee.first_name + " " + _assignee.last_name).label("assignee_name"),
            (_creator.first_name + " " + _creator.last_name).label("created_by_name"),
            Project.name.label("project_name"),
        )
        .outerjoin(_assignee, _assignee.id == Todo.assignee_id)
        .outerjoin(_creator, _creator.id == Todo.created_by)
        .outerjoin(Project, Project.id == Todo.project_id)
    )


def _serialize(row: Any) -> dict[str, Any]:
    todo: Todo = row[0]
    return {
        "id": todo.id,
        "kind": "task",
        "title": todo.title,
        "notes": todo.notes,
        "due_date": todo.due_date,
        "status": todo.status,
        "assignee_id": todo.assignee_id,
        "assignee_name": row[1],
        "created_by": todo.created_by,
        "created_by_name": row[2],
        "project_id": todo.project_id,
        "project_name": row[3],
        "entity_type": todo.entity_type,
        "entity_id": todo.entity_id,
        "completed_at": todo.completed_at,
        "approval_request": None,
        "created_at": todo.created_at,
        "updated_at": todo.updated_at,
    }


def _sort_key(item: dict[str, Any]) -> tuple[Any, ...]:
    """Open first, then by due date (none last), then oldest first."""
    due: date | None = item["due_date"]
    created: datetime | None = item["created_at"]
    return (
        item["status"] != "open",
        due is None,
        due or date.max,
        created or datetime.min,
        str(item["id"]),
    )


@router.get("/mine", response_model=list[TodoItem])
async def list_my_todos(
    request: Request,
    status_filter: TodoListStatus = Query("open", alias="status"),
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(get_current_user),
):
    """The caller's tasks and the approvals they may decide (see module doc)."""
    query = _rows_query().where(_mine(user.id))
    if status_filter == "open":
        query = query.where(Todo.status == "open")
    items = [_serialize(row) for row in (await db.execute(query)).all()]
    items.extend(await approvals.decidable_todo_items(db, request, user))
    return sorted(items, key=_sort_key)


async def _load_todo(db: AsyncSession, user: User, todo_id: int) -> Todo:
    """The todo when the caller is its assignee or creator, else 404."""
    todo: Todo | None = (
        await db.execute(select(Todo).where(Todo.id == todo_id, _mine(user.id)))
    ).scalar_one_or_none()
    if todo is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=TODO_NOT_FOUND_DETAIL)
    return todo


async def _item(db: AsyncSession, todo_id: int) -> dict[str, Any]:
    """A written todo as a ``TodoItem`` dict, names included."""
    row = (await db.execute(_rows_query().where(Todo.id == todo_id))).first()
    return _serialize(row)


# ---------------------------------------------------------
# Rules
# ---------------------------------------------------------


def _forbidden(key: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN, detail=permission_required_detail(key)
    )


def _check_rights(user: User, assignee_id: int, pm_id: int | None) -> None:
    """``todos.manage_own`` for one's own todo; ``todos.assign_others`` (or the
    PM bundle on the linked project, whose manager is `pm_id`) for another's."""
    if assignee_id == user.id:
        if not user.permissions.has(MANAGE_OWN_KEY):
            raise _forbidden(MANAGE_OWN_KEY)
    elif not user_can(user, ASSIGN_OTHERS_KEY, pm_id):
        raise _forbidden(ASSIGN_OTHERS_KEY)


async def _pm_if_needed(
    db: AsyncSession, user: User, assignee_id: int, project_id: int | None
) -> int | None:
    """The project's manager, read only when the PM bundle can decide
    ``_check_rights`` (someone else's todo, ``todos.assign_others`` not held
    outright, a linked project)."""
    if assignee_id == user.id or project_id is None or user.permissions.has(ASSIGN_OTHERS_KEY):
        return None
    return await project_pm_id(db, project_id)


async def _ensure_assignee(db: AsyncSession, http: Request, user: User, assignee_id: int) -> None:
    """Someone else as assignee: an existing, active person the caller can see."""
    if assignee_id == user.id:
        return
    active = (
        await db.execute(select(User.active).where(User.id == assignee_id))
    ).scalar_one_or_none()
    if active is None or not await person_is_visible(http, db, user, assignee_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ASSIGNEE_NOT_FOUND_DETAIL)
    if active != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=ASSIGNEE_INACTIVE_DETAIL
        )


async def _resolve_link(
    db: AsyncSession,
    http: Request,
    user: User,
    *,
    project_id: int | None,
    entity_type: str | None,
    entity_id: int | None,
) -> tuple[int | None, int | None]:
    """
    The link's project id (a card's own project when only the card is given)
    and that project's manager. 404 for an unknown card or project, 400 when
    the card is not in the given project, 403 when the project's site is not
    visible to the caller.
    """
    if entity_type is not None and entity_id is not None:
        if entity_type == "phase":
            owner = await project_id_for_phase(db, entity_id)
        else:
            owner = await project_id_for_subphase(db, entity_id)
        if project_id is not None and project_id != owner:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=CARD_PROJECT_MISMATCH_DETAIL
            )
        project_id = owner
    if project_id is None:
        return None, None
    pm_id = await project_pm_id(db, project_id)
    await ensure_project_visible(http, db, user, project_id)
    return project_id, pm_id


# ---------------------------------------------------------
# Effects
# ---------------------------------------------------------


def _assigned_notifications(user: User, todo: Todo) -> list[Notification]:
    """``todo_assigned`` to the assignee (none when the actor is the assignee)."""
    actor = approvals.display_name(user)
    return build_notifications(
        recipient_ids=[todo.assignee_id],
        notification_type="todo_assigned",
        actor_id=user.id,
        entity_type="todo",
        entity_id=todo.id,
        project_id=todo.project_id,
        title=f"{actor} assigned you a task: {todo.title}"[:_TITLE_MAX],
        body=todo.notes,
    )


async def _publish(
    http: Request,
    todo_id: int,
    action: str,
    recipients: set[int | None],
    notifications: list[Notification],
) -> None:
    """After the commit: the notifications, then ``todo:changed`` to each
    person concerned. Live hints only; a failed push never fails the request."""
    for row in notifications:
        try:
            await send_notification(http, row.user_id, notification_payload(row))
        except Exception as e:  # pragma: no cover - defensive, like kanban pushes
            logger.warning("Notification push failed for user %s: %s", row.user_id, e)
    payload = {"id": todo_id, "kind": "task", "action": action}
    for user_id in sorted(uid for uid in recipients if uid is not None):
        try:
            await send_user_event(http, user_id, "todo:changed", payload)
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("todo:changed push failed for user %s: %s", user_id, e)


# ---------------------------------------------------------
# Writing
# ---------------------------------------------------------


@router.post("", response_model=TodoItem, status_code=status.HTTP_201_CREATED)
async def create_todo(
    data: TodoCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Create a task (for oneself unless ``assignee_id`` names someone else)."""
    assignee_id = data.assignee_id if data.assignee_id is not None else user.id
    if assignee_id == user.id:
        _check_rights(user, assignee_id, None)  # before any query
    project_id, pm_id = await _resolve_link(
        db,
        request,
        user,
        project_id=data.project_id,
        entity_type=data.entity_type,
        entity_id=data.entity_id,
    )
    _check_rights(user, assignee_id, pm_id)
    await _ensure_assignee(db, request, user, assignee_id)

    todo = Todo(
        title=data.title,
        notes=data.notes,
        due_date=data.due_date,
        assignee_id=assignee_id,
        created_by=user.id,
        status="open",
        project_id=project_id,
        entity_type=data.entity_type,
        entity_id=data.entity_id,
    )
    db.add(todo)
    await db.flush()
    notifications = _assigned_notifications(user, todo)
    db.add_all(notifications)
    await db.commit()

    await _publish(request, todo.id, "create", {todo.assignee_id, user.id}, notifications)
    return await _item(db, todo.id)


def _new_link(todo: Todo, data: TodoUpdate) -> tuple[int | None, str | None, int | None]:
    """The project / card link after a partial update. Moving to another
    project (or none) without naming a card drops the card."""
    fields = data.model_fields_set
    project_id = data.project_id if "project_id" in fields else todo.project_id
    if "entity_type" in fields or "entity_id" in fields:
        return project_id, data.entity_type, data.entity_id
    if project_id != todo.project_id:
        return project_id, None, None
    return project_id, todo.entity_type, todo.entity_id


@router.put("/{todo_id}", response_model=TodoItem)
async def update_todo(
    todo_id: int,
    data: TodoUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Edit, complete, reopen, re-link or reassign a task (its assignee or creator)."""
    todo = await _load_todo(db, user, todo_id)
    fields = data.model_fields_set

    # The todo as it is ...
    _check_rights(
        user, todo.assignee_id, await _pm_if_needed(db, user, todo.assignee_id, todo.project_id)
    )

    # ... and as it becomes.
    project_id, entity_type, entity_id = _new_link(todo, data)
    link_changed = (project_id, entity_type, entity_id) != (
        todo.project_id,
        todo.entity_type,
        todo.entity_id,
    )
    previous_assignee = todo.assignee_id
    new_assignee = data.assignee_id if data.assignee_id is not None else todo.assignee_id
    reassigned = new_assignee != previous_assignee
    if link_changed:
        project_id, pm_id = await _resolve_link(
            db,
            request,
            user,
            project_id=project_id,
            entity_type=entity_type,
            entity_id=entity_id,
        )
        _check_rights(user, new_assignee, pm_id)
    elif reassigned:
        _check_rights(user, new_assignee, await _pm_if_needed(db, user, new_assignee, project_id))
    if reassigned:
        await _ensure_assignee(db, request, user, new_assignee)

    if data.title is not None:
        todo.title = data.title
    if "notes" in fields:
        todo.notes = data.notes
    if "due_date" in fields:
        todo.due_date = data.due_date
    if data.status is not None and data.status != todo.status:
        todo.status = data.status
        todo.completed_at = utcnow_naive() if data.status == "done" else None
    todo.project_id, todo.entity_type, todo.entity_id = project_id, entity_type, entity_id
    todo.assignee_id = new_assignee
    todo.updated_at = utcnow_naive()

    notifications = _assigned_notifications(user, todo) if reassigned else []
    db.add_all(notifications)
    await db.commit()

    recipients = {previous_assignee, todo.assignee_id, todo.created_by}
    await _publish(request, todo.id, "update", recipients, notifications)
    return await _item(db, todo.id)


@router.delete("/{todo_id}", response_model=TodoDeleteResponse)
async def delete_todo(
    todo_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Delete a task: its creator (or its assignee once the creator is gone)."""
    todo = await _load_todo(db, user, todo_id)
    if todo.created_by is not None and todo.created_by != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=CREATOR_ONLY_DETAIL)
    _check_rights(
        user, todo.assignee_id, await _pm_if_needed(db, user, todo.assignee_id, todo.project_id)
    )

    recipients = {todo.assignee_id, todo.created_by}
    await db.delete(todo)
    await db.commit()

    await _publish(request, todo_id, "delete", recipients, [])
    return {"success": True, "id": todo_id}
