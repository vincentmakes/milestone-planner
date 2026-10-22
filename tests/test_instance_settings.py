"""
Known instance settings (app/services/instance_settings.py): canonical values,
defaults, the boolean flag reading and the permission keys a flag disables.

Pure unit tests; the two DB readers run against a mock session.
"""

import json
from unittest.mock import AsyncMock

import pytest

from app.services.instance_settings import (
    FLAG_DISABLES,
    KNOWN_SETTINGS,
    canonicalise,
    default_for,
    disabled_permission_keys,
    flag_enabled,
    get_value,
    is_enabled,
    with_defaults,
)
from app.services.permissions import DISABLEABLE_KEYS, PERMISSION_KEYS, PermissionSet
from tests.support import scalar_result

DEFAULTS = {
    "gantt_default_panel": "none",
    "staff_panel_default_skills": "[]",
    "equipment_panel_default_types": "[]",
    "kanban_enabled": "true",
    "nager_enabled": "true",
    "new_project_preselect_phases": "true",
}

BOOLEAN_KEYS = ["kanban_enabled", "nager_enabled", "new_project_preselect_phases"]


def test_the_six_known_keys_and_their_defaults():
    assert {key: spec.default for key, spec in KNOWN_SETTINGS.items()} == DEFAULTS
    assert all(default_for(key) == value for key, value in DEFAULTS.items())
    assert default_for("instance_title") is None


def test_every_default_is_already_canonical():
    for key, value in DEFAULTS.items():
        assert canonicalise(key, value) == value


# ---------------------------------------------------------------------------
# Booleans
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("key", BOOLEAN_KEYS)
@pytest.mark.parametrize(
    ("raw", "canonical"),
    [
        ("true", "true"),
        ("TRUE", "true"),
        (" True ", "true"),
        ("1", "true"),
        ("yes", "true"),
        ("on", "true"),
        ("false", "false"),
        ("False", "false"),
        ("0", "false"),
        ("no", "false"),
        ("OFF", "false"),
    ],
)
def test_booleans_are_stored_as_true_or_false(key, raw, canonical):
    assert canonicalise(key, raw) == canonical


@pytest.mark.parametrize("key", BOOLEAN_KEYS)
@pytest.mark.parametrize("raw", ["", "maybe", "2", "truthy", "[]"])
def test_other_boolean_spellings_are_rejected(key, raw):
    with pytest.raises(ValueError):
        canonicalise(key, raw)


# ---------------------------------------------------------------------------
# Default panel
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "canonical"),
    [("none", "none"), ("staff", "staff"), (" Equipment ", "equipment"), ("STAFF", "staff")],
)
def test_default_panel_choices(raw, canonical):
    assert canonicalise("gantt_default_panel", raw) == canonical


@pytest.mark.parametrize("raw", ["", "kanban", "staff,equipment", "null"])
def test_default_panel_rejects_other_values(raw):
    with pytest.raises(ValueError):
        canonicalise("gantt_default_panel", raw)


# ---------------------------------------------------------------------------
# Default skill filter
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "canonical"),
    [
        ("[]", "[]"),
        ("[1, 2]", "[1,2]"),
        (" [ 3 ,1,3, 2,1 ] ", "[3,1,2]"),  # de-duplicated, order kept
    ],
)
def test_skill_ids_are_compact_unique_positive_ints(raw, canonical):
    assert canonicalise("staff_panel_default_skills", raw) == canonical


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "not json",
        "{}",
        "1",
        "[0]",
        "[-4]",
        "[1.5]",
        '["1"]',
        "[true]",
        "[null]",
        "[[1]]",
    ],
)
def test_skill_ids_reject_anything_else(raw):
    with pytest.raises(ValueError):
        canonicalise("staff_panel_default_skills", raw)


def test_skill_ids_are_capped_at_500():
    assert canonicalise("staff_panel_default_skills", json.dumps(list(range(1, 501))))
    with pytest.raises(ValueError):
        canonicalise("staff_panel_default_skills", json.dumps(list(range(1, 502))))


def test_the_cap_counts_unique_skill_ids():
    assert canonicalise("staff_panel_default_skills", json.dumps([1] * 600)) == "[1]"


# ---------------------------------------------------------------------------
# Default equipment-type filter
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "canonical"),
    [
        ("[]", "[]"),
        ('["HPLC", "GC"]', '["HPLC","GC"]'),
        ('[" HPLC ", "HPLC", "GC"]', '["HPLC","GC"]'),
        ('["Réacteur"]', '["Réacteur"]'),
    ],
)
def test_type_names_are_compact_unique_trimmed_strings(raw, canonical):
    assert canonicalise("equipment_panel_default_types", raw) == canonical


@pytest.mark.parametrize("raw", ["", "HPLC", '"HPLC"', "[1]", '[""]', '["   "]', "[null]", "{}"])
def test_type_names_reject_anything_else(raw):
    with pytest.raises(ValueError):
        canonicalise("equipment_panel_default_types", raw)


def test_type_names_are_at_most_100_characters():
    assert canonicalise("equipment_panel_default_types", json.dumps(["x" * 100]))
    with pytest.raises(ValueError):
        canonicalise("equipment_panel_default_types", json.dumps(["x" * 101]))


# ---------------------------------------------------------------------------
# Unknown keys, defaults merge
# ---------------------------------------------------------------------------


def test_unknown_keys_are_free():
    assert canonicalise("instance_title", "  anything at all ") == "  anything at all "


def test_with_defaults_fills_only_missing_known_keys():
    stored = {"instance_title": "Lab", "kanban_enabled": "false", "nager_enabled": None}

    merged = with_defaults(stored)

    assert merged == {
        **DEFAULTS,
        "instance_title": "Lab",
        "kanban_enabled": "false",
        "nager_enabled": None,
    }
    assert stored == {"instance_title": "Lab", "kanban_enabled": "false", "nager_enabled": None}


# ---------------------------------------------------------------------------
# Flags and the permission keys they disable
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "enabled"),
    [(None, True), ("true", True), ("", True), ("False", True), ("false", False)],
)
def test_a_flag_is_on_unless_stored_false(value, enabled):
    assert flag_enabled(value) is enabled


def test_kanban_off_disables_the_board_view_key():
    assert FLAG_DISABLES == {"kanban_enabled": frozenset({"views.kanban"})}
    assert disabled_permission_keys("false") == frozenset({"views.kanban"})
    assert disabled_permission_keys("true") == frozenset()
    assert disabled_permission_keys(None) == frozenset()


@pytest.mark.parametrize("flag", sorted(FLAG_DISABLES))
def test_every_key_a_flag_disables_is_disableable(flag):
    """
    A key a switch turns off but ``DISABLEABLE_KEYS`` does not list would make
    ``PermissionSet.__post_init__`` raise on every request while the switch is
    off: the drift fails here instead.
    """
    keys = FLAG_DISABLES[flag]
    assert keys <= DISABLEABLE_KEYS
    assert keys <= PERMISSION_KEYS
    assert PermissionSet("admin", disabled_keys=keys).disabled_keys == keys


async def test_get_value_reads_one_row():
    db = AsyncMock()
    db.execute.return_value = scalar_result("false")

    assert await get_value(db, "kanban_enabled") == "false"
    sql = str(db.execute.await_args.args[0].compile(compile_kwargs={"literal_binds": True}))
    assert "FROM settings" in sql
    assert "settings.key = 'kanban_enabled'" in sql


@pytest.mark.parametrize(("stored", "enabled"), [(None, True), ("true", True), ("false", False)])
async def test_is_enabled_defaults_to_on(stored, enabled):
    db = AsyncMock()
    db.execute.return_value = scalar_result(stored)

    assert await is_enabled(db, "nager_enabled") is enabled
