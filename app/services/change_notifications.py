"""
"Someone else changed your booking or your project" notifications.

Two notification types, never broadcast and never sent to the person who made
the change:

- ``assignment_changed`` to the **booked person**: their (approved) booking
  was added directly, changed, removed, or the card it is on moved or was
  deleted, or the project was deleted;
- ``project_changed`` to the **project manager**: the same booking events on
  their project, equipment bookings, project field changes (name, dates,
  customer, confirmed, volume, archived, hand-over), phases / subphases added,
  moved or removed, the project deleted, and an approval applied by someone
  else.

Routes build plain-data ``ChangeIntent``s with the builders below -- old values
captured before they mutate anything, names of deleted things resolved before
the delete -- and call ``deliver`` **after** their commit. A name the route
does not have at hand is written as ``{project}``, ``{target}`` (the intent's
entity) or ``{person}`` (``person_id``) and filled by ``deliver`` from one
``approvals.load_context`` per (project, entity) and one ``User`` query, so the
routes run no extra query for the text; literal names go through ``literal``
(braces doubled).

``deliver`` merges the intents to one row per recipient (``assignment_changed``
outranks ``project_changed``; the bodies are joined), drops the actor, inactive
users and ``already_notified``, then coalesces: under
``pg_advisory_xact_lock(hashtext(key))`` (keys sorted, so two requests never
wait on each other in opposite orders), the newest unread row with the same
``(user, type, project, actor)`` from the last ten minutes is updated in place
("3 changes by Ada on Alpha", body = the latest change) instead of a new row.
A project delete carries ``project_id = NULL`` (the FK cascade would remove
the row) and is never coalesced (``project_id IS NULL`` would merge every
delete by the same actor).

**Deliberate departure** from the rule of app/services/notifications.py that
rows are staged in the caller's transaction: these rows are written after the
caller's commit, in their own short transaction. The advisory lock must be held
only for the read-update of one inbox row, not for the whole change, and the
Gantt saves one drag as several PUTs in parallel (children, parent expansion,
project dates, bookings), whose notifications must merge into one line per
recipient -- only a lock taken after each change commits serialises them
without serialising the changes. The cost: a notification is lost if the
process dies between the two commits.

``deliver`` opens **its own session** on the request's tenant database (the
factory ``get_db`` uses) and never touches the caller's: a rollback expires
every object of its session, and the route reads its committed rows after
``deliver`` to build the response, so a failure on the route's session would
turn a committed change into a 500. Any failure is rolled back on the own
session and logged with its traceback; it never fails or undoes the change.
"""

import logging
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Literal

from fastapi import Request
from sqlalchemy import select, text, union
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.database import get_session_factory, resolve_tenant_session_factory
from app.models.assignment import (
    PhaseStaffAssignment,
    ProjectAssignment,
    SubphaseStaffAssignment,
)
from app.models.notification import Notification
from app.models.user import User
from app.services.approvals import (
    ACTION_CREATE,
    ACTION_UPDATE,
    RequestContext,
    describe_change,
    display_name,
    load_context,
)
from app.services.notifications import notification_payload
from app.utils import utcnow_naive
from app.websocket.broadcast import send_notification

logger = logging.getLogger(__name__)

ASSIGNMENT_CHANGED = "assignment_changed"
PROJECT_CHANGED = "project_changed"

# How long an unread notification keeps absorbing changes of the same kind.
COALESCE_WINDOW = timedelta(minutes=10)
TITLE_MAX = 200

_LOCK_SQL = text("SELECT pg_advisory_xact_lock(hashtext(:key))")
_COUNT_RE = re.compile(r"^(\d+) changes by ")
_PLACEHOLDER_RE = re.compile(r"\{\{|\}\}|\{(project|target|person)\}")

Recipient = Literal["person", "pm"]
BookingKind = Literal["create", "update", "remove"]


@dataclass(frozen=True)
class ChangeIntent:
    """
    One notification a change asks for, built before the change is applied.

    ``recipient``: the booked ``person`` or the project's manager (``pm``).
    ``user_id``: the recipient, or None for a ``pm`` intent whose manager
    ``deliver`` resolves from the project after the commit. ``project_id`` is
    None only for a project delete (``project_name`` then carries its name).
    ``title`` may hold ``{project}`` / ``{target}`` / ``{person}``;
    ``person_id`` is whose booking ``{person}`` names.
    """

    recipient: Recipient
    type: str
    user_id: int | None
    project_id: int | None
    project_name: str | None
    entity_type: str | None
    entity_id: int | None
    title: str
    body: str | None
    coalesce: bool = True
    person_id: int | None = None


# ---------------------------------------------------------
# Text builders (pure)
# ---------------------------------------------------------


def literal(name: Any) -> str:
    """A name embedded in a title as-is: braces are not placeholders."""
    return str(name).replace("{", "{{").replace("}", "}}")


def _actor(user: Any) -> str:
    return literal(display_name(user))


def _span(start: Any, end: Any) -> str:
    return f"{start}–{end}"


def _intent(
    recipient: Recipient,
    *,
    user_id: int | None,
    project_id: int | None,
    entity: tuple[str | None, int | None],
    title: str,
    body: str | None = None,
    person_id: int | None = None,
    project_name: str | None = None,
    coalesce: bool = True,
) -> ChangeIntent:
    return ChangeIntent(
        recipient=recipient,
        type=ASSIGNMENT_CHANGED if recipient == "person" else PROJECT_CHANGED,
        user_id=user_id,
        project_id=project_id,
        project_name=project_name,
        entity_type=entity[0],
        entity_id=entity[1],
        title=title,
        body=body,
        coalesce=coalesce,
        person_id=person_id,
    )


def _booking_entity(level: str, project_id: int, target_id: int) -> tuple[str, int]:
    return ("project", project_id) if level == "project" else (level, target_id)


def booking_intents(
    actor: Any,
    *,
    kind: BookingKind,
    level: str,
    project_id: int,
    target_id: int,
    staff_id: int,
    values: dict[str, Any] | None = None,
    previous: dict[str, Any] | None = None,
    target_name: str | None = None,
    person_name: str | None = None,
) -> list[ChangeIntent]:
    """
    A staff booking created, changed or removed directly (approved rows only):
    the person and the PM. ``values`` / ``previous`` are ``booking_dict``s; an
    update to the current values is no change (nothing).
    """
    if kind == "update" and values == previous:
        return []
    who = _actor(actor)
    target = literal(target_name) if target_name is not None else "{target}"
    own = staff_id == getattr(actor, "id", None)
    person = literal(person_name) if person_name is not None else "{person}"
    if kind == "create":
        body: str | None = describe_change(ACTION_CREATE, values, None)
        mine = f"{who} booked you on {target}"
        theirs = f"{who} booked {'themself' if own else person} on {target}"
    elif kind == "update":
        body = describe_change(ACTION_UPDATE, values, previous, level)
        mine = f"{who} changed your booking on {target}"
        whose = "their own" if own else f"{person}'s"
        theirs = f"{who} changed {whose} booking on {target}"
    else:
        body = f"Was {describe_change(ACTION_CREATE, previous, None)}"
        mine = f"{who} removed you from {target}"
        theirs = f"{who} removed {'themself' if own else person} from {target}"
    entity = _booking_entity(level, project_id, target_id)
    return [
        _intent(
            "person", user_id=staff_id, project_id=project_id, entity=entity, title=mine, body=body
        ),
        _intent(
            "pm",
            user_id=None,
            project_id=project_id,
            entity=entity,
            title=theirs,
            body=body,
            person_id=staff_id,
        ),
    ]


def equipment_intents(
    actor: Any, *, kind: BookingKind, project_id: int, equipment_name: str, body: str | None
) -> list[ChangeIntent]:
    """An equipment booking created, changed or removed: the PM."""
    who, equipment = _actor(actor), literal(equipment_name)
    if kind == "create":
        title = f"{who} booked {equipment} for {{project}}"
    elif kind == "update":
        title = f"{who} changed the {equipment} booking for {{project}}"
    else:
        title = f"{who} removed the {equipment} booking from {{project}}"
    return [
        _intent(
            "pm",
            user_id=None,
            project_id=project_id,
            entity=("project", project_id),
            title=title,
            body=body,
        )
    ]


def equipment_change_body(
    *,
    old_name: str,
    new_name: str | None,
    old_dates: tuple[Any, Any],
    new_dates: tuple[Any, Any],
) -> str | None:
    """
    What an equipment booking update changed, or None for no change.
    ``new_name`` is given only when the booking moved to other equipment.
    """
    parts = []
    if new_name is not None:
        parts.append(f"equipment {old_name} → {new_name}")
    if old_dates != new_dates:
        parts.append(f"dates {_span(*old_dates)} → {_span(*new_dates)}")
    return "; ".join(parts) or None


def manager_intents(
    actor: Any,
    *,
    project_id: int,
    project_name: str,
    pm_id: int | None,
    body: str | None = None,
) -> list[ChangeIntent]:
    """The new manager of a project (create with another PM, or hand-over)."""
    if pm_id is None:
        return []
    return [
        _intent(
            "pm",
            user_id=pm_id,
            project_id=project_id,
            entity=("project", project_id),
            title=f"{_actor(actor)} made you the manager of {literal(project_name)}",
            body=body,
        )
    ]


# The project fields whose change notifies the manager (the Gantt echoes every
# field on each PUT, so only a real difference counts; notes, sales PM, tags
# and teams never do).
PROJECT_FIELDS = (
    "name",
    "start_date",
    "end_date",
    "customer",
    "confirmed",
    "volume",
    "archived",
    "pm_id",
)


def _project_changes(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    parts = []
    if before["name"] != after["name"]:
        parts.append(f"name {before['name']} → {after['name']}")
    old_dates = (before["start_date"], before["end_date"])
    new_dates = (after["start_date"], after["end_date"])
    if old_dates != new_dates:
        parts.append(f"dates {_span(*old_dates)} → {_span(*new_dates)}")
    if before["customer"] != after["customer"]:
        parts.append(f"customer {before['customer'] or '—'} → {after['customer'] or '—'}")
    if bool(before["confirmed"]) != bool(after["confirmed"]):
        parts.append("confirmed" if after["confirmed"] else "unconfirmed")
    if before["volume"] != after["volume"]:
        parts.append(f"volume {before['volume']} → {after['volume']}")
    if bool(before["archived"]) != bool(after["archived"]):
        parts.append("archived" if after["archived"] else "restored")
    return parts


def project_update_intents(
    actor: Any,
    *,
    project_id: int,
    project_name: str,
    before: dict[str, Any],
    after: dict[str, Any],
) -> list[ChangeIntent]:
    """
    A project PUT: the manager, for a real difference in ``PROJECT_FIELDS``.
    A hand-over tells the previous manager and the new one.
    """
    changes = _project_changes(before, after)
    body = "; ".join(changes) or None
    old_pm, new_pm = before["pm_id"], after["pm_id"]
    entity = ("project", project_id)
    if old_pm == new_pm:
        if body is None or old_pm is None:
            return []
        return [
            _intent(
                "pm",
                user_id=old_pm,
                project_id=project_id,
                entity=entity,
                title=f"{_actor(actor)} changed {literal(project_name)}",
                body=body,
            )
        ]
    intents = []
    if old_pm is not None:
        intents.append(
            _intent(
                "pm",
                user_id=old_pm,
                project_id=project_id,
                entity=entity,
                title=f"{_actor(actor)} handed {literal(project_name)} over to {{person}}",
                body=body,
                person_id=new_pm,
            )
        )
    intents.extend(
        manager_intents(
            actor, project_id=project_id, project_name=project_name, pm_id=new_pm, body=body
        )
    )
    return intents


def project_deleted_intents(
    actor: Any, *, project_name: str, pm_id: int | None, bookers: Iterable[int]
) -> list[ChangeIntent]:
    """A project deleted: its approved bookers (any level) and its manager."""
    title = f"{_actor(actor)} deleted {literal(project_name)}"
    common: dict[str, Any] = {
        "project_id": None,
        "project_name": project_name,
        "entity": (None, None),
        "title": title,
        "coalesce": False,
    }
    intents = [_intent("person", user_id=staff_id, **common) for staff_id in dict.fromkeys(bookers)]
    if pm_id is not None:
        intents.append(_intent("pm", user_id=pm_id, **common))
    return intents


def card_added_intents(
    actor: Any,
    *,
    project_id: int,
    entity_type: str,
    entity_id: int,
    name: str,
    start: Any,
    end: Any,
) -> list[ChangeIntent]:
    """A phase or subphase added: the manager."""
    return [
        _intent(
            "pm",
            user_id=None,
            project_id=project_id,
            entity=(entity_type, entity_id),
            title=f"{_actor(actor)} added {literal(name)} to {{project}}",
            body=f"from {start} to {end}",
        )
    ]


def card_moved_intents(
    actor: Any,
    *,
    project_id: int,
    entity_type: str,
    entity_id: int,
    name: str,
    old: tuple[Any, Any],
    new: tuple[Any, Any],
    bookers: Sequence[tuple[int, int]],
) -> list[ChangeIntent]:
    """
    A phase or subphase whose start or end moved: its approved bookers
    (``(staff_id, allocation)``) and the manager. Nothing when the dates are
    unchanged.
    """
    if tuple(old) == tuple(new):
        return []
    title = f"{_actor(actor)} moved {literal(name)}"
    dates = f"dates {_span(*old)} → {_span(*new)}"
    entity = (entity_type, entity_id)
    intents = [
        _intent(
            "person",
            user_id=staff_id,
            project_id=project_id,
            entity=entity,
            title=title,
            body=f"{dates} (you are booked at {allocation}%)",
        )
        for staff_id, allocation in bookers
    ]
    intents.append(
        _intent("pm", user_id=None, project_id=project_id, entity=entity, title=title, body=dates)
    )
    return intents


def card_deleted_intents(
    actor: Any, *, project_id: int, name: str, bookers: Iterable[int]
) -> list[ChangeIntent]:
    """A phase or subphase deleted: the approved bookers of its subtree and the manager."""
    who, card = _actor(actor), literal(name)
    entity = ("project", project_id)
    intents = [
        _intent(
            "person",
            user_id=staff_id,
            project_id=project_id,
            entity=entity,
            title=f"{who} removed you from {card} ({card} deleted)",
        )
        for staff_id in dict.fromkeys(bookers)
    ]
    intents.append(
        _intent(
            "pm",
            user_id=None,
            project_id=project_id,
            entity=entity,
            title=f"{who} removed {card} from {{project}}",
        )
    )
    return intents


def approval_intents(
    actor: Any,
    *,
    project_id: int,
    level: str,
    target_id: int,
    target_name: str,
    pm_id: int | None,
    requester_id: int,
    action: str,
    requested: dict[str, Any] | None,
    previous: dict[str, Any] | None,
) -> list[ChangeIntent]:
    """An approval applied: the manager (the requester has ``approval_decided``)."""
    if pm_id is None:
        return []
    return [
        _intent(
            "pm",
            user_id=pm_id,
            project_id=project_id,
            entity=_booking_entity(level, project_id, target_id),
            title=f"{_actor(actor)} approved {{person}}'s request on {literal(target_name)}",
            body=describe_change(action, requested, previous, level),
            person_id=requester_id,
        )
    ]


# ---------------------------------------------------------
# Who is booked (approved rows only), for moves and deletes
# ---------------------------------------------------------


async def approved_bookers(
    db: AsyncSession,
    *,
    project_id: int | None = None,
    phase_ids: Sequence[int] = (),
    subphase_ids: Sequence[int] = (),
) -> list[int]:
    """
    Staff ids with an approved booking on a whole project (any level), on
    phases, or on subphases -- one query. Pending self-bookings are not
    bookings yet (as in ``notifications.card_assignee_ids``).
    """
    selects: list[Any] = []
    if project_id is not None:
        for model in (ProjectAssignment, PhaseStaffAssignment, SubphaseStaffAssignment):
            selects.append(
                select(model.staff_id).where(
                    model.project_id == project_id, model.approval_status == "approved"
                )
            )
    if phase_ids:
        selects.append(
            select(PhaseStaffAssignment.staff_id).where(
                PhaseStaffAssignment.phase_id.in_(list(phase_ids)),
                PhaseStaffAssignment.approval_status == "approved",
            )
        )
    if subphase_ids:
        selects.append(
            select(SubphaseStaffAssignment.staff_id).where(
                SubphaseStaffAssignment.subphase_id.in_(list(subphase_ids)),
                SubphaseStaffAssignment.approval_status == "approved",
            )
        )
    if not selects:
        return []
    query = selects[0] if len(selects) == 1 else union(*selects)
    return list(dict.fromkeys((await db.execute(query)).scalars().all()))


async def card_bookings(
    db: AsyncSession, entity_type: str, entity_id: int
) -> list[tuple[int, int]]:
    """
    ``(staff_id, allocation)`` of the approved bookers of one phase or
    subphase, one per person: someone holding several segments there is
    told once, with the allocation of their first booking (lowest id).
    """
    query: Any
    if entity_type == "phase":
        query = (
            select(PhaseStaffAssignment.staff_id, PhaseStaffAssignment.allocation)
            .where(
                PhaseStaffAssignment.phase_id == entity_id,
                PhaseStaffAssignment.approval_status == "approved",
            )
            .order_by(PhaseStaffAssignment.id)
        )
    else:
        query = (
            select(SubphaseStaffAssignment.staff_id, SubphaseStaffAssignment.allocation)
            .where(
                SubphaseStaffAssignment.subphase_id == entity_id,
                SubphaseStaffAssignment.approval_status == "approved",
            )
            .order_by(SubphaseStaffAssignment.id)
        )
    first: dict[int, int] = {}
    for row in (await db.execute(query)).all():
        first.setdefault(row[0], row[1])
    return list(first.items())


# ---------------------------------------------------------
# Delivery
# ---------------------------------------------------------


@dataclass
class _Row:
    user_id: int
    type: str
    project_id: int | None
    project_name: str
    entity_type: str | None
    entity_id: int | None
    title: str
    body: str | None
    coalesce: bool

    @property
    def key(self) -> str:
        return f"{self.user_id}|{self.type}|{self.project_id}"


def _fill(title: str, names: dict[str, str]) -> str:
    def sub(match: re.Match[str]) -> str:
        token = match.group(0)
        if token == "{{":
            return "{"
        if token == "}}":
            return "}"
        return names[match.group(1)]

    return _PLACEHOLDER_RE.sub(sub, title)


def _context_key(intent: ChangeIntent) -> tuple[int, str, int]:
    assert intent.project_id is not None
    if intent.entity_type in ("phase", "subphase") and intent.entity_id is not None:
        return (intent.project_id, intent.entity_type, intent.entity_id)
    return (intent.project_id, "project", intent.project_id)


def _priority(intent: ChangeIntent) -> int:
    return 0 if intent.type == ASSIGNMENT_CHANGED else 1


async def _resolve(
    db: AsyncSession, actor_id: int, intents: Sequence[ChangeIntent], already: set[int]
) -> tuple[list[_Row], str]:
    """Merged rows (one per recipient, actor / inactive / notified dropped) + the actor's name."""
    contexts: dict[tuple[int, str, int], RequestContext | None] = {}
    targeted: list[tuple[ChangeIntent, int, RequestContext | None]] = []
    for intent in intents:
        context = None
        if intent.project_id is not None:
            key = _context_key(intent)
            if key not in contexts:
                contexts[key] = await load_context(
                    db, project_id=key[0], level=key[1], target_id=key[2]
                )
            context = contexts[key]
            if context is None:  # the project is gone
                continue
        user_id = intent.user_id
        if user_id is None and intent.recipient == "pm" and context is not None:
            user_id = context.pm_id
        if user_id is None:
            continue
        targeted.append((intent, user_id, context))
    if not targeted:
        return [], ""

    ids = {actor_id}
    for intent, user_id, _ in targeted:
        ids.add(user_id)
        if intent.person_id is not None:
            ids.add(intent.person_id)
    people = {
        row[0]: row
        for row in (
            await db.execute(
                select(User.id, User.first_name, User.last_name, User.email, User.active).where(
                    User.id.in_(sorted(ids))
                )
            )
        ).all()
    }

    def name_of(user_id: int | None) -> str:
        row = people.get(user_id) if user_id is not None else None
        if row is None:
            return "someone"
        return display_name(_Person(row[1], row[2], row[3]))

    by_user: dict[int, list[tuple[ChangeIntent, RequestContext | None]]] = {}
    for intent, user_id, context in targeted:
        person = people.get(user_id)
        if user_id == actor_id or user_id in already or person is None or person[4] != 1:
            continue
        by_user.setdefault(user_id, []).append((intent, context))

    rows = []
    for user_id, items in by_user.items():
        items.sort(key=lambda item: _priority(item[0]))
        first, context = items[0]
        project_name = (context.project_name if context else None) or first.project_name or ""
        names = {
            "project": project_name,
            "target": context.target_name if context else project_name,
            "person": name_of(first.person_id),
        }
        bodies = list(dict.fromkeys(i.body for i, _ in items if i.body))
        rows.append(
            _Row(
                user_id=user_id,
                type=first.type,
                project_id=first.project_id,
                project_name=project_name,
                entity_type=first.entity_type,
                entity_id=first.entity_id,
                title=_fill(first.title, names)[:TITLE_MAX],
                body="; ".join(bodies) or None,
                coalesce=first.project_id is not None and all(i.coalesce for i, _ in items),
            )
        )
    return rows, name_of(actor_id)


@dataclass(frozen=True)
class _Person:
    first_name: str | None
    last_name: str | None
    email: str | None


async def _coalesce(
    db: AsyncSession, row: _Row, actor_id: int, actor_name: str
) -> Notification | None:
    """Fold ``row`` into the newest matching unread notification, or None."""
    existing: Notification | None = (
        await db.execute(
            select(Notification)
            .where(
                Notification.user_id == row.user_id,
                Notification.type == row.type,
                Notification.project_id == row.project_id,
                Notification.actor_id == actor_id,
                Notification.read_at.is_(None),
                Notification.created_at >= utcnow_naive() - COALESCE_WINDOW,
            )
            .order_by(Notification.created_at.desc(), Notification.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if existing is None:
        return None
    match = _COUNT_RE.match(existing.title or "")
    count = (int(match.group(1)) if match else 1) + 1
    existing.title = f"{count} changes by {actor_name} on {row.project_name}"[:TITLE_MAX]
    existing.body = f"{row.title} — {row.body}" if row.body else row.title
    existing.created_at = utcnow_naive()
    if (existing.entity_type, existing.entity_id) != (row.entity_type, row.entity_id):
        existing.entity_type, existing.entity_id = "project", row.project_id
    return existing


async def _write(
    db: AsyncSession, actor_id: int, intents: Sequence[ChangeIntent], already: set[int]
) -> list[Notification]:
    rows, actor_name = await _resolve(db, actor_id, intents, already)
    written: list[Notification] = []
    for row in sorted(rows, key=lambda r: (not r.coalesce, f"{r.key}|{actor_id}")):
        if row.coalesce:
            await db.execute(_LOCK_SQL, {"key": f"{row.key}|{actor_id}"})
            merged = await _coalesce(db, row, actor_id, actor_name)
            if merged is not None:
                written.append(merged)
                continue
        notification = Notification(
            user_id=row.user_id,
            type=row.type,
            actor_id=actor_id,
            entity_type=row.entity_type,
            entity_id=row.entity_id,
            project_id=row.project_id,
            title=row.title,
            body=row.body,
            created_at=utcnow_naive(),
        )
        db.add(notification)
        written.append(notification)
    return written


def _session_factory(request: Request) -> async_sessionmaker[AsyncSession]:
    """The request's tenant database, as ``get_db`` resolves it."""
    return resolve_tenant_session_factory(request) or get_session_factory()


async def deliver(
    db: AsyncSession,
    request: Request,
    actor_id: int,
    intents: Sequence[ChangeIntent],
    already_notified: Iterable[int] = (),
) -> None:
    """
    After the caller's commit: write the change notifications in one short
    transaction (resolve, merge, lock, coalesce or insert, commit) on a
    session of its own, then push ``notification:new`` per row. Never
    raises: a failure is logged and rolled back, and the change it reports
    stays committed.

    ``db`` (the route's session) is deliberately **not used**: a rollback
    expires every object of the session it runs on, and the route still reads
    its committed rows to build the response -- on an ``AsyncSession`` that
    lazy load raises ``MissingGreenlet`` and would turn the committed change
    into a 500. The parameter stays so every call site reads the same.
    """
    del db  # never touched, see above
    # The actor is never notified: intents addressed to them need no session.
    intents = [i for i in intents if i.user_id is None or i.user_id != actor_id]
    if not intents:
        return
    payloads: list[tuple[int, dict]] = []
    try:
        async with _session_factory(request)() as session:
            try:
                written = await _write(session, actor_id, intents, set(already_notified))
                await session.commit()
                payloads = [(n.user_id, notification_payload(n)) for n in written]
            except Exception:
                try:
                    await session.rollback()
                except Exception:  # the connection may be gone already
                    logger.debug("Rollback after failed change notifications failed", exc_info=True)
                raise
    except Exception:
        logger.exception("Change notifications failed (actor %s)", actor_id)
        return
    for user_id, payload in payloads:
        try:
            await send_notification(request, user_id, payload)
        except Exception as e:  # a push is a live hint only
            logger.warning("Notification push failed for user %s: %s", user_id, e)
