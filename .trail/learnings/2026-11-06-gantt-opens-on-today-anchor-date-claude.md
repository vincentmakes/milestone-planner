---
title: "Gantt sent months ahead after a refresh: a timeline keeps its place by date, never by pixel, and never anchors on its mount"
author: Claude
date: 2026-11-06
branch: feat/audit-log
cost: { minutes: 90, tokens: 250000 }
id: l-cf2b9883
scope: repo
status: active
src: agent
touches:
  - frontend/src/hooks/useTimelinePosition.ts
  - frontend/src/components/gantt/Timeline/Timeline.tsx
  - frontend/src/components/gantt/Timeline/__tests__/Timeline.scroll.test.tsx
  - frontend/src/components/gantt/utils/timeline.ts
  - frontend/src/components/views/StaffView/StaffView.tsx
  - frontend/src/components/views/EquipmentView/EquipmentView.tsx
  - frontend/src/stores/viewStore.ts
  - frontend/src/stores/__tests__/viewStore.expansion.test.ts
  - frontend/src/stores/uiStore.ts
---

## Decided
- The race: `App.tsx` renders MainLayout (and the Gantt) for one commit before `useDataLoader` flips to the loading screen (`isLoading` starts false). That mount has `instanceSettings === null`, so weekends are shown; its frame stored today's **pixel** offset in `viewStore.timelineScrollLeft`. The real mount, after the data load with `show_weekends=false`, restored that pixel on weekday-only cells: the same pixel is ~7/5 further in time (2027-04 instead of 2026-11 in month view, 2027-01 in week view). Whether the frame fired before the unmount was a race, which is why the 1.5.0 / 1.6.0 fixes seemed to hold and then did not.
- The fix is structural, in one hook shared by the Gantt `Timeline` and the standalone Staff / Equipment views, `hooks/useTimelinePosition.ts`: open from today and the current cells (`openingScrollLeft`), or, in the same session, from `viewStore.timelineAnchorDate` (a YYYY-MM-DD left-edge date, `scrollLeftForDate` / `leftEdgeDate`). The mount never writes the anchor; a debounced scroll, a navigation (same kind of cells, another range: the pixel stays, the date moves) or a cell-set change (view mode, weekends shown/hidden — keyed on `viewMode` + "has weekend cells", not on `cellWidth`, which the zoom paths own) of a connected, visible pane does. `timelineScrollLeft` was then deleted from the store altogether (Fable review): a write-only pixel offset is the bait for the next regression.
- A hidden weekend day falls to the next cell (Monday), as `findTodayCell` does; a day inside a span cell (quarter week, year month) stays in that cell. A previous cell is a span cell when it has `dateEnd` or the next cell starts 7+ days later.
- Guards: `Timeline.scroll.test.tsx` "opens on today — regression guard, do not weaken" (16 cases: throw-away mount before/after its frame, an App-like render with no settings then `show_weekends=false`, settings arriving late; month and week view; a weekday and a hidden Saturday) fails on a8f9006 and passes after; `viewStore.expansion.test.ts` fails if any date or pixel offset is persisted.

## Tried and ruled out
- Persisting the position (localStorage or sessionStorage): Vincent chose "always open on today, never restore across a refresh" (the 1.6.0 rule), and a persisted pixel is exactly what broke 1.5.0.
- Keeping the pixel restore and only skipping the throw-away mount: any other cell-set change (settings arriving late over the WebSocket, a weekend toggle) still moves the date under a pixel.

## Watch out
- There is no pixel offset in viewStore any more (`timelineScrollLeft` was removed after the Fable review): with nothing to restore by pixel, a future "restore the scroll" change has to go through the anchor date. `viewStore.expansion.test.ts` pins the sorted list of persisted keys.
- The Today trigger is one-shot (`{timestamp} | null`, cleared by the one timeline that handles it, which anchors that place with `anchorAt`). As a counter it stayed > 0 for the session, and Timeline's effect, keyed on `cells`, re-centred today on every Previous / Next, zoom and remount after one click.
- The hook cancels its mount frame on unmount; the frame reads the anchor when it fires, so a Today handled before it counts.
- jsdom fires no scroll event on a programmatic `scrollLeft`; browsers do, so in a browser the mount's own scroll writes the anchor 200 ms later on the real (visible) mount — harmless, it is a date.
