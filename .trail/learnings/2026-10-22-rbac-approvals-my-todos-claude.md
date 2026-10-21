---
title: "RBAC 1.13.0: roles as permission sets, own-booking approvals, My Todos — the decisions that hold it together"
author: Claude
date: 2026-10-22
branch: feat/rbac
cost: { minutes: 0, tokens: 0 }
touches:
  - app/services/permissions.py
  - app/middleware/auth.py
  - app/services/project_access.py
  - app/services/site_access.py
  - app/services/user_access.py
  - app/services/approvals.py
  - app/services/tenant_provisioner.py
  - app/services/tenant_data_migrations.py
  - app/models/rbac.py
  - app/models/todo.py
  - app/routers/roles.py
  - app/routers/approval_policies.py
  - app/routers/approvals.py
  - app/routers/todos.py
  - app/routers/users.py
  - migrations/add_rbac.sql
  - shared/permission-keys.json
  - frontend/src/types/permissions.ts
  - frontend/src/utils/permissions.ts
  - frontend/src/utils/pendingBookings.ts
  - frontend/src/hooks/useAllowedViews.ts
  - frontend/src/stores/todoStore.ts
  - frontend/src/components/settings/panels/RolesPanel.tsx
  - frontend/src/components/settings/panels/PermissionMatrix.tsx
  - frontend/src/components/views/TodosView/TodosView.tsx
  - frontend/src/components/gantt/utils/autoCalculation.ts
  - frontend/src/test/factories.ts
  - CLAUDE.md
  - docs/user-guide/settings.md
  - docs/user-guide/my-todos.md
---

## Decided
- **A role is a key string with a FK.** `users.role` stays a `VARCHAR` holding the role key and gains `FOREIGN KEY → roles.key ON UPDATE CASCADE ON DELETE RESTRICT` (the old CHECK is dropped). No `role_id` column: every session snapshot, SSO default role and test kept working. Keys are immutable (`^[a-z][a-z0-9_]{1,19}$`, derived from the name in the UI); a role held by users cannot be deleted (409).
- **One catalogue, 59 keys, 17 groups**, in `app/services/permissions.py` (import-light: the provisioner imports it). Modes are `allow` / `approval` / no row (deny); `approval` only on the three `assignments.self_*` keys. Locked: `projects.view` (always allow) and `roles.manage` (admin only). The admin role has no rows and holds everything in code, so nobody can lock a tenant out; role and policy writes use `require_admin`, everything else `require_permission(key)`.
- **One widener key, `sites.view_all`.** Without it every read and write is limited to the live `user_sites` (`visible_site_ids`, request-cached). Superusers lost tenant-wide project/absence access on purpose; the shipped defaults otherwise reproduce the pre-RBAC behaviour.
- **PM bundle instead of a "PM role".** `projects.manage_as_pm` grants seven keys on projects whose `pm_id` is the user (`PermissionSet.can(key, pm_id=, user_id=)`); never delete/create/import/export.
- **Editor first.** Booking someone with `assignments.manage_others` (or as the PM) never asks for approval, own bookings included; only a non-editor's own row consults the `self_*` mode (`resolve_self_booking` / `approvals.resolve_row_write`).
- **Pending creates are real rows** (`approval_status = 'pending'`, `approval_request_id`), so the Gantt, Kanban and export show them without a parallel model; every capacity/assignee consumer filters them out. **Approval todos are virtual**: `/todos/mine` merges the decidable requests (`kind: 'approval'`, id `approval:<n>`); only tasks live in `todos`.
- **The server decides the 202.** The client only relabels buttons (`needsApproval`) and recognises `{pending: true, request_id}` with `isPendingResponse()`; it never decides on its own whether a write needs approval.
- **Live per-request resolution.** `get_current_user` loads role + matrix in one join on every request (`load_live_user`), so a matrix edit applies on the next request; `change:role` refreshes `/auth/me` in open tabs. No permission data is trusted from the session snapshot.
- **Five DDL sources, one text.** Every RBAC statement is a `tenant_provisioner` constant spliced into `get_tenant_schema_sql()`, `setup_databases.sql`, `scripts/sql/tenant_schema_template.sql`, `migrations/add_rbac.sql` and the tenant auto-migration; `tests/test_rbac_schema_sources.py` asserts parity. The default rows come from one data-modifying CTE that seeds only roles created by that same statement, so an admin's edits are never re-seeded (the demo seed follows the same "first seed only" rule).
- **`users.create` alone suffices for the default role.** The escalation guard (`role_within`: every allow key must be held as allow, every approval key in either mode) runs only when a non-default role is assigned, which also needs `users.change_role`; it checks both the new and the target's current role.
- **Cascade-level fix.** A Gantt drag used to PUT phase/subphase staff rows to the project-level `/assignments/{id}` route (wrong table, same id). `PendingUpdate` now carries the assignment `level`; cascades move only project-level dated rows and never pending ones.
- **Equipment settings panels read `/equipment/all`** (`getAllEquipment()`, gated on `equipment.manage`); `GET /equipment` is the view-gated (`views.equipment`) per-site slice and must stay so.
- **Frontend tests derive permissions from the role.** `makeUser({role})` fills `permissions`, `role_name` and `can_see_all_sites` from `test/permissionFixtures.ts`; `can()` has no role fallback, so a hand-written `{id, role}` user is denied everything.
- **Key spellings are mirrored through `shared/permission-keys.json`** (generated by `permission_keys_json()`), compared by `tests/test_permissions_catalogue.py` and `frontend/src/utils/__tests__/permissions.catalogue.test.ts`.

## Tried and ruled out
- The design drafts' alternative key spellings (`config.*`, `calendar.manage`, `project.*`, `view.*`) and a `users.admin` key — superseded by the one catalogue.
- A role-name map query for `role_name`: a `column_property` subquery avoids the extra round trip and the reordering of ordered mock results.
- `archived=all` → 403 without `views.archived`: `fetchAllProjects()` asks for `all`, so it now leaves archived projects out instead.
- Approve-with-changes and extra role attributes (colour, level): left out; a rejection carries a reason instead.

## Watch out
- A new catalogue key reaches existing tenants as **deny** for the editable system roles (defaults are seeded only with the role row). Grant it with a data migration if it must default to allow, and update `permission-keys.json`, `types/permissions.ts` and `permissionFixtures.ts` together.
- Anything that sums allocations or lists assignees must skip pending rows (`isPendingAssignment` / `approval_status = 'approved'`).
- In What-If, a queued own edit whose key needs approval looks applied in the sandbox and becomes a request (202) on Apply; decisions and new tasks are disabled there.
- The screenshot shots `roles`, `approvals`, `my-todos` (signs in as Bob) and `pending` are registered in `scripts/screenshots/capture.py`; they depend on the demo's pending request, which a decision during capture would consume.
