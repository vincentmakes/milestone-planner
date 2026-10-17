---
title: "Button loading, useSubmitGuard everywhere, Modal focus trap (UI PR 2)"
author: Claude
date: 2026-10-17
branch: fix/ui-guidelines-debt-2
cost: { minutes: 23, tokens: 362337 }
touches:
  - CHANGELOG.md
  - UI_GUIDELINES.md
  - VERSION
  - frontend/src/components/admin/AdminLogin.module.css
  - frontend/src/components/admin/AdminLoginScreen.tsx
  - frontend/src/components/admin/__tests__/AdminLoginScreen.test.tsx
  - frontend/src/components/common/Button/Button.module.css
  - frontend/src/components/modals/ImportProjectModal.tsx
  - frontend/src/components/modals/KanbanCardModal.tsx
  - frontend/src/components/modals/MyAbsencesModal.tsx
---

## Decided
- `<Button loading={isSubmitting}>Save Changes</Button>` is the one way to show an in-flight write; it sets `aria-busy`. No `'Saving...'` label swaps remain, so tests select a busy button by its resting name and assert `aria-busy="true"`.
- Every dialog/panel write goes through `useSubmitGuard` (30 files). One guard per dialog: `KanbanCardModal` shares it between moves, assignments and comments. Test a guard by firing both clicks inside one `act()` (React batches the first click's state update, so the button is still enabled for the second) and asserting one API call. Use `mockImplementationOnce` where the file's `beforeEach` only `clearAllMocks()`.
- `Modal` traps Tab inside the innermost open dialog (module-level `openModals` stack; nested dialogs are portaled to body so only the top one traps), restores focus to the opener, uses `useId` for the title. Every mounted Modal reports to `uiStore.openModalCount` (`modalOpened`/`modalClosed`), which is how `useKeyboardShortcuts` stands down for dialogs opened through local state (custom-column dialogs) and not `activeModal`.
- Login screens use `<Button size="lg" className={styles.fullWidth}>`; `lg` buttons size `icon` svgs at 20 px. The admin "Back to Application" anchor is a ghost Button with `BackIcon` calling `window.location.assign('/')`.

## Tried and ruled out
- Filtering focusables by `offsetParent`/`getClientRects()` — always empty in jsdom; filter only `hidden` / `aria-hidden`.
- `vi.spyOn(window.location, 'assign')` — jsdom's Location is unforgeable. `Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign: vi.fn() } })` works; restore it in `finally`.
- Step 9 (full `Input`/`Select` adoption, ~86 raw inputs) deferred to its own PR; the aria-invalid / aria-describedby / role="alert" wiring landed here.

## Watch out
- `KanbanCardModal`'s Comment button stays `disabled={busy}` rather than `loading`: the busy flag is shared with status moves and assignments, so a spinner on Comment would lie.
- Lower a file's count in `rawColorAllowlist.json` when a removed rule drops a literal (AdminLogin 2 → 1 here).
