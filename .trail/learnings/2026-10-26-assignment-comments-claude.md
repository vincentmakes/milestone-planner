---
title: "Optional comments on bookings and requests, a note on equipment bookings, and equipment always booked on the project"
author: Claude
date: 2026-10-26
branch: feat/teams
cost: { minutes: 0, tokens: 0 }
touches:
  - app/services/card_comments.py
  - app/services/mentions.py
  - app/services/approvals.py
  - app/services/change_notifications.py
  - app/routers/assignments.py
  - app/routers/approvals.py
  - app/routers/equipment.py
  - app/routers/kanban.py
  - app/services/tenant_provisioner.py
  - app/services/tenant_manager.py
  - migrations/add_equipment_assignment_note.sql
  - tests/support.py
  - frontend/src/hooks/useMentionCandidates.ts
  - frontend/src/components/modals/AssignmentModal.tsx
  - frontend/src/api/endpoints/projects.ts
  - frontend/src/components/gantt/Timeline/ResourceDropOverlay.tsx
  - frontend/src/components/views/WorkView/ApprovalRequestRow.tsx
---

## Decided
- **A staff create's `comment`** (the three Gantt create routes only, not the Kanban assignee POST: Join / Add have no dialog). Direct: a `CardComment` by the actor on the booking's thread (`card_comments.booking_thread`: the card's, or `('project', project_id)`) in the booking's transaction, after a `kanban.comment` 403 placed right after the 202 return and before `apply_shrink`. Approval mode: the request's `note`, no `kanban.comment` needed; the approvers' `approval_requested` body is `comment_preview(note)` (strip the tokens, then cut to 200).
- **One notification per person.** Direct: `mention` / `comment` never to the actor, the booked person or the PM; those two get the preview at the end of their `assignment_changed` / `project_changed` body (`booking_intents(note=…)`, `with_note`), and the staged recipients go to `deliver` as `already_notified`. Approve: `mention` from the requester, never to the approver, no `comment` rows; `ApprovalEffects.notified_ids` joins the requester in `_finish`'s `already_notified`, `ApprovalEffects.comments` makes `publish` broadcast `change:card_comment`.
- **The note is posted on approve only if the requester holds `kanban.comment` at that moment** (`_post_request_note` loads their permission set); otherwise it stays on the request. Change requests, reject, cancel and expiry never post it. The dialog shows the request field always, with the "added to the thread once approved" hint only for a commenter; the direct-booking comment field only with `kanban.comment`.
- **Only pure helpers moved out of the comment route** (`new_comment` with one `now`, `build_comment_notifications`, `comment_preview`); `kanban.py` still imports `card_assignee_ids` / `broadcast_change` / `send_notification` and re-exports `_validate_mention_ids`, so the comment tests' patch targets and query order are unchanged.
- **Equipment note**: `equipment_assignments.note TEXT` (≤ 2000 at the API, blank → null), its own self-gated auto-migration step; PUT uses `model_fields_set` (left out keeps it, `null` / `""` clears it); a note-only edit notifies nobody; the project tree's always-null `notes` key became `note`.
- **Equipment is always booked on the project.** `createEquipmentAssignment` takes a required `project_id` and posts only `{equipment_id, start_date, end_date, note?}` to `/api/projects/{id}/equipment`.
- The mention candidates (participants first, then the site's people, never yourself) live in `useMentionCandidates`, shared by `CardComments` and the dialog; it loads nothing for a `null` site, so the hidden field costs no request.

## Tried and ruled out
- Sending the dialog comment as a separate `POST …/comments` after the booking: a second write that can fail on its own, no atomicity with the booking, and the request path would have no thread to post to before approval.
- Extracting the whole comment-route body into a service: the existing tests patch `app.routers.kanban.card_assignee_ids` and feed `execute.side_effect` in a fixed order.

## Watch out
- **The equipment create bug**: phase and subphase rows posted to `/api/phases/{id}/equipment` / `/api/subphases/{id}/equipment`, which never existed (404). Equipment bookings have no phase / subphase column.
- **`MentionTextarea`: serialise, then trim** — `serializeMentions(draft, anchors).trim()`; trimming the draft first shifts every anchor offset. A picked mention ends with a space, so text typed after it needs no leading one.
- `ApprovalFakeDB.key` answers every `select(User.id …)` as "approvers": the mention lookup selects `User.id.label("mentioned_id")` and the note's author query starts with `User.role`, keyed `"mentioned"` / `"author"`.
- A new tenant auto-migration step changes the COMMIT counts in `tests/test_tenant_manager_more.py` (legacy and current tenants) and the README sentence `tests/test_booking_segments_schema.py` checks.
- `deliver` coalescing keeps the latest body: a burst of edits can drop the comment preview from the merged notification (the comment itself is in the thread).
