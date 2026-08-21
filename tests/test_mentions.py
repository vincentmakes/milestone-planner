"""
Mirror of the wire-format cases in src/utils/__tests__/mentions.test.ts.

The two sides must agree on exactly what counts as a token, because the
frontend writes them and the backend reads them to decide who gets notified.
"""

import pytest

from app.services.mentions import parse_mention_ids, strip_mention_tokens


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("", []),
        ("nothing here", []),
        # A comment written before mentions existed.
        ("hello @Bob", []),
        ("@[Bob](4) hi", [4]),
        ("hi @[Bob](4)", [4]),
        ("@[A](1)@[B](2)", [1, 2]),
        ("hi @[Alice Anderson](7) and @[Bob](4)", [7, 4]),
        # Same person twice -> one id, order preserved.
        ("@[Bob](4) and @[Bob](4)", [4]),
        # Malformed tokens are plain text.
        ("@[Alice](x)", []),
        ("@[Alice]7)", []),
        ("@Alice(7)", []),
    ],
)
def test_parse_mention_ids(body, expected):
    assert parse_mention_ids(body) == expected


def test_parse_mention_ids_rejects_a_newline_inside_the_name():
    assert parse_mention_ids("@[Ali\nce](7)") == []


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("", ""),
        ("nothing here", "nothing here"),
        ("hi @[Alice Anderson](7) and @[Bob](4)", "hi @Alice Anderson and @Bob"),
        ("@[Bob](4)", "@Bob"),
        # Left alone: not a token.
        ("@[Alice](x)", "@[Alice](x)"),
    ],
)
def test_strip_mention_tokens(body, expected):
    assert strip_mention_tokens(body) == expected


def test_strip_before_truncate_never_leaves_a_partial_token():
    """Truncating first can cut a token in half; stripping first cannot."""
    body = "x" * 190 + " @[Alice Anderson](7) tail"

    preview = strip_mention_tokens(body)[:200]

    assert "@[" not in preview
    assert preview.startswith("x" * 190)


def test_a_long_name_is_bounded():
    """A 200-char name is not a token, so it cannot be used to hide an id."""
    body = f"@[{'n' * 200}](7)"
    assert parse_mention_ids(body) == []
    assert strip_mention_tokens(body) == body
