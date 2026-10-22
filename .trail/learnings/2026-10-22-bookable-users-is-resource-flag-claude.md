---
title: "Bookable users: a per-user users.is_resource flag replaces the admins-are-never-staff role rule"
author: Claude
date: 2026-10-22
branch: feat/bookable-users
cost: { minutes: 0, tokens: 0 }
touches:
  - app/models/user.py
  - app/services/tenant_provisioner.py
  - app/services/tenant_manager.py
  - migrations/add_user_is_resource.sql
  - app/routers/users.py
  - app/routers/auth.py
  - app/routers/staff.py
  - app/routers/assignments.py
  - app/routers/kanban.py
  - app/services/project_access.py
  - app/services/approvals.py
  - app/services/response_builders.py
  - app/routers/export.py
  - frontend/src/utils/permissions.ts
  - frontend/src/api/endpoints/auth.ts
  - frontend/src/components/settings/panels/UsersPanel.tsx
  - frontend/src/components/modals/AssignmentModal.tsx
  - frontend/src/test/factories.ts
---

## Decided
- Bookability is a column, not a role rule: `users.is_resource BOOLEAN NOT NULL DEFAULT TRUE`. One constant, `tenant_provisioner.USERS_IS_RESOURCE_SQL` (a self-gating DO block, part of `USERS_UPGRADE_SQL`), is shared by `migrations/add_user_is_resource.sql` and the tenant auto-migration (its own step right after `is_system`). It back-fills admins FALSE **only when it adds the column**, so the upgrade changes nobody and a re-run never resets a later choice.
- Defaults: `POST /users` without the field → `role != 'admin'`; the provisioned admin, the demo admin and `scripts/seed_tenant_data.py`'s first admin are FALSE. Changing it is a profile edit (`users.edit`, `users.edit_admins` on an admin): no session revocation, no self / last-admin rule.
- `GET /staff` filters `User.is_resource.is_(True)` — the last role literal in a router is gone. `GET /staff/{id}` is not filtered (anyone visible).
- New bookings only: `project_access.require_bookable_staff(db, staff_id)` (404 `Staff member not found`, 400 `This person is not bookable as a resource`) runs in the three staff POSTs after `resolve_self_booking` and **before** `ensure_no_duplicate` and the 202 branch, so no approval request is ever filed for a non-bookable person; the Kanban assignee POST does the same on the `User` row it already loads. PUT/DELETE of existing rows are untouched — turning the flag off keeps the bookings.
- Approvals: `_requester_problem` expires only a **create** request whose requester is no longer bookable, with the existing `permission_lost`; update / removal requests stay approvable (the bookings are kept).
- Frontend: `isBookable(user)` (`is_resource !== false`, absent = bookable) is folded into `canBookSelf`, which hides Assign me / Join / own-card drag; `AssignmentModal`'s self-only create shows a notice instead. The Users form switch follows the role select on create until touched, and always sends the flag.

## Tried and ruled out
- A new close reason `requester_not_bookable`: `approval_requests.close_reason` is `VARCHAR(20)` with a CHECK in five DDL sources, and the name is 22 chars — the mock suite passed while a real approve would 500 at commit. Reusing `permission_lost` needs no schema change.
- Expiring update/remove requests of a non-bookable requester too: a removal request could then never be approved, although the point of the flag is to keep existing bookings manageable.

## Watch out
- `is_resource` can read `None` on an unflushed ORM `User` (the column default applies on INSERT). `build_user_base` uses `get_is_resource()` (None → True) and Kanban checks `is False`, but `/auth/me` uses `bool(user.is_resource)` — tests building `User(...)` without the field get `isResource: false` there.
- `makeUser({role: 'admin'})` now defaults to `is_resource: false`: a frontend test where a factory admin books themself through `canBookSelf` needs `is_resource: true`.
- Any route that creates a staff booking must call `require_bookable_staff` before the 202 branch; a new self-booking entry point that skips it would file requests for people who cannot be booked.
