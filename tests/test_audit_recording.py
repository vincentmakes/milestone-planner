"""
Where the audit log is written (Task 4): the auth events, the diff-carrying
admin writes, the exports and the two derived tiers.

Every test reads the rows the autouse ``audit_calls`` fixture (conftest)
captured instead of writing them: ``("record", kwargs)`` for the routes'
explicit rows, ``("record_detached", kwargs)`` for the derived tiers. The
commit-before-raise rule is checked by recording, at each commit, how many
rows had been recorded by then: a failure path must commit *after* its row
and before it raises or redirects (``get_db`` rolls back on a raise; the
organization-SSO session never commits by itself).
"""

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi import HTTPException

from app.models.settings import Settings as SettingRow
from app.models.settings import SSOConfig
from app.services import audit_log
from app.services.encryption import hash_user_password
from app.services.login_throttle import reset_login_throttle
from app.services.session import SessionService
from app.services.sso import SSOService
from tests.conftest import FakeUser
from tests.support import scalar_result
from tests.test_auth_routes_more import orm_user
from tests.test_sso_callback import ORG_CONFIG, browser_state
from tests.test_users_routes import make_user, route_db

# The real record_detached, captured before the autouse stub replaces it.
REAL_RECORD_DETACHED = audit_log.record_detached


@pytest.fixture(autouse=True)
def fresh_throttle():
    reset_login_throttle()
    yield
    reset_login_throttle()


def rows(calls, name="record"):
    return [kwargs for kind, kwargs in calls if kind == name]


def commits_after_rows(db, calls) -> list[int]:
    """Make ``db.commit`` note how many rows had been recorded at each commit."""
    seen: list[int] = []

    async def commit():
        seen.append(len(calls))

    db.commit = AsyncMock(side_effect=commit)
    return seen


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------


async def test_unknown_user_records_a_failure_and_commits_before_the_401(
    app_client, mock_db_session, audit_calls
):
    mock_db_session.execute.return_value = scalar_result(None)
    seen = commits_after_rows(mock_db_session, audit_calls)

    resp = await app_client.post(
        "/api/auth/login", json={"email": "ghost@example.com", "password": "whatever1"}
    )

    assert resp.status_code == 401
    (row,) = rows(audit_calls)
    assert row["action"] == "auth.login.failed"
    assert (row["category"], row["outcome"], row["reason"]) == ("auth", "failure", "unknown_user")
    assert row["subject_email"] == "ghost@example.com"
    assert row["actor"] is None
    assert seen == [1]


async def test_bad_password_records_the_known_user(app_client, mock_db_session, audit_calls):
    user = orm_user(hash_user_password("correct-horse"))
    mock_db_session.execute.return_value = scalar_result(user)
    seen = commits_after_rows(mock_db_session, audit_calls)

    resp = await app_client.post(
        "/api/auth/login", json={"email": "ada@example.com", "password": "wrong-horse"}
    )

    assert resp.status_code == 401
    (row,) = rows(audit_calls)
    assert (row["action"], row["reason"]) == ("auth.login.failed", "bad_password")
    assert row["actor"] is user
    assert seen == [1]


async def test_a_disabled_account_records_inactive(app_client, mock_db_session, audit_calls):
    user = orm_user(hash_user_password("correct-horse"), active=0)
    mock_db_session.execute.return_value = scalar_result(user)
    seen = commits_after_rows(mock_db_session, audit_calls)

    resp = await app_client.post(
        "/api/auth/login", json={"email": "ada@example.com", "password": "correct-horse"}
    )

    assert resp.status_code == 401
    (row,) = rows(audit_calls)
    assert (row["action"], row["outcome"], row["reason"]) == (
        "auth.login.failed",
        "failure",
        "inactive",
    )
    assert row["actor"] is user and row["subject_email"] == "ada@example.com"
    assert seen == [1]


async def test_a_locked_login_records_the_throttle(app_client, mock_db_session, audit_calls):
    seen = commits_after_rows(mock_db_session, audit_calls)
    locked = HTTPException(status_code=429, detail="Too many", headers={"Retry-After": "42"})

    with patch("app.routers.auth.check_login_allowed", side_effect=locked):
        resp = await app_client.post(
            "/api/auth/login", json={"email": "ada@example.com", "password": "x" * 8}
        )

    assert resp.status_code == 429
    (row,) = rows(audit_calls)
    assert row["action"] == "auth.login.locked"
    assert (row["outcome"], row["reason"]) == ("failure", "throttled")
    assert row["subject_email"] == "ada@example.com"
    assert row["context"] == {"retry_after": 42}
    assert seen == [1]
    mock_db_session.execute.assert_not_awaited()  # no user lookup once locked


async def test_a_successful_login_records_the_sign_in(app_client, mock_db_session, audit_calls):
    user = orm_user(hash_user_password("correct-horse"))
    mock_db_session.execute.return_value = scalar_result(user)

    with patch.object(SessionService, "create_session", AsyncMock(return_value="sid")):
        resp = await app_client.post(
            "/api/auth/login", json={"email": "ada@example.com", "password": "correct-horse"}
        )

    assert resp.status_code == 200
    (row,) = rows(audit_calls)
    assert (row["action"], row["category"]) == ("auth.login.succeeded", "auth")
    assert row.get("outcome", "success") == "success"
    assert row["actor"] is user and row["subject_email"] == "ada@example.com"
    # The users table keeps no last sign-in: no first_login context.
    assert "context" not in row


# ---------------------------------------------------------------------------
# Logout and the own password change
# ---------------------------------------------------------------------------


async def test_logout_records_the_user_of_the_session(app_client, audit_calls):
    snapshot = {"id": 7, "email": "ada@example.com", "first_name": "Ada", "last_name": "L"}
    with (
        patch.object(SessionService, "get_user_from_session", AsyncMock(return_value=snapshot)),
        patch.object(SessionService, "delete_session", AsyncMock(return_value=True)),
    ):
        resp = await app_client.post("/api/auth/logout", cookies={"connect.sid": "s%3Asid."})

    assert resp.status_code == 200
    (row,) = rows(audit_calls)
    assert (row["action"], row["subject_email"]) == ("auth.logout", "ada@example.com")
    assert (row["actor"].id, row["actor"].first_name, row["actor"].email) == (
        7,
        "Ada",
        "ada@example.com",
    )


async def test_logout_without_a_session_records_nothing(app_client, audit_calls):
    with (
        patch.object(SessionService, "get_user_from_session", AsyncMock(return_value=None)),
        patch.object(SessionService, "delete_session", AsyncMock(return_value=False)),
    ):
        await app_client.post("/api/auth/logout", cookies={"connect.sid": "s%3Agone."})
        await app_client.post("/api/auth/logout")  # no cookie at all

    assert audit_calls == []


async def test_the_own_password_change_records_the_revoked_sessions(
    authed_client, mock_db_session, audit_calls
):
    client, set_user = authed_client
    me = FakeUser(7, "user")
    set_user(me)
    user = orm_user(hash_user_password("old-password"))
    mock_db_session.execute.return_value = scalar_result(user)
    seen = commits_after_rows(mock_db_session, audit_calls)

    with patch.object(SessionService, "destroy_user_sessions", AsyncMock(return_value=2)):
        resp = await client.post(
            "/api/auth/change-password",
            json={"currentPassword": "old-password", "newPassword": "new-password"},
        )

    assert resp.status_code == 200
    (row,) = rows(audit_calls)
    assert row["action"] == "auth.password.changed"
    assert row["actor"] is me and row["subject_email"] == "ada@example.com"
    assert row["context"] == {"sessions_revoked": 2}
    assert seen == [1]


# ---------------------------------------------------------------------------
# SSO callback (on the tenant session it resolved)
# ---------------------------------------------------------------------------


def tenant_session(db):
    @asynccontextmanager
    async def _resolved(request, default_db, tenant_slug):
        yield db, {"id": "tenant-uuid", "slug": tenant_slug}

    return patch("app.routers.auth._resolve_sso_tenant_session", _resolved)


def entra(
    config=None,
    *,
    exchange: httpx.Response | Exception | None = None,
    profile: httpx.Response | None = None,
):
    """Patch the effective config and the two Microsoft hops."""
    exchange = exchange or httpx.Response(200, json={"access_token": "opaque"})
    profile = profile or httpx.Response(
        200, json={"mail": "ada@example.com", "givenName": "Ada", "surname": "L", "id": "oid"}
    )
    post = (
        AsyncMock(side_effect=exchange)
        if isinstance(exchange, Exception)
        else AsyncMock(return_value=exchange)
    )
    real_get = httpx.AsyncClient.get

    async def get(self, url, *args, **kwargs):
        # Only the Graph hop: the test client itself also calls get().
        if "graph.microsoft.com" in str(url):
            return profile
        return await real_get(self, url, *args, **kwargs)

    return (
        patch.object(
            SSOService,
            "get_effective_sso_config",
            AsyncMock(return_value=(config if config is not None else ORG_CONFIG, "organization")),
        ),
        patch("httpx.AsyncClient.post", post),
        patch.object(httpx.AsyncClient, "get", get),
    )


async def _callback(client, db, config=None, **hops):
    state = browser_state(client, "acme")
    config_patch, post_patch, get_patch = entra(config, **hops)
    with tenant_session(db), config_patch, post_patch, get_patch:
        return await client.get(
            f"/api/auth/sso/callback?code=abc&state={state}", follow_redirects=False
        )


@pytest.mark.parametrize(
    ("setup", "reason", "email"),
    [
        ({"config": {**ORG_CONFIG, "enabled": False}}, "config_missing", None),
        ({"config": {**ORG_CONFIG, "client_secret": " "}}, "config_missing", None),
        (
            {"exchange": httpx.Response(400, json={"error": "invalid_client"})},
            "exchange_failed",
            None,
        ),
        ({"exchange": httpx.ConnectError("refused")}, "exchange_failed", None),
        ({"profile": httpx.Response(500, json={})}, "graph_failed", None),
        ({"profile": httpx.Response(200, json={"id": "oid"})}, "no_email", None),
    ],
    ids=["disabled", "no-key", "rejected", "unreachable", "graph", "no-email"],
)
async def test_an_sso_failure_is_committed_before_the_redirect(
    app_client, mock_db_session, audit_calls, setup, reason, email
):
    seen = commits_after_rows(mock_db_session, audit_calls)

    resp = await _callback(app_client, mock_db_session, **setup)

    assert resp.status_code == 302
    (row,) = rows(audit_calls)
    assert (row["action"], row["category"], row["outcome"]) == (
        "auth.sso.failed",
        "auth",
        "failure",
    )
    assert row["reason"] == reason
    assert row["subject_email"] == email
    assert row["context"] == {"provider": "entra"}
    assert seen == [1]
    # Our own words only, never Entra's.
    assert "invalid_client" not in resp.headers["location"]


async def test_an_unknown_sso_account_is_recorded_with_its_email(
    app_client, mock_db_session, audit_calls
):
    mock_db_session.execute.return_value = scalar_result(None)
    seen = commits_after_rows(mock_db_session, audit_calls)

    resp = await _callback(app_client, mock_db_session)

    assert resp.status_code == 302
    (row,) = rows(audit_calls)
    assert (row["reason"], row["subject_email"]) == ("no_account", "ada@example.com")
    assert seen == [1]


async def test_a_disabled_sso_account_is_recorded(app_client, mock_db_session, audit_calls):
    user = orm_user("", active=0)
    user.sso_provider = "microsoft"
    mock_db_session.execute.return_value = scalar_result(user)
    seen = commits_after_rows(mock_db_session, audit_calls)

    await _callback(app_client, mock_db_session)

    (row,) = rows(audit_calls)
    assert (row["reason"], row["actor"]) == ("inactive", user)
    assert seen == [1]


async def test_a_group_refusal_is_recorded(app_client, mock_db_session, audit_calls):
    seen = commits_after_rows(mock_db_session, audit_calls)
    with (
        patch.object(SSOService, "fetch_user_groups", AsyncMock(return_value=["other"])),
        patch.object(SSOService, "validate_group_membership", return_value=False),
    ):
        await _callback(app_client, mock_db_session, {**ORG_CONFIG, "required_group_ids": ["g"]})

    (row,) = rows(audit_calls)
    assert (row["reason"], row["subject_email"]) == ("group_denied", "ada@example.com")
    assert seen == [1]


async def test_a_successful_sso_sign_in_is_committed(app_client, mock_db_session, audit_calls):
    user = orm_user("")
    user.sso_provider = "microsoft"
    mock_db_session.execute.return_value = scalar_result(user)
    seen = commits_after_rows(mock_db_session, audit_calls)

    with patch.object(SessionService, "create_session", AsyncMock(return_value="sid")):
        resp = await _callback(app_client, mock_db_session)

    assert resp.status_code == 302
    (row,) = rows(audit_calls)
    assert row["action"] == "auth.sso.succeeded"
    assert row["actor"] is user and row["subject_email"] == "ada@example.com"
    assert row["context"] == {"provider": "entra", "created": False}
    assert seen == [1]


# ---------------------------------------------------------------------------
# Admin: users
# ---------------------------------------------------------------------------


@pytest.fixture
def revoked():
    with patch.object(SessionService, "destroy_user_sessions", AsyncMock(return_value=3)) as mock:
        yield mock


async def test_a_user_update_records_only_the_changed_fields(
    authed_client, mock_db_session, audit_calls, revoked
):
    client, set_user = authed_client
    admin = FakeUser(1, "admin")
    set_user(admin)
    target = make_user(7)
    route_db(mock_db_session, target)

    resp = await client.put(
        "/api/users/7", json={"first_name": "Grace", "last_name": "Last7", "role": "superuser"}
    )

    assert resp.status_code == 200
    (row,) = rows(audit_calls)
    assert row["action"] == "admin.user.updated"
    assert row["changes"] == {
        "first_name": {"old": "First", "new": "Grace"},
        "role": {"old": "user", "new": "superuser"},
    }
    assert row["context"] == {"sessions_revoked": 3}
    assert row["subject_email"] == "u7@example.com"
    assert row["target"] == ("user", 7, "Grace Last7")
    assert row["actor"] is admin


async def test_an_unchanged_user_update_records_nothing(
    authed_client, mock_db_session, audit_calls, revoked
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    route_db(mock_db_session, make_user(7))

    resp = await client.put("/api/users/7", json={"first_name": "First", "job_title": "Engineer"})

    assert resp.status_code == 200
    assert audit_calls == []


async def test_a_password_set_is_its_own_row_without_a_diff(
    authed_client, mock_db_session, audit_calls, revoked
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    route_db(mock_db_session, make_user(7))

    resp = await client.put("/api/users/7", json={"password": "brand-new-pass"})

    assert resp.status_code == 200
    (row,) = rows(audit_calls)
    assert row["action"] == "admin.user.password_set"
    assert "changes" not in row
    assert row["context"] == {"sessions_revoked": 3}


async def test_toggle_active_records_the_direction(
    authed_client, mock_db_session, audit_calls, revoked
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    target = make_user(7)
    lookup = MagicMock()
    lookup.scalar_one_or_none.return_value = target
    mock_db_session.execute = AsyncMock(return_value=lookup)

    with patch("app.services.approvals.expire_for_requester", AsyncMock(return_value=None)):
        await client.put("/api/users/7/toggle-active")
        await client.put("/api/users/7/toggle-active")

    first, second = rows(audit_calls)
    assert (first["action"], first["context"]) == (
        "admin.user.deactivated",
        {"sessions_revoked": 3},
    )
    assert (second["action"], second["context"]) == ("admin.user.activated", None)


# ---------------------------------------------------------------------------
# Admin: settings and SSO configuration
# ---------------------------------------------------------------------------


async def test_a_setting_change_records_old_and_new(authed_client, mock_db_session, audit_calls):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(
        SettingRow(key="instance_title", value="Milestone")
    )

    resp = await client.put("/api/settings/instance_title", json={"value": "R&D planner"})

    assert resp.status_code == 200
    (row,) = rows(audit_calls)
    assert row["action"] == "admin.settings.updated"
    assert row["target"] == ("setting", "instance_title", "instance_title")
    assert row["changes"] == {"instance_title": {"old": "Milestone", "new": "R&D planner"}}


async def test_an_unchanged_setting_records_nothing(authed_client, mock_db_session, audit_calls):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(
        SettingRow(key="instance_title", value="Milestone")
    )

    await client.put("/api/settings/instance_title", json={"value": "Milestone"})

    assert audit_calls == []


async def test_a_logo_setting_is_recorded_by_its_length(
    authed_client, mock_db_session, audit_calls
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(None)
    logo = "data:image/png;base64," + "A" * 400

    await client.put("/api/settings/custom_logo", json={"value": logo})

    (row,) = rows(audit_calls)
    assert row["changes"] == {
        "custom_logo": {"old": None, "new": {"changed": True, "length": len(logo)}}
    }


@pytest.mark.parametrize(
    "path", ["/api/sso/config", "/api/auth/sso/config", "/api/settings/sso"], ids=str
)
async def test_an_sso_config_change_never_carries_the_plaintext_secret(
    authed_client, mock_db_session, audit_calls, path
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    stored = SSOConfig(
        id=1,
        enabled=0,
        tenant_id="t-old",
        client_id="c",
        redirect_uri="https://x",
        auto_create_users=0,
        default_role="user",
    )
    mock_db_session.execute.return_value = scalar_result(stored)

    with (
        patch("app.routers.auth._active_org_sso", AsyncMock(return_value=None)),
        patch("app.routers.settings._active_org_sso", AsyncMock(return_value=None)),
        patch("app.services.sso.store_tenant_client_secret") as store,
    ):
        store.side_effect = lambda config, value: setattr(config, "client_secret", "iv:tag:ct")
        resp = await client.put(
            path, json={"enabled": True, "tenant_id": "t-new", "client_secret": "s3cr3t-value"}
        )

    assert resp.status_code == 200
    (row,) = rows(audit_calls)
    assert row["action"] == "admin.sso.updated"
    assert row["target"] == ("sso", "tenant", "SSO configuration")
    changes = row["changes"]
    assert changes["enabled"] == {"old": False, "new": True}
    assert changes["tenant_id"] == {"old": "t-old", "new": "t-new"}
    assert changes["client_secret"] == {"old": None, "new": "***"}
    assert "s3cr3t-value" not in repr(row) and "iv:tag:ct" not in repr(row)


async def test_a_replaced_sso_secret_is_a_change(authed_client, mock_db_session, audit_calls):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    stored = SSOConfig(id=1, enabled=1, client_secret="iv:tag:old", default_role="user")
    mock_db_session.execute.return_value = scalar_result(stored)

    with (
        patch("app.routers.auth._active_org_sso", AsyncMock(return_value=None)),
        patch("app.services.sso.store_tenant_client_secret") as store,
    ):
        store.side_effect = lambda config, value: setattr(config, "client_secret", "iv:tag:new")
        await client.put("/api/sso/config", json={"client_secret": "another-value"})

    (row,) = rows(audit_calls)
    assert row["changes"] == {"client_secret": {"old": "***", "new": "***"}}


async def test_an_sso_test_records_its_outcome(authed_client, mock_db_session, audit_calls):
    from app.schemas.sso import SSOTestCheck, SSOTestResponse

    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    result = SSOTestResponse(
        credentials_ok=False,
        summary="no",
        checks=[
            SSOTestCheck(name="Tenant ID", status="pass", message="ok"),
            SSOTestCheck(name="Microsoft sign-in", status="fail", message="AADSTS7000215"),
        ],
    )
    with (
        patch("app.routers.auth._active_org_sso", AsyncMock(return_value=None)),
        patch("app.routers.auth.run_entra_test", AsyncMock(return_value=result)),
    ):
        resp = await client.post(
            "/api/auth/sso/test",
            json={
                "tenant_id": "t",
                "client_id": "c",
                "client_secret": "typed-value",
                "redirect_uri": "https://example.test/api/auth/sso/callback",
            },
        )

    assert resp.status_code == 200
    (row,) = rows(audit_calls)
    assert (row["action"], row["outcome"], row["reason"]) == (
        "admin.sso.tested",
        "failure",
        "microsoft_sign_in",
    )
    assert row["context"] == {"stored_value": False, "failed_checks": ["Microsoft sign-in"]}
    assert "typed-value" not in repr(row)


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------


async def test_a_project_export_records_its_row(authed_client, audit_calls):
    client, set_user = authed_client
    user = FakeUser(1, "admin")
    set_user(user)
    project = SimpleNamespace(id=12, name="Apollo")

    with (
        patch("app.routers.export.get_project_with_hierarchy", AsyncMock(return_value=project)),
        patch("app.routers.export.build_task_list", return_value=[{}, {}, {}]),
        patch("app.routers.export.generate_xml", return_value="<xml/>"),
        patch("app.routers.export.generate_csv", return_value="a,b"),
    ):
        await client.post("/api/export/mpp/12")
        await client.post("/api/export/csv/12")
        await client.get("/api/export/csv/12")

    assert [r["action"] for r in rows(audit_calls)] == [
        "access.export.msproject",
        "access.export.csv",
        "access.export.csv",
    ]
    for row in rows(audit_calls):
        assert row["category"] == "access"
        assert row["target"] == ("project", 12, "Apollo")
        assert (row["project_id"], row["context"]) == (12, {"rows": 3})


async def test_a_site_export_records_its_row(authed_client, mock_db_session, audit_calls):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.get = AsyncMock(return_value=SimpleNamespace(name="Basel Lab"))

    with patch(
        "app.routers.export.build_site_export_workbook",
        AsyncMock(return_value=(b"xlsx", "site.xlsx")),
    ):
        resp = await client.get("/api/export/site/1/excel")

    assert resp.status_code == 200
    (row,) = rows(audit_calls)
    assert (row["action"], row["category"], row["target"]) == (
        "access.export.site",
        "access",
        ("site", 1, "Basel Lab"),
    )


# ---------------------------------------------------------------------------
# Derived tier 2a: broadcast_change
# ---------------------------------------------------------------------------


async def test_broadcast_change_records_a_change_row(audit_calls):
    from app.websocket.broadcast import broadcast_change

    request = MagicMock()
    request.state = SimpleNamespace(tenant_slug="acme")
    actor = FakeUser(3)
    with patch("app.websocket.broadcast.manager.broadcast_change", AsyncMock()):
        await broadcast_change(
            request=request,
            user=actor,
            entity_type="project",
            entity_id=12,
            project_id=12,
            action="create",
            summary="created Apollo",
        )
        await broadcast_change(request, actor, "staff_assignment", 9, 0, "delete")

    first, second = rows(audit_calls, "record_detached")
    assert first == {
        "action": "project.created",
        "category": "change",
        "actor": actor,
        "target": ("project", 12, "created Apollo"),
        "project_id": 12,
    }
    assert second["action"] == "staff_assignment.deleted"
    assert second["project_id"] is None  # 0 = no project


async def test_broadcast_change_without_audit_records_nothing(audit_calls):
    from app.websocket.broadcast import broadcast_change

    with patch("app.websocket.broadcast.manager.broadcast_change", AsyncMock()):
        await broadcast_change(MagicMock(), FakeUser(3), "project", 0, audit=False)

    assert audit_calls == []


async def test_record_detached_commits_on_its_own_session(audit_calls):
    session = MagicMock()
    session.commit = AsyncMock()

    @asynccontextmanager
    async def factory():
        yield session

    request = MagicMock()
    with patch("app.database.resolve_tenant_session_factory", return_value=factory):
        await REAL_RECORD_DETACHED(request, action="project.created", category="change")

    # record (the stub) ran on the detached session, then it was committed.
    assert rows(audit_calls) == [{"action": "project.created", "category": "change", **_DEFAULTS}]
    session.commit.assert_awaited_once()


_DEFAULTS = {
    "outcome": "success",
    "actor": None,
    "subject_email": None,
    "target": None,
    "project_id": None,
    "reason": None,
    "changes": None,
    "items": None,
    "context": None,
}


@pytest.mark.parametrize(
    "failure",
    [
        HTTPException(status_code=503, detail="Organization database is unavailable."),
        RuntimeError("connection refused"),
    ],
    ids=["no-pool", "error"],
)
async def test_record_detached_never_raises(caplog, failure):
    with patch("app.database.resolve_tenant_session_factory", side_effect=failure):
        await REAL_RECORD_DETACHED(MagicMock(), action="project.created", category="change")

    assert "Audit row project.created could not be written" in caplog.text


async def test_record_detached_outside_a_request_uses_the_default_database(audit_calls):
    session = MagicMock()
    session.commit = AsyncMock()

    @asynccontextmanager
    async def factory():
        yield session

    with patch("app.database.get_session_factory", return_value=factory):
        await REAL_RECORD_DETACHED(None, action="project.updated", category="change")

    session.commit.assert_awaited_once()
