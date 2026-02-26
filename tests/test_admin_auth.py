"""Tests for admin authentication endpoints."""

from unittest.mock import MagicMock, patch

import pytest


def _make_admin_user(
    id=1,
    email="admin@milestone.local",
    name="System Admin",
    role="superadmin",
    active=1,
    must_change_password=0,
    password_hash="fakesalt:fakehash",
):
    """Create a mock AdminUser ORM object."""
    user = MagicMock()
    user.id = id
    user.email = email
    user.name = name
    user.role = role
    user.active = active
    user.must_change_password = must_change_password
    user.password_hash = password_hash
    user.is_active = active == 1
    user.is_superadmin = role == "superadmin"
    user.last_login = None
    return user


@pytest.mark.asyncio
async def test_admin_login_missing_fields(app_client):
    """Admin login with empty body returns 422."""
    response = await app_client.post("/api/admin/auth/login", json={})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_admin_login_invalid_credentials(app_client, mock_db_session):
    """Admin login with unknown email returns 401."""
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_db_session.execute.return_value = mock_result

    response = await app_client.post(
        "/api/admin/auth/login",
        json={"email": "nobody@example.com", "password": "wrong"},
    )
    assert response.status_code == 401
    assert "Invalid" in response.json()["detail"]


@pytest.mark.asyncio
async def test_admin_login_wrong_password(app_client, mock_db_session):
    """Admin login with wrong password returns 401."""
    admin = _make_admin_user()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = admin
    mock_db_session.execute.return_value = mock_result

    with patch("app.routers.admin.auth.verify_password", return_value=False):
        response = await app_client.post(
            "/api/admin/auth/login",
            json={"email": "admin@milestone.local", "password": "wrong"},
        )
    assert response.status_code == 401
    assert "Invalid" in response.json()["detail"]


@pytest.mark.asyncio
async def test_admin_login_disabled_account(app_client, mock_db_session):
    """Admin login with disabled account returns 401."""
    admin = _make_admin_user(active=0)
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = admin
    mock_db_session.execute.return_value = mock_result

    with patch("app.routers.admin.auth.verify_password", return_value=True):
        response = await app_client.post(
            "/api/admin/auth/login",
            json={"email": "admin@milestone.local", "password": "correct"},
        )
    assert response.status_code == 401
    assert "disabled" in response.json()["detail"]


@pytest.mark.asyncio
async def test_admin_login_success(app_client, mock_db_session):
    """Admin login with valid credentials returns 200 and sets cookie."""
    admin = _make_admin_user()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = admin
    mock_db_session.execute.return_value = mock_result

    with patch("app.routers.admin.auth.verify_password", return_value=True):
        response = await app_client.post(
            "/api/admin/auth/login",
            json={"email": "admin@milestone.local", "password": "correct"},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["user"]["id"] == 1
    assert data["user"]["email"] == "admin@milestone.local"
    assert data["user"]["role"] == "superadmin"
    assert data["must_change_password"] is False

    # Verify session was added to DB
    mock_db_session.add.assert_called_once()
    mock_db_session.commit.assert_called_once()

    # Verify cookie was set
    assert "admin_session" in response.cookies


@pytest.mark.asyncio
async def test_admin_login_must_change_password(app_client, mock_db_session):
    """Admin login flags must_change_password when set."""
    admin = _make_admin_user(must_change_password=1)
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = admin
    mock_db_session.execute.return_value = mock_result

    with patch("app.routers.admin.auth.verify_password", return_value=True):
        response = await app_client.post(
            "/api/admin/auth/login",
            json={"email": "admin@milestone.local", "password": "correct"},
        )

    assert response.status_code == 200
    assert response.json()["must_change_password"] is True


@pytest.mark.asyncio
async def test_admin_me_unauthenticated(app_client, mock_db_session):
    """GET /admin/auth/me without session returns null user."""
    response = await app_client.get("/api/admin/auth/me")
    assert response.status_code == 200
    assert response.json()["user"] is None


@pytest.mark.asyncio
async def test_admin_logout(app_client, mock_db_session):
    """Admin logout clears cookie."""
    # No session to look up
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_db_session.execute.return_value = mock_result

    response = await app_client.post("/api/admin/auth/logout")
    assert response.status_code == 200
    assert response.json()["success"] is True
