"""
Project-level access checks on permission keys, with the project-manager bundle.

The keys come from the catalogue (``app/services/permissions.py``); this module
turns them into per-project decisions that need the project's ``pm_id``:

- ``projects.edit_any`` edits any project (fields, phases, subphases); the
  **project manager** (``projects.pm_id == user.id``) whose role allows
  ``projects.manage_as_pm`` holds every key of ``PM_BUNDLE`` on that one
  project (edit, archive, assign others, book equipment, move cards, ...), but
  never ``projects.delete``;
- staff assignments are **editor first**: a holder of
  ``assignments.manage_others`` (outright, or through the bundle) writes
  anyone's row; anyone else writes only their own row, in the mode of the
  matching ``assignments.self_*`` key (``resolve_self_booking``). The callers
  (the eleven self-booking routes) turn an ``"approval"`` outcome into an
  approval request (app/services/approvals.py, 202).

Routes call these *after* loading the entity, with the server-derived
`project_id` -- never one taken from the request body.

Like `card_access`, the helpers only read `user.id` and `user.permissions`:
`get_current_user` is annotated `-> User` but usually returns the lightweight
SessionUser, which carries no relationships.
"""

from types import EllipsisType
from typing import Literal

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.user import User
from app.services.permissions import APPROVABLE_KEYS, permission_required_detail

EDIT_KEY = "projects.edit_any"
MANAGE_OTHERS_KEY = "assignments.manage_others"

EDITOR_REQUIRED_DETAIL = (
    "Only the project manager or a holder of projects.edit_any can modify this project"
)
OWN_ASSIGNMENT_DETAIL = "You can only manage your own assignments"
SELF_BOOKING_DENIED_DETAIL = "You are not allowed to book yourself on projects"
STAFF_NOT_FOUND_DETAIL = "Staff member not found"
NOT_BOOKABLE_DETAIL = "This person is not bookable as a resource"

BookingOutcome = Literal["allow", "approval"]
# ``pm_id=...`` (the default) means "not loaded yet": look it up when needed.
PmId = int | None | EllipsisType


def user_can(user: User, key: str, pm_id: int | None) -> bool:
    """``key`` held outright, or through the PM bundle on a project managed by `pm_id`."""
    return user.permissions.can(key, pm_id=pm_id, user_id=user.id)


def user_can_edit(user: User, pm_id: int | None) -> bool:
    """Editor rule against an already-loaded project's `pm_id` (no query)."""
    return user_can(user, EDIT_KEY, pm_id)


def check_project_editor(user: User, pm_id: int | None) -> None:
    """Raise 403 unless the user may edit a project whose manager is `pm_id`.

    For handlers that already hold the Project row -- avoids a second query.
    """
    if not user_can_edit(user, pm_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=EDITOR_REQUIRED_DETAIL)


async def project_pm_id(db: AsyncSession, project_id: int) -> int | None:
    """The project's `pm_id` (may be NULL), or 404 if the project does not exist."""
    result = await db.execute(select(Project.pm_id).where(Project.id == project_id))
    row = result.first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return row[0]


async def can_on_project(db: AsyncSession, user: User, key: str, project_id: int) -> bool:
    """``key`` on `project_id`: held outright, or through the PM bundle.

    Holders of the key short-circuit without touching the database; everyone
    else costs one `SELECT pm_id` (404 if the project is missing).
    """
    if user.permissions.has(key):
        return True
    return user_can(user, key, await project_pm_id(db, project_id))


async def require_on_project(db: AsyncSession, user: User, key: str, project_id: int) -> None:
    """Raise 403 unless the user holds ``key`` on `project_id` (see `can_on_project`).

    The detail is ``EDITOR_REQUIRED_DETAIL`` for ``projects.edit_any``, else
    ``Permission required: <key>``.
    """
    if not await can_on_project(db, user, key, project_id):
        detail = EDITOR_REQUIRED_DETAIL if key == EDIT_KEY else permission_required_detail(key)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


async def can_edit_project(db: AsyncSession, user: User, project_id: int) -> bool:
    """``projects.edit_any``, or the project manager of `project_id`."""
    return await can_on_project(db, user, EDIT_KEY, project_id)


async def require_project_editor(db: AsyncSession, user: User, project_id: int) -> None:
    """Raise 403 unless the user may edit `project_id` (see `can_edit_project`)."""
    await require_on_project(db, user, EDIT_KEY, project_id)


async def resolve_self_booking(
    db: AsyncSession,
    user: User,
    *,
    project_id: int,
    pm_id: PmId = ...,
    staff_id: int,
    action: str,
) -> BookingOutcome:
    """
    Decide a staff-assignment write, editor first.

    - A holder of ``assignments.manage_others`` on the project (outright or
      through the PM bundle) writes any row, their own included: ``"allow"``.
    - Someone else's row without it: 403 ``OWN_ASSIGNMENT_DETAIL``.
    - The user's own row: the mode of ``action`` (an ``assignments.self_*``
      key) -- ``"allow"``, ``"approval"``, or 403 ``SELF_BOOKING_DENIED_DETAIL``.

    `pm_id` is the project's manager when the caller already loaded it;
    otherwise it is read only when the outcome depends on it (an own row in
    allow mode never queries, so this does not prove `project_id` exists).
    """
    if action not in APPROVABLE_KEYS:
        raise ValueError(f"Not a self-booking permission: {action}")

    permissions = user.permissions
    if permissions.has(MANAGE_OTHERS_KEY):
        return "allow"

    mode = permissions.mode(action) if staff_id == user.id else None
    if mode == "allow":
        # Allowed either way: whether the user is an editor does not matter.
        return "allow"

    resolved = await project_pm_id(db, project_id) if isinstance(pm_id, EllipsisType) else pm_id
    if user_can(user, MANAGE_OTHERS_KEY, resolved):
        return "allow"
    if staff_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=OWN_ASSIGNMENT_DETAIL)
    if mode == "approval":
        return "approval"
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=SELF_BOOKING_DENIED_DETAIL)


async def require_bookable_staff(db: AsyncSession, staff_id: int) -> None:
    """
    The person a new booking is for must exist (404, instead of an FK error)
    and be bookable as a resource (``users.is_resource``, 400).

    Only new bookings check it: existing rows of someone no longer bookable
    stay editable and removable. Callers run it before filing an approval
    request, so a non-bookable person never files one.
    """
    is_resource = (
        await db.execute(select(User.is_resource).where(User.id == staff_id))
    ).scalar_one_or_none()
    if is_resource is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=STAFF_NOT_FOUND_DETAIL)
    if not is_resource:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=NOT_BOOKABLE_DETAIL)


async def project_id_for_phase(db: AsyncSession, phase_id: int) -> int:
    """Resolve a phase's project id server-side, or 404."""
    result = await db.execute(select(ProjectPhase.project_id).where(ProjectPhase.id == phase_id))
    row = result.first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Phase not found")
    return row[0]


async def project_id_for_subphase(db: AsyncSession, subphase_id: int) -> int:
    """Resolve a subphase's project id server-side, or 404."""
    result = await db.execute(
        select(ProjectSubphase.project_id).where(ProjectSubphase.id == subphase_id)
    )
    row = result.first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subphase not found")
    return row[0]
