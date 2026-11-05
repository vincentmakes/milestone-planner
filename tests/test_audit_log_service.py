"""
The audit-log service (app/services/audit_log.py): ``record`` builds one row
from the actor, the request and the details, adds and flushes it, never
commits, and logs the same fields as one JSON line on ``milestone.audit``;
``diff``, ``redact``, ``validate_details``, ``_clip`` and ``change_action``
are its pure helpers.

``REAL_RECORD`` is captured at import time: route tests stub
``audit_log.record`` through an autouse fixture, these tests exercise the
real function.
"""

import json
import logging
from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from starlette.requests import Request

from app.models.audit_log import AuditLog
from app.models.user import User
from app.services import audit_log
from app.services.audit_log import (
    CATEGORIES,
    DETAIL_KEYS,
    LONG_VALUE,
    MASK,
    ORIGINS,
    OUTCOMES,
    VERBS,
    _clip,
    change_action,
    diff,
    log_line,
    redact,
    validate,
    validate_details,
)
from tests.conftest import FakeUser

REAL_RECORD = audit_log.record

BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Firefox/131.0"


def _request(host: str | None = "203.0.113.9", agent: str | None = BROWSER) -> Request:
    headers = [(b"user-agent", agent.encode())] if agent is not None else []
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/auth/login",
        "headers": headers,
        "client": (host, 51000) if host is not None else None,
        "query_string": b"",
    }
    return Request(scope)


def _db() -> MagicMock:
    db = MagicMock()
    db.add = MagicMock()
    db.flush = AsyncMock()
    db.commit = AsyncMock()
    db.rollback = AsyncMock()
    return db


def _row(db: MagicMock) -> AuditLog:
    db.add.assert_called_once()
    db.flush.assert_awaited_once()
    db.commit.assert_not_called()
    db.rollback.assert_not_called()
    (entry,) = db.add.call_args.args
    assert isinstance(entry, AuditLog)
    return entry


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


def test_the_constants():
    assert CATEGORIES == ("auth", "admin", "access", "change")
    assert OUTCOMES == ("success", "failure")
    assert ORIGINS == ("web", "system")
    assert MASK == "***"
    assert DETAIL_KEYS == ("reason", "changes", "items", "context")
    assert LONG_VALUE == 200
    assert audit_log.AUDIT_LOGGER.name == "milestone.audit"
    assert VERBS == {"create": "created", "update": "updated", "delete": "deleted", "move": "moved"}


def test_change_action_uses_the_past_tense():
    assert change_action("project", "create") == "project.created"
    assert change_action("staff_assignment", "delete") == "staff_assignment.deleted"
    assert change_action("phase", "update") == "phase.updated"
    assert change_action("subphase", "move") == "subphase.moved"
    # A verb outside the map is kept.
    assert change_action("project", "archived") == "project.archived"


# ---------------------------------------------------------------------------
# record: the actor
# ---------------------------------------------------------------------------


async def test_record_fills_every_column_from_an_orm_user():
    db = _db()
    actor = User(id=5, email="jane@example.com", first_name="Jane", last_name="Doe")

    entry = await REAL_RECORD(
        db,
        _request(),
        action="admin.user.updated",
        category="admin",
        actor=actor,
        subject_email="bob@example.com",
        target=("user", 9, "Bob Smith"),
        project_id=12,
        changes={"job_title": {"old": "Engineer", "new": "Lead"}},
        context={"sessions_revoked": 2},
    )

    assert _row(db) is entry
    assert entry.category == "admin"
    assert entry.action == "admin.user.updated"
    assert entry.outcome == "success"
    assert (entry.actor_user_id, entry.actor_email, entry.actor_name) == (
        5,
        "jane@example.com",
        "Jane Doe",
    )
    assert entry.subject_email == "bob@example.com"
    # The id is stored as text.
    assert (entry.target_type, entry.target_id, entry.target_label) == ("user", "9", "Bob Smith")
    assert entry.project_id == 12
    assert (entry.ip, entry.user_agent, entry.origin) == ("203.0.113.9", BROWSER, "web")
    assert isinstance(entry.created_at, datetime) and entry.created_at.tzinfo is None
    # Compact, sorted JSON text.
    assert entry.details == (
        '{"changes":{"job_title":{"new":"Lead","old":"Engineer"}},'
        '"context":{"sessions_revoked":2}}'
    )


async def test_record_names_a_session_user():
    """get_current_user usually returns the lightweight SessionUser, which has
    no ``full_name``: the name comes from first / last name."""
    from app.middleware.auth import get_current_user_optional

    with patch("app.middleware.auth.SessionService") as service:
        service.return_value.get_user_from_session = AsyncMock(
            return_value={
                "id": 7,
                "email": "sam@example.com",
                "first_name": "Sam",
                "last_name": "Lee",
                "role": "user",
            }
        )
        actor = await get_current_user_optional(session_id="sid", db=MagicMock())
    assert type(actor).__name__ == "SessionUser"
    assert not hasattr(actor, "full_name")
    db = _db()

    entry = await REAL_RECORD(db, _request(), action="auth.logout", category="auth", actor=actor)

    assert (entry.actor_user_id, entry.actor_email, entry.actor_name) == (
        7,
        "sam@example.com",
        "Sam Lee",
    )
    assert entry.details is None


async def test_record_names_a_fake_user():
    db = _db()

    entry = await REAL_RECORD(
        db, _request(), action="project.created", category="change", actor=FakeUser(3)
    )

    assert (entry.actor_user_id, entry.actor_email, entry.actor_name) == (
        3,
        "user3@example.com",
        "Test User3",
    )


async def test_record_without_a_name_falls_back_to_the_email():
    db = _db()
    actor = SimpleNamespace(id=4, email="noname@example.com", first_name="", last_name=None)

    entry = await REAL_RECORD(db, _request(), action="auth.logout", category="auth", actor=actor)

    assert entry.actor_name == "noname@example.com"


async def test_record_without_an_actor():
    db = _db()

    entry = await REAL_RECORD(
        db,
        _request(),
        action="auth.login.failed",
        category="auth",
        outcome="failure",
        subject_email="who@example.com",
        reason="unknown_user",
    )

    _row(db)
    assert (entry.actor_user_id, entry.actor_email, entry.actor_name) == (None, None, None)
    assert entry.outcome == "failure"
    assert entry.subject_email == "who@example.com"
    assert (entry.target_type, entry.target_id, entry.target_label) == (None, None, None)
    assert entry.project_id is None
    assert entry.details == '{"reason":"unknown_user"}'


# ---------------------------------------------------------------------------
# record: the request
# ---------------------------------------------------------------------------


async def test_record_outside_a_request_is_a_system_row():
    db = _db()

    entry = await REAL_RECORD(db, None, action="project.updated", category="change")

    assert (entry.ip, entry.user_agent, entry.origin) == (None, None, "system")


@pytest.mark.parametrize(
    ("host", "expected"),
    [
        ("203.0.113.9", "203.0.113.9"),
        ("2001:DB8::1", "2001:db8::1"),  # normalised
        ("testclient", None),  # Starlette's TestClient: not an address
        ("", None),
        (None, None),  # no client at all
    ],
)
async def test_record_keeps_only_a_valid_ip(host, expected):
    db = _db()

    entry = await REAL_RECORD(db, _request(host=host), action="auth.logout", category="auth")

    assert entry.ip == expected
    assert entry.origin == "web"


async def test_record_clips_the_user_agent_and_the_long_strings():
    db = _db()

    entry = await REAL_RECORD(
        db,
        _request(agent="A" * 400),
        action="admin.settings.updated",
        category="admin",
        subject_email="e" * 300,
        target=("setting" * 10, "9" * 150, "L" * 300),
    )

    assert entry.user_agent == "A" * 255
    assert entry.subject_email == "e" * 255
    assert entry.target_type == ("setting" * 10)[:50]
    assert entry.target_id == "9" * 100
    assert entry.target_label == "L" * 255


async def test_record_without_a_user_agent():
    db = _db()

    entry = await REAL_RECORD(db, _request(agent=None), action="auth.logout", category="auth")

    assert entry.user_agent is None


async def test_record_pads_a_short_target():
    db = _db()

    entry = await REAL_RECORD(
        db, None, action="access.export.site", category="access", target=("site", 3)
    )

    assert (entry.target_type, entry.target_id, entry.target_label) == ("site", "3", None)


async def test_record_logs_one_json_line(caplog):
    db = _db()

    with caplog.at_level(logging.INFO, logger="milestone.audit"):
        await REAL_RECORD(
            db,
            _request(),
            action="admin.sso.updated",
            category="admin",
            actor=FakeUser(1, "admin"),
            changes={"client_secret": {"old": "old-value", "new": "new-value"}},
        )

    (line,) = (r for r in caplog.records if r.name == "milestone.audit")
    payload = json.loads(line.getMessage())
    assert payload["action"] == "admin.sso.updated"
    assert payload["details"] == {"changes": {"client_secret": {"old": MASK, "new": MASK}}}
    assert "old-value" not in line.getMessage() and "new-value" not in line.getMessage()


# ---------------------------------------------------------------------------
# record / validate: rejected input
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "kwargs",
    [
        {"action": "project.created", "category": "security"},
        {"action": "project.created", "category": "change", "outcome": "partial"},
        {"action": "", "category": "change"},
        {"action": "project", "category": "change"},
        {"action": "Project.Created", "category": "change"},
        {"action": "project.created.", "category": "change"},
        {"action": "project.create2", "category": "change"},
        {"action": "project.created", "category": "change", "reason": ""},
        {"action": "project.created", "category": "change", "context": {"a": {"b": 1}}},
    ],
)
async def test_record_rejects_invalid_input_before_adding(kwargs):
    db = _db()

    with pytest.raises(ValueError):
        await REAL_RECORD(db, None, **kwargs)

    db.add.assert_not_called()
    db.flush.assert_not_called()


def test_validate_accepts_every_category_and_outcome():
    for category in CATEGORIES:
        for outcome in OUTCOMES:
            validate(category, outcome, "auth.login.succeeded")
    with pytest.raises(ValueError, match="action"):
        validate("auth", "success", None)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# diff
# ---------------------------------------------------------------------------


def test_diff_reports_changed_fields_only():
    old = {"name": "Alpha", "pm_id": 3, "archived": False}
    new = {"name": "Beta", "pm_id": 3, "archived": True}

    assert diff(old, new) == {
        "name": {"old": "Alpha", "new": "Beta"},
        "archived": {"old": False, "new": True},
    }


def test_diff_reads_only_what_was_written():
    # A field ``new`` does not carry was not touched; a field ``old`` lacks
    # reads as None.
    assert diff({"name": "A", "color": "#fff"}, {"name": "A", "notes": "x"}) == {
        "notes": {"old": None, "new": "x"}
    }


def test_diff_restricted_to_keys_and_on_objects():
    old = SimpleNamespace(first_name="Jo", last_name="Doe", email="jo@x")
    new = {"first_name": "Joe", "last_name": "Doe", "email": "joe@x"}

    assert diff(old, new, keys=["first_name", "last_name"]) == {
        "first_name": {"old": "Jo", "new": "Joe"}
    }
    # Objects on both sides need explicit keys.
    assert diff(old, SimpleNamespace(first_name="Jim"), keys=["first_name", "missing"]) == {
        "first_name": {"old": "Jo", "new": "Jim"}
    }
    assert diff(old, SimpleNamespace(first_name="Jim")) == {}


def test_diff_replaces_a_long_value_by_its_length():
    logo = "data:image/png;base64," + "A" * 500
    short = "x" * LONG_VALUE  # exactly the limit: kept

    assert diff({"header_logo": None}, {"header_logo": logo}) == {
        "header_logo": {"old": None, "new": {"changed": True, "length": len(logo)}}
    }
    assert diff({"header_logo": logo}, {"header_logo": logo + "B"}) == {
        "header_logo": {
            "old": {"changed": True, "length": len(logo)},
            "new": {"changed": True, "length": len(logo) + 1},
        }
    }
    assert diff({"title": "a"}, {"title": short}) == {"title": {"old": "a", "new": short}}
    # The marker passes the details contract.
    assert validate_details({"changes": diff({"l": None}, {"l": logo})}) is not None


def test_diff_masks_a_credential_key():
    changes = diff(
        {"client_secret": None, "smtp_password": "a", "tenant_id": "t1"},
        {"client_secret": "s3", "smtp_password": "b", "tenant_id": "t2"},
    )

    assert changes == {
        # None stays None: the first configuration is visible as such.
        "client_secret": {"old": None, "new": MASK},
        "smtp_password": {"old": MASK, "new": MASK},
        "tenant_id": {"old": "t1", "new": "t2"},
    }
    # An unchanged credential is not reported.
    assert diff({"api_key": "k"}, {"api_key": "k"}) == {}


# ---------------------------------------------------------------------------
# redact
# ---------------------------------------------------------------------------


def test_redact_masks_nested_credentials_and_keeps_the_shape():
    value = {
        "changes": {
            "client_secret": {"old": "a", "new": "b"},
            "name": {"old": "x", "new": "y"},
            "nested": {"Access_Token": "t", "keep": 1},
        },
        "items": [{"private_key": "k", "kind": "role.key_added"}],
        "context": {"apikey": None, "credentials": ["a", "b"], "count": 3},
    }

    assert redact(value) == {
        "changes": {
            "client_secret": {"old": MASK, "new": MASK},
            "name": {"old": "x", "new": "y"},
            "nested": {"Access_Token": MASK, "keep": 1},
        },
        "items": [{"private_key": MASK, "kind": "role.key_added"}],
        "context": {"apikey": None, "credentials": [MASK, MASK], "count": 3},
    }
    # The input is untouched.
    assert value["changes"]["client_secret"] == {"old": "a", "new": "b"}
    assert redact("plain") == "plain" and redact(None) is None


async def test_record_redacts_the_stored_details():
    db = _db()

    entry = await REAL_RECORD(
        db,
        None,
        action="admin.settings.updated",
        category="admin",
        changes={"password": {"old": "hunter1", "new": "hunter2"}},
        context={"token_hint": "abcd"},
    )

    assert json.loads(entry.details) == {
        "changes": {"password": {"old": MASK, "new": MASK}},
        "context": {"token_hint": MASK},
    }


# ---------------------------------------------------------------------------
# validate_details
# ---------------------------------------------------------------------------


def test_validate_details_accepts_the_contract():
    assert validate_details(None) is None
    assert validate_details({}) is None
    # Empty parts are dropped.
    assert validate_details({"changes": {}, "items": [], "context": {}, "reason": None}) is None
    assert validate_details(
        {
            "reason": "bad_password",
            "changes": {
                "start_date": {"old": date(2026, 1, 5), "new": date(2026, 1, 6)},
                "tags": {"old": ["a"], "new": ["a", "b"]},
            },
            "items": ({"key": "views.kanban", "mode": "allow"},),
            "context": {"rows": 12, "first_login": True, "ratio": 0.5, "ids": [1, 2, None]},
        }
    ) == {
        "reason": "bad_password",
        "changes": {
            "start_date": {"old": date(2026, 1, 5), "new": date(2026, 1, 6)},
            "tags": {"old": ["a"], "new": ["a", "b"]},
        },
        "items": [{"key": "views.kanban", "mode": "allow"}],
        "context": {"rows": 12, "first_login": True, "ratio": 0.5, "ids": [1, 2, None]},
    }


@pytest.mark.parametrize(
    "details",
    [
        "reason",
        {"extra": 1},
        {"reason": 3},
        {"reason": "  "},
        {"changes": []},
        {"changes": {1: {"old": 1, "new": 2}}},
        {"changes": {"name": "x"}},
        {"changes": {"name": {"old": 1}}},
        {"changes": {"name": {"old": 1, "new": 2, "was": 0}}},
        {"changes": {"name": {"old": {"a": 1}, "new": 2}}},
        {"changes": {"name": {"old": [[1]], "new": 2}}},
        {"changes": {"logo": {"old": None, "new": {"changed": False, "length": 3}}}},
        {"changes": {"logo": {"old": None, "new": {"changed": True, "length": True}}}},
        {"items": {"a": 1}},
        {"items": ["x"]},
        {"items": [{"a": {"b": 1}}]},
        {"context": ["a"]},
        {"context": {"a": {"b": 1}}},
        {"context": {2: "x"}},
        {"context": {"a": object()}},
    ],
)
def test_validate_details_rejects_a_breach(details):
    with pytest.raises(ValueError):
        validate_details(details)


async def test_record_stores_dates_in_iso_form():
    db = _db()

    entry = await REAL_RECORD(
        db,
        None,
        action="project.updated",
        category="change",
        changes={"end_date": {"old": date(2026, 3, 1), "new": date(2026, 3, 8)}},
        items=[{"at": datetime(2026, 3, 1, 9, 30)}],
    )

    assert json.loads(entry.details) == {
        "changes": {"end_date": {"old": "2026-03-01", "new": "2026-03-08"}},
        "items": [{"at": "2026-03-01T09:30:00"}],
    }


# ---------------------------------------------------------------------------
# _clip and log_line
# ---------------------------------------------------------------------------


def test_clip():
    assert _clip(None, 10) is None
    assert _clip("", 10) is None
    assert _clip("abc", 10) == "abc"
    assert _clip("abcdef", 3) == "abc"
    assert _clip(12345, 3) == "123"


def test_log_line_is_json_with_every_column_and_masked():
    entry = AuditLog(
        id=42,
        created_at=datetime(2026, 11, 5, 8, 0, 0),
        category="admin",
        action="admin.sso.updated",
        outcome="success",
        actor_user_id=1,
        actor_email="a@x",
        actor_name="Ada",
        subject_email=None,
        target_type="sso_config",
        target_id="1",
        target_label="Microsoft Entra",
        project_id=None,
        ip="10.0.0.1",
        user_agent="UA",
        origin="web",
        # A row written before a masking rule existed: masked again on output.
        details='{"changes":{"client_secret":{"new":"raw","old":null}}}',
    )

    payload = json.loads(log_line(entry))

    assert list(payload) == [c.name for c in AuditLog.__table__.columns]
    assert payload["id"] == 42
    assert payload["created_at"] == "2026-11-05T08:00:00"
    assert payload["details"] == {"changes": {"client_secret": {"new": MASK, "old": None}}}
    assert payload["origin"] == "web" and payload["target_label"] == "Microsoft Entra"


def test_log_line_of_a_transient_row_never_loads():
    entry = AuditLog(category="auth", action="auth.logout")

    payload = json.loads(log_line(entry))

    assert payload["id"] is None and payload["details"] is None
    assert payload["action"] == "auth.logout"


def test_the_module_names_no_local_after_a_credential():
    """CodeQL flags a logged value whose variable name says password /
    secret / token: the module keeps such words out of its identifiers."""
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(audit_log))
    names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
    names |= {node.arg for node in ast.walk(tree) if isinstance(node, ast.arg)}
    for name in names:
        assert not any(word in name.lower() for word in ("password", "secret", "token")), name
