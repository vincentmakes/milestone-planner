---
title: "UI PR 1: paying the UI_GUIDELINES debt (shared Notice, overlay hook, switches, token ratchet)"
author: Claude
date: 2026-10-17
branch: fix/ui-guidelines-debt-1
cost: { minutes: 42, tokens: 598290 }
touches:
  - CHANGELOG.md
  - CLAUDE.md
  - UI_GUIDELINES.md
  - VERSION
  - frontend/src/components/admin/AdminDashboard.module.css
  - frontend/src/components/admin/AdminLogin.module.css
  - frontend/src/components/admin/TenantList.module.css
  - frontend/src/components/admin/modals/AdminModal.module.css
  - frontend/src/components/common/ActivityFeed/ActivityFeed.module.css
  - frontend/src/components/common/ActivityFeed/ActivityFeed.tsx
---

## Decided
- Errors never go through alert(): a form/panel renders `<Notice tone="error">` (components/common/Notice); an action with no form (context-menu delete, refused dependency link, failed Kanban move) calls `uiStore.showFlash(message, tone)`, rendered by `layout/FlashNotice` bottom-right and auto-cleared after 6 s. window.confirm stays until a shared confirm dialog is a product decision.
- Every dropdown/popover/menu dismisses through `hooks/useDismissableOverlay` (outside mousedown, Tab out via the returned onBlur, capture-phase Escape + focus back on the trigger). ContextMenu is role="menu" / menuitem, so tests select items with getByRole('menuitem').
- Settings on/off flags are ToggleSwitch (role="switch"); entity flags in dialogs stay checkboxes. SSOPanel has two switches now, so tests name them ('Enable SSO', /Auto-create/).
- Row actions are 28 px with PanelIcons and an aria-label naming the row; the 44 px growth on phones is kept on purpose.
- cssTokens.test also fails on a `var(--x, fallback)` for a defined token and ratchets hex/rgba counts per module.css against styles/__tests__/rawColorAllowlist.json (357 literals in 71 files at 1.7.0): lower a number when paying debt, never raise one. Tints are color-mix(in srgb, var(--accent-x) N%, transparent).
- One avatar palette: utils/avatarColor.ts avatarColorFor(id) (Kanban's palette had drifted at indexes 6/7 and is now the same as presence/activity).

## Tried and ruled out
- Clearing the admin-list error in the `finally` block together with setActionLoading(null): it wiped the message the catch had just set. Clear it when an action starts, not when it ends.
- Asserting the overview toggle starts unpressed: showAssignments defaults to true.

## Watch out
- The Staff Overview rows (name + "title · N% available") have been 52 px two-line rows since the first commit and the embedded panel opens at a non-persisted 250 px; PR #75 did not change them (user asked). Tightening them is a product change for a later PR.
- The session-start hook rewrites .claude/settings.json and deletes .claude/skills/trail/SKILL.md: `git checkout -- .claude/` before every commit.
- The screenshot pipeline was not re-run for this PR (settings/admin shots differ only in 28 px icons and switches); refresh them with the seed PR.
