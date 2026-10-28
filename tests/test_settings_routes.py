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


DEFAULTS = {
    "gantt_default_panel": "none",
    "staff_panel_default_skills": "[]",
    "equipment_panel_default_types": "[]",
    "kanban_enabled": "true",
    "nager_enabled": "true",
    "new_project_preselect_phases": "true",
    "gantt_completion_badges": "true",
    "project_field_labels": "{}",
    "project_fields_hidden": "[]",
}


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
    assert response.json() == {
        **DEFAULTS,
        "instance_title": "R&D Lab",
        "show_weekends": None,
    }


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
# Known keys: admin defaults and feature switches (instance_settings.py)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_all_settings_merge_defaults_without_writing(app_client, mock_db_session):
    mock_db_session.execute.return_value = scalars_result(
        [Settings(key="kanban_enabled", value="false"), Settings(key="nager_enabled", value=None)]
    )

    response = await app_client.get("/api/settings")

    assert response.status_code == 200
    # A stored row wins, even a NULL one; only missing known keys are filled.
    assert response.json() == {**DEFAULTS, "kanban_enabled": "false", "nager_enabled": None}
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(("key", "default"), list(DEFAULTS.items()))
async def test_a_missing_known_key_reads_as_its_default(app_client, mock_db_session, key, default):
    mock_db_session.execute.return_value = scalar_result(None)

    response = await app_client.get(f"/api/settings/{key}")

    assert response.status_code == 200
    assert response.json() == {"key": key, "value": default}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("key", "raw", "stored"),
    [
        ("gantt_default_panel", " Staff ", "staff"),
        ("staff_panel_default_skills", "[3, 1, 3]", "[3,1]"),
        ("equipment_panel_default_types", '[" HPLC ", "GC", "HPLC"]', '["HPLC","GC"]'),
        ("kanban_enabled", "OFF", "false"),
        ("nager_enabled", "0", "false"),
        ("new_project_preselect_phases", "Yes", "true"),
        ("gantt_completion_badges", "off", "false"),
        (
            "project_field_labels",
            '{"confirmed": " Won ", "customer": "Client"}',
            '{"customer":"Client","confirmed":"Won"}',
        ),
        ("project_fields_hidden", '["volume", "customer", "volume"]', '["customer","volume"]'),
    ],
)
async def test_a_known_key_stores_its_canonical_form(
    authed_client, mock_db_session, key, raw, stored
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.put(f"/api/settings/{key}", json={"value": raw})

    assert response.status_code == 200
    assert response.json() == {"key": key, "value": stored}
    (row,) = (c.args[0] for c in mock_db_session.add.call_args_list)
    assert (row.key, row.value) == (key, stored)


@pytest.mark.asyncio
async def test_a_known_key_updates_its_row_canonically(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    row = Settings(key="kanban_enabled", value="true")
    mock_db_session.execute.return_value = scalar_result(row)

    response = await client.put("/api/settings/kanban_enabled", json={"value": "False"})

    assert response.status_code == 200
    assert row.value == "false"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("key", "raw"),
    [
        ("gantt_default_panel", "kanban"),
        ("staff_panel_default_skills", "[0]"),
        ("staff_panel_default_skills", "1,2"),
        ("equipment_panel_default_types", '[""]'),
        ("equipment_panel_default_types", '["' + "x" * 101 + '"]'),
        ("kanban_enabled", "maybe"),
        ("nager_enabled", ""),
        ("new_project_preselect_phases", "2"),
        ("gantt_completion_badges", "hidden"),
        ("project_field_labels", '{"name": "Title"}'),
        ("project_field_labels", '{"customer": "   "}'),
        ("project_field_labels", '{"customer": "' + "x" * 61 + '"}'),
        ("project_field_labels", '["customer"]'),
        ("project_fields_hidden", '["confirmed"]'),
        ("project_fields_hidden", '["customer", "notes"]'),
        ("project_fields_hidden", '{"customer": true}'),
    ],
)
async def test_an_invalid_value_for_a_known_key_is_422(authed_client, mock_db_session, key, raw):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.put(f"/api/settings/{key}", json={"value": raw})

    assert response.status_code == 422
    assert response.json()["detail"] == f"Invalid value for {key}"
    mock_db_session.execute.assert_not_awaited()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_an_unknown_key_stays_free(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.put("/api/settings/logo_url", json={"value": " maybe [0] "})

    assert response.status_code == 200
    assert response.json() == {"key": "logo_url", "value": " maybe [0] "}


@pytest.mark.asyncio
async def test_null_on_a_known_key_deletes_the_row(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    row = Settings(key="gantt_default_panel", value="staff")
    mock_db_session.execute.return_value = scalar_result(row)

    response = await client.put("/api/settings/gantt_default_panel", json={"value": None})

    assert response.status_code == 200
    # The default applies again, and is what the route answers.
    assert response.json() == {"key": "gantt_default_panel", "value": "none"}
    mock_db_session.delete.assert_awaited_once_with(row)
    mock_db_session.commit.assert_awaited_once()
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("key", "stored", "default"),
    [
        ("project_field_labels", '{"customer":"Client"}', "{}"),
        ("project_fields_hidden", '["sales_pm"]', "[]"),
    ],
)
async def test_null_resets_a_built_in_field_setting(
    authed_client, mock_db_session, key, stored, default
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    row = Settings(key=key, value=stored)
    mock_db_session.execute.return_value = scalar_result(row)

    response = await client.put(f"/api/settings/{key}", json={"value": None})

    assert response.status_code == 200
    assert response.json() == {"key": key, "value": default}
    mock_db_session.delete.assert_awaited_once_with(row)


@pytest.mark.asyncio
async def test_null_on_a_known_key_without_a_row_writes_nothing(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.put("/api/settings/nager_enabled", json={"value": None})

    assert response.status_code == 200
    assert response.json() == {"key": "nager_enabled", "value": "true"}
    mock_db_session.delete.assert_not_awaited()
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_null_on_an_unknown_key_is_stored(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    row = Settings(key="instance_title", value="Lab")
    mock_db_session.execute.return_value = scalar_result(row)

    response = await client.put("/api/settings/instance_title", json={"value": None})

    assert response.status_code == 200
    assert row.value is None
    mock_db_session.delete.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["user", "superuser"])
async def test_known_keys_need_settings_general(authed_client, mock_db_session, role):
    client, set_user = authed_client
    set_user(FakeUser(1, role))

    response = await client.put("/api/settings/kanban_enabled", json={"value": "false"})

    assert response.status_code == 403
    assert response.json()["detail"] == "Permission required: settings.general"
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_known_keys_follow_the_settings_general_permission(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(4, "ops", {"settings.general"}))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.put("/api/settings/nager_enabled", json={"value": "false"})

    assert response.status_code == 200
    assert response.json()["value"] == "false"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("project_field_labels", '{"customer":"Client"}'),
        ("project_fields_hidden", '["sales_pm"]'),
    ],
)
async def test_project_field_keys_accept_project_fields_manage(
    authed_client, mock_db_session, key, value
):
    """Settings -> Project fields is gated on project_fields.manage and saves these two keys."""
    client, set_user = authed_client
    set_user(FakeUser(5, "fields", {"project_fields.manage"}))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.put(f"/api/settings/{key}", json={"value": value})

    assert response.status_code == 200
    assert response.json() == {"key": key, "value": value}


@pytest.mark.asyncio
async def test_project_fields_manage_does_not_open_other_keys(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "fields", {"project_fields.manage"}))

    for key in ("instance_title", "kanban_enabled"):
        response = await client.put(f"/api/settings/{key}", json={"value": "false"})
        assert response.status_code == 403
        assert response.json()["detail"] == "Permission required: settings.general"
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("key", ["project_field_labels", "project_fields_hidden"])
async def test_project_field_keys_need_one_of_the_two_keys(authed_client, mock_db_session, key):
    client, set_user = authed_client
    set_user(FakeUser(6, "plain", set()))

    response = await client.put(f"/api/settings/{key}", json={"value": "[]"})

    assert response.status_code == 403
    assert response.json()["detail"] == "Permission required: settings.general"
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


# ---------------------------------------------------------------------------
# SSO default role: any existing non-admin role key
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_sso_settings_accepts_a_custom_default_role(
    authed_client, mock_db_session, no_org_sso
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    row = sso_row()
    # The SSO row, then the role lookup (team_lead exists).
    mock_db_session.execute.side_effect = [scalar_result(row), scalar_result("team_lead")]

    response = await client.put("/api/settings/sso", json={"default_role": "team_lead"})

    assert response.status_code == 200
    assert row.default_role == "team_lead"
    assert response.json()["default_role"] == "team_lead"


@pytest.mark.asyncio
async def test_update_sso_settings_rejects_an_unknown_default_role(
    authed_client, mock_db_session, no_org_sso
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    row = sso_row()
    mock_db_session.execute.side_effect = [scalar_result(row), scalar_result(None)]

    response = await client.put("/api/settings/sso", json={"default_role": "ghost"})

    assert response.status_code == 400
    assert "ghost" in response.json()["detail"]
    assert row.default_role == "superuser"
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_sso_settings_follow_the_settings_sso_permission(
    authed_client, mock_db_session, no_org_sso
):
    client, set_user = authed_client
    set_user(FakeUser(4, "it_ops", {"settings.sso"}))
    mock_db_session.execute.side_effect = [scalar_result(sso_row())]

    response = await client.put("/api/settings/sso", json={"enabled": False})

    assert response.status_code == 200
