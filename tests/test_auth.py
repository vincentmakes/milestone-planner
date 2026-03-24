"""Tests for authentication endpoints."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


@pytest.mark.asyncio
async def test_login_missing_fields(app_client):
    """Login with missing fields returns 422 validation error."""
    response = await app_client.post("/api/auth/login", json={})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_login_invalid_credentials(app_client, mock_db_session):
    """Login with wrong credentials returns 401."""
    # Mock: no user found for the email
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_db_session.execute.return_value = mock_result

    response = await app_client.post(
        "/api/auth/login",
        json={"email": "bad@example.com", "password": "wrong"},
    )
    assert response.status_code == 401
    assert "Invalid" in response.json()["detail"]


@pytest.mark.asyncio
async def test_auth_me_unauthenticated(app_client, mock_db_session):
    """GET /auth/me without session returns null user."""
    response = await app_client.get("/api/auth/me")
    assert response.status_code == 200
    assert response.json()["user"] is None


@pytest.mark.asyncio
async def test_logout_without_session(app_client, mock_db_session):
    """Logout without active session still succeeds."""
    response = await app_client.post("/api/auth/logout")
    assert response.status_code == 200
    assert response.json()["success"] is True


@pytest.mark.asyncio
async def test_login_empty_password_rejected(app_client):
    """Login with empty password is rejected by validation."""
    response = await app_client.post(
        "/api/auth/login",
        json={"email": "user@example.com", "password": ""},
    )
    assert response.status_code == 422
