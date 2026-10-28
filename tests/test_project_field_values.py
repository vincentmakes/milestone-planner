"""
Project-field values on projects (app/services/project_field_rules.py, 2.0.0).

``validate_field_values`` checks a ``field_values`` write: every type, the
clears (``null`` / ``""`` / ``[]``), item scope (site, teams), the one-item
rule of ``select`` fields, items of another field, and the What-If rule that
unknown item ids are dropped silently. ``apply_field_values`` writes it onto a
project (only the fields given change), ``current_selection_ids`` groups the
items a project holds, and ``load_project_field_values`` reads many projects'
values in two column queries.
"""

import math
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.models.project import Project
from app.models.project_field import ProjectFieldOption, ProjectFieldValue
from app.models.site import Site
from app.models.team import Team
from app.services.project_field_rules import (
    MAX_TEXT_VALUE_LENGTH,
    NormalisedValues,
    ScalarValue,
    apply_field_values,
    current_selection_ids,
    invalid_value_detail,
    load_project_field_values,
    not_an_item_of_field_detail,
    option_not_applicable_detail,
    option_not_applicable_to_teams_detail,
    single_item_detail,
    text_too_long_detail,
    validate_field_values,
)
from tests.support import scalars_result

# id → (name, type)
FIELDS = {
    1: ("Remark", "text"),
    2: ("Budget", "number"),
    3: ("Regulated", "toggle"),
    4: ("Project type", "select"),
    5: ("Area", "multiselect"),
}


def rows_result(rows):
    result = MagicMock()
    result.all.return_value = list(rows)
    return result


def _fields_result(*field_ids, decimals=None):
    """The fields query: (id, name, type, decimals) per field (decimals: {id: n})."""
    return rows_result([(fid, *FIELDS[fid], (decimals or {}).get(fid)) for fid in field_ids])


def _option(option_id, field_id, name, sort_order=0, site_ids=None, teams=()):
    return ProjectFieldOption(
        id=option_id,
        field_id=field_id,
        name=name,
        color="#6366f1",
        sort_order=sort_order,
        all_sites=site_ids is None,
        sites=[Site(id=sid, name=f"Site {sid}") for sid in (site_ids or [])],
        teams=list(teams),
    )


INTERNAL = _option(41, 4, "Internal", 0)
CUSTOMER = _option(42, 4, "Customer", 1)
PROCESS = _option(51, 5, "Process", 0)
ANALYTICS = _option(52, 5, "Analytics", 1)
FRANKFURT_ONLY = _option(53, 5, "GxP", 2, site_ids=[2])
QA_TEAM = Team(id=7, site_id=1, name="QA")
OTHER_SITE_TEAM = Team(id=8, site_id=2, name="Basel QC")
QA_ONLY = _option(54, 5, "QA", 3, teams=[QA_TEAM, OTHER_SITE_TEAM])


def _db(*results):
    db = MagicMock()
    db.execute = AsyncMock(side_effect=list(results))
    return db


def _sql(db) -> list[str]:
    return [
        " ".join(str(call.args[0].compile(compile_kwargs={"literal_binds": True})).split())
        for call in db.execute.await_args_list
    ]


async def _reject(db, values, status, detail, site_id=1, team_ids=()):
    with pytest.raises(HTTPException) as excinfo:
        await validate_field_values(db, site_id, team_ids, values)
    assert (excinfo.value.status_code, excinfo.value.detail) == (status, detail)


# ---------------------------------------------------------------------------
# Detail texts
# ---------------------------------------------------------------------------


def test_detail_texts():
    assert invalid_value_detail("Budget") == 'Invalid value for "Budget"'
    assert text_too_long_detail("Remark") == '"Remark" can be at most 2000 characters'
    assert (
        not_an_item_of_field_detail("Process", "Project type")
        == 'The item "Process" is not an item of "Project type"'
    )
    assert single_item_detail("Project type") == 'Only one item of "Project type" can be chosen'
    assert (
        option_not_applicable_detail("GxP", "Area")
        == 'The item "GxP" of "Area" is not available at this project\'s site'
    )
    assert (
        option_not_applicable_to_teams_detail("QA", "Area")
        == 'The item "QA" of "Area" is limited to teams this project is not part of'
    )


# ---------------------------------------------------------------------------
# validate_field_values
# ---------------------------------------------------------------------------


async def test_an_empty_write_runs_no_query():
    db = _db()

    normalised = await validate_field_values(db, 1, [], {})

    assert not normalised
    db.execute.assert_not_awaited()


async def test_every_scalar_type_is_normalised():
    db = _db(_fields_result(1, 2, 3))

    normalised = await validate_field_values(db, 1, [], {1: "  Pilot plant  ", 2: 12, 3: False})

    assert normalised.scalars == {
        1: ScalarValue(value_text="Pilot plant"),
        2: ScalarValue(value_number=12.0),
        3: ScalarValue(value_bool=False),
    }
    assert normalised.selections == {}
    assert db.execute.await_count == 1  # no item lookup without dropdown values
    assert "project_fields.id IN (1, 2, 3)" in _sql(db)[0]


@pytest.mark.parametrize("value", [None, "", []])
@pytest.mark.parametrize("field_id", [1, 2, 3])
async def test_null_and_empty_clear_a_scalar(field_id, value):
    normalised = await validate_field_values(
        _db(_fields_result(field_id)), 1, [], {field_id: value}
    )

    assert normalised.scalars == {field_id: None}


async def test_blank_text_clears_it():
    normalised = await validate_field_values(_db(_fields_result(1)), 1, [], {1: " \t "})

    assert normalised.scalars == {1: None}


@pytest.mark.parametrize("value", [-3.25, 0, 1e300, 10**20])
async def test_numbers_are_stored_as_floats(value):
    normalised = await validate_field_values(_db(_fields_result(2)), 1, [], {2: value})

    assert normalised.scalars[2] == ScalarValue(value_number=float(value))


async def test_a_number_is_rounded_half_up_to_the_fields_decimals():
    db = _db(_fields_result(2, decimals={2: 2}))

    normalised = await validate_field_values(db, 1, [], {2: 0.125})

    assert normalised.scalars[2] == ScalarValue(value_number=0.13)
    assert "project_fields.decimals" in _sql(db)[0]


async def test_a_number_without_decimals_is_kept_as_typed():
    normalised = await validate_field_values(_db(_fields_result(2)), 1, [], {2: 0.125})

    assert normalised.scalars[2] == ScalarValue(value_number=0.125)


@pytest.mark.parametrize(
    ("field_id", "value"),
    [
        (1, 5),
        (1, True),
        (1, ["a"]),
        (2, "12"),
        (2, True),
        (2, [1]),
        (2, math.nan),
        (2, math.inf),
        (2, -math.inf),
        (2, 10**400),  # too large for a double
        (3, "true"),
        (3, 1),
        (4, "41"),
        (4, True),
        (4, 4.0),
        (4, [41, "42"]),
        (5, 51),
        (5, "51"),
        (5, [51, None]),
        (5, [True]),
        (5, list(range(501))),
    ],
)
async def test_a_value_of_the_wrong_type_is_422(field_id, value):
    await _reject(
        _db(_fields_result(field_id)),
        {field_id: value},
        422,
        invalid_value_detail(FIELDS[field_id][0]),
    )


async def test_text_is_at_most_2000_characters():
    longest = "x" * MAX_TEXT_VALUE_LENGTH
    normalised = await validate_field_values(_db(_fields_result(1)), 1, [], {1: f" {longest} "})
    assert normalised.scalars[1] == ScalarValue(value_text=longest)

    await _reject(_db(_fields_result(1)), {1: longest + "y"}, 422, text_too_long_detail("Remark"))


async def test_unknown_field_ids_are_dropped_silently():
    # Field 99 was deleted meanwhile (a What-If replay): its key is ignored,
    # whatever it carries, and the known fields are written.
    db = _db(_fields_result(2))

    normalised = await validate_field_values(db, 1, [], {2: 7, 99: "anything"})

    assert normalised.scalars == {2: ScalarValue(value_number=7.0)}
    assert normalised.selections == {}
    assert "project_fields.id IN (2, 99)" in _sql(db)[0]


async def test_only_unknown_field_ids_write_nothing():
    db = _db(_fields_result())

    normalised = await validate_field_values(db, 1, [], {98: [1, 2], 99: None})

    assert not normalised
    assert db.execute.await_count == 1  # no item lookup


async def test_dropdown_items_are_checked_and_ordered_by_item_order():
    db = _db(_fields_result(4, 5), scalars_result([ANALYTICS, CUSTOMER, PROCESS]))

    normalised = await validate_field_values(db, 1, [], {4: 42, 5: [52, 51, 52]})

    assert normalised.selections == {4: [CUSTOMER], 5: [PROCESS, ANALYTICS]}
    assert normalised.scalars == {}
    item_sql = _sql(db)[1]
    assert "project_field_options.id IN (42, 51, 52)" in item_sql


async def test_a_select_accepts_a_one_item_list():
    db = _db(_fields_result(4), scalars_result([INTERNAL]))

    normalised = await validate_field_values(db, 1, [], {4: [41]})

    assert normalised.selections == {4: [INTERNAL]}


@pytest.mark.parametrize("value", [None, [], ""])
async def test_null_and_empty_clear_a_dropdown_without_an_item_query(value):
    db = _db(_fields_result(4, 5))

    normalised = await validate_field_values(db, 1, [], {4: value, 5: value})

    assert normalised.selections == {4: [], 5: []}
    assert db.execute.await_count == 1


async def test_unknown_item_ids_are_dropped_silently():
    # 999 was deleted meanwhile (a What-If replay): no error, nothing kept for it.
    db = _db(_fields_result(4, 5), scalars_result([PROCESS]))

    normalised = await validate_field_values(db, 1, [], {4: 999, 5: [999, 51]})

    assert normalised.selections == {4: [], 5: [PROCESS]}


async def test_two_items_on_a_select_field_are_400():
    await _reject(
        _db(_fields_result(4), scalars_result([INTERNAL, CUSTOMER])),
        {4: [41, 42]},
        400,
        single_item_detail("Project type"),
    )


async def test_an_unknown_id_does_not_count_towards_the_one_item_rule():
    db = _db(_fields_result(4), scalars_result([INTERNAL]))

    normalised = await validate_field_values(db, 1, [], {4: [999, 41]})

    assert normalised.selections == {4: [INTERNAL]}


async def test_an_item_of_another_field_is_400():
    await _reject(
        _db(_fields_result(4), scalars_result([PROCESS])),
        {4: 51},
        400,
        not_an_item_of_field_detail("Process", "Project type"),
    )


async def test_an_item_restricted_to_another_site_is_400():
    db = _db(_fields_result(5), scalars_result([FRANKFURT_ONLY]))
    await _reject(db, {5: [53]}, 400, option_not_applicable_detail("GxP", "Area"))
    # A site-less project only holds items available everywhere.
    db = _db(_fields_result(5), scalars_result([FRANKFURT_ONLY]))
    await _reject(db, {5: [53]}, 400, option_not_applicable_detail("GxP", "Area"), site_id=None)


async def test_an_item_restricted_to_the_projects_site_passes():
    db = _db(_fields_result(5), scalars_result([FRANKFURT_ONLY]))

    normalised = await validate_field_values(db, 2, [], {5: [53]})

    assert normalised.selections == {5: [FRANKFURT_ONLY]}


async def test_an_item_limited_to_teams_needs_one_of_them_at_the_site():
    db = _db(_fields_result(5), scalars_result([QA_ONLY]))
    await _reject(
        db, {5: [54]}, 400, option_not_applicable_to_teams_detail("QA", "Area"), team_ids=[3]
    )

    db = _db(_fields_result(5), scalars_result([QA_ONLY]))
    normalised = await validate_field_values(db, 1, [3, 7], {5: [54]})
    assert normalised.selections == {5: [QA_ONLY]}

    # At site 2 only the Basel team counts.
    db = _db(_fields_result(5), scalars_result([QA_ONLY]))
    await _reject(
        db,
        {5: [54]},
        400,
        option_not_applicable_to_teams_detail("QA", "Area"),
        site_id=2,
        team_ids=[7],
    )


async def test_the_item_query_loads_sites_and_teams_explicitly():
    db = _db(_fields_result(5), scalars_result([PROCESS]))

    await validate_field_values(db, 1, [], {5: [51]})

    stmt = db.execute.await_args_list[1].args[0]
    paths = {
        " -> ".join(str(attr) for attr in element.path.natural_path[1::2])
        for option in stmt._with_options
        for element in option.context
    }
    assert {"ProjectFieldOption.sites", "ProjectFieldOption.teams"} <= paths


# ---------------------------------------------------------------------------
# apply_field_values / current_selection_ids
# ---------------------------------------------------------------------------


def _project(values=(), selections=()):
    return Project(id=1, name="P", field_values=list(values), field_selections=list(selections))


def test_apply_inserts_updates_and_deletes_value_rows():
    kept = ProjectFieldValue(field_id=9, value_text="untouched")
    budget = ProjectFieldValue(field_id=2, value_number=5.0)
    remark = ProjectFieldValue(field_id=1, value_text="old")
    project = _project([kept, budget, remark])

    apply_field_values(
        project,
        NormalisedValues(
            scalars={
                2: ScalarValue(value_number=7.5),
                1: None,
                3: ScalarValue(value_bool=True),
            }
        ),
    )

    rows = {row.field_id: row for row in project.field_values}
    assert set(rows) == {9, 2, 3}
    assert rows[9] is kept and kept.value_text == "untouched"
    assert rows[2] is budget and budget.value_number == 7.5
    assert (rows[3].value_text, rows[3].value_number, rows[3].value_bool) == (None, None, True)


def test_apply_replaces_only_the_dropdown_fields_given():
    project = _project(selections=[INTERNAL, PROCESS, ANALYTICS])

    apply_field_values(project, NormalisedValues(selections={5: [ANALYTICS, QA_ONLY]}))
    assert project.field_selections == [INTERNAL, ANALYTICS, QA_ONLY]

    apply_field_values(project, NormalisedValues(selections={4: []}))
    assert project.field_selections == [ANALYTICS, QA_ONLY]


def test_apply_without_selections_leaves_them_alone():
    project = _project(selections=[INTERNAL])
    before = project.field_selections

    apply_field_values(project, NormalisedValues(scalars={1: None}))

    assert project.field_selections is before


def test_apply_on_a_new_project():
    project = Project(name="New")

    apply_field_values(
        project,
        NormalisedValues(scalars={1: ScalarValue(value_text="x")}, selections={4: [CUSTOMER]}),
    )

    assert [(r.field_id, r.value_text) for r in project.field_values] == [(1, "x")]
    assert project.field_selections == [CUSTOMER]


def test_current_selection_ids_groups_by_field():
    project = _project(selections=[INTERNAL, PROCESS, ANALYTICS])

    assert current_selection_ids(project) == {4: [41], 5: [51, 52]}


# ---------------------------------------------------------------------------
# load_project_field_values
# ---------------------------------------------------------------------------


async def test_load_runs_no_query_for_no_projects():
    db = _db()

    assert await load_project_field_values(db, []) == {}
    db.execute.assert_not_awaited()


async def test_load_reads_values_and_items_in_two_queries():
    db = _db(
        rows_result(
            [
                (10, 1, "text", "Pilot", None, None),
                (10, 2, "number", None, 12.5, None),
                (10, 3, "toggle", None, None, False),
                (11, 2, "number", None, None, None),  # an empty row: left out
            ]
        ),
        rows_result(
            [
                (10, 4, "select", 42),
                (10, 5, "multiselect", 51),
                (10, 5, "multiselect", 52),
                (11, 4, "select", 41),
                (11, 4, "select", 42),  # bad old data: the first item wins
            ]
        ),
    )

    values = await load_project_field_values(db, [10, 11, 12])

    assert values == {
        10: {1: "Pilot", 2: 12.5, 3: False, 4: 42, 5: [51, 52]},
        11: {4: 41},
        12: {},
    }
    value_sql, item_sql = _sql(db)
    assert "project_field_values.project_id IN (10, 11, 12)" in value_sql
    assert "JOIN project_fields" in value_sql
    assert "project_field_selections.project_id IN (10, 11, 12)" in item_sql
    assert item_sql.endswith(
        "ORDER BY project_field_selections.project_id, project_fields.sort_order, "
        "project_fields.id, project_field_options.sort_order, project_field_options.id"
    )
