"""
Non-SSO tenant auth routes not covered elsewhere (app/routers/auth.py).

Login success (session cookie, Node-shaped user, lazy hash upgrade, disabled
account), ``/auth/me`` with a live session, logout destroying the session,
change-password for a vanished user, and the multi-tenant "no tenant
context" guards. SessionService is patched; the DB is the shared AsyncMock.
"""

from unittest.mock import AsyncMock, patch

import pytest

from app.config import Settings
from app.models.site import Site
from app.models.user import User
from app.routers import auth as auth_router
from app.services.encryption import hash_user_password, verify_user_password
from app.services.login_throttle import reset_login_throttle
from app.services.session import SessionService
from tests.conftest import FakeUser
from tests.support import scalar_result


@pytest.fixture(autouse=True)
def fresh_throttle():
    reset_login_throttle()
    yield
    reset_login_throttle()


def orm_user(password: str, *, active: int = 1, with_site: bool = True) -> User:
    user = User(
        id=7,
        email="ada@example.com",
        password=password,
        first_name="Ada",
        last_name="Lovelace",
        job_title="Engineer",
        role="superuser",
        max_capacity=100,
        active=active,
        is_system=0,
    )
    user.sites = (
        [
            Site(
                id=3,
                name="Basel Lab",
                location="Basel",
                city="Basel",
                country_code="CH",
                region_code="BS",
                timezone="Europe/Zurich",
                active=1,
            )
        ]
        if with_site
        else []
    )
    return user


MULTI_TENANT = Settings(session_secret="s" * 64, multi_tenant=True)


# ---------------------------------------------------------------------------
# POST /auth/login
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_login_success_sets_cookie_and_returns_node_shaped_user(app_client, mock_db_session):
    user = orm_user(hash_user_password("correct-horse"))
    original_hash = user.password
    mock_db_session.execute.return_value = scalar_result(user)

    with patch.object(
        SessionService, "create_session", AsyncMock(return_value="new-sid")
    ) as create:
        resp = await app_client.post(
            "/api/auth/login", json={"email": "ada@example.com", "password": "correct-horse"}
        )

    assert resp.status_code == 200
    create.assert_awaited_once_with(user)
    cookie = resp.headers["set-cookie"]
    assert cookie.startswith("connect.sid=s%3Anew-sid.;")  # express-session shape
    assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Path=/" in cookie
    body = resp.json()
    assert body["success"] is True
    assert body["user"]["id"] == 7
    assert body["user"]["name"] == "Ada Lovelace"
    assert body["user"]["jobTitle"] == "Engineer"
    assert body["user"]["siteIds"] == [3]
    assert body["user"]["sites"][0]["name"] == "Basel Lab"
    assert body["user"]["sites"][0]["country_code"] == "CH"
    # Already bcrypt: no re-hash, no extra commit.
    assert user.password == original_hash
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_login_upgrades_a_legacy_plaintext_password(app_client, mock_db_session):
    user = orm_user("legacy-plain", with_site=False)
    mock_db_session.execute.return_value = scalar_result(user)

    with patch.object(SessionService, "create_session", AsyncMock(return_value="sid")):
        resp = await app_client.post(
            "/api/auth/login", json={"email": "ada@example.com", "password": "legacy-plain"}
        )

    assert resp.status_code == 200
    assert resp.json()["user"]["siteIds"] == []
    assert user.password.startswith("$2b$")
    assert verify_user_password("legacy-plain", user.password)
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_login_keeps_a_legacy_password_too_long_for_bcrypt(app_client, mock_db_session):
    long_password = "x" * 80
    user = orm_user(long_password, with_site=False)
    mock_db_session.execute.return_value = scalar_result(user)

    with patch.object(SessionService, "create_session", AsyncMock(return_value="sid")):
        resp = await app_client.post(
            "/api/auth/login", json={"email": "ada@example.com", "password": long_password}
        )

    assert resp.status_code == 200
    assert user.password == long_password  # not upgraded, login not failed
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_login_of_a_disabled_account_is_401_without_a_session(app_client, mock_db_session):
    user = orm_user(hash_user_password("correct-horse"), active=0)
    mock_db_session.execute.return_value = scalar_result(user)

    with patch.object(SessionService, "create_session", AsyncMock()) as create:
        resp = await app_client.post(
            "/api/auth/login", json={"email": "ada@example.com", "password": "correct-horse"}
        )

    assert resp.status_code == 401
    assert resp.json()["detail"] == "User account is disabled"
    create.assert_not_awaited()
    assert "set-cookie" not in resp.headers


@pytest.mark.asyncio
async def test_login_unknown_email_is_401(app_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(None)
    with patch.object(SessionService, "create_session", AsyncMock()) as create:
        resp = await app_client.post(
            "/api/auth/login", json={"email": "nobody@example.com", "password": "whatever"}
        )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Invalid email or password"
    create.assert_not_awaited()


# ---------------------------------------------------------------------------
# GET /auth/me
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_me_returns_the_fresh_user_for_a_valid_session(app_client, mock_db_session):
    user = orm_user("irrelevant")
    mock_db_session.execute.return_value = scalar_result(user)

    with patch.object(
        SessionService, "get_user_from_session", AsyncMock(return_value={"id": 7})
    ) as lookup:
        resp = await app_client.get("/api/auth/me", cookies={"connect.sid": "s%3Amy-sid."})

    lookup.assert_awaited_once_with("my-sid")
    assert resp.status_code == 200
    me = resp.json()["user"]
    assert me["id"] == 7 and me["email"] == "ada@example.com" and me["role"] == "superuser"
    assert me["siteIds"] == [3]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("session_data", "db_user"),
    [
        (None, None),  # unknown / expired session
        ({"name": "no id"}, None),  # session without a user id
        ({"id": 7}, None),  # user deleted since login
        ({"id": 7}, "inactive"),  # user disabled since login
    ],
    ids=["no-session", "no-user-id", "deleted-user", "disabled-user"],
)
async def test_me_returns_null_user(app_client, mock_db_session, session_data, db_user):
    user = orm_user("x", active=0) if db_user == "inactive" else None
    mock_db_session.execute.return_value = scalar_result(user)

    with patch.object(
        SessionService, "get_user_from_session", AsyncMock(return_value=session_data)
    ):
        resp = await app_client.get("/api/auth/me", cookies={"connect.sid": "s%3Asid."})

    assert resp.status_code == 200
    assert resp.json() == {"user": None}


@pytest.mark.asyncio
async def test_me_without_tenant_context_in_multi_tenant_mode(app_client, mock_db_session):
    with (
        patch.object(auth_router, "settings", MULTI_TENANT),
        patch.object(SessionService, "get_user_from_session", AsyncMock()) as lookup,
    ):
        resp = await app_client.get("/api/auth/me", cookies={"connect.sid": "s%3Asid."})

    assert resp.json() == {"user": None}
    lookup.assert_not_awaited()


# ---------------------------------------------------------------------------
# POST /auth/logout
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_logout_destroys_the_session_and_clears_the_cookie(app_client):
    with patch.object(SessionService, "delete_session", AsyncMock(return_value=True)) as delete:
        resp = await app_client.post("/api/auth/logout", cookies={"connect.sid": "s%3Amy-sid."})

    assert resp.status_code == 200
    assert resp.json() == {"success": True}
    delete.assert_awaited_once_with("my-sid")
    cookie = resp.headers["set-cookie"]
    assert cookie.startswith("connect.sid=") and "Max-Age=0" in cookie


@pytest.mark.asyncio
async def test_logout_without_tenant_context_only_clears_the_cookie(app_client):
    with (
        patch.object(auth_router, "settings", MULTI_TENANT),
        patch.object(SessionService, "delete_session", AsyncMock()) as delete,
    ):
        resp = await app_client.post("/api/auth/logout", cookies={"connect.sid": "s%3Asid."})

    assert resp.json() == {"success": True}
    delete.assert_not_awaited()
    assert "Max-Age=0" in resp.headers["set-cookie"]


@pytest.mark.asyncio
async def test_login_without_tenant_context_in_multi_tenant_mode_is_400(
    app_client, mock_db_session
):
    with patch.object(auth_router, "settings", MULTI_TENANT):
        resp = await app_client.post(
            "/api/auth/login", json={"email": "ada@example.com", "password": "x"}
        )

    assert resp.status_code == 400
    assert "No tenant context" in resp.json()["detail"]
    mock_db_session.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# POST /auth/change-password
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_change_password_for_a_vanished_user_is_401(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))
    mock_db_session.execute.return_value = scalar_result(None)

    with patch.object(SessionService, "destroy_user_sessions", AsyncMock()) as destroy:
        resp = await client.post(
            "/api/auth/change-password",
            json={"currentPassword": "old-pass", "newPassword": "new-pass-123"},
        )

    assert resp.status_code == 401
    destroy.assert_not_awaited()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_change_password_without_tenant_context_is_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))

    with patch.object(auth_router, "settings", MULTI_TENANT):
        resp = await client.post(
            "/api/auth/change-password",
            json={"currentPassword": "old-pass", "newPassword": "new-pass-123"},
        )

    assert resp.status_code == 400
    assert resp.json()["detail"] == "No tenant context."
    mock_db_session.execute.assert_not_awaited()
