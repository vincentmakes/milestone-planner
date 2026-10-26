---
title: "Date range picker: react-day-picker in a fixed panel inside the Modal, our click rules in onDayClick, --rdp-* only set"
author: Claude
date: 2026-10-22
branch: feat/date-range-picker
cost: { minutes: 0, tokens: 0 }
touches:
  - frontend/src/components/common/DateRangeField/DateRangeField.tsx
  - frontend/src/components/common/DateRangeField/DateField.tsx
  - frontend/src/components/common/DateRangeField/DatePickerPopover.tsx
  - frontend/src/components/common/DateRangeField/dateRangeLogic.ts
  - frontend/src/components/common/DateRangeField/computePopoverPosition.ts
  - frontend/src/components/common/DateRangeField/DateRangeField.module.css
  - frontend/src/test/datePicker.ts
  - frontend/src/utils/date.ts
---

## Decided
- Every model date goes through `DateRangeField` / `DateField` (react-day-picker 10.0.2, MIT). Values cross the boundary as `YYYY-MM-DD` strings (`''` = none), never `Date`s; the field text is `formatMediumDate`. The click rules are pure (`dateRangeLogic.ts`): first click start, second end; a start after the end moves the end keeping the duration, an end before the start becomes the new start. One `onChange({start, end})` per click so a shift is atomic.
- The panel is `position: fixed` but rendered inside the fields' wrapper, never in a portal. Fixed escapes the Modal body's `overflow-y: auto`; staying in the subtree keeps the Modal's Tab trap, `aria-modal`, `aria-controls` and `useDismissableOverlay`'s `wrapperRef.contains` working unchanged. Placement is computed in a layout effect and again on resize and on a capture-phase scroll (rAF-throttled); it re-measures on `active` because the status row changes the height; the panel closes when the fields scroll out of view.
- DayPicker only paints: `selected` controlled with `onSelect={noop}` (without an `onSelect` it reads `selected` once and keeps its own selection) and our rules run in `onDayClick`. Hover preview is a separate `preview` modifier so `aria-selected` never flickers; a click clears it (touch never sends mouseleave).
- Always pass `startMonth` / `endMonth` (today ± 10 years, widened to the values): with the dropdown caption and no `endMonth`, navigation stops at the end of this year.
- No `autoFocus`: it ranks selected over today, and in range mode every day of the range is selected, and it also fires on mouse opens. A keyboard open (a `focusRequest` counter, 0 for a mouse open) focuses `td[data-day="<active>"]:not([data-outside]) button` from an effect; that button's `onFocus` syncs DayPicker's focus state so arrows work. Never change `month` programmatically while open.
- DayPicker's `footer` renders inside `role="status" aria-live="polite"`: only the status text ("Now pick the end date") goes there; the Clear button lives in our own footer outside DayPicker, `type="button"` (the shared Button has no default type).
- The wrapper is `display: contents`, so the two fields and the separator stay grid items of the consumer's `minmax(0, 1fr)` row; `fieldClassName` carries the item class.
- The Settings holiday/event forms pass `markSiteCalendar={false}`: the marks come from the header site in `appStore`, and those forms may edit another site.
- Tests find fields by their exact label and assert `data-value` (the ISO value), never the locale text; `src/test/datePicker.ts` (`pickRange`, `pickDate`, `pickEnd`, `dateValue`) navigates through the first month's "Choose the Year" then "Choose the Month" dropdowns (in that order: months outside the range are disabled) and clicks the day in a cell of its own month.

## Tried and ruled out
- Reading a `--rdp-*` property in our CSS: `cssTokens.test.ts`'s regex stops at `_` and reports `var(--rdp-day_button-width)` as an undefined `--rdp-day`. Only SET `--rdp-*` (on `.panel .calendar`, which wins over the library's `.rdp-root` whatever the load order).
- A portal for the panel: it leaves the Modal subtree, so the Tab trap and the outside-click/blur dismissal treat the calendar as outside.

## Watch out
- `react-day-picker/style.css` is imported once, in `DatePickerPopover.tsx`; don't import it elsewhere.
- Outside-day cells carry the neighbouring month's `data-day`: always select with `:not([data-outside])`.
- Pre-existing, out of scope: the Modal records React's `autoFocus`ed name input as the opener, so its focus restore on close does nothing.
