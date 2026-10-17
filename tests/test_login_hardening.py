"""
Login hardening (B1-14): failed-login throttling on both login routes, timing
equalisation for unknown e-mails, stronger self-describing admin hashes with
lazy upgrade, validated admin roles and an enforced must_change_password.
"""

import hashlib
import secrets
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from app.services import login_throttle
from app.services.encryption import (
    ADMIN_PBKDF2_ITERATIONS,
    admin_password_needs_upgrade,
    hash_password,
    verify_password,
    verify_user_password,
)


@pytest.fixture(autouse=True)
def _fresh_throttle():
    login_throttle.reset_login_throttle()
    yield
    login_throttle.reset_login_throttle()


@pytest.fixture
def cheap_password_checks():
    """The throttle tests make many attempts; skip the real bcrypt cost."""
    with (
        patch("app.routers.auth.dummy_verify_user_password"),
        patch(
            "app.routers.auth.verify_user_password",
            side_effect=lambda password, stored: stored == f"plain:{password}",
        ),
    ):
        yield


def legacy_admin_hash(password: str) -> str:
    """The pre-1.5 Node-compatible format: salt:hash at 10 000 iterations."""
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha512", password.encode(), salt.encode(), 10000, dklen=64)
    return f"{salt}:{digest.hex()}"


def no_user(mock_db_session):
    result = MagicMock()
    result.scalar_one_or_none.return_value = None
    mock_db_session.execute.return_value = result


# ---------------------------------------------------------------------------
# Admin hash format
# ---------------------------------------------------------------------------


def test_new_admin_hash_is_self_describing_with_600k_iterations():
    stored = hash_password("portal-pass-1")
    algo, iterations, salt, digest = stored.split("$")
    assert algo == "pbkdf2_sha512"
    assert int(iterations) == ADMIN_PBKDF2_ITERATIONS == 600_000
    assert len(salt) == 32 and len(digest) == 128
    assert verify_password("portal-pass-1", stored)
    assert not verify_password("wrong", stored)
    assert not admin_password_needs_upgrade(stored)


def test_legacy_admin_hash_still_verifies_and_needs_upgrade():
    stored = legacy_admin_hash("old-portal-pass")
    assert verify_password("old-portal-pass", stored)
    assert not verify_password("nope", stored)
    assert admin_password_needs_upgrade(stored)


def test_lower_iteration_self_describing_hash_needs_upgrade():
    stored = hash_password("x-password", iterations=1000)
    assert verify_password("x-password", stored)
    assert admin_password_needs_upgrade(stored)


def test_malformed_self_describing_hash_does_not_verify():
    assert not verify_password("x", "pbkdf2_sha512$abc$salt$hash")
    assert not verify_password("x", "pbkdf2_sha512$600000$only-three")


def test_tenant_users_seeded_with_the_new_format_can_log_in():
    """Tenant admins seeded with hash_password() (before bcrypt seeding) still log in."""
    stored = hash_password("seeded-admin-pass")
    assert verify_user_password("seeded-admin-pass", stored)
    assert not verify_user_password("other", stored)


# ---------------------------------------------------------------------------
# Tenant login: throttling + timing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tenant_login_is_throttled_after_ten_failures(
    app_client, mock_db_session, cheap_password_checks
):
    no_user(mock_db_session)
    for _ in range(login_throttle.MAX_FAILURES):
        resp = await app_client.post(
            "/api/auth/login", json={"email": "victim@example.com", "password": "guess"}
        )
        assert resp.status_code == 401

    resp = await app_client.post(
        "/api/auth/login", json={"email": "victim@example.com", "password": "guess"}
    )
    assert resp.status_code == 429
    assert int(resp.headers["retry-after"]) > 0

    # Keyed per e-mail: another account from the same address is unaffected.
    other = await app_client.post(
        "/api/auth/login", json={"email": "someone@example.com", "password": "guess"}
    )
    assert other.status_code == 401


@pytest.mark.asyncio
async def test_throttled_login_refuses_even_the_right_password(
    app_client, mock_db_session, cheap_password_checks
):
    user = MagicMock()
    user.password = "plain:right-password"
    result = MagicMock()
    result.scalar_one_or_none.return_value = user
    mock_db_session.execute.return_value = result

    for _ in range(login_throttle.MAX_FAILURES):
        await app_client.post(
            "/api/auth/login", json={"email": "u@example.com", "password": "wrong-password"}
        )
    resp = await app_client.post(
        "/api/auth/login", json={"email": "u@example.com", "password": "right-password"}
    )
    assert resp.status_code == 429


@pytest.mark.asyncio
async def test_failures_age_out_of_the_window(app_client, mock_db_session, cheap_password_checks):
    no_user(mock_db_session)
    with patch("app.services.login_throttle.time.monotonic", return_value=1000.0):
        for _ in range(login_throttle.MAX_FAILURES):
            await app_client.post("/api/auth/login", json={"email": "a@b.c", "password": "x"})
    later = 1000.0 + login_throttle.WINDOW_SECONDS + 1
    with patch("app.services.login_throttle.time.monotonic", return_value=later):
        resp = await app_client.post("/api/auth/login", json={"email": "a@b.c", "password": "x"})
    assert resp.status_code == 401


def test_success_clears_the_counter():
    request = MagicMock()
    request.client.host = "10.0.0.1"
    for _ in range(login_throttle.MAX_FAILURES):
        login_throttle.record_login_failure("tenant:", request, "A@B.c")
    login_throttle.record_login_success("tenant:", request, "a@b.c")
    login_throttle.check_login_allowed("tenant:", request, "a@b.c")  # does not raise


def test_tracked_keys_are_bounded():
    request = MagicMock()
    request.client.host = "10.0.0.1"
    with patch.object(login_throttle, "MAX_TRACKED_KEYS", 3):
        for i in range(10):
            login_throttle.record_login_failure("tenant:", request, f"u{i}@x.y")
        assert len(login_throttle._failures) == 3


def _request_from(host: str) -> MagicMock:
    request = MagicMock()
    request.client.host = host
    return request


# Public addresses: the RFC 5737 documentation ranges are not "global".
def _spray(request: MagicMock, count: int, scope: str = "tenant:acme") -> None:
    """``count`` failures from one address, each for a different e-mail."""
    for i in range(count):
        login_throttle.check_login_allowed(scope, request, f"user{i}@x.y")
        login_throttle.record_login_failure(scope, request, f"user{i}@x.y")


def test_password_spraying_from_one_public_ip_is_capped():
    request = _request_from("81.2.69.142")
    _spray(request, login_throttle.MAX_FAILURES_PER_IP)

    with pytest.raises(HTTPException) as exc:
        login_throttle.check_login_allowed("tenant:acme", request, "fresh@x.y")
    assert exc.value.status_code == 429
    # Across scopes too: the budget belongs to the address.
    with pytest.raises(HTTPException):
        login_throttle.check_login_allowed("admin", request, "fresh@x.y")
    # Other addresses are unaffected.
    login_throttle.check_login_allowed("tenant:acme", _request_from("81.2.69.200"), "fresh@x.y")


def test_a_successful_login_does_not_reset_the_per_ip_budget():
    request = _request_from("81.2.69.142")
    _spray(request, login_throttle.MAX_FAILURES_PER_IP)
    login_throttle.record_login_success("tenant:acme", request, "user0@x.y")
    with pytest.raises(HTTPException):
        login_throttle.check_login_allowed("tenant:acme", request, "user0@x.y")


@pytest.mark.parametrize(
    "host",
    [
        "127.0.0.1",
        "10.0.0.1",
        "172.18.0.5",
        "192.168.1.20",
        "100.64.0.1",
        "::1",
        "fd00::1",
        "unknown",
    ],
)
def test_no_per_ip_lockout_for_addresses_a_proxy_or_nat_may_share(host):
    """Behind an unconfigured reverse proxy every client has the proxy's
    address; a per-ip limit there would let anyone block every login."""
    request = _request_from(host)
    _spray(request, login_throttle.MAX_FAILURES_PER_IP * 2)
    login_throttle.check_login_allowed("tenant:acme", request, "fresh@x.y")  # does not raise
    assert login_throttle._ip_failures == {}
    # The (ip, e-mail) bucket still applies there.
    for _ in range(login_throttle.MAX_FAILURES):
        login_throttle.record_login_failure("tenant:acme", request, "victim@x.y")
    with pytest.raises(HTTPException):
        login_throttle.check_login_allowed("tenant:acme", request, "victim@x.y")


def test_ipv4_mapped_ipv6_public_address_counts_as_public():
    request = _request_from("::ffff:81.2.69.142")
    _spray(request, login_throttle.MAX_FAILURES_PER_IP)
    with pytest.raises(HTTPException):
        login_throttle.check_login_allowed("tenant:acme", request, "fresh@x.y")


def test_per_ip_tracked_keys_are_bounded():
    with patch.object(login_throttle, "MAX_TRACKED_KEYS", 3):
        for i in range(10):
            login_throttle.record_login_failure("tenant:", _request_from(f"81.2.69.{i}"), "a@b.c")
        assert len(login_throttle._ip_failures) == 3


@pytest.mark.asyncio
async def test_unknown_email_still_runs_a_password_check(app_client, mock_db_session):
    no_user(mock_db_session)
    with patch("app.routers.auth.dummy_verify_user_password") as dummy:
        resp = await app_client.post(
            "/api/auth/login", json={"email": "ghost@example.com", "password": "pw"}
        )
    assert resp.status_code == 401
    dummy.assert_called_once_with("pw")


# ---------------------------------------------------------------------------
# Admin portal login
# ---------------------------------------------------------------------------


@pytest.fixture
def master_session():
    session = AsyncMock()
    session.add = MagicMock()
    return session


@pytest_asyncio.fixture
async def portal_client(test_settings, master_session):
    with patch("app.config.get_settings", return_value=test_settings):
        from app.main import create_app
        from app.services.master_db import get_master_db

        app = create_app()

        async def _master():
            yield master_session

        app.dependency_overrides[get_master_db] = _master
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
        app.dependency_overrides.clear()


def admin_row(password_hash: str, must_change: int = 0):
    admin = MagicMock()
    admin.id = 1
    admin.email = "portal@example.com"
    admin.name = "Portal"
    admin.role = "superadmin"
    admin.is_active = True
    admin.is_superadmin = True
    admin.password_hash = password_hash
    admin.must_change_password = must_change
    return admin


def master_returns(master_session, admin):
    result = MagicMock()
    result.scalar_one_or_none.return_value = admin
    master_session.execute = AsyncMock(return_value=result)


@pytest.mark.asyncio
async def test_admin_login_is_throttled(portal_client, master_session):
    master_returns(master_session, None)
    with patch("app.routers.admin.auth.dummy_verify_admin_password") as dummy:
        for _ in range(login_throttle.MAX_FAILURES):
            resp = await portal_client.post(
                "/api/admin/auth/login", json={"email": "p@example.com", "password": "x"}
            )
            assert resp.status_code == 401
        resp = await portal_client.post(
            "/api/admin/auth/login", json={"email": "p@example.com", "password": "x"}
        )
    assert resp.status_code == 429
    assert dummy.call_count == login_throttle.MAX_FAILURES


@pytest.mark.asyncio
async def test_admin_login_upgrades_a_legacy_hash(portal_client, master_session):
    admin = admin_row(legacy_admin_hash("old-portal-pass"))
    master_returns(master_session, admin)

    resp = await portal_client.post(
        "/api/admin/auth/login", json={"email": admin.email, "password": "old-portal-pass"}
    )

    assert resp.status_code == 200
    assert admin.password_hash.startswith("pbkdf2_sha512$600000$")
    assert verify_password("old-portal-pass", admin.password_hash)
    master_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_admin_login_leaves_a_current_hash_alone(portal_client, master_session):
    current = hash_password("portal-pass-1")
    admin = admin_row(current)
    master_returns(master_session, admin)

    resp = await portal_client.post(
        "/api/admin/auth/login", json={"email": admin.email, "password": "portal-pass-1"}
    )

    assert resp.status_code == 200
    assert admin.password_hash == current


# ---------------------------------------------------------------------------
# must_change_password is enforced
# ---------------------------------------------------------------------------


def flagged_session(master_session, must_change: int):
    admin = admin_row(hash_password("portal-pass-1"), must_change=must_change)
    return patch(
        "app.routers.admin.auth.validate_admin_session", AsyncMock(return_value=admin)
    ), admin


@pytest.mark.asyncio
async def test_flagged_admin_is_refused_on_portal_routes(portal_client, master_session):
    patcher, _ = flagged_session(master_session, must_change=1)
    with patcher:
        resp = await portal_client.get("/api/admin/users", cookies={"admin_session": "sid"})
    assert resp.status_code == 403
    assert "Password change required" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_flagged_admin_can_still_reach_me_and_change_password(portal_client, master_session):
    patcher, admin = flagged_session(master_session, must_change=1)
    with patcher:
        me = await portal_client.get("/api/admin/auth/me", cookies={"admin_session": "sid"})
        change = await portal_client.post(
            "/api/admin/auth/change-password",
            json={"current_password": "portal-pass-1", "new_password": "brand-new-pass"},
            cookies={"admin_session": "sid"},
        )
    assert me.status_code == 200
    assert me.json()["must_change_password"] is True
    assert me.json()["user"]["email"] == admin.email
    assert change.status_code == 200
    assert admin.must_change_password == 0
    assert admin.password_hash.startswith("pbkdf2_sha512$600000$")


@pytest.mark.asyncio
async def test_unflagged_admin_reaches_portal_routes(portal_client, master_session):
    patcher, _ = flagged_session(master_session, must_change=0)
    result = MagicMock()
    result.scalars.return_value.all.return_value = []
    master_session.execute = AsyncMock(return_value=result)
    with patcher:
        resp = await portal_client.get("/api/admin/users", cookies={"admin_session": "sid"})
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Admin role validation
# ---------------------------------------------------------------------------


def test_admin_user_role_is_validated():
    from app.schemas.tenant import AdminUserCreate, AdminUserUpdate

    assert AdminUserCreate(email="a@example.com", password="12345678").role == "admin"
    AdminUserCreate(email="a@example.com", password="12345678", role="superadmin")
    with pytest.raises(ValidationError):
        AdminUserCreate(email="a@example.com", password="12345678", role="root")
    with pytest.raises(ValidationError):
        AdminUserUpdate(role="Superadmin")
    assert AdminUserUpdate(role=None).role is None
