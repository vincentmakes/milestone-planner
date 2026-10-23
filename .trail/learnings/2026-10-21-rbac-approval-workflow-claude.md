---
title: "RBAC approvals: eleven self-booking routes through one service, 202 contract, live approvers, expiry hooks"
author: Claude
date: 2026-10-21
branch: feat/rbac
cost: { minutes: 0, tokens: 0 }
touches:
  - app/services/approvals.py
  - app/routers/approvals.py
  - app/routers/assignments.py
  - app/routers/kanban.py
  - app/routers/projects.py
  - app/routers/export.py
  - app/services/notifications.py
  - app/websocket/broadcast.py
  - tests/test_approvals_service.py
  - tests/test_approvals_routes.py
  - tests/test_project_access_routes.py
---

## Decided
- One path: creates call `resolve_self_booking`, row writes `approvals.resolve_row_write` (pending create → its requester amends/cancels it through the request; anyone else 403 without rights, else 409); `"approval"` → `approvals.submit_request`, which commits, publishes and returns the 202 JSONResponse itself. Direct writes call `expire_overtaken` before the write and `publish` after the commit; phase/subphase/project deletes call `cancel_for_entity` right after collecting the subtree (before any ORM delete: autoflush would cascade the requests away).
- The requester's own direct write (allow mode, or an editor on their own row) closes their open request `cancelled`, not `expired(overtaken)`; an update back to the current values withdraws the open request (200, no new request); DELETE of one's own pending create = cancel (200 `{cancelled: true}`).
- Approvers are never stored: `approver_user_ids` is one SQL query (admins ∪ PM if `pm_approves` ∪ policy roles, the last two only when they see the site via `user_sites` or a `sites.view_all` role; requester excluded). `can_decide` is the pure per-row check; the caller's site visibility is checked separately.
- Invalid stored values on approve (cannot happen through the API) answer 409 and leave the request pending (no close reason fits); every other re-validation failure closes `expired(<reason>)` with a 409 `{detail, status, close_reason}`.
- Closing any request marks the approvers' unread `approval_requested` rows for it read (one UPDATE).

## Tried and ruled out
- Sequence-mocked service tests: the approve path is ~9 queries. `tests/test_approvals_service.py` uses a `FakeDB` that answers each SELECT by what it selects (entity + first column name, `with_for_update` tells the locked row from the duplicate check), so the tests pin the state machine, not the query order.

## Open
- Not implemented (not in the brief): a fresh `approval_requested` to a new PM on a `pm_id` change or to new approvers on a policy edit (edge cases #2/#10); "Apply now" (#3, frontend).
