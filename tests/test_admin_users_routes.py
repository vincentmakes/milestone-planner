"""
Route tests for /api/admin/users — admin-portal account management.

Master-DB routes (admin_session auth, not the tenant cookie): the tests
override ``get_current_admin`` with a fixed AdminUser and ``get_master_db``
with the mock session (as tests/test_sso_default_role.py does), and leave
``require_superadmin`` real so the role gate is exercised.
"""

from datetime import datetime
from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.models.tenant import AdminUser
from app.services.encryption import verify_password
from tests.support import scalar_result, scalars_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)


def make_admin(admin_id: int = 1, role: str = "superadmin", email: str | None = None):
    return AdminUser(
        id=admin_id,
        email=email or f"admin{admin_id}@example.com",
        password_hash="pbkdf2$old",
        name=f"Admin {admin_id}",
        role=role,
        active=1,
        must_change_password=0,
        created_at=STAMP,
        last_login=None,
    )


@pytest_asyncio.fixture
async def portal_client(test_settings, mock_db_session):
    """Yields (client, set_admin); the caller is superadmin #1 unless changed."""
    with patch("app.config.get_settings", return_value=test_settings):
        from app.main import create_app
        from app.routers.admin.auth import get_current_admin
        from app.services.master_db import get_master_db

        app = create_app()
        state = {"admin": make_admin(1, "superadmin")}
        app.dependency_overrides[get_current_admin] = lambda: state["admin"]
        app.dependency_overrides[get_master_db] = lambda: mock_db_session

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:

            def set_admin(admin: AdminUser) -> None:
                state["admin"] = admin

            yield c, set_admin

        app.dependency_overrides.clear()


@pytest.fixture
def db_assigns_ids(mock_db_session):
    async def refresh(obj):
        if getattr(obj, "id", None) is None:
            obj.id = 12
        obj.created_at = obj.created_at or STAMP

    mock_db_session.refresh.side_effect = refresh
    return mock_db_session


@pytest.mark.asyncio
async def test_list_admin_users(portal_client, mock_db_session):
    client, _ = portal_client
    mock_db_session.execute.return_value = scalars_result([make_admin(1), make_admin(2, "admin")])

    response = await client.get("/api/admin/users")

    assert response.status_code == 200
    body = response.json()
    assert [(u["id"], u["role"], u["last_login"]) for u in body] == [
        (1, "superadmin", None),
        (2, "admin", None),
    ]
    assert all("password_hash" not in u for u in body)
    assert "ORDER BY admin_users.email" in str(mock_db_session.execute.await_args.args[0])


@pytest.mark.asyncio
async def test_list_admin_users_requires_superadmin(portal_client, mock_db_session):
    client, set_admin = portal_client
    set_admin(make_admin(3, "admin"))

    response = await client.get("/api/admin/users")

    assert response.status_code == 403
    assert response.json()["detail"] == "Superadmin access required"
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_admin_user_hashes_password(portal_client, db_assigns_ids):
    client, _ = portal_client
    db_assigns_ids.execute.return_value = scalar_result(None)

    response = await client.post(
        "/api/admin/users",
        json={"email": "new@example.com", "password": "s3cret-pass", "name": "New"},
    )

    assert response.status_code == 201
    body = response.json()
    assert (body["id"], body["email"], body["role"], body["active"]) == (
        12,
        "new@example.com",
        "admin",
        1,
    )
    assert "password" not in str(body)
    (user,) = (c.args[0] for c in db_assigns_ids.add.call_args_list)
    assert user.password_hash != "s3cret-pass"
    assert verify_password("s3cret-pass", user.password_hash)
    db_assigns_ids.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_admin_user_duplicate_email_is_409(portal_client, mock_db_session):
    client, _ = portal_client
    mock_db_session.execute.return_value = scalar_result(make_admin(2, "admin"))

    response = await client.post(
        "/api/admin/users", json={"email": "admin2@example.com", "password": "s3cret-pass"}
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "Email already exists"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {"email": "not-an-email", "password": "s3cret-pass"},
        {"email": "a@example.com", "password": "short"},
        {"email": "a@example.com", "password": "s3cret-pass", "role": "owner"},
    ],
)
async def test_create_admin_user_validates_input(portal_client, mock_db_session, payload):
    client, _ = portal_client

    response = await client.post("/api/admin/users", json=payload)

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_admin_user_requires_superadmin(portal_client, mock_db_session):
    client, set_admin = portal_client
    set_admin(make_admin(3, "admin"))

    response = await client.post(
        "/api/admin/users", json={"email": "x@example.com", "password": "s3cret-pass"}
    )

    assert response.status_code == 403
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_update_admin_user_fields(portal_client, db_assigns_ids):
    client, _ = portal_client
    target = make_admin(2, "admin")
    db_assigns_ids.execute.return_value = scalar_result(target)

    response = await client.put(
        "/api/admin/users/2",
        json={"name": "Renamed", "role": "superadmin", "active": False, "password": "n3w-pass!"},
    )

    assert response.status_code == 200
    assert (target.name, target.role, target.active) == ("Renamed", "superadmin", 0)
    assert verify_password("n3w-pass!", target.password_hash)
    assert response.json()["active"] == 0
    db_assigns_ids.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_admin_user_partial_keeps_password(portal_client, db_assigns_ids):
    client, _ = portal_client
    target = make_admin(2, "admin")
    db_assigns_ids.execute.return_value = scalar_result(target)

    response = await client.put("/api/admin/users/2", json={"active": True})

    assert response.status_code == 200
    assert (target.active, target.password_hash, target.role) == (1, "pbkdf2$old", "admin")


@pytest.mark.asyncio
async def test_update_admin_user_404(portal_client, mock_db_session):
    client, _ = portal_client
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.put("/api/admin/users/9", json={"name": "X"})

    assert response.status_code == 404
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_admin_user_rejects_short_password(portal_client, mock_db_session):
    client, _ = portal_client

    response = await client.put("/api/admin/users/2", json={"password": "short"})

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_admin_user_requires_superadmin(portal_client, mock_db_session):
    client, set_admin = portal_client
    set_admin(make_admin(3, "admin"))

    response = await client.put("/api/admin/users/2", json={"role": "superadmin"})

    assert response.status_code == 403
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_admin_user(portal_client, mock_db_session):
    client, _ = portal_client
    target = make_admin(2, "admin")
    mock_db_session.execute.return_value = scalar_result(target)

    response = await client.delete("/api/admin/users/2")

    assert response.status_code == 200
    assert response.json() == {"success": True}
    mock_db_session.delete.assert_awaited_once_with(target)
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_delete_self_is_rejected(portal_client, mock_db_session):
    client, _ = portal_client

    response = await client.delete("/api/admin/users/1")

    assert response.status_code == 400
    assert response.json()["detail"] == "Cannot delete yourself"
    mock_db_session.execute.assert_not_awaited()
    mock_db_session.delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_admin_user_404(portal_client, mock_db_session):
    client, _ = portal_client
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.delete("/api/admin/users/9")

    assert response.status_code == 404
    mock_db_session.delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_admin_user_requires_superadmin(portal_client, mock_db_session):
    client, set_admin = portal_client
    set_admin(make_admin(3, "admin"))

    response = await client.delete("/api/admin/users/2")

    assert response.status_code == 403
    mock_db_session.delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_must_change_password_admin_is_blocked(test_settings, mock_db_session):
    """Without the get_current_admin override, a session for an admin who must
    change their password is refused before the route runs."""
    with patch("app.config.get_settings", return_value=test_settings):
        from app.main import create_app
        from app.routers.admin.auth import get_current_admin_allow_password_change
        from app.services.master_db import get_master_db

        app = create_app()
        pending = make_admin(1, "superadmin")
        pending.must_change_password = 1
        app.dependency_overrides[get_current_admin_allow_password_change] = lambda: pending
        app.dependency_overrides[get_master_db] = lambda: mock_db_session

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            response = await c.get("/api/admin/users")

        app.dependency_overrides.clear()

    assert response.status_code == 403
    mock_db_session.execute.assert_not_awaited()
