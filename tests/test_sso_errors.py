"""Tests for translating Entra token-endpoint failures into safe messages.

The security-relevant property here is negative: Microsoft's ``error_description``
is remote free text that ends up in a redirect URL an unauthenticated visitor
sees, so nothing from the response body may reach the user message except a
regex-validated ``AADSTS`` code.
"""

import json

import pytest

from app.services.sso_errors import (
    GENERIC_MESSAGE,
    MAX_USER_MESSAGE,
    describe_aadsts,
    extract_aadsts_code,
    parse_entra_token_error,
)


def entra_body(code: str, description: str = "Some description.") -> str:
    """A response shaped the way Entra's token endpoint answers a failure."""
    return json.dumps(
        {
            "error": "invalid_client",
            "error_description": f"{code}: {description}\r\nTrace ID: abc\r\n",
            "error_codes": [int(code.removeprefix("AADSTS"))],
            "timestamp": "2026-08-28 09:00:00Z",
            "correlation_id": "00000000-0000-0000-0000-000000000000",
        }
    )


# ---------------------------------------------------------------------------
# Mapped codes
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("code", "expected_category"),
    [
        ("AADSTS9002327", "app_registration"),
        ("AADSTS9002325", "app_registration"),
        ("AADSTS9002326", "app_registration"),
        ("AADSTS7000215", "credentials"),
        ("AADSTS7000222", "credentials"),
        ("AADSTS7000218", "credentials"),
        ("AADSTS50011", "redirect_uri"),
        ("AADSTS54005", "retry"),
        ("AADSTS70008", "retry"),
        ("AADSTS9002313", "retry"),
        ("AADSTS700016", "credentials"),
        ("AADSTS65001", "app_registration"),
        ("AADSTS90002", "credentials"),
        ("AADSTS900023", "credentials"),
        ("AADSTS28000", "app_registration"),
    ],
)
def test_mapped_codes_are_categorised_and_carry_a_remedy(code, expected_category):
    err = parse_entra_token_error(400, entra_body(code))

    assert err.code == code
    assert err.category == expected_category
    assert err.admin_remedy
    assert err.user_message != GENERIC_MESSAGE


def test_spa_platform_code_names_the_web_platform_fix():
    """The likeliest org-SSO failure must point at the actual remedy."""
    err = parse_entra_token_error(400, entra_body("AADSTS9002327"))

    assert "AADSTS9002327" in err.user_message
    assert "Single-page application" in err.admin_remedy
    assert "'Web'" in err.admin_remedy


def test_secret_id_confusion_is_called_out():
    err = parse_entra_token_error(401, entra_body("AADSTS7000215"))

    assert err.category == "credentials"
    assert "Secret ID" in err.admin_remedy


def test_retryable_codes_ask_the_user_to_try_again():
    err = parse_entra_token_error(400, entra_body("AADSTS54005"))

    assert "try signing in again" in err.user_message
    assert err.category == "retry"


# ---------------------------------------------------------------------------
# Unmapped / absent codes
# ---------------------------------------------------------------------------


def test_unmapped_code_is_still_reported():
    """An unknown code is the search term that finds Microsoft's own docs."""
    err = parse_entra_token_error(400, entra_body("AADSTS123456"))

    assert err.code == "AADSTS123456"
    assert err.category == "unknown"
    assert "AADSTS123456" in err.user_message


def test_body_without_a_code_keeps_the_original_message():
    """No code to show means the message must not change from what it was."""
    err = parse_entra_token_error(500, '{"error": "server_error"}')

    assert err.code is None
    assert err.user_message == GENERIC_MESSAGE
    assert err.category == "unknown"


def test_non_json_body_is_handled():
    err = parse_entra_token_error(502, "<html><body>502 Bad Gateway</body></html>")

    assert err.code is None
    assert err.user_message == GENERIC_MESSAGE


def test_empty_body_is_handled():
    assert parse_entra_token_error(500, "").user_message == GENERIC_MESSAGE


def test_code_is_recovered_from_error_codes_when_description_lacks_it():
    body = json.dumps({"error": "invalid_client", "error_codes": [7000215]})

    assert parse_entra_token_error(401, body).code == "AADSTS7000215"


def test_code_is_recovered_from_a_bare_text_body():
    """Entra is not the only thing that can answer; stay tolerant of shape."""
    err = parse_entra_token_error(400, "AADSTS50011: The redirect URI does not match.")

    assert err.code == "AADSTS50011"


# ---------------------------------------------------------------------------
# The anti-reflection guarantee
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "hostile",
    [
        "<script>alert(1)</script>",
        "https://evil.example.com/phish",
        'He said "click here" now',
        "line one\r\nline two",
        "'; DROP TABLE users; --",
        "Contact attacker@evil.example.com to restore access",
    ],
)
def test_remote_description_never_reaches_the_user_message(hostile):
    err = parse_entra_token_error(400, entra_body("AADSTS7000215", hostile))

    assert hostile not in err.user_message
    # Nothing distinctive from the hostile text leaks either.
    for fragment in ("script", "evil.example.com", "DROP TABLE", "attacker@"):
        assert fragment not in err.user_message


def test_unmapped_code_message_carries_only_the_code():
    hostile = "<img src=x onerror=alert(1)> visit https://evil.example.com"
    err = parse_entra_token_error(400, entra_body("AADSTS999999", hostile))

    assert err.user_message == "SSO sign-in failed (AADSTS999999). Contact your administrator."


def test_huge_body_is_bounded_and_harmless():
    body = json.dumps({"error_description": "x" * 200_000 + " AADSTS7000215: nope"})
    err = parse_entra_token_error(400, body)

    # The tail is past the scan window, so no code is found — and crucially the
    # call returns promptly with our own message rather than echoing anything.
    assert err.user_message == GENERIC_MESSAGE
    assert "x" * 100 not in err.user_message


def test_user_message_is_length_capped():
    for code in ("AADSTS9002327", "AADSTS7000215", "AADSTS123456", None):
        message = parse_entra_token_error(400, entra_body(code) if code else "{}").user_message
        assert len(message) <= MAX_USER_MESSAGE


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def test_extract_aadsts_code_requires_the_documented_shape():
    assert extract_aadsts_code("AADSTS7000215: bad secret") == "AADSTS7000215"
    assert extract_aadsts_code("AADSTS12") is None  # too few digits
    assert extract_aadsts_code("NOTAADSTS") is None
    assert extract_aadsts_code("") is None


def test_describe_aadsts_without_a_code():
    user_message, admin_remedy, category = describe_aadsts(None)

    assert user_message == GENERIC_MESSAGE
    assert category == "unknown"
    assert admin_remedy
