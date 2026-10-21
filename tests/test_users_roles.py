"""
/api/users and roles: a user's role is any role key in ``roles`` (custom roles
included), validated in the router -- an unknown key is 404 "Role not found"
-- and list / detail responses carry the role's display name (``role_name``).

The system roles always exist, so they are accepted without a lookup.
"""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.user import User
from app.schemas.user import StaffCreate, StaffUpdate
from app.services.session import SessionService
from tests.conftest import FakeUser
from tests.support import _ScalarList, scalar_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)


def make_user(user_id: int, role: str = "user", role_name: str | None = None) -> User:
    user = User(
        id=user_id,
        email=f"u{user_id}@example.com",
        password="$2b$12$existinghashexistinghashexistinghashexistinghashexist",
        first_name="First",
        last_name=f"Last{user_id}",
        role=role,
        max_capacity=100,
        active=1,
        is_system=0,
        created_at=STAMP,
    )
    user.role_name = role_name
    user.sites = []
    user.skills = []
    user.teams = []
    return user


def create_body(**overrides):
    body = {
        "email": "new@example.com",
        "password": "s3cret-pass",
        "first_name": "New",
        "last_name": "Person",
        "role": "team_lead",
    }
    body.update(overrides)
    return body


def compiled(db, index: int) -> str:
    statement = db.execute.await_args_list[index].args[0]
    return " ".join(str(statement.compile(compile_kwargs={"literal_binds": True})).split())


@pytest.fixture
def created(mock_db_session):
    async def flush():
        for call in mock_db_session.add.call_args_list:
            if isinstance(call.args[0], User):
                call.args[0].id = 55

    async def refresh(obj):
        obj.created_at = STAMP

    mock_db_session.flush.side_effect = flush
    mock_db_session.refresh.side_effect = refresh


@pytest.fixture
def destroy_sessions():
    with patch.object(SessionService, "destroy_user_sessions", new_callable=AsyncMock) as mock:
        mock.return_value = 0
        yield mock


# ---------------------------------------------------------------------------
# Schemas: any role key (the router checks it exists)
# ---------------------------------------------------------------------------


def test_schemas_accept_a_custom_role_key():
    assert StaffCreate(**create_body()).role == "team_lead"
    assert StaffUpdate(role="team_lead").role == "team_lead"


def test_schemas_still_default_to_the_user_role():
    body = create_body()
    del body["role"]
    assert StaffCreate(**body).role == "user"


# ---------------------------------------------------------------------------
# POST /users
# ---------------------------------------------------------------------------


async def test_create_with_a_custom_role(authed_client, mock_db_session, created):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(None), scalar_result("team_lead")]

    resp = await client.post("/api/users", json=create_body())

    assert resp.status_code == 201
    assert resp.json()["role"] == "team_lead"
    assert "roles.key = 'team_lead'" in compiled(mock_db_session, 1)


async def test_create_with_an_unknown_role_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(None), scalar_result(None)]

    resp = await client.post("/api/users", json=create_body(role="ghost"))

    assert resp.status_code == 404
    assert resp.json()["detail"] == "Role not found"
    mock_db_session.add.assert_not_called()


async def test_create_with_a_system_role_needs_no_lookup(authed_client, mock_db_session, created):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    resp = await client.post("/api/users", json=create_body(role="superuser"))

    assert resp.status_code == 201
    assert resp.json()["role_name"] == "Superuser"  # not loaded yet: the system name
    assert mock_db_session.execute.await_count == 1


# ---------------------------------------------------------------------------
# PUT /users/{id}
# ---------------------------------------------------------------------------


def target_db(mock_db_session, target: User, role_found: str | None) -> None:
    """The user lookup returns ``target``; the role lookup returns ``role_found``."""
    lookup = MagicMock()
    lookup.unique.return_value.scalar_one_or_none.return_value = target
    mock_db_session.execute = AsyncMock(side_effect=[lookup, scalar_result(role_found)])


async def test_update_to_a_custom_role(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    target = make_user(7)
    target_db(mock_db_session, target, "team_lead")

    resp = await client.put("/api/users/7", json={"role": "team_lead"})

    assert resp.status_code == 200
    assert target.role == "team_lead"
    destroy_sessions.assert_awaited_once()


async def test_update_to_an_unknown_role_is_404(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    target = make_user(7)
    target_db(mock_db_session, target, None)

    resp = await client.put("/api/users/7", json={"role": "ghost"})

    assert resp.status_code == 404
    assert resp.json()["detail"] == "Role not found"
    assert target.role == "user"
    mock_db_session.commit.assert_not_awaited()
    destroy_sessions.assert_not_awaited()


async def test_unchanged_custom_role_needs_no_lookup(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    target = make_user(7, "team_lead", "Team Lead")
    lookup = MagicMock()
    lookup.unique.return_value.scalar_one_or_none.return_value = target
    mock_db_session.execute = AsyncMock(return_value=lookup)

    resp = await client.put("/api/users/7", json={"role": "team_lead", "last_name": "New"})

    assert resp.status_code == 200
    assert resp.json()["role_name"] == "Team Lead"
    assert mock_db_session.execute.await_count == 1
    destroy_sessions.assert_not_awaited()


# ---------------------------------------------------------------------------
# role_name on reads
# ---------------------------------------------------------------------------


async def test_list_and_detail_carry_the_role_name(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    lead = make_user(7, "team_lead", "Team Lead")
    plain = make_user(8, "user")  # role_name not loaded: the system name
    listing = MagicMock()
    listing.unique.return_value.scalars.return_value = _ScalarList([lead, plain])
    detail = MagicMock()
    detail.unique.return_value.scalar_one_or_none.return_value = lead
    mock_db_session.execute.side_effect = [scalar_result(2), listing, detail]

    items = (await client.get("/api/users")).json()["items"]
    one = (await client.get("/api/users/7")).json()

    assert [(i["role"], i["role_name"]) for i in items] == [
        ("team_lead", "Team Lead"),
        ("user", "User"),
    ]
    assert (one["role"], one["role_name"]) == ("team_lead", "Team Lead")
    # The name is read in the user's own SELECT (no extra query).
    assert "roles.name" in compiled(mock_db_session, 1)


@pytest.mark.parametrize("role", ["Owner", "a", "1lead", "team-lead", "x" * 21])
def test_schemas_reject_a_malformed_role_key(role):
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        StaffCreate(**create_body(role=role))
    with pytest.raises(ValidationError):
        StaffUpdate(role=role)
