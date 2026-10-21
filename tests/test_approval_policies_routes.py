"""
Route tests for /api/approval-policies (app/routers/approval_policies.py).

One policy per approvable action (the own-booking keys): whether the
project's manager approves and which roles' holders may approve (admins
always may). Every signed-in user reads them; only admins change them.
"""

from datetime import datetime

import pytest

from app.models.rbac import ApprovalPolicy, Role
from app.services.permissions import APPROVABLE_KEYS, PERMISSIONS
from tests.conftest import FakeUser, permissive_user
from tests.support import scalar_result, scalars_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)
APPROVABLE_IN_ORDER = [p.key for p in PERMISSIONS if p.approvable]
LABELS = {p.key: p.label for p in PERMISSIONS}


def make_role(role_id: int, key: str) -> Role:
    return Role(id=role_id, key=key, name=key.title(), is_system=False, sort_order=role_id)


def make_policy(action: str, pm_approves: bool = True, roles: list[Role] | None = None):
    return ApprovalPolicy(
        action=action, pm_approves=pm_approves, roles=list(roles or []), updated_at=STAMP
    )


def compiled(db, index: int) -> str:
    statement = db.execute.await_args_list[index].args[0]
    return " ".join(str(statement.compile(compile_kwargs={"literal_binds": True})).split())


@pytest.fixture
def admin_client(authed_client):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    return client


# ---------------------------------------------------------------------------
# GET
# ---------------------------------------------------------------------------


async def test_list_policies_one_per_approvable_action(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(3, "user"))
    lead, senior = make_role(4, "team_lead"), make_role(5, "senior")
    mock_db_session.execute.side_effect = [
        scalars_result(
            [
                make_policy("assignments.self_create", True, [senior, lead]),
                make_policy("assignments.self_remove", False),
                make_policy("retired.action"),  # not approvable any more: left out
            ]
        )
    ]

    resp = await client.get("/api/approval-policies")

    assert resp.status_code == 200
    policies = resp.json()
    assert [p["action"] for p in policies] == APPROVABLE_IN_ORDER
    by_action = {p["action"]: p for p in policies}
    assert by_action["assignments.self_create"] == {
        "action": "assignments.self_create",
        "label": LABELS["assignments.self_create"],
        "pm_approves": True,
        "role_ids": [4, 5],
    }
    assert by_action["assignments.self_remove"]["pm_approves"] is False
    # A missing row reads as the seeded default: the PM approves, no roles.
    assert by_action["assignments.self_update"] == {
        "action": "assignments.self_update",
        "label": LABELS["assignments.self_update"],
        "pm_approves": True,
        "role_ids": [],
    }


async def test_list_needs_a_session(app_client):
    assert (await app_client.get("/api/approval-policies")).status_code == 401


# ---------------------------------------------------------------------------
# PUT
# ---------------------------------------------------------------------------


async def test_update_policy(admin_client, mock_db_session):
    lead, senior = make_role(4, "team_lead"), make_role(5, "senior")
    policy = make_policy("assignments.self_create", True, [])
    mock_db_session.execute.side_effect = [
        scalars_result([senior, lead]),  # the roles
        scalar_result(policy),
    ]

    resp = await admin_client.put(
        "/api/approval-policies/assignments.self_create",
        json={"pm_approves": False, "role_ids": [5, 4, 5]},
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "action": "assignments.self_create",
        "label": LABELS["assignments.self_create"],
        "pm_approves": False,
        "role_ids": [4, 5],
    }
    assert policy.pm_approves is False
    assert sorted(r.id for r in policy.roles) == [4, 5]
    assert "roles.id IN (5, 4)" in compiled(mock_db_session, 0)
    mock_db_session.commit.assert_awaited_once()


async def test_update_creates_a_missing_policy_row(admin_client, mock_db_session):
    mock_db_session.execute.side_effect = [scalar_result(None)]

    resp = await admin_client.put(
        "/api/approval-policies/assignments.self_update",
        json={"pm_approves": True, "role_ids": []},
    )

    assert resp.status_code == 200
    assert resp.json()["role_ids"] == []
    (call,) = mock_db_session.add.call_args_list
    created = call.args[0]
    assert isinstance(created, ApprovalPolicy)
    assert created.action == "assignments.self_update"
    assert created.pm_approves is True
    # No role ids: no roles query.
    assert mock_db_session.execute.await_count == 1


async def test_update_unknown_action_is_404(admin_client, mock_db_session):
    resp = await admin_client.put(
        "/api/approval-policies/projects.create", json={"pm_approves": True, "role_ids": []}
    )

    assert resp.status_code == 404
    assert resp.json()["detail"] == "Unknown approval action"
    mock_db_session.execute.assert_not_awaited()


async def test_update_unknown_role_is_404(admin_client, mock_db_session):
    mock_db_session.execute.side_effect = [scalars_result([make_role(4, "team_lead")])]

    resp = await admin_client.put(
        "/api/approval-policies/assignments.self_create",
        json={"pm_approves": True, "role_ids": [4, 99]},
    )

    assert resp.status_code == 404
    assert resp.json()["detail"] == "Role not found"
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.parametrize(
    "body", [{"role_ids": []}, {"pm_approves": True}, {"pm_approves": True, "role_ids": ["x"]}]
)
async def test_update_rejects_an_incomplete_body(admin_client, mock_db_session, body):
    resp = await admin_client.put("/api/approval-policies/assignments.self_create", json=body)

    assert resp.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.parametrize(
    "user", [FakeUser(3, "user"), FakeUser(5, "superuser"), permissive_user(6)]
)
async def test_update_needs_admin(authed_client, mock_db_session, user):
    client, set_user = authed_client
    set_user(user)

    resp = await client.put(
        "/api/approval-policies/assignments.self_create",
        json={"pm_approves": True, "role_ids": []},
    )

    assert resp.status_code == 403
    mock_db_session.execute.assert_not_awaited()


def test_every_approvable_key_has_a_policy_route_entry():
    assert set(APPROVABLE_IN_ORDER) == APPROVABLE_KEYS
