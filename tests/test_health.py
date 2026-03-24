"""Tests for health check endpoints."""

import pytest
from unittest.mock import AsyncMock, MagicMock

from httpx import ASGITransport, AsyncClient


@pytest.mark.asyncio
async def test_health_endpoint(app_client, mock_db_session):
    """Health endpoint returns 200 with expected fields."""
    # Mock the DB SELECT 1 check
    mock_result = MagicMock()
    mock_db_session.execute.return_value = mock_result

    response = await app_client.get("/health")
    assert response.status_code == 200

    data = response.json()
    assert data["status"] == "ok"
    assert data["backend"] == "python-fastapi"
    assert "version" in data
    assert "timestamp" in data


@pytest.mark.asyncio
async def test_api_health_endpoint(app_client, mock_db_session):
    """API-prefixed health endpoint works too."""
    mock_db_session.execute.return_value = MagicMock()

    response = await app_client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
