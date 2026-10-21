"""
Route tests for /api/permissions and /api/roles (app/routers/roles.py).

Reads are open to every signed-in user (the Settings matrix and the frontend
mirror read them); writes are admin-only. Rules: the admin role's matrix is
read-only (403), system roles cannot be deleted (403), a role held by users
cannot be deleted (409), keys are well-formed and immutable, names unique
(400), and the matrix only takes catalogue keys, ``approval`` only on the
approvable ones and never a change to a locked key (422).
"""

from datetime import datetime
from unittest.mock import MagicMock

import pytest
from sqlalchemy.exc import IntegrityError

from app.models.rbac import Role, RolePermission
from app.services.permissions import APPROVABLE_KEYS, PERMISSION_KEYS, PERMISSIONS, PM_BUNDLE
from tests.conftest import FakeUser, permissive_user
from tests.support import scalar_result, scalars_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)


def make_role(
    role_id: int = 4,
    key: str = "team_lead",
    name: str = "Team Lead",
    modes: dict[str, str] | None = None,
    *,
    is_system: bool = False,
    sort_order: int = 3,
    description: str | None = "Leads a team",
) -> Role:
    return Role(
        id=role_id,
        key=key,
        name=name,
        description=description,
        is_system=is_system,
        sort_order=sort_order,
        created_at=STAMP,
        updated_at=STAMP,
        permissions=[
            RolePermission(permission=k, mode=m)
            for k, m in (modes if modes is not None else {"projects.create": "allow"}).items()
        ],
    )


def rows_result(rows):
    result = MagicMock()
    result.all.return_value = list(rows)
    return result


def compiled(db, index: int) -> str:
    statement = db.execute.await_args_list[index].args[0]
    return " ".join(str(statement.compile(compile_kwargs={"literal_binds": True})).split())


@pytest.fixture
def admin_client(authed_client):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    return client


@pytest.fixture
def db_assigns_ids(mock_db_session):
    async def refresh(obj, attribute_names=None):
        if getattr(obj, "id", None) is None:
            obj.id = 42
        obj.created_at = obj.created_at or STAMP
        obj.updated_at = STAMP

    mock_db_session.refresh.side_effect = refresh
    return mock_db_session


# ---------------------------------------------------------------------------
# GET /api/permissions
# ---------------------------------------------------------------------------


async def test_permissions_catalogue_is_served_grouped(authed_client):
    client, set_user = authed_client
    set_user(FakeUser(3, "user"))

    resp = await client.get("/api/permissions")

    assert resp.status_code == 200
    body = resp.json()
    groups = body["groups"]
    assert [g["name"] for g in groups] == list(dict.fromkeys(p.group for p in PERMISSIONS))
    flat = [p for g in groups for p in g["permissions"]]
    assert [p["key"] for p in flat] == [p.key for p in PERMISSIONS]
    by_key = {p["key"]: p for p in flat}
    assert by_key["assignments.self_create"]["approvable"] is True
    assert by_key["projects.create"]["approvable"] is False
    assert by_key["projects.view"]["locked"] is True
    assert by_key["roles.manage"]["locked"] is True
    assert by_key["projects.create"]["locked"] is False
    assert by_key["projects.create"]["label"] == "Create projects"
    assert by_key["projects.create"]["description"]
    assert by_key["projects.create"]["defaults"] == {"superuser": "allow", "user": None}
    assert by_key["kanban.comment"]["defaults"] == {"superuser": "allow", "user": "allow"}
    assert sorted(body["pm_bundle"]) == sorted(PM_BUNDLE)


async def test_permissions_need_a_session(app_client):
    assert (await app_client.get("/api/permissions")).status_code == 401


# ---------------------------------------------------------------------------
# GET /api/roles, /api/roles/{id}
# ---------------------------------------------------------------------------


async def test_list_roles_with_matrix_and_user_count(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(3, "user"))
    admin = make_role(1, "admin", "Administrator", {}, is_system=True, sort_order=0)
    user = make_role(3, "user", "User", {"views.kanban": "allow"}, is_system=True, sort_order=2)
    lead = make_role(4, modes={"projects.create": "allow", "assignments.self_create": "approval"})
    mock_db_session.execute.side_effect = [
        scalars_result([admin, user, lead]),
        rows_result([("admin", 2), ("team_lead", 5)]),
    ]

    resp = await client.get("/api/roles")

    assert resp.status_code == 200
    roles = resp.json()
    assert [r["key"] for r in roles] == ["admin", "user", "team_lead"]
    by_key = {r["key"]: r for r in roles}
    # The admin holds every key in code; it has no rows.
    assert by_key["admin"]["permissions"] == dict.fromkeys(sorted(PERMISSION_KEYS), "allow")
    assert by_key["admin"]["user_count"] == 2
    # Locked projects.view is always shown as allowed.
    assert by_key["user"]["permissions"] == {"projects.view": "allow", "views.kanban": "allow"}
    assert by_key["user"]["user_count"] == 0
    assert by_key["team_lead"] == {
        "id": 4,
        "key": "team_lead",
        "name": "Team Lead",
        "description": "Leads a team",
        "is_system": False,
        "sort_order": 3,
        "permissions": {
            "assignments.self_create": "approval",
            "projects.create": "allow",
            "projects.view": "allow",
        },
        "user_count": 5,
    }
    assert "ORDER BY roles.sort_order, roles.id" in compiled(mock_db_session, 0)
    assert "GROUP BY users.role" in compiled(mock_db_session, 1)


async def test_get_one_role(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(3, "user"))
    mock_db_session.execute.side_effect = [scalar_result(make_role()), scalar_result(7)]

    resp = await client.get("/api/roles/4")

    assert resp.status_code == 200
    assert resp.json()["user_count"] == 7
    assert "users.role = 'team_lead'" in compiled(mock_db_session, 1)


async def test_get_missing_role_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(3, "user"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    resp = await client.get("/api/roles/99")

    assert resp.status_code == 404
    assert resp.json()["detail"] == "Role not found"


# ---------------------------------------------------------------------------
# Writes are admin-only
# ---------------------------------------------------------------------------


# "permissive" holds every grantable key: roles.manage stays the admin's alone.
@pytest.mark.parametrize("role", ["user", "superuser", "permissive"])
@pytest.mark.parametrize(
    ("method", "url", "body"),
    [
        ("post", "/api/roles", {"key": "lead", "name": "Lead"}),
        ("put", "/api/roles/4", {"name": "Lead"}),
        ("delete", "/api/roles/4", None),
    ],
)
async def test_writes_need_admin(authed_client, mock_db_session, role, method, url, body):
    client, set_user = authed_client
    set_user(FakeUser(3, role) if role != "permissive" else permissive_user(3))

    kwargs = {"json": body} if body is not None else {}
    resp = await getattr(client, method)(url, **kwargs)

    assert resp.status_code == 403
    mock_db_session.execute.assert_not_awaited()
    mock_db_session.commit.assert_not_awaited()


# ---------------------------------------------------------------------------
# POST /api/roles
# ---------------------------------------------------------------------------


async def test_create_role(admin_client, mock_db_session, db_assigns_ids):
    mock_db_session.execute.side_effect = [
        scalar_result(None),  # key free
        scalar_result(None),  # name free
        scalar_result(2),  # max sort_order
    ]

    resp = await admin_client.post(
        "/api/roles",
        json={
            "key": "team_lead",
            "name": "  Team Lead ",
            "description": "Leads a team",
            "permissions": {
                "projects.create": "allow",
                "assignments.self_create": "approval",
                "projects.view": "allow",
            },
        },
    )

    assert resp.status_code == 201
    body = resp.json()
    assert body["id"] == 42
    assert (body["key"], body["name"], body["is_system"], body["sort_order"]) == (
        "team_lead",
        "Team Lead",
        False,
        3,
    )
    assert body["user_count"] == 0
    assert body["permissions"] == {
        "assignments.self_create": "approval",
        "projects.create": "allow",
        "projects.view": "allow",
    }
    (call,) = mock_db_session.add.call_args_list
    role = call.args[0]
    assert isinstance(role, Role)
    # projects.view is stored like on the system roles (always allowed).
    assert role.permission_modes == {
        "assignments.self_create": "approval",
        "projects.create": "allow",
        "projects.view": "allow",
    }
    assert "lower(roles.name) = 'team lead'" in compiled(mock_db_session, 1)
    mock_db_session.commit.assert_awaited_once()


async def test_create_role_with_explicit_sort_order(admin_client, mock_db_session, db_assigns_ids):
    mock_db_session.execute.side_effect = [scalar_result(None), scalar_result(None)]

    resp = await admin_client.post(
        "/api/roles", json={"key": "lead", "name": "Lead", "sort_order": 9}
    )

    assert resp.status_code == 201
    assert resp.json()["sort_order"] == 9
    assert resp.json()["permissions"] == {"projects.view": "allow"}
    assert mock_db_session.execute.await_count == 2


async def test_create_role_first_custom_sort_order_without_roles(
    admin_client, mock_db_session, db_assigns_ids
):
    mock_db_session.execute.side_effect = [
        scalar_result(None),
        scalar_result(None),
        scalar_result(None),
    ]

    resp = await admin_client.post("/api/roles", json={"key": "lead", "name": "Lead"})

    assert resp.json()["sort_order"] == 0


@pytest.mark.parametrize("key", ["Lead", "l", "1lead", "team-lead", "team lead", "x" * 21, ""])
async def test_create_rejects_a_malformed_key(admin_client, mock_db_session, key):
    resp = await admin_client.post("/api/roles", json={"key": key, "name": "Lead"})

    assert resp.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.parametrize("key", ["admin", "user", "team_lead"])
async def test_create_rejects_a_taken_key(admin_client, mock_db_session, key):
    mock_db_session.execute.side_effect = [scalar_result(1)]

    resp = await admin_client.post("/api/roles", json={"key": key, "name": "Something"})

    assert resp.status_code == 400
    assert resp.json()["detail"] == f'A role with the key "{key}" already exists'
    mock_db_session.add.assert_not_called()


async def test_create_rejects_a_taken_name(admin_client, mock_db_session):
    mock_db_session.execute.side_effect = [scalar_result(None), scalar_result(3)]

    resp = await admin_client.post("/api/roles", json={"key": "member", "name": "user"})

    assert resp.status_code == 400
    assert resp.json()["detail"] == 'A role named "user" already exists'
    mock_db_session.add.assert_not_called()


async def test_create_rejects_a_blank_name(admin_client, mock_db_session):
    resp = await admin_client.post("/api/roles", json={"key": "lead", "name": "   "})

    assert resp.status_code == 400
    assert resp.json()["detail"] == "Role name cannot be empty"
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.parametrize(
    ("permissions", "detail"),
    [
        ({"projects.creat": "allow"}, "Unknown permission: projects.creat"),
        (
            {"projects.create": "approval"},
            "Only own-booking permissions can require approval: projects.create",
        ),
        ({"roles.manage": "allow"}, "Permission is locked: roles.manage"),
        (
            {"projects.view": "approval"},
            "Only own-booking permissions can require approval: projects.view",
        ),
    ],
)
async def test_create_rejects_a_bad_matrix(admin_client, mock_db_session, permissions, detail):
    resp = await admin_client.post(
        "/api/roles", json={"key": "lead", "name": "Lead", "permissions": permissions}
    )

    assert resp.status_code == 422
    assert resp.json()["detail"] == detail
    mock_db_session.execute.assert_not_awaited()


async def test_create_rejects_an_unknown_mode(admin_client, mock_db_session):
    resp = await admin_client.post(
        "/api/roles",
        json={"key": "lead", "name": "Lead", "permissions": {"projects.create": "deny"}},
    )

    assert resp.status_code == 422
    mock_db_session.execute.assert_not_awaited()


async def test_create_accepts_approval_on_every_approvable_key(
    admin_client, mock_db_session, db_assigns_ids
):
    mock_db_session.execute.side_effect = [scalar_result(None), scalar_result(None)]
    matrix = dict.fromkeys(APPROVABLE_KEYS, "approval")

    resp = await admin_client.post(
        "/api/roles",
        json={"key": "intern", "name": "Intern", "sort_order": 5, "permissions": matrix},
    )

    assert resp.status_code == 201
    assert resp.json()["permissions"] == {**matrix, "projects.view": "allow"}


async def test_create_lost_race_on_unique_is_400(admin_client, mock_db_session):
    mock_db_session.execute.side_effect = [scalar_result(None), scalar_result(None)]
    mock_db_session.commit.side_effect = IntegrityError("INSERT", {}, Exception("dup"))

    resp = await admin_client.post(
        "/api/roles", json={"key": "lead", "name": "Lead", "sort_order": 4}
    )

    assert resp.status_code == 400
    assert resp.json()["detail"] == 'A role with the key "lead" or the name "Lead" already exists'
    mock_db_session.rollback.assert_awaited_once()


# ---------------------------------------------------------------------------
# PUT /api/roles/{id}
# ---------------------------------------------------------------------------


async def test_update_role_name_description_and_matrix(
    admin_client, mock_db_session, db_assigns_ids
):
    role = make_role(modes={"projects.create": "allow", "views.kanban": "allow"})
    kept = role.permissions[0]
    mock_db_session.execute.side_effect = [
        scalar_result(role),
        scalar_result(None),  # new name free
        scalar_result(4),  # user count
    ]

    resp = await admin_client.put(
        "/api/roles/4",
        json={
            "name": "Lead",
            "description": None,
            "permissions": {
                "projects.create": "allow",
                "assignments.self_create": "approval",
            },
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert (body["name"], body["description"], body["user_count"]) == ("Lead", None, 4)
    assert body["permissions"] == {
        "assignments.self_create": "approval",
        "projects.create": "allow",
        "projects.view": "allow",
    }
    # Rows are diffed in place: the kept one is the same object.
    assert role.permissions[0] is kept
    assert role.permission_modes == {
        "assignments.self_create": "approval",
        "projects.create": "allow",
        "projects.view": "allow",
    }
    mock_db_session.commit.assert_awaited_once()


async def test_update_changes_a_mode_in_place(admin_client, mock_db_session, db_assigns_ids):
    role = make_role(modes={"assignments.self_create": "allow"})
    row = role.permissions[0]
    mock_db_session.execute.side_effect = [scalar_result(role), scalar_result(0)]

    resp = await admin_client.put(
        "/api/roles/4",
        json={"permissions": {"assignments.self_create": "approval"}, "sort_order": 7},
    )

    assert resp.status_code == 200
    assert row.mode == "approval"
    assert resp.json()["sort_order"] == 7
    # Omitted fields stay as they were.
    assert role.name == "Team Lead" and role.description == "Leads a team"


async def test_update_system_role_matrix(admin_client, mock_db_session, db_assigns_ids):
    user_role = make_role(3, "user", "User", {"views.kanban": "allow"}, is_system=True)
    mock_db_session.execute.side_effect = [scalar_result(user_role), scalar_result(10)]

    resp = await admin_client.put("/api/roles/3", json={"permissions": {}})

    assert resp.status_code == 200
    assert resp.json()["permissions"] == {"projects.view": "allow"}


async def test_update_admin_role_is_403(admin_client, mock_db_session):
    admin = make_role(1, "admin", "Administrator", {}, is_system=True)
    mock_db_session.execute.side_effect = [scalar_result(admin)]

    resp = await admin_client.put("/api/roles/1", json={"permissions": {}})

    assert resp.status_code == 403
    assert resp.json()["detail"] == "Administrator permissions cannot be edited"
    mock_db_session.commit.assert_not_awaited()


async def test_update_missing_role_is_404(admin_client, mock_db_session):
    mock_db_session.execute.side_effect = [scalar_result(None)]

    resp = await admin_client.put("/api/roles/99", json={"name": "X"})

    assert resp.status_code == 404


async def test_update_cannot_change_the_key(admin_client, mock_db_session):
    mock_db_session.execute.side_effect = [scalar_result(make_role())]

    resp = await admin_client.put("/api/roles/4", json={"key": "boss"})

    assert resp.status_code == 422
    assert resp.json()["detail"] == "A role key cannot be changed"
    mock_db_session.commit.assert_not_awaited()


async def test_update_tolerates_the_unchanged_key(admin_client, mock_db_session, db_assigns_ids):
    mock_db_session.execute.side_effect = [scalar_result(make_role()), scalar_result(0)]

    resp = await admin_client.put("/api/roles/4", json={"key": "team_lead"})

    assert resp.status_code == 200


async def test_update_rejects_a_taken_name(admin_client, mock_db_session):
    mock_db_session.execute.side_effect = [scalar_result(make_role()), scalar_result(2)]

    resp = await admin_client.put("/api/roles/4", json={"name": "Superuser"})

    assert resp.status_code == 400
    assert resp.json()["detail"] == 'A role named "Superuser" already exists'
    assert "roles.id != 4" in compiled(mock_db_session, 1)
    mock_db_session.commit.assert_not_awaited()


async def test_update_same_name_needs_no_lookup(admin_client, mock_db_session, db_assigns_ids):
    mock_db_session.execute.side_effect = [scalar_result(make_role()), scalar_result(0)]

    resp = await admin_client.put("/api/roles/4", json={"name": "Team Lead"})

    assert resp.status_code == 200
    assert mock_db_session.execute.await_count == 2


@pytest.mark.parametrize(
    "permissions",
    [{"nope.key": "allow"}, {"projects.delete": "approval"}, {"roles.manage": "allow"}],
)
async def test_update_rejects_a_bad_matrix(admin_client, mock_db_session, permissions):
    role = make_role()
    mock_db_session.execute.side_effect = [scalar_result(role)]

    resp = await admin_client.put("/api/roles/4", json={"permissions": permissions})

    assert resp.status_code == 422
    assert role.permission_modes == {"projects.create": "allow"}
    mock_db_session.commit.assert_not_awaited()


# ---------------------------------------------------------------------------
# DELETE /api/roles/{id}
# ---------------------------------------------------------------------------


async def test_delete_unused_custom_role(admin_client, mock_db_session):
    role = make_role()
    mock_db_session.execute.side_effect = [scalar_result(role), scalar_result(0)]

    resp = await admin_client.delete("/api/roles/4")

    assert resp.status_code == 204
    mock_db_session.delete.assert_awaited_once_with(role)
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.parametrize("key", ["admin", "superuser", "user"])
async def test_delete_system_role_is_403(admin_client, mock_db_session, key):
    mock_db_session.execute.side_effect = [scalar_result(make_role(1, key, key, is_system=True))]

    resp = await admin_client.delete("/api/roles/1")

    assert resp.status_code == 403
    assert resp.json()["detail"] == "System roles cannot be deleted"
    mock_db_session.delete.assert_not_awaited()


async def test_delete_role_in_use_is_409(admin_client, mock_db_session):
    mock_db_session.execute.side_effect = [scalar_result(make_role()), scalar_result(3)]

    resp = await admin_client.delete("/api/roles/4")

    assert resp.status_code == 409
    assert resp.json()["detail"] == "3 users hold this role. Give them another role first."
    mock_db_session.delete.assert_not_awaited()


async def test_delete_role_held_by_one_user_is_409(admin_client, mock_db_session):
    mock_db_session.execute.side_effect = [scalar_result(make_role()), scalar_result(1)]

    resp = await admin_client.delete("/api/roles/4")

    assert resp.json()["detail"] == "1 user holds this role. Give them another role first."


async def test_delete_missing_role_is_404(admin_client, mock_db_session):
    mock_db_session.execute.side_effect = [scalar_result(None)]

    assert (await admin_client.delete("/api/roles/99")).status_code == 404
