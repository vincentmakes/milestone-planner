"""
Project-level access checks: project-manager edit rights and self-assignment.

This sits on top of the role dependencies in app/middleware/auth.py rather than
duplicating them. Superusers and admins keep their blanket write access
(unchanged, no site scoping); this adds the two narrower rules a plain `user`
gets on top of read access:

- the **project manager** (`projects.pm_id == user.id`) may edit that one
  project as if they were a superuser -- fields, phases, subphases, staff and
  equipment assignments, Kanban moves -- but may not delete it;
- anyone may create, update and delete **their own** staff assignments
  (`staff_id == user.id`) at project, phase and subphase level, and join or
  leave Kanban cards.

Routes call these *after* loading the entity, with the server-derived
`project_id` -- never one taken from the request body.

Like `card_access`, the helpers only read `user.id` and `user.role`:
`get_current_user` is annotated `-> User` but usually returns the lightweight
SessionUser, which carries no relationships.
"""

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.user import User

PRIVILEGED_ROLES = frozenset({"admin", "superuser"})

EDITOR_REQUIRED_DETAIL = "Only the project manager or a superuser can modify this project"
OWN_ASSIGNMENT_DETAIL = "You can only manage your own assignments"


def is_privileged(user: User) -> bool:
    """Whether the user holds a role with blanket write access (admin or superuser)."""
    return getattr(user, "role", None) in PRIVILEGED_ROLES


def user_can_edit(user: User, pm_id: int | None) -> bool:
    """Editor rule against an already-loaded project's `pm_id` (no query)."""
    return is_privileged(user) or (pm_id is not None and pm_id == user.id)


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


async def can_edit_project(db: AsyncSession, user: User, project_id: int) -> bool:
    """Privileged, or the project manager of `project_id`.

    Privileged callers short-circuit without touching the database; everyone
    else costs one `SELECT pm_id` (404 if the project is missing).
    """
    if is_privileged(user):
        return True
    return user_can_edit(user, await project_pm_id(db, project_id))


async def require_project_editor(db: AsyncSession, user: User, project_id: int) -> None:
    """Raise 403 unless the user may edit `project_id` (see `can_edit_project`)."""
    if not await can_edit_project(db, user, project_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=EDITOR_REQUIRED_DETAIL)


async def require_assignment_write(
    db: AsyncSession,
    user: User,
    *,
    project_id: int,
    staff_id: int,
) -> None:
    """Allow a staff-assignment write by a project editor, or by the staff member
    themself (self-assignment). Raises 403 otherwise.

    Own rows short-circuit without a query, like privileged callers -- so this
    does not prove `project_id` exists. Callers taking `project_id` from the
    URL resolve the project first and use `check_assignment_write` instead.
    """
    if staff_id == user.id:
        return
    if await can_edit_project(db, user, project_id):
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=OWN_ASSIGNMENT_DETAIL)


def check_assignment_write(user: User, *, pm_id: int | None, staff_id: int) -> None:
    """`require_assignment_write` against an already-resolved project's `pm_id`
    (no query). Raises 403 unless the row is the user's own or the user may
    edit the project.
    """
    if staff_id == user.id or user_can_edit(user, pm_id):
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=OWN_ASSIGNMENT_DETAIL)


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
