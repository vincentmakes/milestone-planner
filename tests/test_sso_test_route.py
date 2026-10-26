"""
``POST /api/auth/sso/test``: the tenant admin's "Test configuration".

It tests the values entered in Settings → SSO before they are saved. The
properties that matter: a blank or masked secret means the stored one (the
rule Save applies too), nothing is written, organization SSO answers 409, and
the stored secret is only ever sent to Microsoft. The 403 lives in
tests/test_permission_gates.py. All values are fake.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from pydantic import ValidationError

from app.models.settings import SSOConfig
from app.schemas.sso import SSOTestRequest, SSOTestResponse
from app.services.encryption import encrypt
from tests.conftest import FakeUser

URL = "/api/auth/sso/test"
TENANT = "d9c7995d-4c06-40b7-829c-3921bdc751ed"
CLIENT = "1e03c280-f98d-4cc4-a673-837bb7b4fd47"
STORED = "Fake8Q~stored.secret.value"
ENTERED = "Fake8Q~entered.secret.value"
CALLBACK = "https://milestone.example.com/api/auth/sso/callback"

BODY = {"tenant_id": TENANT, "client_id": CLIENT, "redirect_uri": CALLBACK}

CANNED = SSOTestResponse(credentials_ok=True, summary="canned", checks=[])


def stored_row(client_secret):
    return SSOConfig(
        id=1,
        enabled=1,
        tenant_id="old-tenant",
        client_id="old-client",
        client_secret=client_secret,
        redirect_uri=CALLBACK,
        auto_create_users=0,
        default_role="user",
    )


def returning(row):
    result = MagicMock()
    result.scalar_one_or_none.return_value = row
    return result


@pytest.fixture
def admin_client(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = returning(None)
    return client


@pytest.fixture
def service():
    with patch("app.routers.auth.run_entra_test", AsyncMock(return_value=CANNED)) as run:
        yield run


# ---------------------------------------------------------------------------
# Which values are tested
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_entered_values_are_tested_as_given(admin_client, mock_db_session, service):
    resp = await admin_client.post(
        URL,
        json={
            "tenant_id": f" {TENANT}\n",
            "client_id": CLIENT,
            "client_secret": f"{ENTERED}\n",
            "redirect_uri": CALLBACK,
        },
    )

    assert resp.status_code == 200, resp.text
    kwargs = service.await_args.kwargs
    assert kwargs["tenant_id"] == TENANT  # trimmed
    assert kwargs["client_id"] == CLIENT
    assert kwargs["secret"] == ENTERED
    assert kwargs["secret_state"] == "ok"
    assert kwargs["secret_source"] == "entered"
    assert kwargs["redirect_uri"] == CALLBACK
    assert kwargs["shared_callback"] is False
    # An entered secret needs no database read, and nothing is ever written.
    mock_db_session.execute.assert_not_awaited()
    mock_db_session.commit.assert_not_awaited()
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "secret_field",
    [
        {},
        {"client_secret": None},
        {"client_secret": ""},
        {"client_secret": "   "},
        {"client_secret": "****alue"},
    ],
    ids=["omitted", "null", "empty", "blank", "masked"],
)
async def test_blank_or_masked_secret_means_the_stored_one(
    admin_client, mock_db_session, service, secret_field
):
    mock_db_session.execute.return_value = returning(stored_row(encrypt(STORED)))

    resp = await admin_client.post(URL, json={**BODY, **secret_field})

    assert resp.status_code == 200, resp.text
    kwargs = service.await_args.kwargs
    assert kwargs["secret"] == STORED
    assert kwargs["secret_state"] == "ok"
    assert kwargs["secret_source"] == "stored"
    # The entered ids are tested, not the stored ones.
    assert kwargs["tenant_id"] == TENANT
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_no_stored_secret_is_missing(admin_client, service):
    resp = await admin_client.post(URL, json=BODY)

    assert resp.status_code == 200, resp.text
    assert service.await_args.kwargs["secret"] is None
    assert service.await_args.kwargs["secret_state"] == "missing"


@pytest.mark.asyncio
async def test_an_empty_stored_secret_is_missing(admin_client, mock_db_session, service):
    mock_db_session.execute.return_value = returning(stored_row(""))

    await admin_client.post(URL, json=BODY)

    assert service.await_args.kwargs["secret_state"] == "missing"


@pytest.mark.asyncio
async def test_an_undecryptable_stored_secret_is_unreadable(admin_client, mock_db_session, service):
    # The iv:tag:ciphertext shape, under a key this deployment does not have.
    undecryptable = f"{'0' * 24}:{'0' * 32}:abcd"
    mock_db_session.execute.return_value = returning(stored_row(undecryptable))

    await admin_client.post(URL, json=BODY)

    assert service.await_args.kwargs["secret"] is None
    assert service.await_args.kwargs["secret_state"] == "unreadable"


# ---------------------------------------------------------------------------
# The wire format, through the real diagnostic
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_response_json_and_the_stored_secret_never_returned(admin_client, mock_db_session):
    mock_db_session.execute.return_value = returning(stored_row(encrypt(STORED)))
    client = MagicMock()
    client.get = AsyncMock(return_value=httpx.Response(200, json={}))
    client.post = AsyncMock(return_value=httpx.Response(200, json={"access_token": "t"}))
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)

    with patch("app.services.sso_test.httpx.AsyncClient", return_value=client):
        resp = await admin_client.post(URL, json={**BODY, "client_secret": "****alue"})

    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["credentialsOk"] is True
    assert "credentials_ok" not in payload
    assert {check["name"] for check in payload["checks"]} == {
        "Directory (tenant) ID",
        "Application (client) ID",
        "Client secret",
        "Redirect URI",
        "Outbound network",
        "Microsoft directory",
        "Client credentials",
        "Microsoft sign-in",
    }
    assert set(payload["checks"][0]) == {"name", "status", "message", "code"}
    # The stored secret went to Microsoft and nowhere else.
    assert client.post.await_args.kwargs["data"]["client_secret"] == STORED
    assert STORED not in resp.text
    assert TENANT in client.get.await_args.args[0]


@pytest.mark.asyncio
async def test_a_local_failure_answers_without_calling_microsoft(admin_client):
    with patch("app.services.sso_test.httpx.AsyncClient") as async_client:
        resp = await admin_client.post(URL, json=BODY)  # no stored secret

    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["credentialsOk"] is False
    secret = next(c for c in payload["checks"] if c["name"] == "Client secret")
    assert secret["status"] == "fail"
    async_client.assert_not_called()


# ---------------------------------------------------------------------------
# Refusals
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_organization_sso_answers_409(admin_client, mock_db_session, service):
    org_sso = {"enabled": True, "organization": {"name": "Acme"}}
    with patch("app.routers.auth._active_org_sso", AsyncMock(return_value=org_sso)) as lookup:
        resp = await admin_client.post(URL, json={**BODY, "client_secret": ENTERED})

    assert resp.status_code == 409
    assert resp.json()["detail"] == "SSO is managed by your organization"
    assert lookup.await_args.kwargs == {"strict": True}
    service.assert_not_awaited()
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {"client_id": CLIENT, "redirect_uri": CALLBACK},
        {**BODY, "tenant_id": "contoso.com/evil?x=#"},
        {**BODY, "tenant_id": ""},
        {**BODY, "client_id": "c" * 101},
        {**BODY, "client_secret": "s" * 201},
        {**BODY, "redirect_uri": "https://x/" + "a" * 500},
    ],
    ids=["no-tenant", "tenant-path", "tenant-empty", "client-long", "secret-long", "uri-long"],
)
async def test_invalid_bodies_are_422(admin_client, service, body):
    resp = await admin_client.post(URL, json=body)

    assert resp.status_code == 422
    service.assert_not_awaited()


# ---------------------------------------------------------------------------
# The request schema
# ---------------------------------------------------------------------------


def test_request_strips_every_value_and_blank_secret_is_none():
    request = SSOTestRequest(
        tenant_id=" contoso.onmicrosoft.com\n",
        client_id="\tclient ",
        client_secret="  ",
        redirect_uri=f"{CALLBACK}\n",
    )

    assert request.tenant_id == "contoso.onmicrosoft.com"
    assert request.client_id == "client"
    assert request.client_secret is None
    assert request.redirect_uri == CALLBACK
    assert SSOTestRequest(**BODY, client_secret=f" {ENTERED} ").client_secret == ENTERED


@pytest.mark.parametrize("tenant_id", ["a/b", "a?b", "a#b", "t" * 101])
def test_request_rejects_a_tenant_id_that_would_change_the_url(tenant_id):
    with pytest.raises(ValidationError):
        SSOTestRequest(**{**BODY, "tenant_id": tenant_id})
