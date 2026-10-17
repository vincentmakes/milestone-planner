"""
Tests for the project-level access rules.

The rules: superusers/admins edit anything; the project manager edits their
own project; anyone manages their own staff assignments. Everyone else is
rejected, and a missing project is a 404 rather than a silent deny.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.services.project_access import (
    EDITOR_REQUIRED_DETAIL,
    OWN_ASSIGNMENT_DETAIL,
    can_edit_project,
    check_assignment_write,
    check_project_editor,
    is_privileged,
    project_id_for_phase,
    project_id_for_subphase,
    project_pm_id,
    require_assignment_write,
    require_project_editor,
    user_can_edit,
)


def _db_returning(row):
    """Mock session whose execute().first() yields `row`."""
    db = AsyncMock()
    result = MagicMock()
    result.first.return_value = row
    db.execute.return_value = result
    return db


def _user(user_id: int, role: str = "user"):
    """Shaped like SessionUser: only id and role are relied on."""
    return SimpleNamespace(id=user_id, role=role)


# ---------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------


@pytest.mark.parametrize(
    ("role", "expected"),
    [("admin", True), ("superuser", True), ("user", False), (None, False)],
)
def test_is_privileged(role, expected):
    assert is_privileged(_user(1, role)) is expected


def test_user_can_edit_covers_privileged_pm_and_outsider():
    assert user_can_edit(_user(1, "superuser"), pm_id=None) is True
    assert user_can_edit(_user(7, "user"), pm_id=7) is True
    assert user_can_edit(_user(7, "user"), pm_id=8) is False
    # A project without a manager has no PM to match -- plain users stay out.
    assert user_can_edit(_user(7, "user"), pm_id=None) is False


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


@pytest.mark.asyncio
async def test_project_pm_id_returns_pm():
    db = _db_returning((42,))
    assert await project_pm_id(db, 1) == 42


@pytest.mark.asyncio
async def test_project_pm_id_distinguishes_null_pm_from_missing_project():
    # A project with no manager yields None ...
    assert await project_pm_id(_db_returning((None,)), 1) is None
    # ... a missing project is a 404.
    with pytest.raises(HTTPException) as exc:
        await project_pm_id(_db_returning(None), 1)
    assert exc.value.status_code == 404


# ---------------------------------------------------------
# can_edit_project / require_project_editor
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_superuser_passes_without_querying():
    db = _db_returning(None)
    assert await can_edit_project(db, _user(99, "superuser"), 1) is True
    await require_project_editor(db, _user(99, "admin"), 1)
    # Privileged callers must short-circuit before touching the database.
    db.execute.assert_not_called()


@pytest.mark.asyncio
async def test_pm_may_edit_their_project():
    db = _db_returning((7,))
    assert await can_edit_project(db, _user(7), 1) is True
    await require_project_editor(db, _user(7), 1)
    db.execute.assert_awaited()


@pytest.mark.asyncio
async def test_other_user_is_rejected():
    db = _db_returning((8,))
    assert await can_edit_project(db, _user(7), 1) is False
    with pytest.raises(HTTPException) as exc:
        await require_project_editor(db, _user(7), 1)
    assert exc.value.status_code == 403
    assert exc.value.detail == EDITOR_REQUIRED_DETAIL


@pytest.mark.asyncio
async def test_require_project_editor_404s_on_missing_project_for_plain_user():
    with pytest.raises(HTTPException) as exc:
        await require_project_editor(_db_returning(None), _user(7), 1)
    assert exc.value.status_code == 404


# ---------------------------------------------------------
# require_assignment_write
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_own_assignment_passes_without_querying():
    db = _db_returning(None)
    await require_assignment_write(db, _user(5), project_id=1, staff_id=5)
    db.execute.assert_not_called()


@pytest.mark.asyncio
async def test_pm_may_manage_anyones_assignment():
    db = _db_returning((5,))
    await require_assignment_write(db, _user(5), project_id=1, staff_id=9)


@pytest.mark.asyncio
async def test_superuser_may_manage_anyones_assignment():
    db = _db_returning(None)
    await require_assignment_write(db, _user(5, "superuser"), project_id=1, staff_id=9)
    db.execute.assert_not_called()


@pytest.mark.asyncio
async def test_user_cannot_manage_someone_elses_assignment():
    db = _db_returning((8,))
    with pytest.raises(HTTPException) as exc:
        await require_assignment_write(db, _user(5), project_id=1, staff_id=9)
    assert exc.value.status_code == 403
    assert exc.value.detail == OWN_ASSIGNMENT_DETAIL


@pytest.mark.parametrize(
    ("user", "pm_id", "staff_id"),
    [
        (_user(5), None, 5),  # own row
        (_user(5), 5, 9),  # project manager
        (_user(5, "superuser"), None, 9),
        (_user(5, "admin"), 8, 9),
    ],
)
def test_check_assignment_write_allows(user, pm_id, staff_id):
    check_assignment_write(user, pm_id=pm_id, staff_id=staff_id)


@pytest.mark.parametrize("pm_id", [None, 8])
def test_check_assignment_write_rejects_outsiders(pm_id):
    with pytest.raises(HTTPException) as exc:
        check_assignment_write(_user(5), pm_id=pm_id, staff_id=9)
    assert exc.value.status_code == 403
    assert exc.value.detail == OWN_ASSIGNMENT_DETAIL


# ---------------------------------------------------------
# Resolvers
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_project_id_for_phase_and_subphase():
    assert await project_id_for_phase(_db_returning((3,)), 1) == 3
    assert await project_id_for_subphase(_db_returning((4,)), 1) == 4


@pytest.mark.asyncio
@pytest.mark.parametrize("resolver", [project_id_for_phase, project_id_for_subphase])
async def test_resolvers_404_when_missing(resolver):
    with pytest.raises(HTTPException) as exc:
        await resolver(_db_returning(None), 1)
    assert exc.value.status_code == 404
