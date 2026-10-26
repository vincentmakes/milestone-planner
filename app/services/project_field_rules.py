"""
Project-field rules shared by the routers (2.0.0).

The items of a dropdown field (select / multiselect) are scoped like tags:

- an item restricted to some sites (``all_sites = false``) applies only to
  projects at one of those sites; a project without a site may only hold
  items available at every site;
- an item linked to teams at a site applies to a project at that site only
  when the project shares one of those teams (team rows at other sites do not
  restrict it there).

The count helpers back the 409s that keep existing projects consistent when an
item's sites or teams are narrowed underneath projects that hold it; they are
the tag counters of ``tag_rules`` over ``project_field_selections``, and the
409 details share the tag texts' shape ("... use this item").

A project's values travel as ``field_values: {field_id: value}``: text a
string (trimmed, at most 2000 characters), number a finite number, toggle a
boolean, select an item id (or a one-item list), multiselect a list of item
ids. ``null``, ``""`` and ``[]`` clear. ``validate_field_values`` checks a
write, ``apply_field_values`` writes it onto the project, and
``load_project_field_values`` reads the values of many projects in two
queries (responses list the items of a field in item order).

Error details are plain strings (the frontend renders ``detail`` as text).
"""

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException
from sqlalchemy import func, select, union
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.project_field import (
    DROPDOWN_FIELD_TYPES,
    ProjectField,
    ProjectFieldOption,
    ProjectFieldSelection,
    ProjectFieldValue,
)
from app.models.team import Team
from app.services.tag_rules import (
    count_linked_projects_outside_sites,
    count_linked_projects_outside_teams,
    other_sites_conflict_detail,
    other_teams_conflict_detail,
)

if TYPE_CHECKING:
    from app.models.project import Project

ITEM_NOUN = "item"

# A text value's maximum length (after trimming) and the most items a
# dropdown value may list.
MAX_TEXT_VALUE_LENGTH = 2000
MAX_ITEMS_PER_VALUE = 500


def invalid_value_detail(field_name: str) -> str:
    """422: a value of the wrong type for its field (or a non-finite number)."""
    return f'Invalid value for "{field_name}"'


def text_too_long_detail(field_name: str) -> str:
    """422: a text value longer than ``MAX_TEXT_VALUE_LENGTH``."""
    return f'"{field_name}" can be at most {MAX_TEXT_VALUE_LENGTH} characters'


def not_an_item_of_field_detail(option_name: str, field_name: str) -> str:
    """400: an item of another field given as a value of ``field_name``."""
    return f'The item "{option_name}" is not an item of "{field_name}"'


def single_item_detail(field_name: str) -> str:
    """400: more than one item for a ``select`` field."""
    return f'Only one item of "{field_name}" can be chosen'


def option_not_applicable_detail(option_name: str, field_name: str) -> str:
    """400: the tag site text, for an item of ``field_name``."""
    return f'The item "{option_name}" of "{field_name}" is not available at this project\'s site'


def option_not_applicable_to_teams_detail(option_name: str, field_name: str) -> str:
    """400: the tag team text, for an item of ``field_name``."""
    return (
        f'The item "{option_name}" of "{field_name}" is limited to teams '
        "this project is not part of"
    )


def option_other_sites_conflict_detail(count: int) -> str:
    """409 when narrowing an item's sites: "2 projects at other sites use this item"."""
    return other_sites_conflict_detail(count, ITEM_NOUN)


def option_other_teams_conflict_detail(count: int) -> str:
    """409 when narrowing an item's teams: "1 project outside these teams uses this item"."""
    return other_teams_conflict_detail(count, ITEM_NOUN)


def option_applies_to_site(option: ProjectFieldOption, site_id: int | None) -> bool:
    """Whether ``option`` may be held by a project at ``site_id``."""
    if option.all_sites:
        return True
    return site_id is not None and site_id in option.site_ids


def option_applies_to_project(
    option: ProjectFieldOption, site_id: int | None, team_ids: Iterable[int]
) -> bool:
    """Whether ``option`` may be held by a project at ``site_id`` in teams ``team_ids``."""
    if not option_applies_to_site(option, site_id):
        return False
    scoped = {team.id for team in option.teams if team.site_id == site_id}
    return not scoped or bool(scoped & set(team_ids))


async def count_projects_outside_option_sites(
    db: AsyncSession, option_id: int, site_ids: list[int]
) -> int:
    """Projects holding ``option_id`` that are not at one of ``site_ids`` (incl. site-less ones)."""
    return await count_linked_projects_outside_sites(
        db,
        ProjectFieldSelection.project_id,
        ProjectFieldSelection.option_id,
        option_id,
        site_ids,
    )


async def count_projects_outside_option_teams(
    db: AsyncSession, option_id: int, teams: list[Team]
) -> int:
    """
    Projects holding ``option_id`` at a site of ``teams`` that share none of ``teams``.

    No query for no teams.
    """
    return await count_linked_projects_outside_teams(
        db,
        ProjectFieldSelection.project_id,
        ProjectFieldSelection.option_id,
        option_id,
        teams,
    )


async def count_projects_using_field(db: AsyncSession, field_id: int) -> int:
    """
    Projects holding a value or an item of ``field_id`` (what deleting it would clear).

    One query: the union of the value rows and the selections of the field's items.
    """
    with_value = select(ProjectFieldValue.project_id).where(ProjectFieldValue.field_id == field_id)
    with_item = (
        select(ProjectFieldSelection.project_id)
        .join(ProjectFieldOption, ProjectFieldOption.id == ProjectFieldSelection.option_id)
        .where(ProjectFieldOption.field_id == field_id)
    )
    projects = union(with_value, with_item).subquery()
    result = await db.execute(select(func.count()).select_from(projects))
    return int(result.scalar() or 0)


# ---------------------------------------------------------------------------
# Project values
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScalarValue:
    """The stored columns of a text / number / toggle value (one is set)."""

    value_text: str | None = None
    value_number: float | None = None
    value_bool: bool | None = None


@dataclass
class NormalisedValues:
    """
    A checked ``field_values`` write, per field given.

    ``scalars``: text / number / toggle fields, ``None`` = clear the value.
    ``selections``: dropdown fields, their items in item order (``[]`` = clear).
    Fields left out of the write appear in neither and stay unchanged.
    """

    scalars: dict[int, ScalarValue | None] = field(default_factory=dict)
    selections: dict[int, list[ProjectFieldOption]] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return bool(self.scalars or self.selections)


def _is_clear(value: Any) -> bool:
    return value is None or (isinstance(value, str | list) and len(value) == 0)


def _is_int(value: Any) -> bool:
    # bool is an int subclass: true / false are not ids or numbers here.
    return isinstance(value, int) and not isinstance(value, bool)


def _scalar(field_type: str, name: str, value: Any) -> ScalarValue | None:
    """The stored form of a text / number / toggle value (None = clear); 422 otherwise."""
    if _is_clear(value):
        return None
    if field_type == "text":
        if not isinstance(value, str):
            raise HTTPException(status_code=422, detail=invalid_value_detail(name))
        text = value.strip()
        if not text:
            return None
        if len(text) > MAX_TEXT_VALUE_LENGTH:
            raise HTTPException(status_code=422, detail=text_too_long_detail(name))
        return ScalarValue(value_text=text)
    if field_type == "number":
        if not (_is_int(value) or isinstance(value, float)):
            raise HTTPException(status_code=422, detail=invalid_value_detail(name))
        try:
            number = float(value)
        except OverflowError as exc:  # an int too large for a double
            raise HTTPException(status_code=422, detail=invalid_value_detail(name)) from exc
        if not math.isfinite(number):
            raise HTTPException(status_code=422, detail=invalid_value_detail(name))
        return ScalarValue(value_number=number)
    # toggle
    if not isinstance(value, bool):
        raise HTTPException(status_code=422, detail=invalid_value_detail(name))
    return ScalarValue(value_bool=value)


def _item_ids(field_type: str, name: str, value: Any) -> list[int]:
    """The item ids of a dropdown value, de-duplicated in order ([] = clear); 422 otherwise."""
    if _is_clear(value):
        return []
    if field_type == "select" and _is_int(value):
        return [value]
    if (
        not isinstance(value, list)
        or len(value) > MAX_ITEMS_PER_VALUE
        or not all(_is_int(item) for item in value)
    ):
        raise HTTPException(status_code=422, detail=invalid_value_detail(name))
    return list(dict.fromkeys(value))


async def validate_field_values(
    db: AsyncSession,
    site_id: int | None,
    team_ids: Iterable[int],
    field_values: Mapping[int, Any],
) -> NormalisedValues:
    """
    Check a project's ``field_values`` write for a project at ``site_id`` in ``team_ids``.

    400 for an item of another field, more than one item on a ``select``
    field, or an item that does not apply to the project's site or teams (the
    tag rules); 422 for a value of the wrong type, a non-finite number or a
    text over 2000 characters. Unknown field and item ids are dropped silently
    (deliberate, like tags: a What-If replay may carry the id of a field or an
    item deleted in the meantime), whatever value they carry. Two queries at
    most (the fields, then the items with their sites and teams); none for an
    empty write.
    """
    normalised = NormalisedValues()
    if not field_values:
        return normalised

    result = await db.execute(
        select(ProjectField.id, ProjectField.name, ProjectField.field_type).where(
            ProjectField.id.in_(set(field_values))
        )
    )
    fields = {row[0]: (row[1], row[2]) for row in result.all()}
    wanted: dict[int, list[int]] = {}
    for field_id in sorted(fields):
        name, field_type = fields[field_id]
        value = field_values[field_id]
        if field_type in DROPDOWN_FIELD_TYPES:
            wanted[field_id] = _item_ids(field_type, name, value)
        else:
            normalised.scalars[field_id] = _scalar(field_type, name, value)

    options: dict[int, ProjectFieldOption] = {}
    all_ids = {option_id for ids in wanted.values() for option_id in ids}
    if all_ids:
        # sites / teams loaded explicitly (the checks need them), as tags do.
        result = await db.execute(
            select(ProjectFieldOption)
            .options(selectinload(ProjectFieldOption.sites), selectinload(ProjectFieldOption.teams))
            .where(ProjectFieldOption.id.in_(all_ids))
        )
        options = {option.id: option for option in result.scalars().all()}

    project_team_ids = set(team_ids)
    for field_id, ids in wanted.items():
        name, field_type = fields[field_id]
        chosen = [options[option_id] for option_id in ids if option_id in options]
        for option in chosen:
            if option.field_id != field_id:
                raise HTTPException(
                    status_code=400, detail=not_an_item_of_field_detail(option.name, name)
                )
        if field_type == "select" and len(chosen) > 1:
            raise HTTPException(status_code=400, detail=single_item_detail(name))
        for option in chosen:
            if not option_applies_to_site(option, site_id):
                raise HTTPException(
                    status_code=400, detail=option_not_applicable_detail(option.name, name)
                )
            if not option_applies_to_project(option, site_id, project_team_ids):
                raise HTTPException(
                    status_code=400,
                    detail=option_not_applicable_to_teams_detail(option.name, name),
                )
        normalised.selections[field_id] = sorted(chosen, key=lambda o: (o.sort_order, o.id))
    return normalised


def current_selection_ids(project: "Project") -> dict[int, list[int]]:
    """The project's chosen items per dropdown field (from ``Project.field_selections``)."""
    current: dict[int, list[int]] = {}
    for option in project.field_selections:
        current.setdefault(option.field_id, []).append(option.id)
    return current


def apply_field_values(project: "Project", values: NormalisedValues) -> None:
    """
    Write a checked ``field_values`` onto ``project`` (new or loaded).

    Only the fields given change: a value row is inserted, updated or deleted
    (delete-orphan), a dropdown field's items are replaced.
    """
    rows = {row.field_id: row for row in project.field_values}
    for field_id, scalar in values.scalars.items():
        row = rows.get(field_id)
        if scalar is None:
            if row is not None:
                project.field_values.remove(row)
            continue
        if row is None:
            row = ProjectFieldValue(field_id=field_id)
            project.field_values.append(row)
        row.value_text = scalar.value_text
        row.value_number = scalar.value_number
        row.value_bool = scalar.value_bool
    if values.selections:
        kept = [o for o in project.field_selections if o.field_id not in values.selections]
        chosen = [o for options in values.selections.values() for o in options]
        project.field_selections = kept + chosen


async def load_project_field_values(
    db: AsyncSession, project_ids: Iterable[int]
) -> dict[int, dict[int, Any]]:
    """
    ``{project_id: {field_id: value}}`` for ``project_ids``, in two queries (none for none).

    Text a string, number a float, toggle a bool, select an item id,
    multiselect the item ids in item order. Fields without a value are left
    out. Column queries: nothing enters the session's identity map, so the
    caller's ORM objects and later validation are unaffected.
    """
    ids = set(project_ids)
    values: dict[int, dict[int, Any]] = {project_id: {} for project_id in ids}
    if not ids:
        return values

    result = await db.execute(
        select(
            ProjectFieldValue.project_id,
            ProjectFieldValue.field_id,
            ProjectField.field_type,
            ProjectFieldValue.value_text,
            ProjectFieldValue.value_number,
            ProjectFieldValue.value_bool,
        )
        .join(ProjectField, ProjectField.id == ProjectFieldValue.field_id)
        .where(ProjectFieldValue.project_id.in_(ids))
        .order_by(ProjectFieldValue.project_id, ProjectField.sort_order, ProjectField.id)
    )
    for project_id, field_id, field_type, text, number, flag in result.all():
        value = {"text": text, "number": number, "toggle": flag}.get(field_type)
        if value is not None:
            values[project_id][field_id] = value

    result = await db.execute(
        select(
            ProjectFieldSelection.project_id,
            ProjectFieldOption.field_id,
            ProjectField.field_type,
            ProjectFieldOption.id,
        )
        .join(ProjectFieldOption, ProjectFieldOption.id == ProjectFieldSelection.option_id)
        .join(ProjectField, ProjectField.id == ProjectFieldOption.field_id)
        .where(ProjectFieldSelection.project_id.in_(ids))
        .order_by(
            ProjectFieldSelection.project_id,
            ProjectField.sort_order,
            ProjectField.id,
            ProjectFieldOption.sort_order,
            ProjectFieldOption.id,
        )
    )
    for project_id, field_id, field_type, option_id in result.all():
        project_values = values[project_id]
        if field_type == "select":
            # One item at most; should old data hold more, the first wins.
            project_values.setdefault(field_id, option_id)
        else:
            project_values.setdefault(field_id, []).append(option_id)
    return values
