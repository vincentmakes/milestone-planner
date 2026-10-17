---
title: Shared confirm dialog replaces window.confirm (UI PR 4)
author: Claude
date: 2026-10-17
branch: fix/ui-guidelines-debt-4
cost: { minutes: 27, tokens: 372435 }
touches:
  - CHANGELOG.md
  - CLAUDE.md
  - UI_GUIDELINES.md
  - VERSION
  - frontend/src/App.tsx
  - frontend/src/__tests__/App.test.tsx
  - frontend/src/components/admin/AdminUserList.tsx
  - frontend/src/components/admin/OrganizationList.tsx
  - frontend/src/components/admin/TenantList.tsx
  - frontend/src/components/admin/__tests__/AdminDashboard.test.tsx
---

## Decided
- Confirmations go through `confirmAction(options)` (`frontend/src/utils/confirmDialog.ts`), a promise backed by `confirmStore` (a queue) and rendered once by `components/common/ConfirmDialog` mounted at the root of `App.tsx`, so the admin portal is covered too. `destructive: true` gives a red Delete button; messages were kept byte-for-byte.
- A handler that confirms is async and confirms BEFORE taking its submit guard, so an open dialog never holds the in-flight flag.
- Tests stub the service with `stubConfirm(result)` (`src/test/confirmDialog.ts`, restored in `test/setup.ts`) and assert `expect.objectContaining({ message })`; no `vi.spyOn(window, 'confirm')` anywhere.
- `Modal`'s Escape listener acts only for the top of the open-modal stack; `useEscapeKey` and `useDismissableOverlay` are inert while a confirm is pending, so the confirm owns Escape and the overlay that asked stays open until the answer.

## Tried and ruled out
- Removing a closed Modal from `openModals` through `modalRef.current`: it is already null in the close/unmount effects, so the stale entry stayed on top and the parent stopped trapping Tab. Keep the pushed container in its own ref.
- `autoFocus` on the Cancel button: Modal's open effect focuses the container afterwards; focus Cancel from an effect in the dialog instead.

## Watch out
- `trail check` flags keyword matches on this change ("clear admin action", "build docker image", "sql screenshot"); none reintroduces a ruled-out approach.
- `commitDragUpdate` can await the confirm safely because `handleMouseUp` detaches the document listeners first; the bar stays at the drop until the answer.
