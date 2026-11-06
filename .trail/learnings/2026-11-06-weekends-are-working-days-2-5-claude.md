---
title: "Weekends are working days (2.5.0): one mirrored working-day rule, a default-off flag that is not a switch"
author: Claude
date: 2026-11-06
branch: feat/weekends-and-polish
id: l-04a7d951
scope: repo
status: active
src: agent
touches:
  - app/services/metrics.py
  - app/services/instance_settings.py
  - frontend/src/hooks/useWorkloadCalculation.ts
  - frontend/src/components/views/StaffView/__tests__/StaffView.test.tsx
  - frontend/src/components/layout/ResourcePanel/__tests__/ResourcePanel.test.tsx
---

## Decided
- **One working-day rule, mirrored**: `app/services/working_days.py` (`is_working_day`, `count_working_days` — arithmetic plus a bisect slice of the off days, never a walk —, `WORKING_DAYS_PER_WEEK` {False: 5, True: 7}) ↔ `frontend/src/utils/workingDays.ts` (`isWorkingDay`, `countWorkingDays`, `workingDaysPerWeek`), `WORKING_DAY_CASES` + `COUNT_CASES` copied verbatim with length assertions. An off day that is no working day (a Saturday holiday with weekends off) takes nothing away, so callers may pass unfiltered holiday sets.
- **`weekend_working_days` is NOT a switch**: default off, read `value.strip().lower() == "true"` (`weekends_working_from`) / `=== 'true'` (`selectWeekendsWorking`), because `flag_enabled` / `isSettingOn` would turn it on for a missing or stray row and change every dashboard number. Kept out of `SwitchSettingKey` and `FLAG_DISABLES`.
- **Applied once on the server**, in `load_facts` (`Facts.weekends_working`), passed keyword-only with default `False` to `expand_holidays`, `person_off_days`, `equipment_off_days`, `absence_weekdays`, then `WorkingCalendar(holidays, weekends_working)`; `_amount` divides weeks by `calendar.days_per_week`. With the flag off every number is the Monday-to-Friday one and the direct test callers need no argument, because the `test_metrics.py` weekend cases pin it.
- **Heatmap precedence nonworking > absence / closure > booking**, decided on `cell.dateStr` because the tests build cells as `{dateStr}`; a nonworking cell carries no assignments, so `workloadRuns` splits around it. The Gantt absence markers apply the rule only at day zoom, because a year-zoom cell is a month judged by its 1st.

## Ruled out
- Reading the flag with `flag_enabled` like the other booleans (the plan's blocker).
- Letting `calculateWorkloadCells` decide on `cell.isWeekend`: test cells have no flags.

## Watch out
- **Tests that render the Staff panel or the resource cards depend on the weekday of the real date**, since a staff card reads *Weekend* on a non-working day: `StaffView.test.tsx` and `ResourcePanel.test.tsx` pin `Date` to a Wednesday at module scope (`vi.useFakeTimers({ toFake: ['Date'], now })`, real timers in `afterAll`); a test there that needs a weekend calls `vi.setSystemTime` and restores the Wednesday in `afterEach`.
- The frontend `=== 'true'` is case-sensitive while the backend lowercases: they agree on every canonical value (the PUT stores `true`/`false`), not on a hand-written `True` row.
