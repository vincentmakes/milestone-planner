"""
Audit log -- read and export (Settings -> Audit log).

Rows are written only by ``app/services/audit_log.record``; this module reads
them. There is deliberately no create, update or delete route: the log is
immutable. Mirrors turbo-ea's ``api/v1/audit_log.py``.

Every route requires ``system.audit_log`` (admins by default). Not under
``/settings``: ``GET /settings/{key}`` is public.

- ``GET /audit-log`` -- filtered, paginated, newest first
  (``{items, total, page, page_size}``).
- ``GET /audit-log/actions`` -- the distinct actions present, sorted.
- ``GET /audit-log/export`` -- the same filters as CSV, at most
  ``AUDIT_EXPORT_MAX_ROWS`` rows, newest first. The export is itself recorded
  (``access.audit_log.exported``) and committed **before** the body is built;
  the body is built in memory and returned as a plain ``Response`` (a
  streaming response would hold the request's session while the client reads).

Both the list and the export first purge the rows past the retention
setting (``audit_log.purge_old``, committed): lazy retention, no scheduler.

The filter and CSV logic are module-level functions the tests drive on SQLite;
the route bodies only wire them together.
"""

import asyncio
import csv
import io
import json
from datetime import date, datetime, time, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import require_permission
from app.models.audit_log import AuditLog
from app.models.project import Project
from app.models.user import User
from app.schemas.audit_log import AuditLogActions, AuditLogEntryOut, AuditLogPage
from app.schemas.base import serialize_datetime_js
from app.services import audit_log
from app.services.csv_safety import safe_cell
from app.utils import utcnow_naive

router = APIRouter(prefix="/audit-log")

AUDIT_EXPORT_MAX_ROWS = 50_000

CSV_COLUMNS: tuple[str, ...] = (
    "id",
    "created_at",
    "category",
    "action",
    "outcome",
    "actor_user_id",
    "actor_email",
    "actor_name",
    "subject_email",
    "target_type",
    "target_id",
    "target_label",
    "project_id",
    "project_name",
    "ip",
    "user_agent",
    "origin",
    "details",
)

Category = Literal["auth", "admin", "access", "change"]
Outcome = Literal["success", "failure"]


def build_filters(
    *,
    category: str | None = None,
    action: str | None = None,
    outcome: str | None = None,
    actor_user_id: int | None = None,
    q: str | None = None,
    ip: str | None = None,
    since: date | None = None,
    until: date | None = None,
    project_id: int | None = None,
) -> list[Any]:
    """
    The ``WHERE`` clauses for one set of list / export filters.

    ``action`` is an exact key (``auth.login.failed``) unless it ends with a
    dot, which makes it a prefix (``auth.login.`` matches every sign-in
    action) -- exact by default so a key never matches its longer siblings.
    ``q`` is a case-insensitive substring over the actor's email and name,
    the subject email and the target label; every LIKE escapes ``%`` / ``_``
    so user input is never a pattern. ``since`` / ``until`` are inclusive
    days: ``created_at >= since 00:00`` and ``< the day after until``.
    """
    filters: list[Any] = []
    if category:
        filters.append(AuditLog.category == category)
    if action:
        if action.endswith("."):
            filters.append(AuditLog.action.startswith(action, autoescape=True))
        else:
            filters.append(AuditLog.action == action)
    if outcome:
        filters.append(AuditLog.outcome == outcome)
    if actor_user_id is not None:
        filters.append(AuditLog.actor_user_id == actor_user_id)
    term = (q or "").strip()
    if term:
        filters.append(
            or_(
                AuditLog.actor_email.icontains(term, autoescape=True),
                AuditLog.actor_name.icontains(term, autoescape=True),
                AuditLog.subject_email.icontains(term, autoescape=True),
                AuditLog.target_label.icontains(term, autoescape=True),
            )
        )
    if ip and ip.strip():
        filters.append(AuditLog.ip == ip.strip())
    if since is not None:
        filters.append(AuditLog.created_at >= datetime.combine(since, time.min))
    if until is not None:
        filters.append(AuditLog.created_at < datetime.combine(until + timedelta(days=1), time.min))
    if project_id is not None:
        filters.append(AuditLog.project_id == project_id)
    return filters


def filtered_query(filters: list[Any]):
    """``(row, project name)`` matching ``filters``, newest first (``id``
    breaks a tie). An outer join: the row outlives its project."""
    query = select(AuditLog, Project.name).outerjoin(Project, Project.id == AuditLog.project_id)
    for clause in filters:
        query = query.where(clause)
    return query.order_by(AuditLog.created_at.desc(), AuditLog.id.desc())


def count_query(filters: list[Any]):
    query = select(func.count()).select_from(AuditLog)
    for clause in filters:
        query = query.where(clause)
    return query


def entry_out(entry: AuditLog, project_name: str | None) -> AuditLogEntryOut:
    """The response item of one row: every column, ``details`` parsed."""
    return AuditLogEntryOut(
        id=entry.id,
        created_at=entry.created_at,
        category=entry.category,
        action=entry.action,
        outcome=entry.outcome,
        actor_user_id=entry.actor_user_id,
        actor_email=entry.actor_email,
        actor_name=entry.actor_name,
        subject_email=entry.subject_email,
        target_type=entry.target_type,
        target_id=entry.target_id,
        target_label=entry.target_label,
        project_id=entry.project_id,
        project_name=project_name,
        ip=entry.ip,
        user_agent=entry.user_agent,
        origin=entry.origin,
        details=json.loads(entry.details) if entry.details else None,
    )


async def load_page(
    db: AsyncSession, filters: list[Any], page: int, page_size: int
) -> AuditLogPage:
    """One page of the filtered rows and the filtered total."""
    total = int((await db.execute(count_query(filters))).scalar_one() or 0)
    result = await db.execute(
        filtered_query(filters).offset((page - 1) * page_size).limit(page_size)
    )
    return AuditLogPage(
        items=[entry_out(entry, name) for entry, name in result.all()],
        total=total,
        page=page,
        page_size=page_size,
    )


def csv_cell(value: Any) -> str:
    """One CSV cell: ``None`` as empty, a datetime in the API's UTC form
    (``2026-11-03T08:00:00.000Z``, ``serialize_datetime_js``), and a
    formula-looking text prefixed with ``'`` (``csv_safety.safe_cell``, the
    triggers ``= + - @ \\t \\r`` -- turbo-ea's ``csv_safe`` set)."""
    if value is None:
        return ""
    text = serialize_datetime_js(value) if isinstance(value, datetime) else str(value)
    return str(safe_cell(text))


def entry_row(entry: AuditLog, project_name: str | None) -> list[str]:
    """One CSV row in ``CSV_COLUMNS`` order; ``details`` as compact JSON."""
    row: list[str] = []
    for column in CSV_COLUMNS:
        value = project_name if column == "project_name" else getattr(entry, column, None)
        if column == "details" and value:
            # Re-dumped compactly with sorted keys (the stored text already is).
            value = json.dumps(json.loads(value), separators=(",", ":"), sort_keys=True)
        row.append(csv_cell(value))
    return row


def build_csv(rows: list[tuple[AuditLog, str | None]]) -> str:
    """The whole export: a header row, then one row per entry."""
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(CSV_COLUMNS)
    for entry, project_name in rows:
        writer.writerow(entry_row(entry, project_name))
    return output.getvalue()


async def _purge(db: AsyncSession) -> None:
    """Lazy retention: delete the rows past ``audit_log_retention_days`` and
    commit, before anything is read."""
    await audit_log.purge_old(db, utcnow_naive())
    await db.commit()


@router.get("", response_model=AuditLogPage)
async def list_audit_log(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("system.audit_log")),
    category: Category | None = Query(None),
    action: str | None = Query(None, max_length=100),
    outcome: Outcome | None = Query(None),
    actor_user_id: int | None = Query(None),
    q: str | None = Query(None, max_length=200),
    ip: str | None = Query(None, max_length=45),
    since: date | None = Query(None),
    until: date | None = Query(None),
    project_id: int | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
) -> AuditLogPage:
    """The audit log, newest first, in a ``{items, total, page, page_size}`` envelope.

    The rows past retention are purged (and committed) first."""
    await _purge(db)
    filters = build_filters(
        category=category,
        action=action,
        outcome=outcome,
        actor_user_id=actor_user_id,
        q=q,
        ip=ip,
        since=since,
        until=until,
        project_id=project_id,
    )
    return await load_page(db, filters, page, page_size)


@router.get("/actions", response_model=AuditLogActions)
async def list_audit_log_actions(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("system.audit_log")),
) -> AuditLogActions:
    """Every distinct action present in the log, sorted -- the filter's options."""
    result = await db.execute(select(AuditLog.action).distinct().order_by(AuditLog.action))
    return AuditLogActions(actions=[a for a in result.scalars().all() if a])


@router.get("/export")
async def export_audit_log(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("system.audit_log")),
    category: Category | None = Query(None),
    action: str | None = Query(None, max_length=100),
    outcome: Outcome | None = Query(None),
    actor_user_id: int | None = Query(None),
    q: str | None = Query(None, max_length=200),
    ip: str | None = Query(None, max_length=45),
    since: date | None = Query(None),
    until: date | None = Query(None),
    project_id: int | None = Query(None),
) -> Response:
    """
    The filtered log as CSV (newest first, at most ``AUDIT_EXPORT_MAX_ROWS``).

    Records ``access.audit_log.exported`` and commits it before the body is
    built, so the export is on the record even if the client never reads it.
    The rows past retention are purged (and committed) first.
    """
    await _purge(db)
    filters = build_filters(
        category=category,
        action=action,
        outcome=outcome,
        actor_user_id=actor_user_id,
        q=q,
        ip=ip,
        since=since,
        until=until,
        project_id=project_id,
    )
    result = await db.execute(filtered_query(filters).limit(AUDIT_EXPORT_MAX_ROWS))
    rows = [(entry, name) for entry, name in result.all()]
    await audit_log.record(
        db,
        request,
        action="access.audit_log.exported",
        category="access",
        actor=user,
        target=("audit_log", None, "Audit log"),
        context={"rows": len(rows)},
    )
    await db.commit()
    # Up to AUDIT_EXPORT_MAX_ROWS rows: built off the event loop.
    content = await asyncio.to_thread(build_csv, rows)
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="audit-log.csv"'},
    )
