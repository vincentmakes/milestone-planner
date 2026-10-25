---
title: "Timeline event strip (2.1.0 round 5): every cell carries its company events, one TimelineMarkers strip + AnchoredPanel in all five timelines"
author: Claude
date: 2026-10-25
branch: feat/dashboards
cost: { minutes: 0, tokens: 0 }
touches:
  - frontend/src/components/gantt/utils/timeline.ts
  - frontend/src/components/gantt/utils/eventLanes.ts
  - frontend/src/components/gantt/Timeline/TimelineMarkers.tsx
  - frontend/src/components/gantt/Timeline/TimelineMarkers.module.css
  - frontend/src/components/gantt/Timeline/TimelineBody.tsx
  - frontend/src/components/gantt/Timeline/TimelineHeader.tsx
  - frontend/src/styles/variables.css
  - frontend/src/components/views/StaffView/StaffTimelineBody.tsx
  - frontend/src/components/views/EquipmentView/EquipmentTimelineBody.tsx
  - frontend/src/components/views/CrossSiteView/CrossSiteTimelineBody.tsx
  - frontend/src/components/views/ArchivedView/ArchivedView.tsx
  - frontend/src/components/views/ArchivedView/TimelineRow.tsx
  - frontend/src/styles/__tests__/mobileTouchTargets.test.ts
  - app/scripts/demo_data.py
  - tests/test_demo_data.py
---

## Decided
- **Cells carry every event**: `TimelineCell.companyEvents: CellEvent[]` lists every event overlapping the cell's day, quarter week or year month, ordered whole-site closures → team-limited closures → start → name → id (`compareCellEvents`). The old single-event fields are the first of the list, so the tints keep working. A year cell's span is computed inside the year generator (no `dateEnd`: the drag code reads `data-date-end`).
- **One strip for all five timelines**: `gantt/Timeline/TimelineMarkers.tsx`, mounted by `TimelineHeader` in its own third row (`eventsRow`, 14 px, below the day labels) at **every** zoom (only the background tints stay week / month), with the **current** site's id read from `appStore` in every view, Cross-site included (events are loaded for the current site only). Archived's `TimelineRow` tint cells became plain (`pointer-events: none`, z 1, no `data-tooltip`).
- **Fix wave: out of the bodies.** The first version drew the strip in each body's overlay; at 12 px it sat on the first row's bars (they start 4–5 px in) and its hit cells took the top of a bar's mousedown. The header grew to 66 px = `--timeline-header-total` (declared in every theme block), which every left pane's header reads, so both panes shift together.
- Day zoom: bands on up to three lanes from `eventLanes.ts` (lane 0 reserved for the holiday line, a run placed whole or counted as `+N`); quarter / year: one band (first event's colour) + a count.
- The hit cells stay **12 px** high and are `button.markerBadge`: the `Badge` substring keeps them out of the 44 px / 40 px mobile button rule, which would make them cover the first row's bars. Pinned in `mobileTouchTargets.test.ts`; measured live at 640 px.
- The panel is the shared `AnchoredPanel` (`role="dialog"`, no focus trap); hover (150 ms intent), focus, click / tap pins; Escape / outside / Tab out through `useDismissableOverlay`, and a `skipNextFocus` flag (cleared in a microtask) stops the returned focus from reopening it.

## Tried and ruled out
- Per-view CSS `::after` tooltips (the old `data-tooltip` cells): one name per day, no keyboard, nothing at quarter / year zoom. Removed from all five views; the raw-colour allowlist went down with them.
- Gating the strip on week / month like the tints: span cells then lose every event.

## Watch out
- A left pane next to a timeline must size its header with `var(--timeline-header-total)`, never a pixel value: a new header row means changing the token (and `timelineHeaderHeight.test.ts`), not five stylesheets. `StaffView.module.css`'s `.staffRow { min-height: 52px }` is a staff row, not a header (the inline row height wins) — it is not part of the token.
- The Staff / Equipment panels embedded below the Gantt render no `TimelineHeader` (a 36 px tinted spacer instead), so they have no strip: the Gantt's header strip above covers them.
- The strip's DOM must hold no `data-date` and no class / attribute containing `row` or `bar`: `useDragAndDrop` / `useResize` read every `[data-date]` in the document and `DependencyLayer` takes the first `[class*="rows"]`.
- Lane order follows the cell order, so on the demo's ISO-audit day the lanes read amber (audit, starts first), purple ("Instrument calibration day"), cyan ("Lab safety walk-through") — alphabetical within the plain events, not the order they were created in.
- The Settings event form offers the seven event swatches only (`ColorSwatchPicker` without `allowCustom`, `EVENT_COLOR_SWATCHES`): seed event colours from that list (the demo's two stacked events are Cyan `#06b6d4` and Purple `#8b5cf6`, `test_demo_data.py` reads the list), or an edit through Settings silently changes them. The round-5 seed used `#14b8a6` / `#a855f7`, which no swatch matches.
- At 640 px the Gantt's project panel plus custom columns is wider than the viewport, so the Gantt timeline is off-screen on a phone; the phone checks of the strip ran on the Staff Overview. At ≤ 640 px the panel's name buttons take the global 44 px height, so the panel grows taller (intended: they are touch targets).
