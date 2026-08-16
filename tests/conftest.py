"""
Shared test fixtures for the Milestone API test suite.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.config import Settings


@pytest.fixture
def test_settings():
    """Settings configured for testing (no real DB connection needed)."""
    return Settings(
        db_host="localhost",
        db_port=5432,
        db_name="milestone_test",
        db_user="test",
        db_password="test",
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
    # add/add_all/delete-staging are synchronous on a real AsyncSession; without
    # this they return un-awaited coroutines and emit RuntimeWarnings.
    session.add = MagicMock()
    session.add_all = MagicMock()
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

        app.dependency_overrides[get_db] = lambda: mock_db_session
        app.dependency_overrides[get_db_readonly] = lambda: mock_db_session

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client

        app.dependency_overrides.clear()


class FakeUser:
    """
    Stand-in for an authenticated user.

    Deliberately shaped like the lightweight SessionUser that
    get_current_user_optional returns (id/email/name/role + the role
    properties) rather than an ORM User -- code under test must not rely on
    attributes SessionUser does not have.
    """

    def __init__(self, user_id: int = 1, role: str = "user"):
        self.id = user_id
        self.email = f"user{user_id}@example.com"
        self.first_name = "Test"
        self.last_name = f"User{user_id}"
        self.role = role
        self.is_active = True
        self._site_ids: list[int] = [1]

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def is_superuser(self) -> bool:
        return self.role == "superuser"

    @property
    def site_ids(self) -> list[int]:
        return self._site_ids


@pytest.fixture
def fake_user():
    """Factory for FakeUser instances."""
    return FakeUser


@pytest_asyncio.fixture
async def authed_client(test_settings, mock_db_session):
    """
    Test client with an authenticated session.

    Yields (client, set_user) where set_user(FakeUser(...)) swaps the identity
    for the next request, so one fixture covers user/superuser/admin cases.
    """
    with patch("app.config.get_settings", return_value=test_settings):
        from app.main import create_app

        app = create_app()

        from app.database import get_db, get_db_readonly
        from app.middleware.auth import get_current_user, require_admin, require_superuser

        state = {"user": FakeUser(1, "user")}

        def current_user():
            return state["user"]

        def superuser():
            user = state["user"]
            if not (user.is_admin or user.is_superuser):
                from fastapi import HTTPException

                raise HTTPException(status_code=403, detail="Superuser access required")
            return user

        def admin():
            user = state["user"]
            if not user.is_admin:
                from fastapi import HTTPException

                raise HTTPException(status_code=403, detail="Admin access required")
            return user

        app.dependency_overrides[get_db] = lambda: mock_db_session
        app.dependency_overrides[get_db_readonly] = lambda: mock_db_session
        app.dependency_overrides[get_current_user] = current_user
        app.dependency_overrides[require_superuser] = superuser
        app.dependency_overrides[require_admin] = admin

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:

            def set_user(user: FakeUser) -> None:
                state["user"] = user

            yield client, set_user

        app.dependency_overrides.clear()
