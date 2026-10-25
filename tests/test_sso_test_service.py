"""
The shared Microsoft Entra diagnostic (``app.services.sso_test``).

The organization flavour is covered end to end by
tests/test_admin_org_sso_test.py; this file pins what the tenant flavour adds:
values passed in as plain strings, an entered secret, a per-tenant callback,
and the encryption key named by deployment mode. All values are fake.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.services.sso_test import local_checks, outbound_network_check, run_entra_test

TENANT = "d9c7995d-4c06-40b7-829c-3921bdc751ed"
CLIENT = "1e03c280-f98d-4cc4-a673-837bb7b4fd47"
SECRET = "Fake8Q~notaguid.value"
SECRET_ID = "5f8d1c22-7f4b-4d0f-9a6e-2b1a3c4d5e6f"
CALLBACK = "https://milestone.example.com/api/auth/sso/callback"
TENANT_CALLBACK = "https://milestone.example.com/t/acme/api/auth/sso/callback"


def values(**overrides):
    base = {
        "tenant_id": TENANT,
        "client_id": CLIENT,
        "secret": SECRET,
        "secret_state": "ok",
        "redirect_uri": CALLBACK,
        "shared_callback": False,
        "secret_source": "entered",
    }
    base.update(overrides)
    return base


def named(checks, name):
    return next(check for check in checks if check.name == name)


def settings(multi_tenant: bool):
    fake = MagicMock()
    fake.multi_tenant = multi_tenant
    fake.https_proxy = None
    fake.http_proxy = None
    fake.proxy_pac_url = None
    fake.proxy_ca_cert = None
    fake.proxy_username = None
    fake.proxy_password = None
    fake.proxy_verify_ssl = True
    return patch("app.services.sso_test.get_settings", return_value=fake)


# ---------------------------------------------------------------------------
# local_checks
# ---------------------------------------------------------------------------


def test_valid_entered_values_all_pass():
    checks = local_checks(**values())

    assert [c.name for c in checks] == [
        "Directory (tenant) ID",
        "Application (client) ID",
        "Client secret",
        "Redirect URI",
    ]
    assert all(c.status == "pass" for c in checks)
    assert named(checks, "Client secret").message == "Looks like a secret value."
    # The secret is never echoed back.
    assert not any(SECRET in c.message for c in checks)


def test_stored_secret_keeps_the_organization_wording():
    checks = local_checks(**values(secret_source="stored"))

    assert named(checks, "Client secret").message == "Stored and readable."


def test_an_identifier_that_is_not_a_guid_is_a_warning():
    checks = local_checks(**values(tenant_id="contoso.onmicrosoft.com", client_id="my-app"))

    assert named(checks, "Directory (tenant) ID").status == "warn"
    assert named(checks, "Application (client) ID").status == "warn"


def test_a_secret_id_pasted_as_the_secret_is_a_warning():
    checks = local_checks(**values(secret=SECRET_ID))

    secret = named(checks, "Client secret")
    assert secret.status == "warn"
    assert "Secret ID" in secret.message


def test_missing_values_fail():
    checks = local_checks(
        **values(tenant_id="", client_id=None, secret=None, secret_state="missing", redirect_uri="")
    )

    assert all(c.status == "fail" for c in checks)
    assert {c.message for c in checks} == {"Not set."}


def test_a_per_tenant_callback_fails_only_for_the_shared_organization_callback():
    tenant = local_checks(**values(redirect_uri=TENANT_CALLBACK))
    organization = local_checks(**values(redirect_uri=TENANT_CALLBACK, shared_callback=True))

    assert named(tenant, "Redirect URI").status == "pass"
    assert named(organization, "Redirect URI").status == "fail"
    assert "/t/{slug}/" in named(organization, "Redirect URI").message


@pytest.mark.parametrize(
    ("uri", "message"),
    [
        ("http://milestone.local/api/auth/sso/callback", "Should be an absolute https:// URL."),
        ("https://milestone.example.com/callback", "Should end in /api/auth/sso/callback."),
    ],
)
def test_redirect_uri_shape_warnings(uri, message):
    check = named(local_checks(**values(redirect_uri=uri)), "Redirect URI")

    assert check.status == "warn"
    assert check.message == message


@pytest.mark.parametrize(
    ("multi_tenant", "shared_callback", "key"),
    [
        (False, False, "SESSION_SECRET"),
        (True, False, "TENANT_ENCRYPTION_KEY"),
        (False, True, "TENANT_ENCRYPTION_KEY"),
    ],
)
def test_an_unreadable_secret_names_the_key_of_this_deployment(multi_tenant, shared_callback, key):
    with settings(multi_tenant):
        checks = local_checks(
            **values(
                secret=None,
                secret_state="unreadable",
                secret_source="stored",
                shared_callback=shared_callback,
            )
        )

    secret = named(checks, "Client secret")
    assert secret.status == "fail"
    assert key in secret.message
    other = {"SESSION_SECRET", "TENANT_ENCRYPTION_KEY"} - {key}
    assert other.pop() not in secret.message


def test_disabled_proxy_verification_is_called_out():
    with settings(False) as get_settings:
        get_settings.return_value.proxy_verify_ssl = False
        check = outbound_network_check()

    assert check.status == "warn"
    assert "PROXY_VERIFY_SSL=false is configured" in check.message


# ---------------------------------------------------------------------------
# run_entra_test
# ---------------------------------------------------------------------------


def fake_client(*, discovery=None, token=None, error=None):
    client = MagicMock()
    client.get = AsyncMock(
        side_effect=error, return_value=discovery or httpx.Response(200, json={})
    )
    client.post = AsyncMock(return_value=token or httpx.Response(200, json={"access_token": "t"}))
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    return patch("app.services.sso_test.httpx.AsyncClient", return_value=client), client


async def run(*, client_kwargs=None, **overrides):
    patcher, client = fake_client(**(client_kwargs or {}))
    with patcher, settings(False):
        result = await run_entra_test(log_label="tenant", **values(**overrides))
    return result, client


@pytest.mark.asyncio
async def test_accepted_credentials():
    result, client = await run()

    assert result.credentials_ok is True
    assert named(result.checks, "Microsoft directory").status == "pass"
    assert named(result.checks, "Client credentials").status == "pass"
    assert named(result.checks, "Microsoft sign-in").status == "manual"
    assert result.summary.startswith("Microsoft accepted the credentials.")
    # The probe goes to the entered directory with the entered values.
    assert TENANT in client.get.await_args.args[0]
    token_call = client.post.await_args
    assert token_call.kwargs["data"]["client_id"] == CLIENT
    assert token_call.kwargs["data"]["client_secret"] == SECRET


@pytest.mark.asyncio
async def test_unknown_directory_fails_without_asking_for_a_token():
    result, client = await run(client_kwargs={"discovery": httpx.Response(404)})

    assert result.credentials_ok is False
    assert named(result.checks, "Microsoft directory").status == "fail"
    assert result.summary == "Microsoft rejected the configuration. See below."
    client.post.assert_not_awaited()


@pytest.mark.asyncio
async def test_rejected_secret_carries_the_aadsts_code_and_logs_no_secret(caplog):
    rejection = httpx.Response(
        401,
        json={
            "error": "invalid_client",
            "error_description": "AADSTS7000215: Invalid client secret provided.",
            "error_codes": [7000215],
        },
    )
    with caplog.at_level("DEBUG", logger="app.services.sso_test"):
        result, _ = await run(client_kwargs={"token": rejection})

    credentials = named(result.checks, "Client credentials")
    assert credentials.status == "fail"
    assert credentials.code == "AADSTS7000215"
    assert result.credentials_ok is False
    assert "SSO test for tenant rejected" in caplog.text
    assert SECRET not in caplog.text
    # Entra's own text never reaches the response.
    assert "Invalid client secret provided" not in credentials.message


@pytest.mark.asyncio
async def test_unreachable_microsoft_is_a_warning(caplog):
    with caplog.at_level("WARNING", logger="app.services.sso_test"):
        result, _ = await run(client_kwargs={"error": httpx.ConnectError("refused")})

    assert result.credentials_ok is False
    assert named(result.checks, "Microsoft directory").status == "warn"
    assert not any(c.status == "fail" for c in result.checks)
    assert result.summary == (
        "The settings look right, but they could not be checked with Microsoft."
    )
    assert "could not reach Microsoft for tenant" in caplog.text


@pytest.mark.asyncio
async def test_a_local_failure_never_calls_microsoft():
    result, client = await run(secret=None, secret_state="missing", secret_source="stored")

    assert result.credentials_ok is False
    assert result.summary == "Fix the settings marked below, then test again."
    assert result.checks[-1].status == "manual"
    client.get.assert_not_awaited()
    client.post.assert_not_awaited()


@pytest.mark.asyncio
async def test_the_response_serialises_the_wire_alias():
    result, _ = await run()

    dumped = result.model_dump(by_alias=True)
    assert dumped["credentialsOk"] is True
    assert "credentials_ok" not in dumped
