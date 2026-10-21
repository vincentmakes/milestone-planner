"""
Pydantic schemas for todos (My Todos).

The routes are in app/routers/todos.py. A todo is a private row: its assignee
and its creator see it, nobody else. ``GET /todos/mine`` returns ``TodoItem``s
of two kinds: ``task`` (a ``todos`` row) and ``approval`` (a pending approval
request the caller may decide, id ``approval:<n>``, merged in at read time).
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.approval import ApprovalRequestResponse
from app.schemas.base import DateSimple, DateTimeJS

TodoStatus = Literal["open", "done", "cancelled"]
TodoEntityType = Literal["phase", "subphase"]
TodoListStatus = Literal["open", "all"]
TodoKind = Literal["task", "approval"]

TITLE_MAX = 200
NOTES_MAX = 5000


def _clean_title(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        raise ValueError("title must not be blank")
    return value


class _CardLink(BaseModel):
    """``entity_type`` and ``entity_id`` come together or not at all."""

    entity_type: TodoEntityType | None = None
    entity_id: int | None = None

    @model_validator(mode="after")
    def _entity_pair(self) -> "_CardLink":
        if (self.entity_type is None) != (self.entity_id is None):
            raise ValueError("entity_type and entity_id must be given together")
        return self


class TodoCreate(_CardLink):
    """A new task; the assignee defaults to the caller."""

    title: str = Field(..., min_length=1, max_length=TITLE_MAX)
    notes: str | None = Field(None, max_length=NOTES_MAX)
    due_date: date | None = None
    assignee_id: int | None = None
    project_id: int | None = None

    @field_validator("title")
    @classmethod
    def _title(cls, value: str) -> str:
        cleaned = _clean_title(value)
        assert cleaned is not None
        return cleaned


class TodoUpdate(_CardLink):
    """
    A partial update. An explicit ``null`` clears ``notes``, ``due_date`` and
    the project / card link (``model_fields_set``); omitted fields are kept.
    """

    title: str | None = Field(None, min_length=1, max_length=TITLE_MAX)
    notes: str | None = Field(None, max_length=NOTES_MAX)
    due_date: date | None = None
    status: TodoStatus | None = None
    assignee_id: int | None = None
    project_id: int | None = None

    @field_validator("title")
    @classmethod
    def _title(cls, value: str | None) -> str | None:
        return _clean_title(value)


class TodoItem(BaseModel):
    """One My Todos entry: a task, or an approval request to decide."""

    id: int | str
    kind: TodoKind
    title: str
    notes: str | None = None
    due_date: DateSimple | None = None
    status: TodoStatus
    assignee_id: int | None = None
    assignee_name: str | None = None
    created_by: int | None = None
    created_by_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    entity_type: str | None = None
    entity_id: int | None = None
    completed_at: DateTimeJS | None = None
    approval_request: ApprovalRequestResponse | None = None
    created_at: DateTimeJS | None = None
    updated_at: DateTimeJS | None = None


class TodoDeleteResponse(BaseModel):
    success: bool = True
    id: int
