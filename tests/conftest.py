"""
Shared test fixtures for the Milestone API test suite.
"""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.config import Settings


@pytest.fixture(scope="session")
def event_loop():
    """Create a single event loop for the entire test session."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def test_settings():
    """Settings configured for testing (no real DB connection needed)."""
    return Settings(
        db_host="localhost",
        db_port=5432,
        db_name="milestone_test",
        db_user="test",
        db_password="test",
        secret_key="test-secret-key",
        session_secret="test-session-secret",
        multi_tenant=False,
        debug=True,
    )


@pytest.fixture
def mock_db_session():
    """Create a mock async database session."""
    session = AsyncMock()
    session.execute = AsyncMock()
    session.commit = AsyncMock()
    session.rollback = AsyncMock()
    session.close = AsyncMock()
    session.refresh = AsyncMock()
    return session


@pytest_asyncio.fixture
async def app_client(test_settings, mock_db_session):
    """Create a test client with mocked database dependencies."""
    with patch("app.config.get_settings", return_value=test_settings):
        # Import after patching settings
        from app.main import create_app

        app = create_app()

        # Override the database dependency to use our mock
        from app.database import get_db, get_db_readonly
        from app.services.master_db import get_master_db

        app.dependency_overrides[get_db] = lambda: mock_db_session
        app.dependency_overrides[get_db_readonly] = lambda: mock_db_session
        app.dependency_overrides[get_master_db] = lambda: mock_db_session

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client

        app.dependency_overrides.clear()
