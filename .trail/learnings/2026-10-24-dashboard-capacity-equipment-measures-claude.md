---
title: "Dashboards (2.1.0): measure families, composites over two fact lists, capacity per person and equipment availability, delivery by due date"
author: Claude
date: 2026-10-24
branch: feat/dashboards
cost: { minutes: 0, tokens: 0 }
touches:
  - app/services/metrics.py
  - app/services/absence_patterns.py
  - app/schemas/dashboard.py
  - app/routers/dashboards.py
  - shared/metric-matrix.json
  - app/scripts/demo_data.py
  - tests/test_metrics.py
  - tests/test_metrics_loader.py
  - tests/test_demo_data_dashboards.py
  - frontend/src/utils/metrics.ts
  - frontend/src/utils/recurringVacation.ts
  - frontend/src/contexts/wsSlices.ts
  - frontend/src/components/views/DashboardsView/builder/WidgetEditor.tsx
  - frontend/src/components/views/DashboardsView/builder/widgetDraft.ts
  - frontend/src/components/views/DashboardsView/charts/toOption.ts
---

## Decided
- **Five measure families** (`FAMILY`: booking, project, phase, capacity, equipment) carry everything a measure differs by: its facts (`_items` dispatches on the base measure's family, the rules on the asked one's), its filters (`FAMILY_FILTERS` + `MEASURE_FILTER_OVERRIDES` → `MEASURE_FILTERS`; another filter with a non-default value is a 422), its permission (`MEASURE_NEEDS`: capacity → `views.staff`, equipment → `views.equipment`, beside the dimension `NEEDS` and the `FILTER_NEEDS`). `MEASURES` lists them in family order and the editor groups the list by family.
- **Composites are two sides of one contribution list**: `COMPOSITES` maps utilisation / available days / people over capacity to (`booked_days`, `capacity_days`) and equipment utilisation to (`equipment_booked_days`, the internal `equipment_available_days`, never in `MEASURES` or the JSON); `aggregate` runs the item loop once per side (`_Contribution.side`, `subject` = person / equipment id) and `COMPOSITE_RULES` folds each group, so top N, *Other*, empty buckets and the per-person "over capacity" test reuse the existing code. Booked time over zero capacity → `None` (JSON `null`, the client "–"), nothing at all → 0.
- **Capacity is the person's, not the project's**: every active `is_resource` member of a visible site, weekdays minus `person_off_days` (holidays of any of their sites, unavailable absences, closures by the exact `getClosureOn` rule), × `max_capacity`. Site / team / person on **both** sides read the capacity fact, so a team's utilisation is the weighted team figure and a two-site person sits in both site rows, once in the total. The booked side still comes from the project-scoped bookings (visible sites).
- **Equipment availability is the equipment's** (holidays of its sites, its blocks); booked days stay whole working days of the project's site. Overlaps and bookings inside a block add up — over 100 % is the conflict signal, never clamped.
- **Recurring absences parsed on the server**: `app/services/absence_patterns.py` mirrors `recurringVacation.ts` (0 = Sunday, `isoweekday() % 7`), one `PATTERN_CASES` table on both sides.
- **Families load lazily**: the router passes `measure_families` of the widgets to `load_facts`, so the Overview loads no capacity or equipment facts; absences and equipment bookings count toward `MAX_FACT_ROWS`.
- **Delivery**: `phases_due` files a phase once on its end (milestone: its date), `phases_overdue` = due before today and not done; the `status` dimension follows the Kanban columns.
- **`NO_PERCENT_MEASURES`** (both utilisations, available days) refuse `percent_of`; a KPI of them has no dimension (the weighted figure) — every KPI share path keys on `percent_of`, so the builder drops the dimension instead.

## Tried and ruled out
- Site and team of a capacity measure from the **project** on the booked side: a person booked at another site's project would land in a row where they have no capacity (utilisation ∞).
- A per-site reading of `getClosureOn` (team limits only at the event's own sites): the heatmap's code restricts by the event's teams at any shared site; ported exactly so the two agree.
- Demo figures "whatever day it is seeded": with the demo's relative dates, `utilisation` by team for **this quarter** depends on where today falls in the quarter (late in a quarter the window is mostly past, which the demo plans lightly — two absence weeks move a team by ~5 points), and **HPLC System 1 over 100 % for this year** would need ~250 booked days on one instrument. The demo tests assert the quarter story only for a quarter seeded early, the over-capacity team on `next_month` (true for every seed day), and the conflict over the days the two HPLC bookings share.

## Watch out
- `tests/demo_data_snapshot.json` predates the eight extra projects: their rows (phases included) are not in it, so changing them does not fail the "only added rows" guard — the canonical rows are what it protects. Never regenerate it.
- `test_demo_data.py` pins exactly **two** HPLC System 1 bookings (the Gantt overlap screenshot); add instrument time on other equipment.
- The phase measures read **top-level phases only**; the demo's milestones are subphases, so *Milestones = Only* is empty on the demo.
- Capacity booked side vs capacity side: a person seen through site A whose bookings are on a project at a site the viewer cannot see reads low. Documented in the user guide; do not "fix" it by loading the hidden project.
- The Staff heatmap is per day and ignores bank holidays, the dashboard counts both — the two do not agree to the day.
