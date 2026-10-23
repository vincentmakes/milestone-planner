"""
"Bookable as a resource" (``users.is_resource``) on the users API and
``/auth/me``.

A new account is bookable unless its role is ``admin`` (when the field is
omitted); an explicit value wins either way. User list / detail responses
carry ``is_resource``, ``/auth/me`` and login ``isResource``. Editing the flag
is covered with the other profile fields in ``test_users_routes.py``.
"""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.user import User
from app.routers.users import build_user_detail_response, build_user_list_response
from app.schemas.user import StaffCreate, StaffUpdate
from app.services.encryption import hash_user_password
from app.services.login_throttle import reset_login_throttle
from app.services.session import SessionService
from tests.conftest import FakeUser
from tests.support import scalar_result, unique_scalar_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)


def make_user(user_id: int = 7, role: str = "user", *, is_resource: bool | None = True) -> User:
    user = User(
        id=user_id,
        email=f"u{user_id}@example.com",
        password=hash_user_password("correct-horse"),
        first_name="Ada",
        last_name="Lovelace",
        role=role,
        max_capacity=100,
        active=1,
        is_system=0,
        created_at=STAMP,
    )
    if is_resource is not None:
        user.is_resource = is_resource
    user.role_name = None
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
    }
    body.update(overrides)
    return body


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


def added_user(mock_db_session) -> User:
    (user,) = (c.args[0] for c in mock_db_session.add.call_args_list if isinstance(c.args[0], User))
    return user


@pytest.fixture(autouse=True)
def fresh_throttle():
    reset_login_throttle()
    yield
    reset_login_throttle()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


def test_schemas_leave_the_flag_unset_by_default():
    assert StaffCreate(**create_body()).is_resource is None
    assert StaffUpdate().is_resource is None
    assert StaffUpdate(is_resource=False).is_resource is False


def test_the_model_column_defaults_to_bookable():
    column = User.__table__.c.is_resource
    assert column.nullable is False
    assert column.default is not None and column.default.arg is True


# ---------------------------------------------------------------------------
# POST /users
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("role", "expected"), [("user", True), ("superuser", True), ("admin", False)]
)
async def test_create_without_the_flag_defaults_by_role(
    authed_client, mock_db_session, created, role, expected
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    resp = await client.post("/api/users", json=create_body(role=role))

    assert resp.status_code == 201
    assert resp.json()["is_resource"] is expected
    assert added_user(mock_db_session).is_resource is expected


async def test_create_a_bookable_admin(authed_client, mock_db_session, created):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    resp = await client.post("/api/users", json=create_body(role="admin", is_resource=True))

    assert resp.status_code == 201
    assert resp.json()["is_resource"] is True
    assert added_user(mock_db_session).is_resource is True


async def test_create_a_user_who_is_not_bookable(authed_client, mock_db_session, created):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    resp = await client.post("/api/users", json=create_body(is_resource=False))

    assert resp.status_code == 201
    assert resp.json()["is_resource"] is False


async def test_create_rejects_a_non_boolean_flag(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    resp = await client.post("/api/users", json=create_body(is_resource=[1]))

    assert resp.status_code == 422
    mock_db_session.add.assert_not_called()


async def test_create_still_needs_users_create(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))  # no users.create

    resp = await client.post("/api/users", json=create_body(is_resource=True))

    assert resp.status_code == 403
    mock_db_session.add.assert_not_called()


# ---------------------------------------------------------------------------
# GET /users/{id} and the response builders
# ---------------------------------------------------------------------------


async def test_user_detail_carries_the_flag(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute = AsyncMock(
        return_value=unique_scalar_result(make_user(7, "admin", is_resource=False))
    )

    resp = await client.get("/api/users/7")

    assert resp.status_code == 200
    assert resp.json()["is_resource"] is False


async def test_user_detail_of_an_unknown_user_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute = AsyncMock(return_value=unique_scalar_result(None))

    resp = await client.get("/api/users/404")

    assert resp.status_code == 404


def test_builders_emit_the_flag():
    user = make_user(is_resource=False)
    assert build_user_list_response(user)["is_resource"] is False
    assert build_user_detail_response(user)["is_resource"] is False


def test_an_unflushed_user_reads_as_bookable():
    """Before the INSERT the column default (True) has not been applied yet."""
    user = make_user(is_resource=None)
    assert user.is_resource is None
    assert build_user_list_response(user)["is_resource"] is True


# ---------------------------------------------------------------------------
# /auth/me and /auth/login
# ---------------------------------------------------------------------------


def kanban_switch():
    return scalar_result(None)


async def me(app_client):
    with patch.object(SessionService, "get_user_from_session", AsyncMock(return_value={"id": 7})):
        resp = await app_client.get("/api/auth/me", cookies={"connect.sid": "s%3Asid."})
    assert resp.status_code == 200
    return resp.json()["user"]


@pytest.mark.parametrize("value", [True, False])
async def test_me_carries_is_resource(app_client, mock_db_session, value):
    # The admin's set needs no role_permissions query, only the switch.
    mock_db_session.execute.side_effect = [
        scalar_result(make_user(7, "admin", is_resource=value)),
        kanban_switch(),
    ]

    user = await me(app_client)

    assert user["isResource"] is value


async def test_me_reads_an_unset_flag_as_bookable(app_client, mock_db_session):
    """Same rule as the /users responses: an unset flag is the column default."""
    unset = make_user(7, "admin", is_resource=None)
    assert unset.is_resource is None
    mock_db_session.execute.side_effect = [scalar_result(unset), kanban_switch()]

    user = await me(app_client)

    assert user["isResource"] is True


async def test_login_carries_is_resource(app_client, mock_db_session):
    matrix = MagicMock()
    matrix.all.return_value = []
    mock_db_session.execute.side_effect = [
        scalar_result(make_user(7, "user", is_resource=False)),
        matrix,
        kanban_switch(),
    ]

    with patch.object(SessionService, "create_session", AsyncMock(return_value="sid")):
        resp = await app_client.post(
            "/api/auth/login", json={"email": "u7@example.com", "password": "correct-horse"}
        )

    assert resp.status_code == 200
    assert resp.json()["user"]["isResource"] is False
