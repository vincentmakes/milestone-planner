"""
Approval requests API: own bookings awaiting a decision.

Requests are filed by the self-booking routes themselves (assignments.py and
the Kanban join / leave answer 202 when the caller's ``assignments.self_*``
key is in approval mode); this router lists and decides them. Every rule lives
in app/services/approvals.py:

- ``GET /approval-requests?scope=mine|to_decide|all&status=`` -- the caller's
  requests, the pending ones they may decide, or every request at their
  visible sites (``approvals.view_all``);
- ``GET /approval-requests/{id}`` -- the requester, an eligible approver or a
  holder of ``approvals.view_all`` (404 otherwise);
- ``POST /approval-requests/{id}/approve|reject`` -- an eligible approver
  (admins always, the PM when the policy says so, holders of the policy's
  roles), never the requester; ``POST .../cancel`` -- the requester or an
  admin. Body ``{note?}``. A request no longer pending is a 409
  ``{detail: "Request already <status>", status}``; an approval that can no
  longer be applied closes the request ``expired`` and answers 409
  ``{detail, status: "expired", close_reason}``.

Every transition broadcasts ``change:approval_request`` richly (the path is
in ``BroadcastMiddleware.SKIP_PATTERNS``) and pushes ``approval:changed`` to
the requester and the approvers.
"""

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, get_db_readonly
from app.middleware.auth import get_current_user
from app.models.user import User
from app.schemas.approval import (
    ApprovalDecision,
    ApprovalDecisionResponse,
    ApprovalRequestResponse,
    ApprovalScope,
    ApprovalStatus,
)
from app.services import approvals, change_notifications
from app.services.site_access import visible_site_ids

router = APIRouter(prefix="/approval-requests", tags=["approval requests"])


@router.get("", response_model=list[ApprovalRequestResponse])
async def list_approval_requests(
    request: Request,
    scope: ApprovalScope = "mine",
    status: ApprovalStatus | None = None,
    limit: int = Query(200, ge=1, le=500),
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(get_current_user),
):
    """List requests by scope (newest first); ``all`` needs ``approvals.view_all``."""
    return await approvals.list_requests(
        db, request, user, scope=scope, status_filter=status, limit=limit
    )


@router.get("/{request_id}", response_model=ApprovalRequestResponse)
async def get_approval_request(
    request_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(get_current_user),
):
    """One request (404 unless the caller may see it)."""
    return await approvals.get_request(db, request, user, request_id)


async def _finish(
    db: AsyncSession, request: Request, user: User, result: approvals.DecisionResult
) -> JSONResponse | dict:
    await approvals.publish(request, user, result.effects)
    # An approval applied: the project's manager (the requester already has
    # approval_decided). Reject, cancel and an expiry carry no change intents.
    await change_notifications.deliver(
        db,
        request,
        user.id,
        result.effects.change_intents,
        already_notified={result.request.requester_id},
    )
    if result.conflict is not None:
        return JSONResponse(status_code=409, content=result.conflict)
    return {"success": True, "id": result.request.id, "status": result.request.status}


def _note(data: ApprovalDecision | None) -> str | None:
    return data.note if data is not None else None


@router.post("/{request_id}/approve", response_model=ApprovalDecisionResponse)
async def approve_request(
    request_id: int,
    request: Request,
    data: ApprovalDecision | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Approve and apply the booking change (eligible approvers only)."""
    visible = await visible_site_ids(request, db, user)
    try:
        result = await approvals.approve(db, user, request_id, note=_note(data), visible=visible)
    except approvals.RequestClosedError as closed:
        return JSONResponse(status_code=409, content=closed.body)
    return await _finish(db, request, user, result)


@router.post("/{request_id}/reject", response_model=ApprovalDecisionResponse)
async def reject_request(
    request_id: int,
    request: Request,
    data: ApprovalDecision | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Reject: a pending booking is removed, a pending change or removal dropped."""
    visible = await visible_site_ids(request, db, user)
    try:
        result = await approvals.reject(db, user, request_id, note=_note(data), visible=visible)
    except approvals.RequestClosedError as closed:
        return JSONResponse(status_code=409, content=closed.body)
    return await _finish(db, request, user, result)


@router.post("/{request_id}/cancel", response_model=ApprovalDecisionResponse)
async def cancel_request(
    request_id: int,
    request: Request,
    data: ApprovalDecision | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Withdraw a request (its requester, or an admin)."""
    try:
        result = await approvals.cancel(db, user, request_id, note=_note(data))
    except approvals.RequestClosedError as closed:
        return JSONResponse(status_code=409, content=closed.body)
    return await _finish(db, request, user, result)
