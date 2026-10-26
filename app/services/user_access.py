"""
Account-level access rules for the users router (and skills assignment).

The route gates name the ``users.*`` keys; these helpers hold the rules that
need the target account or a role's permission set:

- **editing a user** needs ``users.edit``, or ``users.edit_admins`` when the
  target holds the admin role (``ensure_may_edit_user``; also the target rule
  of ``skills.assign``);
- **escalation guard** (always on): a caller assigns only roles whose
  permissions they hold themselves, and changes the role only of users whose
  current role they could assign; the admin role is assigned by admins only
  (``ensure_may_assign_role`` / ``ensure_may_change_role_of``);
- **last active admin**: the last active administrator cannot be demoted,
  deactivated or deleted (``ensure_not_last_active_admin``);
- **visible sites**: an account is managed (and read) only when it is the
  caller's or a member of one of the caller's visible sites
  (``site_access.ensure_person_visible``, 403 ``USER_OUTSIDE_SITES_DETAIL``
  on writes).

Like the other access services, the caller is read through ``id`` and
``permissions`` only (it is often the lightweight SessionUser).
"""

from dataclasses import replace

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.services.permissions import (
    ADMIN_ROLE_KEY,
    PermissionSet,
    load_permission_set,
    permission_required_detail,
)

ASSIGN_ADMIN_DETAIL = "Only administrators can assign the administrator role"
ROLE_ESCALATION_DETAIL = "You can only assign roles whose permissions you hold yourself"
ROLE_CHANGE_OF_STRONGER_DETAIL = (
    "You can only change the role of users whose role grants no more than yours"
)
LAST_ADMIN_DETAIL = "Cannot remove the last active administrator"
USER_OUTSIDE_SITES_DETAIL = "You can only manage users at your sites"


def edit_key_for(target_role: str | None) -> str:
    """The key that edits an account holding `target_role`."""
    return "users.edit_admins" if target_role == ADMIN_ROLE_KEY else "users.edit"


def ensure_may_edit_user(caller: User, target_role: str | None) -> None:
    """403 unless the caller may edit an account holding `target_role`."""
    key = edit_key_for(target_role)
    if not caller.permissions.has(key):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail=permission_required_detail(key)
        )


def role_within(role: PermissionSet, holder: PermissionSet) -> bool:
    """
    Whether every permission of `role` is held by `holder` at least as strongly.

    An ``allow`` in `role` needs ``allow`` in `holder`; an ``approval`` needs
    either mode. The admin role is within the admin role only. A key a
    feature switch disabled still counts as held: the escalation guard
    compares the configured matrices (otherwise nobody but an admin could
    assign a role holding ``views.kanban`` while the board is off).
    """
    if holder.is_admin:
        return True
    if role.is_admin:
        return False
    holder = replace(holder, disabled_keys=frozenset())
    for key, mode in role.effective_modes().items():
        held = holder.mode(key)
        if held is None or (mode == "allow" and held != "allow"):
            return False
    return True


async def ensure_may_assign_role(db: AsyncSession, caller: User, role_key: str) -> None:
    """
    403 unless the caller may give `role_key` to someone (escalation guard).

    Admins assign any role without a query; the admin role needs the admin
    role; any other role costs one query (its matrix) and must be within the
    caller's own permissions.
    """
    if caller.permissions.is_admin:
        return
    if role_key == ADMIN_ROLE_KEY:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=ASSIGN_ADMIN_DETAIL)
    if not role_within(await load_permission_set(db, role_key), caller.permissions):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=ROLE_ESCALATION_DETAIL)


async def ensure_may_change_role_of(db: AsyncSession, caller: User, current_role: str) -> None:
    """403 unless the caller could have assigned the target's `current_role`."""
    if caller.permissions.is_admin:
        return
    if current_role == ADMIN_ROLE_KEY or not role_within(
        await load_permission_set(db, current_role), caller.permissions
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail=ROLE_CHANGE_OF_STRONGER_DETAIL
        )


async def ensure_not_last_active_admin(db: AsyncSession, caller: User, target: User) -> None:
    """
    400 when `target` is the last active administrator (before a demotion,
    deactivation or deletion of `target`).

    No query unless the target is an active admin, and none when the caller
    is another admin (an authenticated caller is active, so one remains).
    """
    if target.role != ADMIN_ROLE_KEY or not target.active:
        return
    if caller.permissions.is_admin and caller.id != target.id:
        return
    others = (
        await db.execute(
            select(func.count())
            .select_from(User)
            .where(User.role == ADMIN_ROLE_KEY, User.active == 1, User.id != target.id)
        )
    ).scalar()
    if not others:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=LAST_ADMIN_DETAIL)
