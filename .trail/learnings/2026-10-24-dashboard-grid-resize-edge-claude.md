---
title: "Dashboard grid: react-grid-layout 2.3.0 refuses (not clamps) a resize past the right edge — every item carries maxW = cols - x"
author: Claude
date: 2026-10-24
branch: feat/dashboards
cost: { minutes: 0, tokens: 0 }
touches:
  - frontend/src/components/views/DashboardsView/gridLayouts.ts
  - frontend/src/components/views/DashboardsView/__tests__/DashboardGrid.test.tsx
---

## Decided
- **`toGridLayouts` gives every item `maxW = max(cols - x, w)`** per breakpoint. rgl 2.3.0's `resizeEast` → `constrainWidth(left, currentWidth, newWidth, containerWidth)` returns the *current* width when `left + newWidth > containerWidth` (still so on upstream master). It is the only growth-only rule on the resize path (react-resizable → `GridItem.onResizeHandler` → `resizeItemInDirection` → `calcWHRaw` → constraints → `GridLayout.onResize` → compactor), so a pointer sample past the grid's right edge before the last column was reached left a right-column widget stuck: shrinking always worked, enlarging back to the edge failed. `maxW` becomes react-resizable's `maxConstraints`, which caps the pixel width at the edge before rgl sees it. `fromGridLayouts` keeps only `x, y, w, h`, so nothing new is stored or makes the draft dirty; a moved widget gets its new `maxW` from the draft round trip on drag stop.

## Tried and ruled out
- Controlled `layouts` rebuilt mid-gesture: `GridLayout` emits `onLayoutChange` only when `activeDrag` is null, i.e. once on stop — the draft never changes during a resize.
- Handle hit area / `overflow: hidden` / pointer events: the handle is a sibling of the card and DraggableCore listens on the document.
- `maxW` / `maxH` / `isBounded` defaults (Infinity, no vertical container bound) and the server's `h ≤ 40`.
- Fine-grained Playwright gestures never fail; it takes one coarse move (1–3 samples, as with coalesced events or a flick to the window edge) past the edge. The jsdom test reproduces it with one 400 px `mouseMove` (jsdom measures 0, so client coordinates are the pointer).

## Notes
- During a resize rgl 2.3.0 re-renders a `GridItem` only when its `w`/`h` changes (the memo compares `children`, stable during the gesture), so the card follows the cursor in column steps while the placeholder shows the target. Library behaviour, left alone.
- The Claude-in-Chrome `left_click_drag` does not drive the resize at all (no intermediate moves: `GridLayout.onResizeStop` ignores the stop size and keeps the last `onResize`). Use Playwright `page.mouse` steps.
