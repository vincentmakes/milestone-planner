"""
Where the audit log is written (Task 4): the auth events, the diff-carrying
admin writes, the exports and the two derived tiers.

Every test reads the rows the autouse ``audit_calls`` fixture (conftest)
captured instead of writing them: ``("record", kwargs)`` for the routes'
explicit rows, ``("record_detached", kwargs)`` for the derived tiers. The
commit-before-raise rule is checked by recording, at each commit, how many
rows had been recorded by then: a failure path must commit *after* its row
and before it raises or redirects (``get_db`` rolls back on a raise; the
organization-SSO session never commits by itself).
"""

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi import HTTPException

from app.models.settings import Settings as SettingRow
from app.models.settings import SSOConfig
from app.services import audit_log
from app.services.encryption import hash_user_password
from app.services.login_throttle import reset_login_throttle
from app.services.session import SessionService
from app.services.sso import SSOService
from tests.conftest import FakeUser
from tests.support import scalar_result
from tests.test_auth_routes_more import orm_user
from tests.test_sso_callback import ORG_CONFIG, browser_state
from tests.test_users_routes import make_user, route_db

# The real record_detached, captured before the autouse stub replaces it.
REAL_RECORD_DETACHED = audit_log.record_detached


@pytest.fixture(autouse=True)
def fresh_throttle():
    reset_login_throttle()
    yield
    reset_login_throttle()


def rows(calls, name="record"):
    return [kwargs for kind, kwargs in calls if kind == name]


def commits_after_rows(db, calls) -> list[int]:
    """Make ``db.commit`` note how many rows had been recorded at each commit."""
    seen: list[int] = []

    async def commit():
        seen.append(len(calls))

    db.commit = AsyncMock(side_effect=commit)
    return seen


# ---------------------------------------------------------------------------
# Derived tier 2a: broadcast_change
# ---------------------------------------------------------------------------


async def test_broadcast_change_records_a_change_row(audit_calls):
    from app.websocket.broadcast import broadcast_change

    request = MagicMock()
    request.state = SimpleNamespace(tenant_slug="acme")
    actor = FakeUser(3)
    with patch("app.websocket.broadcast.manager.broadcast_change", AsyncMock()):
        await broadcast_change(
            request=request,
            user=actor,
            entity_type="project",
            entity_id=12,
            project_id=12,
            action="create",
            summary="created Apollo",
        )
        await broadcast_change(request, actor, "staff_assignment", 9, 0, "delete")

    first, second = rows(audit_calls, "record_detached")
    assert first == {
        "action": "project.created",
        "category": "change",
        "actor": actor,
        "target": ("project", 12, "created Apollo"),
        "project_id": 12,
    }
    assert second["action"] == "staff_assignment.deleted"
    assert second["project_id"] is None  # 0 = no project


async def test_broadcast_change_without_audit_records_nothing(audit_calls):
    from app.websocket.broadcast import broadcast_change

    with patch("app.websocket.broadcast.manager.broadcast_change", AsyncMock()):
        await broadcast_change(MagicMock(), FakeUser(3), "project", 0, audit=False)

    assert audit_calls == []


async def test_record_detached_commits_on_its_own_session(audit_calls):
    session = MagicMock()
    session.commit = AsyncMock()

    @asynccontextmanager
    async def factory():
        yield session

    request = MagicMock()
    with patch("app.database.resolve_tenant_session_factory", return_value=factory):
        await REAL_RECORD_DETACHED(request, action="project.created", category="change")

    # record (the stub) ran on the detached session, then it was committed.
    assert rows(audit_calls) == [{"action": "project.created", "category": "change", **_DEFAULTS}]
    session.commit.assert_awaited_once()


_DEFAULTS = {
    "outcome": "success",
    "actor": None,
    "subject_email": None,
    "target": None,
    "project_id": None,
    "reason": None,
    "changes": None,
    "items": None,
    "context": None,
}


@pytest.mark.parametrize(
    "failure",
    [
        HTTPException(status_code=503, detail="Organization database is unavailable."),
        RuntimeError("connection refused"),
    ],
    ids=["no-pool", "error"],
)
async def test_record_detached_never_raises(caplog, failure):
    with patch("app.database.resolve_tenant_session_factory", side_effect=failure):
        await REAL_RECORD_DETACHED(MagicMock(), action="project.created", category="change")

    assert "Audit row project.created could not be written" in caplog.text


async def test_record_detached_outside_a_request_uses_the_default_database(audit_calls):
    session = MagicMock()
    session.commit = AsyncMock()

    @asynccontextmanager
    async def factory():
        yield session

    with patch("app.database.get_session_factory", return_value=factory):
        await REAL_RECORD_DETACHED(None, action="project.updated", category="change")

    session.commit.assert_awaited_once()
