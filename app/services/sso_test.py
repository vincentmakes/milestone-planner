"""
Microsoft Entra SSO diagnostic, shared by organization and tenant SSO.

Signs in as the application itself (a client-credentials request), which
exercises the directory ID, client ID and secret without needing anyone to sign
in — so a configuration can be diagnosed before, or instead of, a failed user
sign-in.

It cannot prove that a user sign-in will work: the application sign-in never
involves a redirect URI, so nothing here can see whether that URI is registered
under the Web platform. That is reported as a check to make by hand, and the
response says "credentials" rather than "SSO" throughout.

Callers resolve the values (the organization's saved config, or the values a
tenant admin entered) and pass them in as plain strings. Nothing from Microsoft
reaches the response except a regex-validated ``AADSTS`` code
(``parse_entra_token_error``), and the secret is only ever sent to Microsoft —
never logged or returned.
"""

import logging
import re
from typing import Literal

import httpx

from app.config import get_settings
from app.schemas.sso import SSOTestCheck, SSOTestResponse
from app.services.sso_errors import parse_entra_token_error

logger = logging.getLogger(__name__)

SecretState = Literal["missing", "unreadable", "ok"]
SecretSource = Literal["stored", "entered"]

_GUID_RE = re.compile(r"^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")

_WEB_PLATFORM_CHECK = (
    "Confirm the redirect URI is registered under the 'Web' platform in Entra, not "
    "'Single-page application'. A URI registered as a single-page application authorizes "
    "normally but cannot be redeemed from the server, and this test cannot see the difference."
)


def _check(name: str, status_: str, message: str, code: str | None = None) -> SSOTestCheck:
    return SSOTestCheck(name=name, status=status_, message=message, code=code)


def _encryption_key_name(shared_callback: bool) -> str:
    """
    The setting a stored secret's encryption key comes from.

    Organization SSO exists only in multi-tenant mode (``TENANT_ENCRYPTION_KEY``);
    a single-tenant install derives the tenant key from ``SESSION_SECRET``.
    """
    if shared_callback or get_settings().multi_tenant:
        return "TENANT_ENCRYPTION_KEY"
    return "SESSION_SECRET"


def local_checks(
    *,
    tenant_id: str | None,
    client_id: str | None,
    secret: str | None,
    secret_state: SecretState,
    redirect_uri: str | None,
    shared_callback: bool,
    secret_source: SecretSource = "stored",
) -> list[SSOTestCheck]:
    """
    Everything that can be judged without asking Microsoft anything.

    ``secret_state`` says whether there is a secret at all (``missing``), one
    stored but undecryptable (``unreadable``) or a usable one (``ok``, then
    ``secret`` is it). ``shared_callback`` is True for organization SSO, whose
    one callback serves every workspace, so a ``/t/{slug}/`` URI cannot work.
    """
    checks = []

    for label, raw in (
        ("Directory (tenant) ID", tenant_id),
        ("Application (client) ID", client_id),
    ):
        # Coerce to the string this is at runtime (the organization model uses
        # legacy Column() attributes) — which also strips a pasted newline
        # before the shape check, as everywhere else here.
        value = str(raw or "").strip()
        if not value:
            checks.append(_check(label, "fail", "Not set."))
        elif not _GUID_RE.match(value):
            checks.append(
                _check(label, "warn", "This does not look like a GUID. Copy it from Entra.")
            )
        else:
            checks.append(_check(label, "pass", "Looks like a valid identifier."))

    if secret_state == "missing":
        checks.append(_check("Client secret", "fail", "Not set."))
    elif secret_state == "unreadable" or secret is None:
        checks.append(
            _check(
                "Client secret",
                "fail",
                "Stored, but it could not be decrypted. This usually means "
                f"{_encryption_key_name(shared_callback)} changed since it was saved — "
                "re-enter the secret.",
            )
        )
    elif _GUID_RE.match(secret):
        # Azure shows Value and Secret ID side by side and only the Value works.
        checks.append(
            _check(
                "Client secret",
                "warn",
                "This looks like the Secret ID, not the secret Value. Copy the Value column "
                "from Certificates & secrets in Entra — it is only shown once, so a new "
                "secret may be needed.",
            )
        )
    elif secret_source == "entered":
        checks.append(_check("Client secret", "pass", "Looks like a secret value."))
    else:
        checks.append(_check("Client secret", "pass", "Stored and readable."))

    uri = redirect_uri or ""
    if not uri:
        checks.append(_check("Redirect URI", "fail", "Not set."))
    elif shared_callback and "/t/" in uri:
        checks.append(
            _check(
                "Redirect URI",
                "fail",
                "Organization SSO uses one shared callback for every workspace, so the URI "
                "must not contain a /t/{slug}/ path.",
            )
        )
    elif not uri.startswith("https://"):
        checks.append(_check("Redirect URI", "warn", "Should be an absolute https:// URL."))
    elif not uri.endswith("/api/auth/sso/callback"):
        checks.append(_check("Redirect URI", "warn", "Should end in /api/auth/sso/callback."))
    else:
        checks.append(_check("Redirect URI", "pass", uri))

    return checks


def outbound_network_check() -> SSOTestCheck:
    """
    Report how this deployment reaches the internet, and what SSO actually uses.

    Two environments running the same version can differ only here, and an
    operator without access to the container has no other way to see it. The
    asymmetry is the point: SSO requests are plain httpx, so they follow
    HTTPS_PROXY/HTTP_PROXY from the environment and nothing else, while
    PROXY_PAC_URL, PROXY_CA_CERT and the proxy credentials apply only to the
    holiday import. A deployment configured the second way believes it has told
    the app about its proxy and has not.

    Never reports the value of PROXY_USERNAME or PROXY_PASSWORD.
    """
    settings = get_settings()

    env_proxy = settings.https_proxy or settings.http_proxy
    unused = [
        name
        for name, value in (
            ("PROXY_PAC_URL", settings.proxy_pac_url),
            ("PROXY_CA_CERT", settings.proxy_ca_cert),
            ("PROXY_USERNAME/PROXY_PASSWORD", settings.proxy_username or settings.proxy_password),
        )
        if value
    ]
    if not settings.proxy_verify_ssl:
        unused.append("PROXY_VERIFY_SSL=false")

    if not env_proxy and not unused:
        return _check(
            "Outbound network",
            "pass",
            "No proxy is configured; sign-in requests connect to Microsoft directly.",
        )

    parts = []
    if env_proxy:
        parts.append(f"Sign-in requests use the configured proxy ({env_proxy}).")
    else:
        parts.append("Sign-in requests connect to Microsoft directly — no HTTPS_PROXY is set.")
    if unused:
        parts.append(
            f"{', '.join(unused)} {'is' if len(unused) == 1 else 'are'} configured but "
            "applies only to the public-holiday import, not to sign-in. If Microsoft is only "
            "reachable through that proxy, sign-in cannot reach it."
        )

    return _check("Outbound network", "warn" if unused else "pass", " ".join(parts))


async def run_entra_test(
    *,
    tenant_id: str | None,
    client_id: str | None,
    secret: str | None,
    secret_state: SecretState,
    redirect_uri: str | None,
    shared_callback: bool,
    log_label: str,
    secret_source: SecretSource = "stored",
) -> SSOTestResponse:
    """
    Check an Entra configuration against Microsoft.

    Local checks and the outbound-network report first; any ``fail`` among them
    returns before a single request leaves the server. Then OpenID discovery for
    the directory and a client-credentials token for the application. Reaching
    Microsoft and being rejected by it are reported differently. ``log_label``
    names the configuration in the log ("organization <id>", "tenant"); the
    secret is never logged.
    """
    checks = local_checks(
        tenant_id=tenant_id,
        client_id=client_id,
        secret=secret,
        secret_state=secret_state,
        redirect_uri=redirect_uri,
        shared_callback=shared_callback,
        secret_source=secret_source,
    )
    checks.append(outbound_network_check())

    if any(check.status == "fail" for check in checks):
        checks.append(_check("Microsoft sign-in", "manual", _WEB_PLATFORM_CHECK))
        # Built through the wire alias: mypy (no pydantic plugin) knows only it.
        return SSOTestResponse(
            credentialsOk=False,
            summary="Fix the settings marked below, then test again.",
            checks=checks,
        )

    entra_tenant_id = (tenant_id or "").strip()
    base = f"https://login.microsoftonline.com/{entra_tenant_id}"
    credentials_ok = False

    try:
        async with httpx.AsyncClient() as client:
            discovery = await client.get(f"{base}/v2.0/.well-known/openid-configuration")
            if discovery.status_code != 200:
                checks.append(
                    _check(
                        "Microsoft directory",
                        "fail",
                        "Microsoft does not recognise this Directory (tenant) ID.",
                    )
                )
            else:
                checks.append(_check("Microsoft directory", "pass", "Found and reachable."))

                token = await client.post(
                    f"{base}/oauth2/v2.0/token",
                    data={
                        "client_id": (client_id or "").strip(),
                        "client_secret": secret,
                        "grant_type": "client_credentials",
                        "scope": "https://graph.microsoft.com/.default",
                    },
                )
                if token.status_code == 200:
                    credentials_ok = True
                    checks.append(
                        _check(
                            "Client credentials",
                            "pass",
                            "Microsoft accepted the client ID and secret.",
                        )
                    )
                else:
                    error = parse_entra_token_error(token.status_code, token.text)
                    logger.error(
                        "SSO test for %s rejected (%s): %s",
                        log_label,
                        error.code or "no AADSTS code",
                        error.admin_remedy,
                    )
                    checks.append(
                        _check(
                            "Client credentials",
                            "fail",
                            error.admin_remedy,
                            code=error.code,
                        )
                    )
    except Exception:
        # Reaching Microsoft is a separate problem from the credentials being
        # wrong, and reporting it as the latter sends people to fix the wrong
        # thing. Say what actually happened.
        logger.warning("SSO test: could not reach Microsoft for %s", log_label, exc_info=True)
        checks.append(
            _check(
                "Microsoft directory",
                "warn",
                "Could not reach login.microsoftonline.com from the server. Check outbound "
                "network access and any corporate proxy settings.",
            )
        )

    checks.append(_check("Microsoft sign-in", "manual", _WEB_PLATFORM_CHECK))

    if credentials_ok:
        summary = (
            "Microsoft accepted the credentials. Confirm the redirect URI platform below to finish."
        )
    elif any(check.status == "fail" for check in checks):
        summary = "Microsoft rejected the configuration. See below."
    else:
        summary = "The settings look right, but they could not be checked with Microsoft."

    return SSOTestResponse(credentialsOk=credentials_ok, summary=summary, checks=checks)
