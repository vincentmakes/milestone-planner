"""Tests for API routing, SPA fallback, and error handling."""

import pytest
from unittest.mock import MagicMock


@pytest.mark.asyncio
async def test_unknown_api_route_returns_404(app_client):
    """Unknown API routes return 404, not SPA HTML."""
    response = await app_client.get("/api/nonexistent")
    assert response.status_code == 404
    data = response.json()
    assert data["error"] == "Not found"


@pytest.mark.asyncio
async def test_post_to_unknown_api_returns_404_not_405(app_client):
    """POST to unknown API route returns 404, not 405 Method Not Allowed."""
    response = await app_client.post("/api/nonexistent", json={})
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_put_to_unknown_route_returns_404_not_405(app_client):
    """PUT to unknown non-API route returns 404, not 405."""
    response = await app_client.put("/some/random/path", json={})
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_to_unknown_route_returns_404_not_405(app_client):
    """DELETE to unknown non-API route returns 404, not 405."""
    response = await app_client.delete("/some/random/path")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_sso_config_unauthenticated(app_client, mock_db_session):
    """SSO config endpoint returns data without authentication."""
    # Mock: no SSO config found
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_db_session.execute.return_value = mock_result

    response = await app_client.get("/api/auth/sso/config")
    assert response.status_code == 200
    data = response.json()
    assert data["enabled"] is False


@pytest.mark.asyncio
async def test_change_password_requires_auth(app_client, mock_db_session):
    """Change password endpoint requires authentication."""
    response = await app_client.post(
        "/api/auth/change-password",
        json={"currentPassword": "old", "newPassword": "new12345"},
    )
    assert response.status_code == 401
