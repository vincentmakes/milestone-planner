---
title: "Admin defaults: a feature flag inside PermissionSet.mode(), change notifications delivered after the commit under an advisory lock"
author: Claude
date: 2026-10-22
branch: feat/admin-defaults
cost: { minutes: 0, tokens: 0 }
touches:
  - app/services/instance_settings.py
  - app/services/permissions.py
  - app/middleware/auth.py
  - app/services/user_access.py
  - app/routers/settings.py
  - app/routers/sites.py
  - app/services/change_notifications.py
  - app/services/notifications.py
  - app/services/tenant_provisioner.py
  - app/services/tenant_manager.py
  - migrations/add_change_notifications.sql
  - tests/conftest.py
  - shared/permission-keys.json
  - frontend/src/types/permissions.ts
  - frontend/src/utils/roles.ts
  - frontend/src/utils/instanceSettings.ts
  - frontend/src/components/settings/panels/DefaultsPanel.tsx
  - frontend/src/stores/notificationStore.ts
---

## Decided
- Instance defaults stay rows of the free `settings` KV table; `KNOWN_SETTINGS` in `app/services/instance_settings.py` canonicalises the six known keys (422 `Invalid value for <key>`), `value: null` deletes the row, a missing row reads as the default. Shape is validated, not existence: consumers ignore deleted skill ids / renamed type names. A switch is on unless exactly `false` (`flag_enabled`, client `isSettingOn`), which keeps rows written before validation working.
- The Kanban switch is a permission feature flag, not a new client gate: `PermissionSet.disabled_keys` (only `DISABLEABLE_KEYS` = `{views.kanban}`) is checked first in `mode()`, before the admin / always-allowed branches, so `has` / `can` / `effective_modes` / `allow_keys` follow and admins lose the board too; `can()` checks it at its top as well. `load_live_user` reads the switch as a fifth column (scalar subquery) of its one query — no extra round trip on the hottest path, and the mocked `execute` sequences stay aligned. `/auth/me` and login use `effective_permission_set` (one more query). `roles.py` builds sets without it so the matrix shows what is configured.
- The escalation guard ignores the flag: `role_within` compares against `replace(holder, disabled_keys=frozenset())`; the client mirror is `roleWithin(role, user, disabledKeys)` (`UsersPanel` passes `DISABLEABLE_KEYS` while the board is off). Without that, only admins could assign a role holding `views.kanban` while the board is off. `shared/permission-keys.json` carries `disableable` so the frontend catalogue test catches drift.
- Change notifications (`assignment_changed` to the booked person, `project_changed` to the PM; never the actor, never inactive users) are delivered **after** the caller's commit by `change_notifications.deliver`, in their own short transaction: per recipient row, `pg_advisory_xact_lock(hashtext("{user}|{type}|{project}|{actor}"))` in sorted key order, then fold into the newest unread row with that key from the last 10 minutes or insert. This departs on purpose from the "stage in the caller's transaction" rule of `notifications.py`: the Gantt saves one drag as parallel PUTs (`Promise.allSettled`), and only a lock taken after each change commits merges them without serialising the changes; the lock stays short. Cost: a notification is lost if the process dies between the two commits. Failures are logged and rolled back, never fail the change.
- Routes build plain-data `ChangeIntent`s (old values captured before mutating, names of deleted things before the delete) with `{project}` / `{target}` / `{person}` placeholders that `deliver` fills from one `load_context` + one `User` query, so routes add no queries for texts. A project delete carries `project_id = NULL` (the FK cascade would delete the row) and is never coalesced (`IS NULL` would merge every delete by the actor).
- Route tests never see the real delivery: the autouse `change_intents` fixture in `tests/conftest.py` patches `deliver` with a recorder of `(actor_id, intents, already_notified)`; `tests/test_change_notifications.py` captures the real function at import time and runs it against a FakeDB.
- `notificationStore.receive` is an upsert by id: a push with `created_at` **equal to or older than** the stored row is ignored (an identical repeat changes nothing, and a late duplicate cannot undo a local mark-read); a newer one (a coalesced update always bumps `created_at`) replaces the row and moves it to the top, unread count adjusted by the difference.

## Tried and ruled out
- Keeping the widening DO block's marker at `todo_assigned`: a 1.14 constraint already allows it, so upgraded tenants would skip the widening and every new-type insert would fail the CHECK. The marker is now `NOTIFICATION_TYPES[-1]`.
- Running the notification-type widening only inside the RBAC auto-migration block: `RBAC_NEEDS_MIGRATION_SQL` is false on 1.13 / 1.14 tenants, so they never got the new types. It is now its own step on every pool creation (the DO block gates itself).
- Writing the change notifications inside the caller's transaction: the advisory lock would be held for the whole change, and parallel Gantt PUTs would either serialise or race into duplicate rows.

## Watch out
- `tenant_provisioner.NOTIFICATION_TYPES` is the one list (the CHECK text and the marker derive from it), but seven DDL sources carry the list (`tests/test_notification_types_schema.py` checks all of them). A new type goes **at the end**, or the marker no longer detects old constraints.
- `change:settings` refreshes `settings` and `currentUser`, but the saving admin is excluded from the broadcast — `DefaultsPanel` re-reads `/auth/me` itself after a `kanban_enabled` change.
- Kanban off hides only the board and its four reads; card status / assignee / comment writes gate on other keys (two are self-booking decision points) and stay reachable on purpose.
