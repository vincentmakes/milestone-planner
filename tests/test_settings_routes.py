"""
Route tests for /api/settings — the public key/value reads, the admin-only
writes and the tenant SSO settings pair (/api/settings/sso).

Secret handling on PUT /settings/sso is covered in
tests/test_sso_secret_encryption.py; this file covers the rest of the router.
Mock-based, house style (tests/conftest.py).
"""

from unittest.mock import AsyncMock, patch

import pytest

from app.models.settings import Settings, SSOConfig
from tests.conftest import FakeUser
from tests.support import scalar_result, scalars_result


def sso_row(**overrides) -> SSOConfig:
    values = {
        "id": 1,
        "enabled": 1,
        "tenant_id": "entra-tenant",
        "client_id": "client-123",
        "client_secret": None,
        "redirect_uri": "https://app.example.com/callback",
        "auto_create_users": 1,
        "default_role": "superuser",
    }
    values.update(overrides)
    return SSOConfig(**values)


@pytest.fixture
def no_org_sso():
    with patch("app.routers.settings._active_org_sso", new_callable=AsyncMock) as mock:
        mock.return_value = None
        yield mock


# ---------------------------------------------------------------------------
# Key/value settings
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_all_settings_is_a_flat_dict(app_client, mock_db_session):
    mock_db_session.execute.return_value = scalars_result(
        [Settings(key="instance_title", value="R&D Lab"), Settings(key="show_weekends", value=None)]
    )

    response = await app_client.get("/api/settings")

    assert response.status_code == 200
    assert response.json() == {"instance_title": "R&D Lab", "show_weekends": None}


@pytest.mark.asyncio
async def test_get_setting_by_key(app_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(
        Settings(key="instance_title", value="R&D Lab")
    )

    response = await app_client.get("/api/settings/instance_title")

    assert response.status_code == 200
    assert response.json() == {"key": "instance_title", "value": "R&D Lab"}
    sql = str(mock_db_session.execute.await_args.args[0])
    assert "settings.key = " in sql


@pytest.mark.asyncio
async def test_get_missing_setting_returns_null_value(app_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(None)

    response = await app_client.get("/api/settings/nope")

    assert response.status_code == 200
    assert response.json() == {"key": "nope", "value": None}


@pytest.mark.asyncio
async def test_admin_updates_existing_setting(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    row = Settings(key="instance_title", value="Old")
    mock_db_session.execute.return_value = scalar_result(row)

    response = await client.put("/api/settings/instance_title", json={"value": "New"})

    assert response.status_code == 200
    assert response.json() == {"key": "instance_title", "value": "New"}
    assert row.value == "New"
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_admin_creates_missing_setting(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.put("/api/settings/show_weekends", json={"value": "true"})

    assert response.status_code == 200
    assert response.json() == {"key": "show_weekends", "value": "true"}
    (row,) = (c.args[0] for c in mock_db_session.add.call_args_list)
    assert (row.key, row.value) == ("show_weekends", "true")


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["user", "superuser"])
async def test_setting_write_is_admin_only(authed_client, mock_db_session, role):
    client, set_user = authed_client
    set_user(FakeUser(1, role))

    response = await client.put("/api/settings/instance_title", json={"value": "Hacked"})

    assert response.status_code == 403
    mock_db_session.execute.assert_not_awaited()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_setting_write_rejects_non_string_value(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.put("/api/settings/instance_title", json={"value": {"a": 1}})

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# Tenant SSO settings
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sso_settings_public_view(app_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(sso_row(client_secret="hidden"))

    response = await app_client.get("/api/settings/sso")

    assert response.status_code == 200
    assert response.json() == {
        "enabled": True,
        "configured": True,
        "tenant_id": "entra-tenant",
        "client_id": "client-123",
        "redirect_uri": "https://app.example.com/callback",
        "auto_create_users": True,
        "default_role": "superuser",
    }
    assert "hidden" not in response.text


@pytest.mark.asyncio
async def test_sso_settings_incomplete_config_is_not_configured(app_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(sso_row(redirect_uri=None, enabled=0))

    response = await app_client.get("/api/settings/sso")

    assert response.status_code == 200
    assert (response.json()["enabled"], response.json()["configured"]) == (False, False)


@pytest.mark.asyncio
async def test_sso_settings_without_row_is_disabled(app_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(None)

    response = await app_client.get("/api/settings/sso")

    assert response.status_code == 200
    body = response.json()
    assert (body["enabled"], body["configured"], body["tenant_id"]) == (False, False, None)


@pytest.mark.asyncio
async def test_sso_settings_degrade_when_table_missing(app_client, mock_db_session):
    mock_db_session.execute.side_effect = RuntimeError('relation "sso_config" does not exist')

    response = await app_client.get("/api/settings/sso")

    assert response.status_code == 200
    assert response.json()["enabled"] is False
    assert response.json()["configured"] is False


@pytest.mark.asyncio
async def test_update_sso_settings_creates_row(authed_client, mock_db_session, no_org_sso):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.put(
        "/api/settings/sso",
        json={
            "enabled": True,
            "tenant_id": "t",
            "client_id": "c",
            "redirect_uri": "https://r",
            "auto_create_users": False,
            "default_role": "user",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert (body["enabled"], body["configured"], body["auto_create_users"]) == (True, True, False)
    (row,) = (c.args[0] for c in mock_db_session.add.call_args_list)
    assert isinstance(row, SSOConfig)
    assert (row.id, row.enabled, row.tenant_id, row.auto_create_users) == (1, 1, "t", 0)
    assert row.default_role == "user"
    mock_db_session.commit.assert_awaited_once()
    no_org_sso.assert_awaited_once()
    assert no_org_sso.await_args.kwargs == {"strict": True}


@pytest.mark.asyncio
async def test_update_sso_settings_partial_update_keeps_other_fields(
    authed_client, mock_db_session, no_org_sso
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    row = sso_row()
    mock_db_session.execute.return_value = scalar_result(row)

    response = await client.put("/api/settings/sso", json={"enabled": False})

    assert response.status_code == 200
    assert row.enabled == 0
    assert (row.tenant_id, row.client_id, row.default_role) == (
        "entra-tenant",
        "client-123",
        "superuser",
    )
    assert response.json()["enabled"] is False
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_update_sso_settings_rejected_while_org_sso_active(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    org = {"organization": {"name": "Contoso"}}

    with patch("app.routers.settings._active_org_sso", AsyncMock(return_value=org)):
        response = await client.put("/api/settings/sso", json={"enabled": True})

    assert response.status_code == 409
    assert "(via Contoso)" in response.json()["detail"]
    mock_db_session.execute.assert_not_awaited()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_sso_settings_rejects_admin_default_role(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.put("/api/settings/sso", json={"default_role": "admin"})

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_sso_settings_is_admin_only(authed_client, mock_db_session, no_org_sso):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))

    response = await client.put("/api/settings/sso", json={"enabled": False})

    assert response.status_code == 403
    no_org_sso.assert_not_awaited()
    mock_db_session.commit.assert_not_awaited()
