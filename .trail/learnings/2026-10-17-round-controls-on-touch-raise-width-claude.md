---
title: "Round controls on touch: raise width with height (Skills colour picker stretched on iPad)"
author: Claude
date: 2026-10-17
branch: fix/ui-guidelines-debt-1
cost: { minutes: 14, tokens: 150545 }
touches:
  - CHANGELOG.md
  - UI_GUIDELINES.md
  - frontend/src/components/gantt/Timeline/Timeline.tsx
  - frontend/src/components/gantt/Timeline/__tests__/Timeline.scroll.test.tsx
  - frontend/src/components/gantt/index.ts
  - frontend/src/components/gantt/utils/__tests__/timeline.test.ts
  - frontend/src/components/gantt/utils/index.ts
  - frontend/src/components/gantt/utils/timeline.ts
  - frontend/src/components/settings/__tests__/SkillsPanel.test.tsx
  - frontend/src/components/settings/panels/SkillsPanel.module.css
---

## Decided
- There is one colour picker, `components/settings/panels/ColorSwatchPicker` (radiogroup of round radio swatches, 28 px, 40 × 40 on `(hover: none) and (pointer: coarse)`, `allowCustom` for a native colour input). Skills now uses it with `SKILL_COLOR_SWATCHES` (a `ColorSwatch[]` in utils/colorSwatches.ts); the panel's own swatch buttons and raw `<input type="color">` are gone. Documented in UI_GUIDELINES §3.2 and §7.
- `findTodayCell(cells)` in gantt/utils/timeline.ts is the one "where is today" lookup: the `isToday` cell, else the first cell after today (`exact: false`). Week/Month views drop weekend cells while weekends are hidden, so on a Saturday/Sunday nothing was `isToday` and the Today button and the today line did nothing; all four timelines (Gantt, Staff, Equipment, Cross-site) now go through `calculateTodayCenterScrollLeft`.

## Tried and ruled out
- Fixing only the shared picker (an earlier session did): any hand-rolled copy of a round control keeps the bug, because global.css raises only `min-height` on touch.

## Watch out
- A round button on touch must grow in both dimensions or it becomes an oval. Either copy ColorSwatchPicker's width rule or exclude the class from the touch rule.
- Reproduce weekend-today bugs with `vi.useFakeTimers()` + `vi.setSystemTime(new Date(2026, 9, 17))` (a Saturday) and `showWeekends=false` cells.
