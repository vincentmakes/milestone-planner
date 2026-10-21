"""
Shared test fixtures for the Milestone API test suite.
"""

from collections.abc import Iterable, Mapping
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.services.permissions import PERMISSION_KEYS, PermissionSet, default_modes

# ``--shard K/N`` (CI runs the suite as shards on parallel runners). Importing the
# hooks registers them on this conftest; the implementation lives in its own
# module so tests/test_shard_option.py can load it under ``pytester``.
from tests.shard_plugin import (  # noqa: F401
    pytest_addoption,
    pytest_collection_modifyitems,
    pytest_configure,
)


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


PermissionSpec = Iterable[str] | Mapping[str, str] | PermissionSet | None


def build_permission_set(role: str, permissions: PermissionSpec = None) -> PermissionSet:
    """
    A PermissionSet for a test user.

    ``None``: the catalogue defaults of ``role`` (the admin holds everything;
    a custom role key has no defaults). A set / list of keys: those keys in
    ``allow`` mode. A ``{key: mode}`` dict: exactly those modes.
    """
    if isinstance(permissions, PermissionSet):
        return permissions
    if permissions is None:
        return PermissionSet(role, default_modes(role))
    if isinstance(permissions, Mapping):
        return PermissionSet(role, dict(permissions))
    return PermissionSet(role, dict.fromkeys(permissions, "allow"))


class FakeUser:
    """
    Stand-in for an authenticated user.

    Deliberately shaped like the lightweight SessionUser that
    get_current_user returns (id/email/name/role, the live ``permissions``,
    ``site_ids`` / ``sites``) rather than an ORM User -- code under test must
    not rely on attributes SessionUser does not have.

    ``permissions``: omitted = the role's catalogue defaults, so
    ``FakeUser(5, "superuser")`` behaves like a superuser did before RBAC; a
    set of keys (allow) or a ``{key: mode}`` dict for a custom matrix, e.g.
    ``FakeUser(3, "user", {"assignments.self_create": "approval"})``.
    """

    def __init__(
        self,
        user_id: int = 1,
        role: str = "user",
        permissions: PermissionSpec = None,
        site_ids: Iterable[int] | None = None,
    ):
        self.id = user_id
        self.email = f"user{user_id}@example.com"
        self.first_name = "Test"
        self.last_name = f"User{user_id}"
        self.role = role
        self.is_active = True
        self._site_ids: list[int] = list(site_ids) if site_ids is not None else [1]
        self._permission_spec = permissions
        self._permissions: PermissionSet | None = None

    @property
    def permissions(self) -> PermissionSet:
        # Built on read, so a test that changes ``role`` afterwards still gets
        # that role's defaults.
        if self._permissions is None or self._permissions.role_key != self.role:
            self._permissions = build_permission_set(self.role, self._permission_spec)
        return self._permissions

    @permissions.setter
    def permissions(self, value: PermissionSet) -> None:
        self._permission_spec = value
        self._permissions = value

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def is_superuser(self) -> bool:
        return self.role == "superuser"

    @property
    def site_ids(self) -> list[int]:
        return self._site_ids

    @property
    def sites(self) -> list[SimpleNamespace]:
        return [SimpleNamespace(id=i, name=f"Site {i}") for i in self._site_ids]


def permissive_user(user_id: int = 1, site_ids: Iterable[int] | None = None) -> FakeUser:
    """A non-admin user (custom role) holding every grantable key in allow mode."""
    return FakeUser(user_id, "permissive", set(PERMISSION_KEYS), site_ids=site_ids)


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
