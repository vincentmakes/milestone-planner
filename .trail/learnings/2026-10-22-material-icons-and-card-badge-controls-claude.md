---
title: "Material icons through one Icon wrapper (Emotion prepend cache, inline-svg guard), and the card badge split into a pin and a scroll-to name"
author: Claude
date: 2026-10-22
branch: feat/unlinked-bookings
cost: { minutes: 0, tokens: 0 }
touches:
  - frontend/package.json
  - frontend/src/main.tsx
  - frontend/src/components/common/Icon/Icon.tsx
  - frontend/src/components/common/Icon/icons.ts
  - frontend/src/components/__tests__/noInlineIcons.test.ts
  - frontend/src/components/__tests__/noInlineIconsAllowlist.json
  - frontend/src/components/gantt/ProjectPanel/CardBadgeView.tsx
  - frontend/src/components/gantt/ProjectPanel/cardBadge.ts
  - frontend/src/components/gantt/ProjectPanel/AssignmentRow.tsx
  - frontend/src/components/gantt/ProjectPanel/AssignmentRow.module.css
  - frontend/src/components/gantt/ProjectPanel/StaffGroupRow.tsx
  - frontend/src/components/gantt/ProjectPanel/CardStaffRows.tsx
  - frontend/src/components/layout/FlashNotice.module.css
  - frontend/src/components/layout/Sidebar/Navigation.tsx
  - UI_GUIDELINES.md
---

## Decided
- **Every icon is a Material icon from `@mui/icons-material`**, so light and dark themes get one consistent set instead of hand-drawn svgs, emoji and text glyphs. Pins are exact (`@mui/icons-material` / `@mui/material` 7.3.11, `@emotion/react` 11.14.0, `@emotion/styled` 11.14.1, `@emotion/cache` 11.14.0).
- **One wrapper, one name list.** `common/Icon/icons.ts` re-exports each app icon by deep path (`export { default as EditIcon } from '@mui/icons-material/EditOutlined'`), so only the used paths are bundled; `<Icon icon={X} size={…} />` renders it with `fontSize="inherit"`, `aria-hidden` (or `role="img"` + `titleAccess` with a `title`). Outlined variants by default; `PinIcon` (filled) vs `PinOffIcon` (outlined) is the one place where fill carries meaning.
- **No MUI theme, no other MUI component, no `sx`.** CSS Modules stay the rule. The only Emotion setting is `IconStyles` in `main.tsx`: a `CacheProvider` with `createCache({ key: 'mui', prepend: true })`, so MUI's base rules are inserted first and a module class on the svg wins a specificity tie. `StyledEngineProvider injectFirst` would do the same but is an MUI component — hence `@emotion/cache` as a direct dependency.
- **Guard**: `src/components/__tests__/noInlineIcons.test.ts` fails on any `<svg` in a non-test `.tsx` outside `noInlineIconsAllowlist.json` (Gantt dependency arrows / phantom overlays, the four-colour Microsoft logo), and on an allowlist entry that no longer draws one. Kept as text on purpose: the ◆ milestone marker and ⚠️ inside tooltip / confirm strings.
- **Card badge = one rectangle with two buttons** (`CardBadge` in `ProjectPanel/CardBadgeView.tsx`): the pin toggle (always drawn on booking rows, `disabled` when the user may not edit, the row is pending, their own request is open or the card has no dates — never swapped for a span, so every row lines up) and the card name, which scrolls the timeline (`triggerScrollToDate`) to the booking — own start when unlinked, card start when linked; on the overview row (no pin) to the person's earliest booking (`firstStart`, the earliest `bookingSpan` start; rows are in creation order, not date order). Both `stopPropagation`; right-click still opens the row menu.
- The flash notice slot has an opaque `--bg-secondary` surface (the shared Modal surface; `--bg-elevated` does not exist), so a refused drag's message is readable over the dark timeline.
- The Equipment **view** in the sidebar is `EquipmentViewIcon` = BuildOutlined (a wrench); the Settings cog next to it was ambiguous.

## Tried and ruled out
- Inlining the Material paths into a local `SvgIcon` to avoid the runtime: possible later as a codegen step, not worth it for this release.
- A `cardBadge.tsx` holding both helpers and the component: `react-refresh/only-export-components` warning; a `CardBadge.tsx` beside `cardBadge.ts` resolves to the wrong file on case-insensitive macOS — hence `CardBadgeView.tsx`.

## Watch out
- **Bundle cost**: +26.6 KB gzip on the main chunk (+26.9 KB all JS), nearly all MUI's `SvgIcon` runtime (Emotion, `@mui/system` styled, the default theme built without a provider), not the icons.
- The first lazy dialog in a test now also loads MUI + Emotion: under coverage a `findBy*` with the 1 s default can time out (ModalContainer's test waits 5 s).
- Tests render with Emotion's default appended cache (no `IconStyles`), fine in jsdom but not a proof of the prepend order.
- A disabled pin uses the native `disabled` attribute, so keyboard users cannot focus it; its state stays in `aria-pressed` and its name.
- The screenshot pipeline re-captures every documented PNG after an icon change — all of them show icons.
