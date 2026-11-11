"""
The instance settings with a known shape.

The ``settings`` table is a free key/value store (instance title, logos,
legacy keys). The keys listed in ``KNOWN_SETTINGS`` are the admin defaults and
feature switches: ``PUT /settings/{key}`` stores their canonical form (422 on
anything else), a missing row reads as the default, and ``value: null``
deletes the row so the default applies again. Shape is validated, not
existence: skills get deleted and equipment types renamed, so consumers ignore
ids and names they no longer know.

A switch is on unless its row holds exactly ``false`` (``flag_enabled``), the
rule the client already applies to ``show_weekends`` and that rows written
before validation keep. ``FLAG_DISABLES`` names the permission keys a switch
turned off takes away from everyone, admins included (``PermissionSet``'s
``disabled_keys``).

``weekend_working_days`` (2.5.0, *Weekends are working days*) is a boolean
but **not a switch** in that sense: it is off by default, so it is on only
when its row reads a case-insensitive ``true`` (``weekends_working_from``:
``value.strip().lower() == "true"``; the client's ``selectWeekendsWorking``
reads it the same way).
A missing, empty or malformed row keeps Monday to Friday.

Import-light like app/services/permissions.py: the model is imported inside
the readers.
"""

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

MAX_DEFAULT_SKILLS = 500
MAX_TYPE_NAME_LENGTH = 100
MAX_FIELD_LABEL_LENGTH = 60
# The online manual Help opens (help_url, 2.6.0): the public one by default.
# The client's DEFAULT_HELP_URL (frontend/src/utils/helpLinks.ts) is the same.
DEFAULT_HELP_URL = "https://docs-milestone.verdet.me/"
MAX_HELP_URL_LENGTH = 500

# The built-in project fields an admin may rename (project_field_labels), in
# display order, and those that may be hidden (project_fields_hidden): Confirmed
# drives the Gantt stripes, ordering and counts, so it is never hidden. Hiding
# is UI only -- the API keeps accepting and returning the values.
BUILT_IN_PROJECT_FIELDS: tuple[str, ...] = ("customer", "sales_pm", "volume", "confirmed")
HIDEABLE_PROJECT_FIELDS: tuple[str, ...] = ("customer", "sales_pm", "volume")

# The built-in rows of the Gantt's Shift-hover project details
# (project_tooltip_rows), in display order: the built-in fields and PM, then
# the fixed rows. The setting is the shown-list: these keys plus custom project
# field ids, so a new field stays off until an admin ticks it.
PROJECT_TOOLTIP_ROWS: tuple[str, ...] = (
    "customer",
    "pm",
    *BUILT_IN_PROJECT_FIELDS[1:],
    "tags",
    "period",
    "completion",
    "work_days",
    "total_days",
    "staff",
)
# Today's rows: tenants that never save the setting see no change.
DEFAULT_PROJECT_TOOLTIP_ROWS: tuple[str, ...] = (
    "customer",
    "pm",
    "confirmed",
    "tags",
    "period",
    "completion",
    "work_days",
    "total_days",
    "staff",
)
MAX_TOOLTIP_FIELD_IDS = 500

_TRUE = frozenset({"true", "1", "yes", "on"})
_FALSE = frozenset({"false", "0", "no", "off"})


@dataclass(frozen=True)
class SettingSpec:
    """How a known key's value is canonicalised, and its value when unset."""

    canonicalise: Callable[[str], str]
    default: str


def _boolean(value: str) -> str:
    word = value.strip().lower()
    if word in _TRUE:
        return "true"
    if word in _FALSE:
        return "false"
    raise ValueError("expected true or false")


def _choice(*options: str) -> Callable[[str], str]:
    def canonical(value: str) -> str:
        word = value.strip().lower()
        if word not in options:
            raise ValueError(f"expected one of {', '.join(options)}")
        return word

    return canonical


def _int_range(low: int, high: int) -> Callable[[str], str]:
    """A whole number from ``low`` to ``high`` (an int or a numeric string),
    stored as its canonical decimal string (``" 030"`` -> ``"30"``)."""

    def canonical(value: str | int) -> str:
        if isinstance(value, bool):
            raise ValueError(f"expected a whole number from {low} to {high}")
        if isinstance(value, int):
            number = value
        else:
            text = str(value).strip()
            if not text.isdigit():
                raise ValueError(f"expected a whole number from {low} to {high}")
            number = int(text)
        if not low <= number <= high:
            raise ValueError(f"expected a whole number from {low} to {high}")
        return str(number)

    return canonical


def _json_list(value: str) -> list[Any]:
    try:
        items = json.loads(value)
    except ValueError as exc:
        raise ValueError("expected a JSON array") from exc
    if not isinstance(items, list):
        raise ValueError("expected a JSON array")
    return items


def _compact(items: list[Any]) -> str:
    return json.dumps(items, separators=(",", ":"), ensure_ascii=False)


def _skill_ids(value: str) -> str:
    ids: list[int] = []
    for item in _json_list(value):
        # bool is an int subclass: true/false are not ids.
        if isinstance(item, bool) or not isinstance(item, int) or item <= 0:
            raise ValueError("expected positive integer ids")
        if item not in ids:
            ids.append(item)
    if len(ids) > MAX_DEFAULT_SKILLS:
        raise ValueError(f"at most {MAX_DEFAULT_SKILLS} skills")
    return _compact(ids)


def _type_names(value: str) -> str:
    names: list[str] = []
    for item in _json_list(value):
        if not isinstance(item, str):
            raise ValueError("expected type names")
        name = item.strip()
        if not name or len(name) > MAX_TYPE_NAME_LENGTH:
            raise ValueError(f"type names are 1 to {MAX_TYPE_NAME_LENGTH} characters")
        if name not in names:
            names.append(name)
    return _compact(names)


def _field_labels(value: str) -> str:
    """``{built-in field: label}``, labels trimmed, keys in display order."""
    try:
        labels = json.loads(value)
    except ValueError as exc:
        raise ValueError("expected a JSON object") from exc
    if not isinstance(labels, dict):
        raise ValueError("expected a JSON object")
    canonical: dict[str, str] = {}
    for key in labels:
        if key not in BUILT_IN_PROJECT_FIELDS:
            raise ValueError(f"expected keys among {', '.join(BUILT_IN_PROJECT_FIELDS)}")
    for key in BUILT_IN_PROJECT_FIELDS:
        if key not in labels:
            continue
        label = labels[key]
        if not isinstance(label, str):
            raise ValueError("expected labels")
        label = label.strip()
        if not label or len(label) > MAX_FIELD_LABEL_LENGTH:
            raise ValueError(f"labels are 1 to {MAX_FIELD_LABEL_LENGTH} characters")
        canonical[key] = label
    return json.dumps(canonical, separators=(",", ":"), ensure_ascii=False)


def _hidden_fields(value: str) -> str:
    """The hidden built-in fields, unique, in display order (never ``confirmed``)."""
    items = _json_list(value)
    for item in items:
        if not isinstance(item, str) or item not in HIDEABLE_PROJECT_FIELDS:
            raise ValueError(f"expected fields among {', '.join(HIDEABLE_PROJECT_FIELDS)}")
    return _compact([key for key in HIDEABLE_PROJECT_FIELDS if key in items])


def _tooltip_rows(value: str) -> str:
    """
    The shown rows: built-in keys in display order, then custom field ids
    ascending, each once. Existence is not checked (a deleted field's id is
    ignored by the readers until the next save).
    """
    keys: set[str] = set()
    ids: set[int] = set()
    for item in _json_list(value):
        if isinstance(item, str):
            if item not in PROJECT_TOOLTIP_ROWS:
                raise ValueError(f"expected rows among {', '.join(PROJECT_TOOLTIP_ROWS)}")
            keys.add(item)
        # bool is an int subclass: true/false are not ids.
        elif isinstance(item, bool) or not isinstance(item, int) or item <= 0:
            raise ValueError("expected row keys or positive integer field ids")
        else:
            ids.add(item)
    if len(ids) > MAX_TOOLTIP_FIELD_IDS:
        raise ValueError(f"at most {MAX_TOOLTIP_FIELD_IDS} fields")
    rows: list[Any] = [key for key in PROJECT_TOOLTIP_ROWS if key in keys]
    return _compact(rows + sorted(ids))


def _help_url(value: str) -> str:
    """
    The manual's address (``help_url``): an absolute ``http`` / ``https`` URL
    with a host, no ``user:password@``, query or fragment, no whitespace or
    control character, at most 500 characters, stored with its scheme and host
    in lower case and exactly one trailing slash (``https://intranet.example/
    milestone-docs/``). It ends up in an ``<a href>``: anything else --
    ``javascript:``, ``data:``, a scheme-less value -- is refused.
    """
    text = value.strip()
    if not text or any(ch.isspace() or ord(ch) < 32 or ord(ch) == 127 for ch in text):
        raise ValueError("expected an http or https address without spaces")
    try:
        parts = urlsplit(text)
        hostname = parts.hostname
        parts.port  # noqa: B018 -- an invalid port raises ValueError here
    except ValueError as exc:
        raise ValueError("expected an http or https address") from exc
    if parts.scheme.lower() not in ("http", "https") or not hostname:
        raise ValueError("expected an http or https address")
    if "@" in parts.netloc:
        raise ValueError("an address must not carry a user name or password")
    if parts.query or parts.fragment or "?" in text or "#" in text:
        raise ValueError("an address must not carry a query or fragment")
    path = parts.path.rstrip("/") + "/"
    canonical = f"{parts.scheme.lower()}://{parts.netloc.lower()}{path}"
    if len(canonical) > MAX_HELP_URL_LENGTH:
        raise ValueError(f"an address has at most {MAX_HELP_URL_LENGTH} characters")
    return canonical


KNOWN_SETTINGS: dict[str, SettingSpec] = {
    "gantt_default_panel": SettingSpec(_choice("none", "staff", "equipment"), "none"),
    "staff_panel_default_skills": SettingSpec(_skill_ids, "[]"),
    "equipment_panel_default_types": SettingSpec(_type_names, "[]"),
    "kanban_enabled": SettingSpec(_boolean, "true"),
    "nager_enabled": SettingSpec(_boolean, "true"),
    "new_project_preselect_phases": SettingSpec(_boolean, "true"),
    # 2.1.0: false hides the % badges on the Gantt rows (the bar fill stays).
    "gantt_completion_badges": SettingSpec(_boolean, "true"),
    "project_field_labels": SettingSpec(_field_labels, "{}"),
    "project_fields_hidden": SettingSpec(_hidden_fields, "[]"),
    # 2.1.0: the built-in Volume's decimals; ``any`` = as typed.
    "volume_decimals": SettingSpec(_choice("any", "0", "1", "2", "3"), "1"),
    # 2.3.0: the rows of the Gantt's Shift-hover project details.
    "project_tooltip_rows": SettingSpec(
        _tooltip_rows, _compact(list(DEFAULT_PROJECT_TOOLTIP_ROWS))
    ),
    # 2.4.0: how long audit-log rows are kept, in days (0 = forever);
    # app/services/audit_log.purge_old applies it.
    "audit_log_retention_days": SettingSpec(_int_range(0, 3650), "365"),
    # 2.5.0: the timeline's Saturday and Sunday columns (a switch, display only).
    "show_weekends": SettingSpec(_boolean, "true"),
    # 2.5.0: Saturdays and Sundays count as working days in the dashboards,
    # capacity and availability. Off by default -- NOT a switch: read it with
    # ``weekends_working_from``, never ``flag_enabled``.
    "weekend_working_days": SettingSpec(_boolean, "false"),
    # 2.6.0: where Help in the user menu opens (a self-hosted copy of the
    # manual); the client checks the scheme again before using it.
    "help_url": SettingSpec(_help_url, DEFAULT_HELP_URL),
}

# Rows of the ``settings`` table the application keeps for itself (one-time
# markers of the data migrations, 2.6.0): never listed nor answered by
# ``GET /settings``, never written through ``PUT /settings/{key}``.
INTERNAL_SETTING_PREFIX = "_internal."


def is_internal_setting(key: str) -> bool:
    """Whether ``key`` is one of the application's own rows (``INTERNAL_SETTING_PREFIX``)."""
    return key.startswith(INTERNAL_SETTING_PREFIX)


# The settings Settings -> Project fields saves: writable with
# project_fields.manage as well as settings.general (PUT /settings/{key}).
PROJECT_FIELD_SETTING_KEYS: frozenset[str] = frozenset(
    {"project_field_labels", "project_fields_hidden", "volume_decimals", "project_tooltip_rows"}
)

# The permission keys a switch turned off disables for everyone.
FLAG_DISABLES: dict[str, frozenset[str]] = {"kanban_enabled": frozenset({"views.kanban"})}


def canonicalise(key: str, value: str) -> str:
    """
    The stored form of ``value`` for ``key``; ``ValueError`` when it does not fit.

    Unknown keys are free: their value is returned unchanged.
    """
    spec = KNOWN_SETTINGS.get(key)
    return value if spec is None else spec.canonicalise(value)


def default_for(key: str) -> str | None:
    """A known key's default, None for any other key."""
    spec = KNOWN_SETTINGS.get(key)
    return None if spec is None else spec.default


def with_defaults(values: Mapping[str, str | None]) -> dict[str, str | None]:
    """``values`` plus the default of every known key without a row."""
    merged = dict(values)
    for key, spec in KNOWN_SETTINGS.items():
        merged.setdefault(key, spec.default)
    return merged


def flag_enabled(value: str | None) -> bool:
    """A switch is on unless stored as exactly ``false`` (no row: on)."""
    return value != "false"


def weekends_working_from(value: str | None) -> bool:
    """
    Whether the stored ``weekend_working_days`` is on: only a row reading a
    case-insensitive ``true``, spaces trimmed (no row, or anything else: off
    -- not a switch, see above).
    """
    return value is not None and value.strip().lower() == "true"


def volume_decimals_from(value: str | None) -> int | None:
    """
    The decimals the stored ``volume_decimals`` keeps Volume to (None = as
    typed). Never raises: a missing, empty or malformed row (written before
    validation) reads as the default, 1.
    """
    if value == "any":
        return None
    if value in {"0", "1", "2", "3"}:
        return int(value)
    return 1


def disabled_permission_keys(kanban_value: str | None) -> frozenset[str]:
    """The permission keys disabled by the stored ``kanban_enabled`` value."""
    if flag_enabled(kanban_value):
        return frozenset()
    return FLAG_DISABLES["kanban_enabled"]


async def get_value(db: "AsyncSession", key: str) -> str | None:
    """The stored value of ``key`` (None without a row)."""
    from sqlalchemy import select

    from app.models.settings import Settings

    result = await db.execute(select(Settings.value).where(Settings.key == key))
    value: str | None = result.scalar_one_or_none()
    return value


async def is_enabled(db: "AsyncSession", key: str) -> bool:
    """Whether the switch ``key`` is on (one query)."""
    return flag_enabled(await get_value(db, key))


async def weekends_working(db: "AsyncSession") -> bool:
    """Whether Saturdays and Sundays are working days (one query, off by default)."""
    return weekends_working_from(await get_value(db, "weekend_working_days"))


async def volume_decimals(db: "AsyncSession") -> int | None:
    """Volume's decimals (None = as typed), from the stored setting (one query)."""
    return volume_decimals_from(await get_value(db, "volume_decimals"))
