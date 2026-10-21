"""
The permission catalogue (app/services/permissions.py) is the single source of
truth for permission keys: the role matrix, the seed SQL, the frontend mirror
(shared/permission-keys.json) and every later gate read it. These tests pin the
key spellings, the shipped defaults (which reproduce the pre-RBAC behaviour of
the superuser and user roles), the PM bundle and the approvable keys.
"""

import json
import re
from pathlib import Path

import pytest

from app.services import permissions as perms
from app.services.permissions import (
    ADMIN_ROLE_KEY,
    APPROVABLE_KEYS,
    LOCKED_KEYS,
    PERMISSION_KEYS,
    PERMISSIONS,
    PM_BUNDLE,
    SYSTEM_ROLE_KEYS,
    SYSTEM_ROLES,
    Permission,
    build_default_role_permissions_sql,
    default_modes,
    permission_keys_json,
)

ROOT = Path(__file__).resolve().parents[1]
KEYS_FILE = ROOT / "shared" / "permission-keys.json"

# (group, key, superuser default, user default) in catalogue order.
# a = allow, - = deny (no row). "PM" in the plan's table = deny, granted via the bundle.
CATALOGUE = [
    ("Projects", "projects.view", "a", "a"),
    ("Projects", "projects.create", "a", "-"),
    ("Projects", "projects.edit_any", "a", "-"),
    ("Projects", "projects.manage_as_pm", "a", "a"),
    ("Projects", "projects.archive", "a", "-"),
    ("Projects", "projects.delete", "a", "-"),
    ("Projects", "projects.import", "a", "-"),
    ("Projects", "projects.export", "a", "-"),
    ("Staff assignments", "assignments.manage_others", "a", "-"),
    ("Staff assignments", "assignments.self_create", "a", "a"),
    ("Staff assignments", "assignments.self_update", "a", "a"),
    ("Staff assignments", "assignments.self_remove", "a", "a"),
    ("Equipment bookings", "equipment_bookings.manage", "a", "-"),
    ("Kanban", "kanban.move_any", "a", "-"),
    ("Kanban", "kanban.move_assigned", "a", "a"),
    ("Kanban", "kanban.comment", "a", "a"),
    ("Kanban", "kanban.moderate_comments", "a", "-"),
    ("Custom columns", "custom_columns.manage", "-", "-"),
    ("Custom columns", "custom_columns.set_values", "a", "a"),
    ("Absences", "absences.view_others", "a", "a"),
    ("Absences", "absences.manage_own", "a", "a"),
    ("Absences", "absences.manage_others", "a", "-"),
    ("Staff notes", "staff_notes.manage", "a", "-"),
    ("Equipment", "equipment.manage", "a", "-"),
    ("Equipment", "equipment_types.manage", "a", "-"),
    ("Equipment", "equipment_blocks.manage", "a", "-"),
    ("Calendar", "bank_holidays.manage", "a", "-"),
    ("Calendar", "company_events.manage", "a", "-"),
    ("Sites", "sites.view_all", "-", "-"),
    ("Sites", "sites.manage", "-", "-"),
    ("Sites", "sites.export", "a", "-"),
    ("Teams", "teams.manage", "a", "-"),
    ("Users", "users.view", "a", "-"),
    ("Users", "users.create", "-", "-"),
    ("Users", "users.edit", "a", "-"),
    ("Users", "users.edit_credentials", "-", "-"),
    ("Users", "users.edit_admins", "-", "-"),
    ("Users", "users.change_role", "-", "-"),
    ("Users", "users.toggle_active", "-", "-"),
    ("Users", "users.delete", "-", "-"),
    ("Skills", "skills.manage", "a", "-"),
    ("Skills", "skills.assign", "a", "-"),
    ("Project configuration", "tags.manage", "-", "-"),
    ("Project configuration", "absence_types.manage", "-", "-"),
    ("Project configuration", "predefined_phases.manage", "a", "-"),
    ("Instance settings", "settings.general", "-", "-"),
    ("Instance settings", "settings.sso", "-", "-"),
    ("Roles, approvals, todos", "roles.manage", "-", "-"),
    ("Roles, approvals, todos", "approvals.view_all", "-", "-"),
    ("Roles, approvals, todos", "todos.manage_own", "a", "a"),
    ("Roles, approvals, todos", "todos.assign_others", "a", "-"),
    ("Views and tools", "views.kanban", "a", "a"),
    ("Views and tools", "views.staff", "a", "a"),
    ("Views and tools", "views.equipment", "a", "a"),
    ("Views and tools", "views.crosssite", "a", "a"),
    ("Views and tools", "views.archived", "a", "a"),
    ("Views and tools", "whatif.use", "a", "-"),
    ("Views and tools", "system.api_docs", "-", "-"),
    ("Views and tools", "system.ws_debug", "-", "-"),
]


def _mode(flag: str) -> str | None:
    return "allow" if flag == "a" else None


# ---------------------------------------------------------------------------
# Keys and groups
# ---------------------------------------------------------------------------


def test_catalogue_lists_every_key_in_order_with_its_group():
    assert [(p.group, p.key) for p in PERMISSIONS] == [(g, k) for g, k, _, _ in CATALOGUE]


def test_catalogue_has_59_unique_keys():
    # The plan's prose says "58 keys"; its own table (and the design draft's)
    # lists 59. The table is the binding key list.
    keys = [p.key for p in PERMISSIONS]
    assert len(keys) == 59
    assert len(set(keys)) == len(keys)
    assert frozenset(keys) == PERMISSION_KEYS


@pytest.mark.parametrize("permission", PERMISSIONS, ids=lambda p: p.key)
def test_every_entry_is_complete(permission: Permission):
    assert re.fullmatch(r"[a-z_]+\.[a-z_]+", permission.key)
    assert len(permission.key) <= 60  # role_permissions.permission VARCHAR(60)
    assert permission.group.strip()
    assert permission.label.strip()
    assert permission.description.strip()


def test_groups_are_contiguous():
    seen: list[str] = []
    for permission in PERMISSIONS:
        if not seen or seen[-1] != permission.group:
            assert permission.group not in seen, permission.group
            seen.append(permission.group)
    assert len(seen) == 17


def test_permission_is_immutable():
    with pytest.raises(AttributeError):
        PERMISSIONS[0].key = "x"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Approvable keys, PM bundle, locked keys
# ---------------------------------------------------------------------------


def test_approvable_keys_are_the_three_own_booking_keys():
    assert APPROVABLE_KEYS == frozenset(
        {"assignments.self_create", "assignments.self_update", "assignments.self_remove"}
    )
    assert APPROVABLE_KEYS <= PERMISSION_KEYS
    assert {p.key for p in PERMISSIONS if p.approvable} == APPROVABLE_KEYS


def test_pm_bundle():
    assert PM_BUNDLE == frozenset(
        {
            "projects.edit_any",
            "projects.archive",
            "assignments.manage_others",
            "equipment_bookings.manage",
            "kanban.move_any",
            "custom_columns.set_values",
            "todos.assign_others",
        }
    )
    assert PM_BUNDLE <= PERMISSION_KEYS
    # Never in the bundle: delete / create / import / export, the PM key itself.
    for key in (
        "projects.delete",
        "projects.create",
        "projects.import",
        "projects.export",
        "projects.manage_as_pm",
    ):
        assert key not in PM_BUNDLE


def test_locked_keys():
    assert LOCKED_KEYS == frozenset({"projects.view", "roles.manage"})
    assert LOCKED_KEYS <= PERMISSION_KEYS


# ---------------------------------------------------------------------------
# System roles and defaults
# ---------------------------------------------------------------------------


def test_system_roles():
    assert ADMIN_ROLE_KEY == "admin"
    assert SYSTEM_ROLE_KEYS == ("admin", "superuser", "user")
    assert tuple(r.key for r in SYSTEM_ROLES) == SYSTEM_ROLE_KEYS
    assert [r.sort_order for r in SYSTEM_ROLES] == [0, 1, 2]
    names = [r.name for r in SYSTEM_ROLES]
    assert len(set(names)) == len(names)
    for role in SYSTEM_ROLES:
        assert re.fullmatch(r"[a-z][a-z0-9_]{1,19}", role.key)
        assert role.name.strip() and role.description.strip()


@pytest.mark.parametrize("permission", PERMISSIONS, ids=lambda p: p.key)
def test_defaults_only_reference_editable_system_roles(permission: Permission):
    # The admin role holds everything in code and never has rows.
    assert set(permission.defaults) <= {"superuser", "user"}
    for mode in permission.defaults.values():
        assert mode in ("allow", "approval", None)
        if mode == "approval":
            assert permission.approvable


@pytest.mark.parametrize(("group", "key", "su", "user"), CATALOGUE, ids=[c[1] for c in CATALOGUE])
def test_shipped_defaults_reproduce_todays_behaviour(group, key, su, user):
    permission = next(p for p in PERMISSIONS if p.key == key)
    assert permission.defaults.get("superuser") == _mode(su)
    assert permission.defaults.get("user") == _mode(user)


def test_locked_keys_defaults():
    assert default_modes("superuser")["projects.view"] == "allow"
    assert default_modes("user")["projects.view"] == "allow"
    assert "roles.manage" not in default_modes("superuser")
    assert "roles.manage" not in default_modes("user")


def test_default_modes():
    su = default_modes("superuser")
    user = default_modes("user")
    assert su == {k: "allow" for _, k, s, _ in CATALOGUE if s == "a"}
    assert user == {k: "allow" for _, k, _, u in CATALOGUE if u == "a"}
    assert default_modes(ADMIN_ROLE_KEY) == {}
    assert default_modes("team_lead") == {}


# ---------------------------------------------------------------------------
# Seed SQL
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def seed_sql() -> str:
    return re.sub(r"\s+", " ", build_default_role_permissions_sql()).strip()


def test_seed_sql_is_one_statement(seed_sql):
    # asyncpg runs one statement per call and split_sql_statements splits on ';'.
    assert ";" not in build_default_role_permissions_sql()
    assert "$$" not in build_default_role_permissions_sql()
    assert build_default_role_permissions_sql() == build_default_role_permissions_sql()


def test_seed_sql_inserts_the_system_roles_idempotently(seed_sql):
    assert seed_sql.startswith("WITH new_roles AS ( INSERT INTO roles (key, name, description,")
    assert "ON CONFLICT (key) DO NOTHING RETURNING id, key )" in seed_sql
    for role in SYSTEM_ROLES:
        assert f"('{role.key}', '{role.name}', " in seed_sql


def test_seed_sql_only_seeds_roles_created_by_the_same_statement(seed_sql):
    # Defaults join the RETURNING rows of the role insert: a role that already
    # existed (and may have been edited by an admin) is never re-seeded.
    assert "INSERT INTO role_permissions (role_id, permission, mode)" in seed_sql
    assert "FROM new_roles r JOIN" in seed_sql
    assert "ON d.role_key = r.key" in seed_sql


def test_seed_sql_mentions_every_default_row_and_nothing_else(seed_sql):
    rows = set(re.findall(r"\('(\w+)', '([a-z_.]+)', '(allow|approval)'\)", seed_sql))
    expected = {
        (role, key, mode)
        for role in ("superuser", "user")
        for key, mode in default_modes(role).items()
    }
    assert rows == expected
    assert not any(role == ADMIN_ROLE_KEY for role, _, _ in rows)


def test_seed_sql_escapes_quotes(monkeypatch):
    role = perms.SystemRole("superuser", "O'Brien", "It's odd", 9)
    monkeypatch.setattr(perms, "SYSTEM_ROLES", (role,))
    sql = build_default_role_permissions_sql()
    assert "('superuser', 'O''Brien', 'It''s odd', TRUE, 9)" in sql
    assert "('user', " not in sql  # only the listed roles are seeded


# ---------------------------------------------------------------------------
# shared/permission-keys.json (read by the frontend mirror test)
# ---------------------------------------------------------------------------


def test_permission_keys_json_shape():
    data = json.loads(permission_keys_json())
    assert data == {
        "keys": sorted(PERMISSION_KEYS),
        "approvable": sorted(APPROVABLE_KEYS),
        "pm_bundle": sorted(PM_BUNDLE),
    }
    assert permission_keys_json().endswith("}\n")


def test_committed_permission_keys_file_is_up_to_date():
    if not KEYS_FILE.parent.exists():
        pytest.skip("shared/ is not part of this checkout")
    assert KEYS_FILE.read_text() == permission_keys_json(), (
        "shared/permission-keys.json is stale; regenerate it with: python -c "
        '"from app.services.permissions import permission_keys_json; '
        "open('shared/permission-keys.json', 'w').write(permission_keys_json())\""
    )
