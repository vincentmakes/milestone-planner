---
title: "RBAC My Todos: todoStore loaded by the WebSocket provider, one refresh for two slices, policies on their own slice"
author: Claude
date: 2026-10-22
branch: feat/rbac
cost: { minutes: 0, tokens: 0 }
touches:
  - frontend/src/stores/todoStore.ts
  - frontend/src/contexts/WebSocketContext.tsx
  - frontend/src/contexts/wsSlices.ts
  - frontend/src/components/views/TodosView/TodosView.tsx
  - frontend/src/components/common/NotificationBell/NotificationBell.tsx
  - frontend/src/components/gantt/ContextMenuContainer.tsx
---

## Decided
- todoStore (not persisted, reset by `resetAllStores`) holds tasks (`GET /todos/mine?status=all`, `kind: 'task'` only), my requests and the requests to decide; `openCount` = to decide + open tasks assigned to me, recomputed in every setter so the sidebar badge selects a number. `refresh()` shares one in-flight round trip and drops results that land after `reset()` (generation counter).
- The badge needs the store loaded before the view is opened: `WebSocketProvider` refreshes it on mount and window focus (the provider is the signed-in app; mounting it in Navigation/Header would make their tests hit the real API). TodosView refreshes on mount/focus too; the in-flight sharing makes that free.
- `approvals` and `todos` slices (and the per-user `todo:changed` / `approval:changed` pushes, staged through the same 200 ms debounce) call `todoStore.refresh()` once per batch. The approval-policy refetch moved to its own `approvalPolicies` slice, mapped from `approval_policy` only (a decision does not change policies).
- A failed refresh sets `todoStore.loadError` (partial or total) and the view shows it in a Notice instead of an empty state; the tab count for My tasks and the badge share `isMyOpenTask`. A bell target sets tab and filter: `approval_decided` → My requests on Done (a decided request is not pending).
- My Todos is always allowed (`VIEW_PERMISSIONS.todos = null`) but only with a signed-in user. Bell: `approval_requested` → To decide, `approval_decided` → My requests (the server's entity is the request, so a card target never occurs today), `todo_assigned` → My tasks; blocked in What-If like card links.
- Lock rule shared by the Gantt context menu and KanbanCardModal: a row with an open request from me → only Cancel request; a pending create → locked for everyone (deciders approve/reject); editors keep Edit/Delete on approved rows with someone else's change request.

## Tried and ruled out
- `grid-template-columns: 1fr` in a module: `cssTokens.test.ts` rejects a bare `1fr` track; use `minmax(0, 1fr)`.
