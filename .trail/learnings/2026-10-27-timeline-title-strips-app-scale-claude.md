---
title: "The timeline title strips take the app scale; the data area below keeps compact"
author: Claude
date: 2026-10-27
branch: feat/dashboards
cost: { minutes: 0, tokens: 0 }
touches:
  - frontend/src/components/gantt/GanttContainer.tsx
  - frontend/src/components/gantt/ProjectPanel/ProjectPanel.tsx
  - frontend/src/components/gantt/Timeline/Timeline.tsx
  - frontend/src/components/views/StaffView/StaffView.tsx
  - frontend/src/components/views/EquipmentView/EquipmentView.tsx
  - frontend/src/components/views/CrossSiteView/CrossSiteView.tsx
  - frontend/src/components/views/ArchivedView/ArchivedView.tsx
  - UI_GUIDELINES.md
---

## Decided
- The user asked that the title / toolbar strip at the top of each timeline view read like the rest of the app, with only the data below staying dense. So `compact-ui` moved off the five view roots and onto the data areas:
  - Gantt: `ProjectPanel` `.columnHeaders` and `.body`, plus the `Timeline` root. The project panel's `.header` ("Projects", count, 28 px icon buttons, New) takes the app scale.
  - Staff & Calendar, Equipment, Cross-site: `.panelBody` and `.timeline`.
  - Archived: `.panelContent` and `.timelineWrapper`.
  - The `.panelHeader` strips of these four views take the app scale.
- The Staff and Equipment panels embedded below the Gantt stay compact as a whole: their root carries `compact-ui` only when `embedded`, so their 36 px header strip stays compact too.
- The strips' heights were already pinned (`--timeline-header-total`, 36 px when embedded, the Gantt `.header`), so the larger strip text cannot push the rows down. Checked on the demo by comparing every element's `top` and height before and after in the five views and in the Gantt with the Staff panel open.

## Tried and ruled out
- (Considered, not built.) A second global class that restores the app tokens on the strip (an "app-ui" class inside a compact root): it would repeat the app values and their S-Theme variants in a second place, and the two lists could drift apart. Putting the class on the data areas re-declares nothing.

## Watch out
- A new element added between a view's title strip and its data area is at the app scale unless it carries `compact-ui` or sits inside an element that does.
- The five scale tests assert both halves of the rule: the strip has no `.compact-ui` ancestor, and the data areas carry the class (`ProjectPanel` and `Timeline` in `CustomColumnGates.test.tsx` and `Timeline.scroll.test.tsx`, because `GanttContainer.defaultPanel.test.tsx` mocks them).
