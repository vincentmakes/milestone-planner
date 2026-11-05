"""
Response bodies of the audit-log read API (app/routers/audit_log.py).

Every column of ``audit_log`` (app/models/audit_log.py), ``details`` parsed
back from its JSON text, plus the name of the row's project when it still
exists (an outer join: the row outlives the project).
"""

from typing import Any

from pydantic import BaseModel

from app.schemas.base import DateTimeJS


class AuditLogEntryOut(BaseModel):
    """One audit row."""

    id: int
    # toISOString() form, UTC with a Z (the Node-compatibility contract).
    created_at: DateTimeJS
    category: str
    action: str
    outcome: str
    actor_user_id: int | None = None
    actor_email: str | None = None
    actor_name: str | None = None
    subject_email: str | None = None
    target_type: str | None = None
    target_id: str | None = None
    target_label: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    ip: str | None = None
    user_agent: str | None = None
    origin: str
    details: dict[str, Any] | None = None


class AuditLogPage(BaseModel):
    """One page of the filtered log, newest first, and the filtered total."""

    items: list[AuditLogEntryOut]
    total: int
    page: int
    page_size: int


class AuditLogActions(BaseModel):
    """Every distinct action present in the log, sorted (the filter's options)."""

    actions: list[str]
