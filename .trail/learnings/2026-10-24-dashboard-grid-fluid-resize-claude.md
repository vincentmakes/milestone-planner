---
title: "Dashboard grid: react-grid-layout 2.3.0 honours a live onResize adjustment — the row-fluid resize mutates the move's layout array"
author: Claude
date: 2026-10-24
branch: feat/dashboards
cost: { minutes: 0, tokens: 0 }
touches:
  - frontend/src/components/views/DashboardsView/DashboardGrid.tsx
  - frontend/src/components/views/DashboardsView/gridLayouts.ts
---

## Decided
- **The row-fluid resize runs live in `onResize`**, not at stop. In rgl 2.3.0 `GridLayout.onResize` builds the move's layout with `withLayoutItem` (a clone of the resized item) + `modifyLayout` (a fresh array, other entries shared with the state), calls `onResize(finalLayout, oldItem, item, placeholder, …)`, and only **then** runs `compactor.compact(finalLayout)` → `setLayout` and `setActiveDrag(placeholder)`. So replacing entries of that array (never mutating the shared item objects) and setting `item.w` / `placeholder.w` is honoured on every move; `onResizeStop` compacts `layoutRef.current` (the last move's) and reports it, so the gesture's report — and its one undo entry — carries the neighbours.
- `fluidResize` is always computed from a copy of the layout taken in `onResizeStart`, so a neighbour comes back when the widget does within one gesture. `cols` comes from `getBreakpointFromWidth(GRID_BREAKPOINTS, width)` (the library's own rule, `width > breakpoint`).
- `toGridLayouts` gives `maxW = fluidMaxW(...)` (`w + min(column w) − 2`, `cols − x` without a right column) and `minW = min(2, w)`, so react-resizable's pixel constraints stop the corner where the rule does.

## Notes
- A resize reports twice in the same tick (from `onResizeStop` and from the state effect that compares with `prevLayoutRef`), both tagged `'gesture'`; the editor ignores the identical second one.
- The v2 README documents no mutation contract for `onResize`; the evidence is the source order above (`dist/chunk-Z6CWRR74.mjs`). A library upgrade could break it — the real-library tests in `DashboardGrid.test.tsx` assert the neighbour mid-gesture.
