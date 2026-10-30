---
title: "Text and icons one step larger outside the timelines; the five timeline views keep the compact scale through .compact-ui"
author: Claude
date: 2026-10-27
branch: feat/dashboards
cost: { minutes: 0, tokens: 0 }
touches:
  - frontend/src/styles/variables.css
  - frontend/src/styles/themes/themes.css
  - frontend/src/styles/global.css
  - frontend/src/components/common/Icon/Icon.tsx
  - frontend/src/components/common/Button/Button.module.css
  - frontend/src/components/common/Input/Input.module.css
  - frontend/src/components/common/Select/Select.module.css
  - frontend/src/components/gantt/GanttContainer.tsx
  - frontend/src/components/views/StaffView/StaffView.tsx
  - frontend/src/components/views/EquipmentView/EquipmentView.tsx
  - frontend/src/components/views/CrossSiteView/CrossSiteView.tsx
  - frontend/src/components/views/ArchivedView/ArchivedView.tsx
  - frontend/src/styles/__tests__/fontSizeTokens.test.ts
  - UI_GUIDELINES.md
---

## Decided
- **One step up, once, in the tokens**: `--font-size-xs/sm/md/base` 11/12/13/14 → 12/13/14/15 px (S-Theme 12/12/12/14 → 13/13/13/15); `lg` and above unchanged. New `--icon-scale: 1.125` in `:root`, `[data-theme="light"]` and both S-Theme blocks. Control heights (36 / 28 / 44 px), `--header-height`, row heights and spacing did not move.
- **The timelines keep today's sizes through one global class**, `compact-ui`, on the root of GanttContainer, StaffView, EquipmentView, CrossSiteView and ArchivedView. It re-declares the four size tokens and `--icon-scale: 1` (S-Theme override block for 12/12/12/14) and sets `font-size: var(--font-size-base)` (13 px variant inside the ≤ 640 px media query), because unstyled text inside inherits the body's size, which is now 15 px.
- **Icon** renders `fontSize: calc(<size>px * var(--icon-scale))`; `size` stays the compact px, so no call site changed. The `Button`, `Input` and `Select` icon slots multiply their svg width/height by the same variable.
- **Non-timeline stylesheets read the tokens**: 166 raw `rem`/`px` font sizes became tokens (0.6875rem/11px → xs, 0.75rem/12px → sm, 0.8rem/0.8125rem/13px → md, 0.875rem/14px/0.9375rem → base, 1rem → lg, 1.125rem/17px/18px → xl), plus the admin portal's inline `fontSize` strings. Timeline directories were not touched.
- **Exceptions, kept raw and listed in `fontSizeTokens.test.ts` `ALLOWED`**: counters and initials in a fixed circle under 11 px (NotificationBell 9, KanbanCard 9, OnlineUsers 10 ×2, ProjectFilterDropdown 10, Header panels badge 0.625rem → 10px) and display sizes above `xl` (InstanceTitle 1.25/1.2rem, SystemStatsPanel 1.25/1.5rem, TenantList 2rem, AdminLogin 1.5rem).

## Tried and ruled out
(Both ruled out at the planning stage, not implemented.)
- A multiplier variable inside the root type tokens, reset to 1 by the compact scope: custom properties resolve where they are declared, so `:root` hands its children a finished length; a child cannot undo it. The scope has to re-declare the tokens themselves.
- Raising the root `html` size: every rem in the app (spacing, heights, the timelines) would grow with it.

## Watch out
- Popovers, menus and dialogs portalled to `<body>` from inside a timeline take the app scale (intended: a dialog opened from the Gantt matches the rest of the app). A panel rendered inline inside the timeline root keeps the compact scale.
- A stylesheet that sets an svg's `width`/`height` in px wins over `Icon`'s font size and does not scale: multiply by `var(--icon-scale)`.
- A new timeline view needs `compact-ui` on its root; a new raw `font-size` outside the timeline directories fails `fontSizeTokens.test.ts`.
- Never write `var(--icon-scale, 1)`: `cssTokens.test.ts` fails on a fallback for a defined token.
- The docs screenshots (`scripts/screenshots/`) predate the bump and were not refreshed.
