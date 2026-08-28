"""Tests for the organization SSO diagnostic endpoint.

The endpoint exists because an operator who cannot read the server log has no
other way to find out why a sign-in was rejected. So the properties that matter
are about what it *claims*: it must not report a bad secret when it simply could
not reach Microsoft, and it must never suggest that sign-in will work when all
it verified was the application's own credentials.
"""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.routers.admin_organizations import run_organization_sso_test

GOOD_SECRET = "Abc8Q~notaguid.value"
SECRET_ID = "5f8d1c22-7f4b-4d0f-9a6e-2b1a3c4d5e6f"


def sso_config(**overrides):
    config = MagicMock()
    config.entra_tenant_id = "d9c7995d-4c06-40b7-829c-3921bdc751ed"
    config.client_id = "1e03c280-f98d-4cc4-a673-837bb7b4fd47"
    config.client_secret_encrypted = "iv:tag:cipher"
    config.redirect_uri = "https://milestone.example.com/api/auth/sso/callback"
    for key, value in overrides.items():
        setattr(config, key, value)
    return config


def org_db(config):
    org = MagicMock(id="org-uuid", name="Acme", sso_config=config)
    db = MagicMock()
    db.execute = AsyncMock(return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=org)))
    return db


def fake_client(*, discovery=None, token=None, error=None):
    """Stand in for the proxy-aware client the endpoint calls Microsoft with."""
    client = MagicMock()
    client.get = AsyncMock(return_value=discovery or httpx.Response(200, json={}))
    client.post = AsyncMock(return_value=token or httpx.Response(200, json={"access_token": "t"}))

    @asynccontextmanager
    async def _client(url, timeout=10.0):
        if error is not None:
            raise error
        yield client

    return patch("app.routers.admin_organizations.async_client", _client), client


def entra_rejection(code: str) -> httpx.Response:
    return httpx.Response(
        401,
        json={
            "error": "invalid_client",
            "error_description": f"{code}: something Microsoft says.",
            "error_codes": [int(code.removeprefix("AADSTS"))],
        },
    )


def check_named(result, name):
    return next(check for check in result.checks if check.name == name)


async def run_test(db, secret=GOOD_SECRET, **client_kwargs):
    patcher, client = fake_client(**client_kwargs)
    with patcher, patch("app.routers.admin_organizations.decrypt", return_value=secret):
        result = await run_organization_sso_test(
            org_id="org-uuid", admin=MagicMock(email="admin@example.com"), db=db
        )
    return result, client


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_accepted_credentials_are_reported_as_credentials_only():
    """A green result must not be mistaken for 'sign-in works'."""
    result, _ = await run_test(org_db(sso_config()))

    assert result.credentials_ok is True
    assert check_named(result, "Client credentials").status == "pass"
    assert check_named(result, "Microsoft directory").status == "pass"

    # The redirect-URI platform is unverifiable here and must be flagged as such.
    manual = check_named(result, "Microsoft sign-in")
    assert manual.status == "manual"
    assert "Single-page application" in manual.message
    assert "sso_ok" not in result.summary.lower()


# ---------------------------------------------------------------------------
# What Microsoft says
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rejected_secret_names_the_remedy():
    result, _ = await run_test(org_db(sso_config()), token=entra_rejection("AADSTS7000215"))

    assert result.credentials_ok is False
    credentials = check_named(result, "Client credentials")
    assert credentials.status == "fail"
    assert credentials.code == "AADSTS7000215"
    assert "Secret ID" in credentials.message


@pytest.mark.asyncio
async def test_unknown_directory_is_reported_before_the_credentials():
    result, client = await run_test(
        org_db(sso_config()), discovery=httpx.Response(400, json={"error": "invalid_tenant"})
    )

    assert result.credentials_ok is False
    assert check_named(result, "Microsoft directory").status == "fail"
    # No point asking about credentials in a directory that does not exist.
    client.post.assert_not_awaited()


# ---------------------------------------------------------------------------
# Not reaching Microsoft is not the same as being rejected by it
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unreachable_microsoft_is_a_warning_not_a_credentials_failure():
    result, _ = await run_test(
        org_db(sso_config()), error=httpx.ConnectError("proxy refused the connection")
    )

    assert result.credentials_ok is False
    assert check_named(result, "Microsoft directory").status == "warn"
    assert "proxy" in check_named(result, "Microsoft directory").message
    assert not any(check.status == "fail" for check in result.checks)


# ---------------------------------------------------------------------------
# Local checks, before any network call
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_secret_id_pasted_instead_of_value_is_caught_locally():
    result, client = await run_test(org_db(sso_config()), secret=SECRET_ID)

    secret_check = check_named(result, "Client secret")
    assert secret_check.status == "warn"
    assert "Secret ID" in secret_check.message
    # A warning does not stop the probe — Microsoft still gets asked.
    client.post.assert_awaited()


@pytest.mark.asyncio
async def test_tenant_prefixed_redirect_uri_is_rejected_without_calling_microsoft():
    """Organization SSO shares one callback; a per-tenant URI cannot work."""
    config = sso_config(redirect_uri="https://milestone.example.com/t/acme/api/auth/sso/callback")
    result, client = await run_test(org_db(config))

    assert result.credentials_ok is False
    assert check_named(result, "Redirect URI").status == "fail"
    client.get.assert_not_awaited()
    client.post.assert_not_awaited()


@pytest.mark.asyncio
async def test_undecryptable_secret_is_reported_as_a_key_problem():
    result, client = await run_test(org_db(sso_config()), secret=None)

    secret_check = check_named(result, "Client secret")
    assert secret_check.status == "fail"
    assert "TENANT_ENCRYPTION_KEY" in secret_check.message
    client.post.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_configuration_is_reported_plainly():
    result, _ = await run_test(org_db(None))

    assert result.credentials_ok is False
    assert "no SSO configuration" in result.summary


@pytest.mark.asyncio
async def test_unknown_organization_is_404():
    from fastapi import HTTPException

    db = MagicMock()
    db.execute = AsyncMock(
        return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=None))
    )

    with pytest.raises(HTTPException) as exc:
        await run_organization_sso_test(org_id="nope", admin=MagicMock(), db=db)

    assert exc.value.status_code == 404
