---
title: "Gantt two-pane scroll sync: no echo, wheel-driven, measured equal scroll range"
author: Claude
date: 2026-10-17
branch: fix/gantt-scroll-sync
cost: { minutes: 12, tokens: 78066 }
touches:
  - CHANGELOG.md
  - CLAUDE.md
  - UI_GUIDELINES.md
  - VERSION
  - frontend/src/components/gantt/ProjectPanel/ProjectPanel.module.css
  - frontend/src/components/views/ArchivedView/ArchivedView.module.css
  - frontend/src/components/views/CrossSiteView/CrossSiteView.module.css
  - frontend/src/components/views/EquipmentView/EquipmentView.module.css
  - frontend/src/components/views/StaffView/StaffView.module.css
  - frontend/src/hooks/__tests__/useScrollSync.test.ts
---

## Decided
- `useScrollSync` keeps the tree panel and the timeline body together with three behaviours: every programmatic `scrollTop` write is remembered and the follower's matching `scroll` event (within 1 px) is consumed, so the follower never snaps the source back; a non-passive `wheel` listener on both panes moves both in the same frame (Ctrl, Shift, any `deltaX` and zero `deltaY` are left to the browser so zoom and sideways trackpad panning keep working); and the hook measures both panes' natural `scrollHeight - clientHeight` and pads the shorter one so both reach the same scroll end.
- The re-measure after a `ResizeObserver` notification runs one `requestAnimationFrame` later (merged), otherwise changing padding inside the callback raises "ResizeObserver loop completed with undelivered notifications". jsdom has no `ResizeObserver`: the hook falls back to a `window` resize listener, tests stub the observer.

## Tried and ruled out
- A fixed `padding-bottom: 8px` on the left pane "to match the horizontal scrollbar": the scrollbar takes 8 px of layout only with classic scrollbars; with overlay scrollbars (macOS) and `scrollbar-gutter: stable` it takes 0 and the left pane scrolls 8 px further, misaligning the last rows.
- A rAF-reset `isSyncing` flag against echo: the follower's `scroll` event arrives a frame later, after the reset, and copies its older position back, which is the stutter during fast scrolls.
- One shared vertical scroller with a sticky left panel would make alignment exact by construction, but the drag, resize and dependency layers locate rows by DOM position in the two-pane structure; too large for a fix.

## Watch out
- Scroll events coalesce per frame; the echo guard assumes the follower's next `scroll` reports the last written value. Two writes to one pane in one frame are fine; a browser firing two separate events would cause one harmless snap.
- Mouse-wheel notches jump instantly on the wheel path (no smooth scrolling); accepted.
