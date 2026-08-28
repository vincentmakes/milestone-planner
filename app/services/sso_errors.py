"""
Translate Microsoft Entra token-endpoint failures into messages we can show.

Entra answers a failed token request with an ``AADSTS`` code that names the
cause exactly — a redirect URI registered under the wrong platform, a client
secret that is really a secret *id*, an expired secret. That code is the one
fact worth surfacing, and until now it only ever reached the server log, which
an operator running the app as a container often cannot read.

The rule this module exists to enforce: **the only remote-derived text that may
reach a user is a regex-validated ``AADSTS\\d{4,7}`` code.** Everything else is
one of our own fixed strings, looked up from the table below. Microsoft's
``error_description`` is free text from a remote party and is never echoed into
a redirect URL (the SSO callback already refuses to reflect Entra's ``error``
parameter for the same reason).

Deliberately standalone — no DB, settings, or I/O — so both the tenant SSO
callback and the admin portal's organization diagnostics can import it without
dragging in ``app.services.sso``'s encryption and settings dependencies.
"""

import json
import re
from dataclasses import dataclass

# Entra codes are AADSTS followed by 4-7 digits. Anchoring on this pattern is
# what makes the code safe to interpolate into a redirect URL.
AADSTS_RE = re.compile(r"AADSTS(\d{4,7})")

# Cap on how much of a remote response body we are willing to scan.
MAX_BODY_SCAN = 8192

# Cap on the message we hand to the browser, so a redirect URL stays sane.
MAX_USER_MESSAGE = 120

# Preserved verbatim: this is what the callback said before the codes were
# mapped, and it stays the answer when Entra gives us nothing to go on.
GENERIC_MESSAGE = "Failed to exchange authorization code"

RETRY_MESSAGE = "This sign-in link has expired or was already used. Please try signing in again."

_ADMIN_ATTENTION = (
    "SSO sign-in failed ({code}). The identity provider app registration needs attention."
)

# code -> (user_message, admin_remedy, category)
#
# Categories: app_registration | credentials | redirect_uri | retry |
# unexpected_responder | unknown.
# Every message here is ours; none of it comes from Microsoft.
_MAP: dict[str, tuple[str, str, str]] = {
    # --- Redirect URI registered under the wrong platform ------------------
    # The one failure mode that passes /authorize and fails redemption on the
    # very same app registration: /authorize does not check platform type.
    "AADSTS9002327": (
        _ADMIN_ATTENTION,
        "The redirect URI is registered under the 'Single-page application' platform, so the "
        "authorization code cannot be redeemed from the server. In Entra, remove it from that "
        "platform and add the same URI under 'Web'. In the app manifest its replyUrlsWithType "
        'entry must read "type": "Web".',
        "app_registration",
    ),
    "AADSTS9002325": (
        _ADMIN_ATTENTION,
        "Entra is demanding PKCE, which means the redirect URI is registered as a single-page "
        "application. Re-register it under the 'Web' platform.",
        "app_registration",
    ),
    "AADSTS9002326": (
        _ADMIN_ATTENTION,
        "The token request carried an Origin header for a redirect URI registered under 'Web'. "
        "This usually means a forward proxy is injecting Origin on outbound requests.",
        "app_registration",
    ),
    # --- Client secret -----------------------------------------------------
    "AADSTS7000215": (
        _ADMIN_ATTENTION,
        "The client secret is not valid. Copy the secret's Value from Entra, not its Secret ID "
        "(a secret that looks like a GUID is the Secret ID). Check it was not truncated and "
        "carries no trailing whitespace.",
        "credentials",
    ),
    "AADSTS7000222": (
        _ADMIN_ATTENTION,
        "The client secret has expired. Create a new secret in Entra under Certificates & "
        "secrets and save its Value here.",
        "credentials",
    ),
    "AADSTS7000218": (
        _ADMIN_ATTENTION,
        "No client secret reached Entra — the stored secret is empty or could not be decrypted. "
        "Re-enter it.",
        "credentials",
    ),
    # --- Redirect URI value ------------------------------------------------
    "AADSTS50011": (
        "SSO sign-in failed (AADSTS50011). The sign-in redirect address does not match the app "
        "registration.",
        "The redirect URI sent at redemption is not registered for this application. Because "
        "Entra would not have issued a code for an unregistered URI, this almost always means "
        "the redemption used a different SSO configuration than the sign-in did — check the "
        "server log for the configuration fingerprint on both hops.",
        "redirect_uri",
    ),
    # --- Retryable ---------------------------------------------------------
    "AADSTS54005": (
        RETRY_MESSAGE,
        "The authorization code was already redeemed. Codes are single-use; a browser prefetch, "
        "a page refresh or a retrying proxy in front of the callback URL can consume one.",
        "retry",
    ),
    "AADSTS70008": (
        RETRY_MESSAGE,
        "The authorization code expired before it was redeemed. Check the server clock if this "
        "happens consistently.",
        "retry",
    ),
    "AADSTS9002313": (
        RETRY_MESSAGE,
        "Entra rejected the request as malformed, usually an invalid or foreign authorization "
        "code.",
        "retry",
    ),
    # --- Application / directory ------------------------------------------
    "AADSTS700016": (
        _ADMIN_ATTENTION,
        "The client ID was not found in that directory. Check the Application (client) ID and "
        "the Directory (tenant) ID belong to the same app registration, and that the "
        "application has a service principal in the directory.",
        "credentials",
    ),
    "AADSTS65001": (
        "SSO sign-in failed (AADSTS65001). An administrator must grant consent for this "
        "application.",
        "Grant admin consent for the application's delegated permissions (User.Read, plus "
        "GroupMember.Read.All when group-based access is in use) under API permissions.",
        "app_registration",
    ),
    "AADSTS90002": (
        "SSO sign-in failed (AADSTS90002). The identity provider directory could not be found.",
        "The Directory (tenant) ID is wrong. Copy it from the app registration's Overview page.",
        "credentials",
    ),
    "AADSTS900023": (
        "SSO sign-in failed (AADSTS900023). The identity provider directory could not be found.",
        "The Directory (tenant) ID is malformed — check for stray whitespace, or a directory "
        "name where a GUID is expected.",
        "credentials",
    ),
    # --- Guard for future edits -------------------------------------------
    # Not reachable with the current scope list (every value resolves to
    # Microsoft Graph); mapped so that adding a second resource is diagnosable.
    "AADSTS28000": (
        _ADMIN_ATTENTION,
        "The requested scope spans more than one resource. An authorization code request may "
        "only ask for OIDC scopes plus permissions on a single API.",
        "app_registration",
    ),
}


@dataclass(frozen=True)
class EntraTokenError:
    """A parsed Entra token-endpoint failure."""

    code: str | None
    """The ``AADSTS…`` code, or None if the response carried none."""

    user_message: str
    """Our own message, safe to put in a redirect URL. Never remote text."""

    admin_remedy: str
    """Our own message, for an administrator. Never remote text."""

    category: str
    """app_registration | credentials | redirect_uri | retry | unexpected_responder | unknown."""


def extract_aadsts_code(body: str) -> str | None:
    """Return the ``AADSTS…`` code in ``body``, or None."""
    match = AADSTS_RE.search(body[:MAX_BODY_SCAN])
    return f"AADSTS{match.group(1)}" if match else None


def describe_aadsts(code: str | None) -> tuple[str, str, str]:
    """
    Map an ``AADSTS`` code to ``(user_message, admin_remedy, category)``.

    An unmapped code is still worth showing — it is the search term that leads
    an administrator straight to Microsoft's own documentation — so it is
    reported as-is. It has been validated against :data:`AADSTS_RE`, so it can
    only ever be the literal ``AADSTS`` plus digits.
    """
    if not code:
        return (
            GENERIC_MESSAGE,
            "Entra rejected the token request without an AADSTS code. The full response is in "
            "the server log.",
            "unknown",
        )

    mapped = _MAP.get(code)
    if mapped is None:
        return (
            f"SSO sign-in failed ({code}). Contact your administrator.",
            f"Entra returned {code}. Look it up in Microsoft's error code reference; the full "
            f"response is in the server log.",
            "unknown",
        )

    user_message, admin_remedy, category = mapped
    return user_message.format(code=code), admin_remedy, category


def describe_unexpected_responder(status_code: int) -> tuple[str, str, str]:
    """
    Describe a non-200 that carried no ``AADSTS`` code.

    Entra puts a code in every error it returns, so its absence is evidence that
    something other than Entra answered — an intercepting proxy or gateway
    returning a block page reads to httpx as an ordinary non-200 response, which
    is indistinguishable from a rejection unless you look for the code.

    This is a worded inference, not a detection: a 5xx from Microsoft itself
    would also land here. It narrows the search, it does not end it. Only the
    status code — our own integer, never remote text — is interpolated.
    """
    if not status_code:
        return describe_aadsts(None)

    return (
        f"Sign-in failed: the identity provider did not respond as expected "
        f"(HTTP {status_code}). Contact administrator.",
        f"The response to the token request carried no AADSTS code, which Entra always "
        f"includes, so HTTP {status_code} probably did not come from Microsoft. Check whether a "
        f"proxy or gateway is intercepting requests to login.microsoftonline.com from the "
        f"server. A fault at Microsoft would look the same; the full response is in the server "
        f"log. Comparing a working environment against this one separates the two.",
        "unexpected_responder",
    )


def parse_entra_token_error(status_code: int, body: str) -> EntraTokenError:
    """
    Turn a non-200 Entra token response into a message we are willing to show.

    ``body`` is remote text and is treated as hostile: it is scanned only for an
    ``AADSTS`` code (in the JSON fields Entra documents, then as a fallback
    anywhere in the raw text, since error shapes vary), and nothing else from it
    reaches the return value.
    """
    haystack = body[:MAX_BODY_SCAN] if body else ""
    code: str | None = None

    try:
        payload = json.loads(haystack)
    except (ValueError, TypeError):
        payload = None

    if isinstance(payload, dict):
        # Entra puts the code inside error_description, and repeats it
        # numerically in error_codes.
        code = extract_aadsts_code(str(payload.get("error_description") or ""))
        if not code:
            error_codes = payload.get("error_codes")
            if isinstance(error_codes, list) and error_codes:
                candidate = str(error_codes[0])
                if candidate.isdigit() and 4 <= len(candidate) <= 7:
                    code = f"AADSTS{candidate}"

    if not code:
        code = extract_aadsts_code(haystack)

    if code:
        user_message, admin_remedy, category = describe_aadsts(code)
    else:
        user_message, admin_remedy, category = describe_unexpected_responder(status_code)
    return EntraTokenError(
        code=code,
        user_message=user_message[:MAX_USER_MESSAGE],
        admin_remedy=admin_remedy,
        category=category,
    )
