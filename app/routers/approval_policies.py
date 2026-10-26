"""
Approval policies API: who approves a requester's own booking change.

One policy per approvable action (the ``assignments.self_*`` keys of the
catalogue): whether the project's manager approves (``pm_approves``) and
which roles' holders may approve (``role_ids``). Admins always may, whatever
the policy. Every signed-in user reads the policies; only admins change them
(``require_admin``, like the roles). Writes are coarse-broadcast as
``change:approval_policy`` by BroadcastMiddleware. Changing a policy does not
touch requests already pending.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import get_current_user, require_admin
from app.models.rbac import ApprovalPolicy, Role
from app.models.user import User
from app.schemas.role import ApprovalPolicyResponse, ApprovalPolicyUpdate
from app.services.permissions import PERMISSIONS

router = APIRouter(prefix="/approval-policies", tags=["approval policies"])

UNKNOWN_ACTION_DETAIL = "Unknown approval action"
ROLE_NOT_FOUND_DETAIL = "Role not found"

# The approvable actions in catalogue order, with their matrix labels.
_ACTION_LABELS: dict[str, str] = {p.key: p.label for p in PERMISSIONS if p.approvable}


def _policy_response(
    action: str, pm_approves: bool = True, role_ids: list[int] | None = None
) -> ApprovalPolicyResponse:
    return ApprovalPolicyResponse(
        action=action,
        label=_ACTION_LABELS[action],
        pm_approves=pm_approves,
        role_ids=sorted(role_ids or []),
    )


@router.get("", response_model=list[ApprovalPolicyResponse])
async def get_approval_policies(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    One policy per approvable action, in catalogue order (every signed-in user).

    An action without a row (never seeded) reads as the seeded default: the
    project's manager approves, no roles. Rows for actions no longer
    approvable are left out.
    """
    rows = {
        policy.action: policy
        for policy in (await db.execute(select(ApprovalPolicy))).scalars().all()
    }
    responses = []
    for action in _ACTION_LABELS:
        policy = rows.get(action)
        if policy is None:
            responses.append(_policy_response(action))
        else:
            responses.append(_policy_response(action, policy.pm_approves, policy.role_ids))
    return responses


@router.put("/{action}", response_model=ApprovalPolicyResponse)
async def update_approval_policy(
    action: str,
    data: ApprovalPolicyUpdate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Set who approves ``action`` (admin): ``pm_approves`` and ``role_ids``
    replace the stored values.

    404 for an action that is not approvable (before any query) or an unknown
    role id. Queries: the roles (when ``role_ids`` is not empty), the policy
    (created when missing).
    """
    if action not in _ACTION_LABELS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=UNKNOWN_ACTION_DETAIL)

    wanted = list(dict.fromkeys(data.role_ids))
    roles: list[Role] = []
    if wanted:
        roles = list((await db.execute(select(Role).where(Role.id.in_(wanted)))).scalars().all())
        if len(roles) != len(wanted):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ROLE_NOT_FOUND_DETAIL)

    policy = (
        await db.execute(select(ApprovalPolicy).where(ApprovalPolicy.action == action))
    ).scalar_one_or_none()
    if policy is None:
        policy = ApprovalPolicy(action=action)
        db.add(policy)
    policy.pm_approves = data.pm_approves
    policy.roles = roles

    await db.commit()
    return _policy_response(action, data.pm_approves, [role.id for role in roles])
