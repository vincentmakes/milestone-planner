---
title: "Notifications: delete one, clear all, 30-day purge of read rows; the coalescing lookup is FOR UPDATE; derived reminders re-derive on dismissal"
author: Claude
date: 2026-10-28
branch: feat/feedback-2
cost: { minutes: 0, tokens: 0 }
touches:
  - app/routers/notifications.py
  - app/services/notifications.py
  - app/services/change_notifications.py
  - frontend/src/components/common/NotificationBell/NotificationBell.tsx
  - frontend/src/hooks/useDerivedDueNotifications.ts
  - frontend/src/stores/notificationStore.ts
---

## Decided
- **Retention is lazy** (no scheduler in this app): `purge_read_notifications(db, user_id)` runs at the start of `GET /notifications`, deleting the caller's rows with `read_at < utcnow_naive() - READ_RETENTION_DAYS` (30). `read_at < bound` never matches NULL, so unread rows are never purged. The route therefore uses `get_db` and commits; `get_db_readonly` never commits and would silently throw the purge away (`test_list_uses_the_committing_session` inspects the route's dependencies).
- **Coalescing reads its row `FOR UPDATE`** (`_coalesce` in `change_notifications.py`). The advisory lock only serialises `deliver` calls with each other; a user's DELETE (or the purge) between the read and the flushed UPDATE made the UPDATE match nothing → `StaleDataError` → the whole batch rolled back. `RacingDeleteDB` in `tests/test_change_notifications.py` simulates PostgreSQL's row-lock semantics and fails without `.with_for_update()`.
- **`DELETE /notifications/{id}` is 204** (the first 204 route of the app: `status_code=204, response_class=Response`), 404 for someone else's id; `DELETE /notifications` → `{deleted: n}`. Both are covered by the existing prefix rules: `SKIP_PATTERNS` and `isWhatIfExempt` match `/api/notifications` whatever the method.

## Watch out
- `useDerivedDueNotifications` memoised on `[projects, currentUser]` only: a dismissal (localStorage write) re-rendered nothing, so an opened reminder stayed in the bell until the projects changed. It now subscribes to the stored dismissal map with `useSyncExternalStore` (snapshot = the map as a JSON string, compared by value; a module-level cache would go stale when tests `localStorage.clear()`).
- The bell's × is a **sibling** of the row button inside the `<li>` (a button inside a button is invalid). The row styles (border, unread background, hover) moved from `.item` to the `<li>` (`.row`). The × moves focus to the neighbouring row's × (`[data-row-delete]`; CSS-module class names are not reliable selectors in tests), or the bell, before the row disappears.
