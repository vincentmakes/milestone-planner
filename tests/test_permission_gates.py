"""
The permission gate of every re-gated tenant router, one representative route
per router file (RBAC Task 3).

For each route: a role holding the shipped superuser defaults *minus* the key
gets 403 ``Permission required: <key>``, and a custom role holding *only*
that key gets through the gate (the handler then answers from an empty
database, usually 404). The in-handler rules (archive, absences, Kanban
moves and comments, custom-column values, user accounts, skills, SSO default
role) have their own files.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.permissions import default_modes
from tests.conftest import FakeUser


def empty_result() -> MagicMock:
    """A result for "nothing there": no rows, except a ``(8,)`` first row (pm_id 8)."""
    result = MagicMock()
    result.first.return_value = (8,)
    result.scalar_one_or_none.return_value = None
    result.unique.return_value.scalar_one_or_none.return_value = None
    result.scalars.return_value.all.return_value = []
    result.scalars.return_value.unique.return_value.all.return_value = []
    result.scalar.return_value = 0
    result.all.return_value = []
    result.rowcount = 0
    return result


def without(key: str) -> FakeUser:
    """The superuser defaults with ``key`` removed, as a custom role."""
    modes = {k: v for k, v in default_modes("superuser").items() if k != key}
    return FakeUser(3, "custom", modes)


def only(key: str) -> FakeUser:
    return FakeUser(3, "custom", {key})


# (router file, method, path, key, json body)
GATES = [
    (
        "projects",
        "POST",
        "/api/projects",
        "projects.create",
        {"name": "P", "site_id": 1, "start_date": "2025-01-01", "end_date": "2025-02-01"},
    ),
    ("projects", "DELETE", "/api/projects/1", "projects.delete", None),
    (
        "assignments",
        "POST",
        "/api/projects/1/equipment",
        "equipment_bookings.manage",
        {"equipment_id": 4, "start_date": "2026-01-01", "end_date": "2026-01-02"},
    ),
    ("equipment", "GET", "/api/equipment/all", "equipment.manage", None),
    ("equipment", "DELETE", "/api/equipment-types/Reactor", "equipment_types.manage", None),
    ("equipment", "DELETE", "/api/equipment-blocks/1", "equipment_blocks.manage", None),
    ("export", "GET", "/api/export/csv/1", "projects.export", None),
    ("export", "GET", "/api/export/site/1/excel", "sites.export", None),
    ("mpp_import", "GET", "/api/import/test", "projects.import", None),
    ("notes", "DELETE", "/api/notes/1", "staff_notes.manage", None),
    ("predefined_phases", "DELETE", "/api/predefined-phases/1", "predefined_phases.manage", None),
    ("skills", "DELETE", "/api/skills/1", "skills.manage", None),
    ("skills", "DELETE", "/api/skills/user/7/1", "skills.assign", None),
    ("teams", "DELETE", "/api/teams/1", "teams.manage", None),
    ("sites", "DELETE", "/api/sites/1", "sites.manage", None),
    ("sites", "DELETE", "/api/sites/1/holidays/1", "bank_holidays.manage", None),
    ("sites", "DELETE", "/api/events/1", "company_events.manage", None),
    ("kanban", "POST", "/api/kanban/cards/phase/1/comments", "kanban.comment", {"body": "hi"}),
    ("custom_columns", "DELETE", "/api/custom-columns/1", "custom_columns.manage", None),
    ("absence_types", "DELETE", "/api/absence-types/1", "absence_types.manage", None),
    ("tags", "DELETE", "/api/tags/1", "tags.manage", None),
    ("project_fields", "DELETE", "/api/project-fields/1", "project_fields.manage", None),
    ("settings", "PUT", "/api/settings/instance_title", "settings.general", {"value": "X"}),
    ("settings", "PUT", "/api/settings/sso", "settings.sso", {"default_role": "user"}),
    ("auth", "GET", "/api/sso/config/full", "settings.sso", None),
    ("health", "GET", "/api/ws-debug", "system.ws_debug", None),
    ("users", "GET", "/api/users", "users.view", None),
    ("users", "DELETE", "/api/users/7", "users.delete", None),
    ("users", "PUT", "/api/users/7/toggle-active", "users.toggle_active", None),
]


@pytest.fixture
def empty_db(mock_db_session):
    mock_db_session.execute = AsyncMock(side_effect=lambda *a, **k: empty_result())
    mock_db_session.get = AsyncMock(return_value=None)
    return mock_db_session


@pytest.fixture
def no_org_sso():
    with (
        patch("app.routers.settings._active_org_sso", AsyncMock(return_value=None)),
        patch("app.routers.auth._active_org_sso", AsyncMock(return_value=None)),
    ):
        yield


def _ids(gate):
    return f"{gate[0]}:{gate[1]} {gate[2]}"


@pytest.mark.asyncio
@pytest.mark.parametrize("gate", GATES, ids=[_ids(g) for g in GATES])
async def test_a_role_without_the_key_is_refused(authed_client, empty_db, no_org_sso, gate):
    _, method, path, key, body = gate
    client, set_user = authed_client
    set_user(without(key))

    response = await client.request(method, path, json=body)

    assert response.status_code == 403
    assert key in response.json()["detail"]
    empty_db.commit.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("gate", GATES, ids=[_ids(g) for g in GATES])
async def test_a_custom_role_with_only_the_key_gets_through(
    authed_client, empty_db, no_org_sso, gate
):
    _, method, path, key, body = gate
    client, set_user = authed_client
    set_user(only(key))

    response = await client.request(method, path, json=body)

    # Past the gate: the handler answers (an empty database: mostly 404),
    # never a validation error of a body the test got wrong.
    assert response.status_code not in (403, 422), response.text
