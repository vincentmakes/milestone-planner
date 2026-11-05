"""The tenant audit log -- the one write path into ``audit_log``.

Mirrors turbo-ea's "Security & admin log" (``backend/app/services/
audit_log.py``), adapted. ``record`` writes one row per recorded action (a
sign-in, a failed attempt, a sign-out, an admin changing a user, a role or a
setting, an export, a project or booking change) and emits the same fields as
one JSON line on the ``milestone.audit`` logger, so ``docker logs`` and any
log shipping / SIEM receive the stream with no extra configuration.

**Categories**: ``auth`` (sign-in, sign-out, password, SSO), ``admin``
(users, roles, approval policies, settings, sites, teams, the Settings
entities), ``access`` (exports) and ``change`` (projects, phases, subphases,
bookings, absences, ... -- the content changes). **Action keys are past
tense everywhere**: ``auth.login.succeeded``, ``admin.user.updated``,
``project.created``, ``staff_assignment.deleted`` (``change_action`` builds
the derived ones from a broadcast verb).

**The ``details`` contract.** A row's ``details`` holds at most four keys,
each passed as its own keyword to ``record`` and checked by
``validate_details`` (a breach is a ``ValueError`` at the caller, never a row
the Audit log cannot render):

- ``reason`` -- a short snake_case code saying why an attempt failed
  (``bad_password``, ``unknown_user``, ``inactive``).
- ``changes`` -- ``{field: {"old": v, "new": v}}`` for plain fields that
  moved (``diff`` builds it). Field names are snake_case; the frontend labels
  them. A string longer than ``LONG_VALUE`` (a data-URL logo) is stored as
  ``{"changed": true, "length": n}`` instead of its text.
- ``items`` -- a list of flat mappings, one per change item of a list-shaped
  value (a role's permission keys).
- ``context`` -- ``{key: v}`` plain facts that are not a change (a count, a
  provider, ``first_login``).

Every ``v`` is a scalar (``str`` / ``int`` / ``float`` / ``bool`` / ``None``;
a ``date`` / ``datetime`` is stored as its ISO form) or a flat list of
scalars -- never a nested mapping. Empty parts are dropped, and a row with
nothing left stores ``details = NULL``. Stored as compact JSON **text**
(``separators=(",", ":")``, ``sort_keys=True``): no JSONB on a tenant model.

Rules for callers:

- **``record`` never commits.** It adds and flushes, like every helper handed
  a session. The caller's own commit -- ``get_db``'s at the end of the
  request -- persists the row with the rest of its work.
- **Commit before you raise.** ``get_db`` rolls back when the handler raises,
  so a row recorded on a path that then raises ``HTTPException`` is rolled
  back with the request and the failure leaves no trace -- which is exactly
  the record a failed-login audit exists to keep. A handler that records a
  failure and then raises must ``await db.commit()`` in between::

      await audit_log.record(db, request, action="auth.login.failed",
                             category="auth", outcome="failure",
                             subject_email=email, reason="bad_password")
      await db.commit()
      raise HTTPException(401, "Invalid email or password")

- **Secrets are masked at write time.** ``details`` always passes through
  ``redact`` after validation and before it is stored or logged, so a caller
  cannot leak a credential by passing a raw settings diff. ``diff`` masks
  them too.
- **Rows are immutable.** Nothing updates or deletes one except the retention
  purge.
- **The request is the context.** ``ip`` is ``request.client.host`` (uvicorn's
  ``--proxy-headers`` / ``FORWARDED_ALLOW_IPS`` already resolved the proxy;
  anything that is not an IP address is dropped), ``user_agent`` its header,
  ``origin`` ``web``; ``request=None`` (work outside any request) stamps
  ``origin = "system"`` and no ip / user agent.
- **The table is the record; the stream is the live feed.** The JSON line is
  emitted when the entry is *recorded* (added and flushed), not when it is
  committed. A request whose transaction later rolls back leaves a
  ``milestone.audit`` line with no matching row. Reconcile against the
  ``audit_log`` table, never the other way round.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import re
from collections.abc import Iterable, Mapping
from datetime import date, datetime
from typing import Any

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit_log import AUDIT_LOG_CATEGORIES, AUDIT_LOG_OUTCOMES, AuditLog
from app.utils import utcnow_naive

AUDIT_LOGGER = logging.getLogger("milestone.audit")

CATEGORIES: tuple[str, ...] = AUDIT_LOG_CATEGORIES
OUTCOMES: tuple[str, ...] = AUDIT_LOG_OUTCOMES
# ``web``: a request; ``system``: work outside any request.
ORIGINS: tuple[str, ...] = ("web", "system")

MASK = "***"

DETAIL_KEYS: tuple[str, ...] = ("reason", "changes", "items", "context")

# A string value longer than this is not copied into ``changes``: the header
# logos are data URLs written through PUT /settings/{key}.
LONG_VALUE = 200

# ``<noun>.<verb>`` or deeper (``auth.login.failed``), snake_case parts.
ACTION_PATTERN = re.compile(r"^[a-z_]+(\.[a-z_]+)+$")

# A key whose name says it holds a credential. Searched, not matched, so
# ``smtp_password`` and ``client_secret`` are caught by their stem.
_MASKED_KEY_PATTERN = re.compile(
    r"password|secret|token|api_key|apikey|credential|private_key", re.IGNORECASE
)

# Column widths of ``audit_log``, applied to every string the caller passes so
# a long user-supplied email can never fail the INSERT.
_WIDTHS = {
    "action": 100,
    "email": 255,
    "name": 255,
    "target_type": 50,
    "target_id": 100,
    "target_label": 255,
    "ip": 45,
    "user_agent": 255,
    "origin": 20,
}

# Broadcast verbs -> past-tense action verbs (the derived tiers).
VERBS: dict[str, str] = {
    "create": "created",
    "update": "updated",
    "delete": "deleted",
    "move": "moved",
}

# What a value inside ``details`` may be (dates are stored in ISO form).
_DETAIL_SCALARS = (str, int, float, bool, date, datetime)


def change_action(entity_type: str, verb: str) -> str:
    """The action key of a derived row: ``project`` + ``create`` ->
    ``project.created``. A verb outside ``VERBS`` is kept as given."""
    return f"{entity_type}.{VERBS.get(verb, verb)}"


# ---------------------------------------------------------------------------
# Masking
# ---------------------------------------------------------------------------


def is_masked_key(key: Any) -> bool:
    """True when a mapping key names a credential."""
    return isinstance(key, str) and bool(_MASKED_KEY_PATTERN.search(key))


def _mask_all(value: Any) -> Any:
    """Mask every leaf of ``value`` while keeping its shape.

    ``None`` stays ``None``: "no credential was set" is not itself a
    credential, and it tells an auditor one was configured for the first
    time. A ``{"old", "new"}`` diff therefore reads ``{"old": None, "new":
    "***"}``.
    """
    if value is None:
        return None
    if isinstance(value, Mapping):
        return {k: _mask_all(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_mask_all(v) for v in value]
    return MASK


def redact(value: Any) -> Any:
    """Return a copy of ``value`` with every credential masked as ``"***"``.

    Recursive over mappings and lists (a ``changes`` entry, a nested
    ``context``): the value of any key matching the credential pattern is
    masked leaf by leaf (``_mask_all``). Never mutates its input.
    """
    if isinstance(value, Mapping):
        return {k: (_mask_all(v) if is_masked_key(k) else redact(v)) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [redact(v) for v in value]
    return value


# ---------------------------------------------------------------------------
# diff
# ---------------------------------------------------------------------------


_MISSING = object()


def _read(source: Any, key: str) -> Any:
    if isinstance(source, Mapping):
        return source.get(key, _MISSING)
    return getattr(source, key, _MISSING)


def _long_marker(value: Any) -> Any:
    """``{"changed": True, "length": n}`` for a string longer than
    ``LONG_VALUE``; any other value as is."""
    if isinstance(value, str) and len(value) > LONG_VALUE:
        return {"changed": True, "length": len(value)}
    return value


def _is_long_marker(value: Any) -> bool:
    return (
        isinstance(value, Mapping)
        and set(value) == {"changed", "length"}
        and value["changed"] is True
        and isinstance(value["length"], int)
        and not isinstance(value["length"], bool)
    )


def diff(
    old: Mapping[str, Any] | Any,
    new: Mapping[str, Any] | Any,
    *,
    keys: Iterable[str] | None = None,
) -> dict[str, dict[str, Any]]:
    """``{field: {"old": ..., "new": ...}}`` for every field whose value changed.

    ``old`` and ``new`` are mappings or objects (read with ``getattr``).
    ``new`` is what was *written*: a field it does not carry was not touched
    and is not reported, which makes a partial body
    (``model_dump(exclude_unset=True)``) a valid ``new``. A field missing
    from ``old`` reads as ``None``. ``keys`` restricts the comparison
    (default: every key of a mapping ``new``). Values are compared in full;
    a string longer than ``LONG_VALUE`` is then reported as ``{"changed":
    true, "length": n}`` on the side that holds it, and a credential key
    (``is_masked_key``) is masked on both sides.
    """
    if keys is None:
        keys = list(new.keys()) if isinstance(new, Mapping) else []
    changes: dict[str, dict[str, Any]] = {}
    for key in keys:
        after = _read(new, key)
        if after is _MISSING:
            continue
        before = _read(old, key)
        if before is _MISSING:
            before = None
        if before == after:
            continue
        if is_masked_key(key):
            changes[key] = _mask_all({"old": before, "new": after})
        else:
            changes[key] = {"old": _long_marker(before), "new": _long_marker(after)}
    return changes


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate(category: str, outcome: str, action: str) -> None:
    """Raise ``ValueError`` for a category or outcome the log does not know,
    or for an action key that is not ``<noun>.<verb>`` snake_case
    (``ACTION_PATTERN``) -- at the caller, never as a failed INSERT."""
    if not isinstance(action, str) or not ACTION_PATTERN.match(action):
        raise ValueError(f"Invalid audit action {action!r}; expected e.g. 'project.created'")
    if category not in CATEGORIES:
        raise ValueError(f"Unknown audit category {category!r}; expected one of {CATEGORIES}")
    if outcome not in OUTCOMES:
        raise ValueError(f"Unknown audit outcome {outcome!r}; expected one of {OUTCOMES}")


def _is_detail_value(value: Any) -> bool:
    """A scalar, or a flat list of scalars."""
    if value is None or isinstance(value, _DETAIL_SCALARS):
        return True
    return isinstance(value, list | tuple) and all(
        v is None or isinstance(v, _DETAIL_SCALARS) for v in value
    )


def _check_flat_map(name: str, value: Any) -> None:
    if not isinstance(value, Mapping):
        raise ValueError(f"Audit details {name!r} must be a mapping; got {type(value).__name__}")
    for key, v in value.items():
        if not isinstance(key, str):
            raise ValueError(f"Audit details {name!r} has a non-string key {key!r}")
        if not _is_detail_value(v):
            raise ValueError(
                f"Audit details {name}[{key!r}] must be a scalar or a flat list of scalars"
            )


def _check_changes(changes: Any) -> None:
    if not isinstance(changes, Mapping):
        raise ValueError("Audit details 'changes' must be a mapping of {field: {old, new}}")
    for field, change in changes.items():
        if not isinstance(field, str):
            raise ValueError(f"Audit details 'changes' has a non-string field {field!r}")
        if not isinstance(change, Mapping) or set(change) != {"old", "new"}:
            raise ValueError(f"Audit details changes[{field!r}] must be exactly {{old, new}}")
        for side in ("old", "new"):
            value = change[side]
            if not (_is_detail_value(value) or _is_long_marker(value)):
                raise ValueError(
                    f"Audit details changes[{field!r}] must hold scalars or flat lists of scalars"
                )


def _check_items(items: Any) -> None:
    if not isinstance(items, list | tuple):
        raise ValueError("Audit details 'items' must be a list of flat mappings")
    for index, entry in enumerate(items):
        _check_flat_map(f"items[{index}]", entry)


def validate_details(details: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Enforce the ``details`` contract and return what to store.

    Top-level keys must be a subset of ``DETAIL_KEYS``: ``reason`` a non-empty
    string; ``changes`` ``{field: {"old": v, "new": v}}`` (``v`` may also be
    the long-value marker ``diff`` writes); ``items`` a list of flat
    mappings; ``context`` ``{key: v}``. Every ``v`` is a scalar or a flat
    list of scalars -- a nested mapping is a ``ValueError`` naming where it
    sits. An empty ``changes`` / ``items`` / ``context`` (and a ``None``
    anywhere at the top) is dropped; ``None`` when nothing is left.
    """
    if details is None:
        return None
    if not isinstance(details, Mapping):
        raise ValueError(f"Audit details must be a mapping; got {type(details).__name__}")
    for key in details:
        if key not in DETAIL_KEYS:
            raise ValueError(
                f"Unknown audit details key {key!r}; expected a subset of {DETAIL_KEYS}"
            )
    out: dict[str, Any] = {}
    reason = details.get("reason")
    if reason is not None:
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError(f"Audit details 'reason' must be a non-empty string; got {reason!r}")
        out["reason"] = reason
    changes = details.get("changes")
    if changes is not None:
        _check_changes(changes)
        if changes:
            out["changes"] = dict(changes)
    items = details.get("items")
    if items is not None:
        _check_items(items)
        if items:
            out["items"] = list(items)
    context = details.get("context")
    if context is not None:
        _check_flat_map("context", context)
        if context:
            out["context"] = dict(context)
    return out or None


# ---------------------------------------------------------------------------
# The row
# ---------------------------------------------------------------------------


def _clip(value: Any, width: int) -> str | None:
    """``value`` as a string cut to the column width; ``None`` for ``None``
    or an empty string."""
    if value is None:
        return None
    text = str(value)
    return text[:width] if text else None


def _json_default(value: Any) -> str:
    if isinstance(value, datetime | date):
        return value.isoformat()
    return str(value)


def _dumps(details: Mapping[str, Any]) -> str:
    return json.dumps(details, separators=(",", ":"), sort_keys=True, default=_json_default)


def _client_ip(request: Request) -> str | None:
    """``request.client.host`` when it is an IP address (the proxy was
    resolved by uvicorn's ``--proxy-headers`` / ``FORWARDED_ALLOW_IPS``)."""
    client = getattr(request, "client", None)
    host = getattr(client, "host", None) if client is not None else None
    if not host:
        return None
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        return None


def request_context(request: Request | None) -> tuple[str | None, str | None, str]:
    """``(ip, user_agent, origin)`` of ``request``; ``(None, None, "system")``
    outside any request."""
    if request is None:
        return None, None, "system"
    agent = request.headers.get("user-agent")
    return _client_ip(request), _clip(agent, _WIDTHS["user_agent"]), "web"


def _actor_name(actor: Any) -> str | None:
    if actor is None:
        return None
    # Lazily: approvals imports the broadcast layer, which records rows.
    from app.services.approvals import display_name

    return _clip(display_name(actor), _WIDTHS["name"])


def build_entry(
    request: Request | None,
    *,
    action: str,
    category: str,
    outcome: str = "success",
    actor: Any = None,
    subject_email: str | None = None,
    target: tuple[Any, ...] | None = None,
    project_id: int | None = None,
    reason: str | None = None,
    changes: Mapping[str, Any] | None = None,
    items: Iterable[Mapping[str, Any]] | None = None,
    context: Mapping[str, Any] | None = None,
) -> AuditLog:
    """Build (but do not add) the row ``record`` writes, stamped with the
    request context. Raises ``ValueError`` like ``validate`` /
    ``validate_details``."""
    validate(category, outcome, action)
    stored = validate_details(
        {
            "reason": reason,
            "changes": changes,
            "items": list(items) if items is not None else None,
            "context": context,
        }
    )
    ip, agent, origin = request_context(request)
    target_type, target_id, target_label = (tuple(target or ()) + (None, None, None))[:3]
    return AuditLog(
        created_at=utcnow_naive(),
        category=category,
        action=_clip(action, _WIDTHS["action"]),
        outcome=outcome,
        actor_user_id=getattr(actor, "id", None),
        actor_email=_clip(getattr(actor, "email", None), _WIDTHS["email"]),
        actor_name=_actor_name(actor),
        subject_email=_clip(subject_email, _WIDTHS["email"]),
        target_type=_clip(target_type, _WIDTHS["target_type"]),
        target_id=_clip(target_id, _WIDTHS["target_id"]),
        target_label=_clip(target_label, _WIDTHS["target_label"]),
        project_id=project_id,
        ip=_clip(ip, _WIDTHS["ip"]),
        user_agent=agent,
        origin=_clip(origin, _WIDTHS["origin"]),
        details=_dumps(redact(stored)) if stored is not None else None,
    )


# Every column, in table order: the fields of the JSON line.
_LOG_FIELDS: tuple[str, ...] = tuple(c.name for c in AuditLog.__table__.columns)


def log_line(entry: AuditLog) -> str:
    """The JSON line ``record`` emits on ``milestone.audit`` for ``entry``:
    every column (``details`` parsed back), redacted once more. Read from the
    instance's ``__dict__`` so an unloaded attribute never triggers a lazy
    load (an async session cannot)."""
    fields = {name: entry.__dict__.get(name) for name in _LOG_FIELDS}
    if isinstance(fields["details"], str):
        fields["details"] = json.loads(fields["details"])
    return json.dumps(redact(fields), default=_json_default)


async def record(
    db: AsyncSession,
    request: Request | None,
    *,
    action: str,
    category: str,
    outcome: str = "success",
    actor: Any = None,
    subject_email: str | None = None,
    target: tuple[Any, ...] | None = None,
    project_id: int | None = None,
    reason: str | None = None,
    changes: Mapping[str, Any] | None = None,
    items: Iterable[Mapping[str, Any]] | None = None,
    context: Mapping[str, Any] | None = None,
) -> AuditLog:
    """Write one audit row and emit it on ``milestone.audit``. Never commits.

    ``request`` gives the ip, the user agent and ``origin = "web"``; ``None``
    stamps ``origin = "system"``. ``actor`` is whoever acted -- an ORM
    ``User``, a ``SessionUser`` or any object with ``id`` / ``email`` /
    ``first_name`` / ``last_name``; its id, email and display name are
    snapshotted. ``subject_email`` is the account acted upon; ``target`` a
    ``(type, id, label)`` tuple (shorter tuples pad with ``None``; the id is
    stored as text); ``project_id`` the project the row belongs to.
    ``reason`` / ``changes`` / ``items`` / ``context`` are the four parts of
    ``details`` (module docstring), redacted before they are stored.

    The caller commits (``get_db`` does at the end of the request); a path
    that records a failure and then raises must ``await db.commit()`` before
    the raise, since ``get_db`` rolls back on a raise. Raises ``ValueError``
    on an unknown category or outcome, a malformed action key or ``details``
    that break the contract.
    """
    entry = build_entry(
        request,
        action=action,
        category=category,
        outcome=outcome,
        actor=actor,
        subject_email=subject_email,
        target=target,
        project_id=project_id,
        reason=reason,
        changes=changes,
        items=items,
        context=context,
    )
    db.add(entry)
    await db.flush()
    AUDIT_LOGGER.info(log_line(entry))
    return entry
