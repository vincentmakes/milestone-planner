---
title: "My Work replaces My Todos (personal tasks removed); booking dialogs carry the card's comment thread or a project thread; one lock rule; overview defaults seed the Gantt panels only"
author: Claude
date: 2026-10-23
branch: feat/project-fields
cost: { minutes: 0, tokens: 0 }
touches:
  - app/routers/kanban.py
  - app/models/card_comment.py
  - app/services/tenant_provisioner.py
  - app/services/tenant_manager.py
  - migrations/add_project_comments.sql
  - frontend/src/components/views/WorkView/WorkView.tsx
  - frontend/src/stores/workStore.ts
  - frontend/src/utils/myAssignments.ts
  - frontend/src/utils/pendingBookings.ts
  - frontend/src/components/common/CardComments/CardComments.tsx
  - frontend/src/api/endpoints/mentionableCache.ts
  - frontend/src/components/modals/AssignmentModal.tsx
  - frontend/src/components/views/StaffView/StaffView.tsx
  - frontend/src/components/views/EquipmentView/EquipmentView.tsx
---

## Decided
- **Personal tasks are gone** (never shipped to `main`): the `todos` table, `/api/todos`, the task dialog, `todos.manage_own` / `todos.assign_others` (58 keys, PM bundle 6) and the `todo_assigned` notification. The unshipped `add_rbac.sql` / `add_change_notifications.sql` were edited in place; no new migration drops anything.
- **My Work** (`WorkView`, `workStore`): My Approvals (to decide), My Assignments (opens first), My Requests. The sidebar badge counts the approvals only. `currentView` `'todos'` → `'work'` through `migrateViewState` (persist version 2).
- **My Assignments is derived client-side** (`collectMyAssignments(appStore.projects, userId, today)`): approved rows at every level, archived projects out, `upcoming` = end ≥ today (local). `appStore.projects` already holds every visible site's projects.
- **Comment threads**: a phase/subphase booking's dialog shows the card's thread (the same rows as the Kanban card dialog); a project-level booking gets a project thread (`entity_type = 'project'`, `entity_id` = project id; the CHECK gains `project` via `PROJECT_COMMENTS_CHECK_SQL` in every schema source + auto-migration with rollback). `CardComments` is shared by both dialogs.
- **Read gates relaxed**: GET thread and `mentionable-users` need project / site visibility only; writes keep `kanban.comment` / `kanban.moderate_comments`; the comment counts keep `views.kanban`.
- **One lock rule**: `assignmentLock(row, user, project)` → `request-open` / `pending-other` / `no-right` / `null`, used by the Gantt context menu's Edit and by `AssignmentModal`, which opens read-only with a `Notice` while the comments stay usable.
- The `staff_panel_default_skills` / `equipment_panel_default_types` settings seed only the `embedded` Staff / Equipment views (the panels below the Gantt); the standalone views open unfiltered.

## Tried and ruled out
- A new "my bookings" list endpoint: the client already holds every booking with `approval_status`, `approval` and `linked`.
- One thread per booking row: a card's bookings would each hide the others' discussion; the card thread is what people already use on the board.
- A frontend mirror of the comment-target rule: the server derives the target and the notified people, the client only passes `(entity_type, id)`.

## Watch out
- **The Comment button must sit outside the booking `<form>`**: the shared `Button` has no default `type`, so inside the form a Comment click submits and closes the dialog. `CardComments` renders after the form and every button in it is `type="button"`; a test asserts no submit.
- **`NOTIFICATION_TYPES` marker rule**: the widening DO block is gated on the *last* entry. Removing a middle type (`todo_assigned`) keeps the marker, so already-upgraded tenants stay on the wider CHECK — harmless, never "fix" it by changing the last entry.
- The mention list is cached per site at module level (`mentionableCache.ts`, import-free, the loader passed in) because the booking dialog unmounts; cleared by `resetAllStores` and WS batches holding `staff` / `roles`.
- A project thread is read only from the dialog of a project-level booking: someone mentioned there without such a booking gets the notification (it opens the Gantt on the project) but cannot read the thread.
- `AnchoredPanel` is never used inside a `Modal` (the dialog's Tab trap pulls focus out of the portal) — the mention picker inside the booking dialog stays an in-place `MentionTextarea` list.
