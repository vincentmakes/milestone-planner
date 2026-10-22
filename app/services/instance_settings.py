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

Import-light like app/services/permissions.py: the model is imported inside
the readers.
"""

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

MAX_DEFAULT_SKILLS = 500
MAX_TYPE_NAME_LENGTH = 100

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


KNOWN_SETTINGS: dict[str, SettingSpec] = {
    "gantt_default_panel": SettingSpec(_choice("none", "staff", "equipment"), "none"),
    "staff_panel_default_skills": SettingSpec(_skill_ids, "[]"),
    "equipment_panel_default_types": SettingSpec(_type_names, "[]"),
    "kanban_enabled": SettingSpec(_boolean, "true"),
    "nager_enabled": SettingSpec(_boolean, "true"),
    "new_project_preselect_phases": SettingSpec(_boolean, "true"),
}

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
