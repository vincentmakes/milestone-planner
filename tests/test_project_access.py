"""
Tests for the project-level access rules (app/services/project_access.py).

Permission keys decide: ``projects.edit_any`` edits any project, and the PM
bundle (``projects.manage_as_pm`` + ``pm_id == me``) lends the bundle keys on
the projects a user manages. Staff assignments are editor-first: a holder of
``assignments.manage_others`` (outright or through the bundle) writes any row;
anyone else writes only their own row, in the mode of the ``assignments.self_*``
key (allow, approval, or 403). A missing project is a 404, not a silent deny.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.services.project_access import (
    EDITOR_REQUIRED_DETAIL,
    OWN_ASSIGNMENT_DETAIL,
    SELF_BOOKING_DENIED_DETAIL,
    can_edit_project,
    can_on_project,
    check_project_editor,
    project_id_for_phase,
    project_id_for_subphase,
    project_pm_id,
    require_on_project,
    require_project_editor,
    resolve_self_booking,
    user_can,
    user_can_edit,
)
from tests.conftest import FakeUser


def _db_returning(row):
    """Mock session whose execute().first() yields `row`."""
    db = AsyncMock()
    result = MagicMock()
    result.first.return_value = row
    db.execute.return_value = result
    return db


def _user(user_id: int, role: str = "user", permissions=None):
    return FakeUser(user_id, role, permissions)


CREATE = "assignments.self_create"
UPDATE = "assignments.self_update"
REMOVE = "assignments.self_remove"


# ---------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------


@pytest.mark.parametrize(
    ("role", "expected"),
    [("admin", True), ("superuser", True), ("user", False), ("custom", False)],
)
def test_edit_any_follows_the_role_defaults(role, expected):
    assert user_can_edit(_user(1, role), pm_id=None) is expected


def test_user_can_edit_covers_editor_pm_and_outsider():
    assert user_can_edit(_user(1, "superuser"), pm_id=None) is True
    assert user_can_edit(_user(7, "user"), pm_id=7) is True
    assert user_can_edit(_user(7, "user"), pm_id=8) is False
    # A project without a manager has no PM to match -- plain users stay out.
    assert user_can_edit(_user(7, "user"), pm_id=None) is False


def test_the_pm_bundle_needs_manage_as_pm():
    # Without projects.manage_as_pm, managing the project lends nothing.
    assert user_can_edit(_user(7, "custom", set()), pm_id=7) is False
    # A custom role holding edit_any edits any project.
    assert user_can_edit(_user(7, "custom", {"projects.edit_any"}), pm_id=8) is True


def test_user_can_only_lends_bundle_keys():
    pm = _user(7, "user")
    assert user_can(pm, "equipment_bookings.manage", 7) is True
    assert user_can(pm, "projects.delete", 7) is False


def test_check_project_editor_raises_403_for_outsider():
    with pytest.raises(HTTPException) as exc:
        check_project_editor(_user(7, "user"), pm_id=8)
    assert exc.value.status_code == 403
    assert exc.value.detail == EDITOR_REQUIRED_DETAIL


def test_check_project_editor_passes_for_pm():
    check_project_editor(_user(7, "user"), pm_id=7)


# ---------------------------------------------------------
# project_pm_id
# ---------------------------------------------------------


async def test_project_pm_id_returns_pm():
    db = _db_returning((42,))
    assert await project_pm_id(db, 1) == 42


async def test_project_pm_id_distinguishes_null_pm_from_missing_project():
    # A project with no manager yields None ...
    assert await project_pm_id(_db_returning((None,)), 1) is None
    # ... a missing project is a 404.
    with pytest.raises(HTTPException) as exc:
        await project_pm_id(_db_returning(None), 1)
    assert exc.value.status_code == 404


# ---------------------------------------------------------
# can_edit_project / require_project_editor / require_on_project
# ---------------------------------------------------------


async def test_editor_passes_without_querying():
    db = _db_returning(None)
    assert await can_edit_project(db, _user(99, "superuser"), 1) is True
    await require_project_editor(db, _user(99, "admin"), 1)
    await require_project_editor(db, _user(99, "custom", {"projects.edit_any"}), 1)
    # Key holders must short-circuit before touching the database.
    db.execute.assert_not_called()


async def test_pm_may_edit_their_project():
    db = _db_returning((7,))
    assert await can_edit_project(db, _user(7), 1) is True
    await require_project_editor(db, _user(7), 1)
    db.execute.assert_awaited()


async def test_other_user_is_rejected():
    db = _db_returning((8,))
    assert await can_edit_project(db, _user(7), 1) is False
    with pytest.raises(HTTPException) as exc:
        await require_project_editor(db, _user(7), 1)
    assert exc.value.status_code == 403
    assert exc.value.detail == EDITOR_REQUIRED_DETAIL


async def test_require_project_editor_404s_on_missing_project_for_plain_user():
    with pytest.raises(HTTPException) as exc:
        await require_project_editor(_db_returning(None), _user(7), 1)
    assert exc.value.status_code == 404


async def test_can_on_project_checks_the_named_key():
    # A superuser stripped of equipment bookings cannot book, even as editor.
    user = _user(7, "custom", {"projects.edit_any"})
    assert await can_on_project(_db_returning((8,)), user, "equipment_bookings.manage", 1) is False
    with pytest.raises(HTTPException) as exc:
        await require_on_project(_db_returning((8,)), user, "equipment_bookings.manage", 1)
    assert exc.value.status_code == 403
    # The PM of the project gets it through the bundle.
    assert await can_on_project(_db_returning((7,)), _user(7), "equipment_bookings.manage", 1)


# ---------------------------------------------------------
# resolve_self_booking: the mode matrix
# ---------------------------------------------------------


async def test_manage_others_holder_books_anyone_without_querying():
    db = _db_returning(None)
    for staff_id in (5, 9):
        outcome = await resolve_self_booking(
            db, _user(5, "superuser"), project_id=1, staff_id=staff_id, action=CREATE
        )
        assert outcome == "allow"
    db.execute.assert_not_called()


async def test_pm_books_anyone_on_their_project():
    db = _db_returning((5,))
    outcome = await resolve_self_booking(db, _user(5), project_id=1, staff_id=9, action=CREATE)
    assert outcome == "allow"


async def test_others_rows_without_editor_rights_are_403():
    with pytest.raises(HTTPException) as exc:
        await resolve_self_booking(
            _db_returning((8,)), _user(5), project_id=1, staff_id=9, action=UPDATE
        )
    assert exc.value.status_code == 403
    assert exc.value.detail == OWN_ASSIGNMENT_DETAIL


async def test_others_rows_on_a_missing_project_are_404():
    with pytest.raises(HTTPException) as exc:
        await resolve_self_booking(
            _db_returning(None), _user(5), project_id=1, staff_id=9, action=CREATE
        )
    assert exc.value.status_code == 404


@pytest.mark.parametrize("action", [CREATE, UPDATE, REMOVE])
async def test_own_row_in_allow_mode_passes_without_querying(action):
    db = _db_returning(None)
    outcome = await resolve_self_booking(db, _user(5), project_id=1, staff_id=5, action=action)
    assert outcome == "allow"
    db.execute.assert_not_called()


@pytest.mark.parametrize("action", [CREATE, UPDATE, REMOVE])
async def test_own_row_in_approval_mode_needs_approval(action):
    user = _user(5, "custom", {action: "approval", "projects.manage_as_pm": "allow"})
    outcome = await resolve_self_booking(
        _db_returning((8,)), user, project_id=1, staff_id=5, action=action
    )
    assert outcome == "approval"


async def test_editor_first_the_pm_never_needs_approval_on_their_project():
    user = _user(5, "custom", {CREATE: "approval", "projects.manage_as_pm": "allow"})
    outcome = await resolve_self_booking(
        _db_returning((5,)), user, project_id=1, staff_id=5, action=CREATE
    )
    assert outcome == "allow"


async def test_a_known_pm_id_spares_the_query():
    user = _user(5, "custom", {CREATE: "approval", "projects.manage_as_pm": "allow"})
    db = _db_returning(None)
    outcome = await resolve_self_booking(db, user, project_id=1, pm_id=5, staff_id=5, action=CREATE)
    assert outcome == "allow"
    db.execute.assert_not_called()


@pytest.mark.parametrize("action", [CREATE, UPDATE, REMOVE])
async def test_own_row_with_the_self_key_denied_is_403(action):
    user = _user(5, "custom", {"projects.manage_as_pm"})
    with pytest.raises(HTTPException) as exc:
        await resolve_self_booking(
            _db_returning((8,)), user, project_id=1, staff_id=5, action=action
        )
    assert exc.value.status_code == 403
    assert exc.value.detail == SELF_BOOKING_DENIED_DETAIL


async def test_resolve_rejects_a_non_booking_action():
    with pytest.raises(ValueError):
        await resolve_self_booking(
            _db_returning(None), _user(5), project_id=1, staff_id=5, action="projects.edit_any"
        )


# ---------------------------------------------------------
# Resolvers
# ---------------------------------------------------------


async def test_project_id_for_phase_and_subphase():
    assert await project_id_for_phase(_db_returning((3,)), 1) == 3
    assert await project_id_for_subphase(_db_returning((4,)), 1) == 4


@pytest.mark.parametrize("resolver", [project_id_for_phase, project_id_for_subphase])
async def test_resolvers_404_when_missing(resolver):
    with pytest.raises(HTTPException) as exc:
        await resolver(_db_returning(None), 1)
    assert exc.value.status_code == 404
