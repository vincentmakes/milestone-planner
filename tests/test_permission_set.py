"""
PermissionSet: a user's resolved permissions for one request.

Built from the role key and the role's ``role_permissions`` rows (``{key: mode}``).
The admin role holds every key in code; ``projects.view`` is always allowed and
``roles.manage`` belongs to the admin role only, whatever the rows say; a role
holding ``projects.manage_as_pm`` gets the PM bundle on the projects it manages.
"""

from types import MappingProxyType
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.permissions import (
    APPROVABLE_KEYS,
    PERMISSION_KEYS,
    PM_BUNDLE,
    PermissionSet,
    default_modes,
    load_permission_set,
    role_display_name,
)


def test_admin_holds_every_catalogue_key():
    admin = PermissionSet("admin", {})
    assert admin.is_admin
    assert all(admin.has(key) for key in PERMISSION_KEYS)
    assert all(admin.mode(key) == "allow" for key in PERMISSION_KEYS)
    assert admin.allow_keys() == sorted(PERMISSION_KEYS)
    # The admin never books through approval.
    assert admin.approval_keys() == []


def test_admin_does_not_hold_unknown_keys():
    assert not PermissionSet("admin", {}).has("no.such_key")
    assert PermissionSet("admin", {}).mode("no.such_key") is None


def test_rows_decide_for_other_roles():
    role = PermissionSet(
        "team_lead",
        {"projects.create": "allow", "assignments.self_create": "approval"},
    )
    assert not role.is_admin
    assert role.has("projects.create")
    assert role.mode("projects.create") == "allow"
    # Approval mode is not an allow.
    assert role.mode("assignments.self_create") == "approval"
    assert not role.has("assignments.self_create")
    # No row = deny.
    assert role.mode("projects.delete") is None
    assert not role.has("projects.delete")


def test_projects_view_is_always_allowed():
    nobody = PermissionSet("viewer", {})
    assert nobody.has("projects.view")
    assert "projects.view" in nobody.allow_keys()


def test_roles_manage_is_admin_only_whatever_the_rows_say():
    sneaky = PermissionSet("sneaky", {"roles.manage": "allow"})
    assert not sneaky.has("roles.manage")
    assert "roles.manage" not in sneaky.allow_keys()


def test_rows_outside_the_catalogue_or_with_a_bad_mode_are_ignored():
    role = PermissionSet(
        "odd",
        {
            "removed.key": "allow",
            "projects.create": "approval",  # not approvable: treated as deny
            "projects.delete": "maybe",
        },
    )
    assert role.mode("removed.key") is None
    assert role.mode("projects.create") is None
    assert role.mode("projects.delete") is None
    assert role.allow_keys() == ["projects.view"]
    assert role.approval_keys() == []


def test_modes_are_read_only():
    role = PermissionSet("user", {"projects.create": "allow"})
    assert isinstance(role.modes, MappingProxyType)
    with pytest.raises(TypeError):
        role.modes["projects.delete"] = "allow"  # type: ignore[index]


def test_allow_and_approval_key_lists_are_sorted():
    role = PermissionSet(
        "demo",
        {
            "views.staff": "allow",
            "kanban.comment": "allow",
            "assignments.self_remove": "approval",
            "assignments.self_create": "approval",
        },
    )
    assert role.allow_keys() == ["kanban.comment", "projects.view", "views.staff"]
    assert role.approval_keys() == ["assignments.self_create", "assignments.self_remove"]


def test_default_user_role_matches_the_catalogue_defaults():
    user = PermissionSet("user", default_modes("user"))
    assert set(user.allow_keys()) == set(default_modes("user")) | {"projects.view"}
    assert user.approval_keys() == []


# ---------------------------------------------------------------------------
# can(): the PM bundle
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("key", sorted(PM_BUNDLE))
def test_pm_bundle_applies_on_the_users_own_project(key):
    pm = PermissionSet("user", {"projects.manage_as_pm": "allow"})
    assert not pm.has(key)
    assert pm.can(key, pm_id=7, user_id=7)
    assert not pm.can(key, pm_id=8, user_id=7)
    assert not pm.can(key, pm_id=None, user_id=7)
    assert not pm.can(key, pm_id=7, user_id=None)
    assert not pm.can(key)


def test_pm_bundle_needs_manage_as_pm():
    plain = PermissionSet("user", {})
    assert not plain.can("projects.edit_any", pm_id=7, user_id=7)


def test_pm_bundle_does_not_cover_delete():
    pm = PermissionSet("user", {"projects.manage_as_pm": "allow"})
    assert "projects.delete" not in PM_BUNDLE
    assert not pm.can("projects.delete", pm_id=7, user_id=7)


def test_can_is_has_for_a_held_key():
    editor = PermissionSet("superuser", {"projects.edit_any": "allow"})
    assert editor.can("projects.edit_any")
    assert editor.can("projects.edit_any", pm_id=1, user_id=2)


def test_admin_can_everything():
    assert PermissionSet("admin", {}).can("projects.delete", pm_id=1, user_id=2)


def test_approvable_keys_can_be_in_approval_mode():
    modes = dict.fromkeys(APPROVABLE_KEYS, "approval")
    role = PermissionSet("demo", modes)
    assert role.approval_keys() == sorted(APPROVABLE_KEYS)


# ---------------------------------------------------------------------------
# load_permission_set / role_display_name
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_load_permission_set_reads_the_role_rows():
    db = MagicMock()
    result = MagicMock()
    result.all.return_value = [
        ("projects.create", "allow"),
        ("assignments.self_create", "approval"),
    ]
    db.execute = AsyncMock(return_value=result)

    perms = await load_permission_set(db, "team_lead")

    assert perms.role_key == "team_lead"
    assert perms.has("projects.create")
    assert perms.mode("assignments.self_create") == "approval"
    sql = str(db.execute.await_args.args[0])
    assert "role_permissions" in sql and "roles" in sql


@pytest.mark.asyncio
async def test_load_permission_set_skips_the_query_for_admin():
    db = MagicMock()
    db.execute = AsyncMock()

    perms = await load_permission_set(db, "admin")

    assert perms.is_admin
    db.execute.assert_not_awaited()


@pytest.mark.parametrize(
    ("key", "name", "expected"),
    [
        ("team_lead", "Team Lead", "Team Lead"),
        ("superuser", None, "Superuser"),
        ("admin", None, "Administrator"),
        ("ghost", None, "ghost"),
    ],
)
def test_role_display_name(key, name, expected):
    assert role_display_name(key, name) == expected


def test_effective_modes_is_the_shown_matrix():
    role = PermissionSet("demo", {"views.staff": "allow", "assignments.self_create": "approval"})
    assert role.effective_modes() == {
        "assignments.self_create": "approval",
        "projects.view": "allow",
        "views.staff": "allow",
    }
    assert PermissionSet("admin", {}).effective_modes() == dict.fromkeys(
        sorted(PERMISSION_KEYS), "allow"
    )


def test_role_key_pattern_matches_the_roles_check_constraint():
    from app.models.rbac import Role
    from app.services.permissions import ROLE_KEY_PATTERN

    checks = [c.sqltext.text for c in Role.__table__.constraints if hasattr(c, "sqltext")]
    assert f"key ~ '{ROLE_KEY_PATTERN}'" in checks
