---
title: "RBAC todos: private rows with per-user pushes, approvals merged live, eligibility in SQL, demo pending booking"
author: Claude
date: 2026-10-21
branch: feat/rbac
cost: { minutes: 0, tokens: 0 }
touches:
  - app/routers/todos.py
  - app/schemas/todo.py
  - app/services/approvals.py
  - app/routers/users.py
  - app/services/tenant_data_migrations.py
  - app/scripts/demo_data.py
  - app/services/demo_seed.py
  - tests/test_todos_routes.py
  - tests/test_approvals_followups.py
---

## Decided
- Todos are private like notifications: every query carries `assignee_id = me OR created_by = me`, strangers get 404, writes are never broadcast tenant-wide (path in `SKIP_PATTERNS`); `todo:changed {id, kind, action}` goes to assignee + creator (+ the previous assignee on a reassign) via `send_user_event`, and `todo_assigned` only when the assignee is not the actor.
- Rights: own todo = `todos.manage_own`; someone else's = `todos.assign_others`, outright or the PM bundle on the todo's project (`user_can`); PUT checks the todo as it is and as it becomes; DELETE = creator (or the assignee once `created_by` is NULL). The project's `pm_id` is read only when the bundle can decide (`_pm_if_needed`).
- `GET /todos/mine` merges `approvals.decidable_todo_items` (id `approval:<n>`); sort = open first, due date (none last), oldest first.
- `to_decide` eligibility is in SQL (`approvals.decider_clause`: PM unless the action's policy has `pm_approves = false`, or the caller's role in the policy roles; admins unrestricted), so `limit` never returns a short page. The Python `can_decide` filter stays as a safety net.
- `expire_for_requester` runs from users.py on PUT `active=0`, toggle-active off and DELETE (`deleted=True`: no notification, events `delete`); publish after the commit.
- Data step cleanups after the request expiry: pending rows whose request is not pending are deleted, approved rows lose pointers to closed requests (one statement per assignment table).
- Demo: roles before users; the pending row is inserted only `WHERE EXISTS` its request is still pending, then the request's `assignment_id` is filled (`AND assignment_id IS NULL`), mirroring `submit_request`'s order. The `approval_requested` notification's entity is `("approval_request", project, target)`.

## Tried and ruled out
- Proving "a page is not cut short" with mocks: impossible. `tests/test_approvals_followups.py` runs `list_requests` against in-memory SQLite (sync Session behind a tiny async `execute` adapter; every tenant table copied into a fresh MetaData with the PostgreSQL CHECKs stripped, only the listing's tables created). Reuse that pattern when a query's semantics, not its shape, needs a test.
