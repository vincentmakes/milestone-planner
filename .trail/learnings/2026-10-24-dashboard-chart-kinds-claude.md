---
title: "Dashboards (2.1.0): nine widget kinds — widening an unreleased CHECK in place, the gauge scale, heatmap and sankey rules, and the order of a standalone demo seed"
author: Claude
date: 2026-10-24
branch: feat/dashboards
cost: { minutes: 0, tokens: 0 }
touches:
  - app/models/dashboard.py
  - app/schemas/dashboard.py
  - app/services/tenant_provisioner.py
  - app/services/tenant_manager.py
  - app/services/dashboard_seed.py
  - app/services/demo_seed.py
  - migrations/add_dashboard_widget_kinds.sql
  - migrations/add_dashboards.sql
  - setup_databases.sql
  - scripts/sql/tenant_schema_template.sql
  - tests/test_dashboard_widget_kinds_schema.py
  - tests/test_tenant_manager_more.py
  - frontend/src/components/views/DashboardsView/charts/toOption.ts
  - frontend/src/components/views/DashboardsView/charts/EChart.tsx
  - frontend/src/components/views/DashboardsView/builder/widgetDraft.ts
  - frontend/src/components/views/DashboardsView/builder/WidgetEditor.tsx
  - docs/user-guide/dashboards.md
---

## Decided
- **An unreleased CHECK is widened in place, plus a self-gated block for pre-release databases.** 2.1.0 had not shipped, so the fresh sources and `add_dashboards.sql` carry the nine kinds directly (`DASHBOARD_WIDGET_KIND_CHECK`, spliced into `DASHBOARD_WIDGETS_TABLE_SQL` from `DASHBOARD_WIDGET_KINDS`). Databases created from the pre-release branch get `DASHBOARD_WIDGET_KIND_CHECK_SQL`: a DO block gated on the constraint lacking the **last** kind (`sankey`), DROP then ADD, no UPDATE, shipped only as `migrations/add_dashboard_widget_kinds.sql` and in the auto-migration's own try right after the visibility block (the `dashboards_visibility_check` precedent). A failure logs an **error** naming the file, since a gauge save would then hit the old CHECK. The six scripted fake connections of the schema tests and both COMMIT counts of `test_tenant_manager_more.py` learn every new auto-migration statement.
- **The server validates the query, the builder owns the kind rules** (`widgetDraft.ts`: gauge 0 dimensions, heatmap and sankey exactly 2, treemap 1–2, no period and no `NO_PERCENT_MEASURES` on treemap / sankey — `SUMMED_KINDS`). A shape the API accepts but the builder never makes is drawn with a defined fallback, and `hasDrawableData` turns a chart with nothing to draw into "Nothing to show for this period."
- **Gauge scale** (`gaugeScale`): `min = min(0, value)`; percent → `max = max(120, ceil10(value), ceil10(target))`, other units → the next 1/2/5 × 10ⁿ above `max(target × 1.25, value × 1.1, 1)`. Bands green below the target, amber up to 100 % (percent) or target × 1.15, red beyond; a target ≥ 100 % leaves no amber band; no target = one colour. Stops are fractions from `min`, the band boundary is compared as a value, not as a float product.
- **Heatmap**: a `period` dimension is always the x axis (sorted by key — row order is not chronological), otherwise dimension 1 rows / dimension 2 columns; both axes `category` with `boundaryGap: true` and a `visualMap` (ECharts 6 requires both); a null cell is left out (the background shows "no data"). Cell values show only when `heatmapLabelsFit` finds 44 × 20 px per cell **after** the row labels and grid (144 px) and the scale plus column labels (88 px) — measured on the whole chart, "116.7 %" overflowed its cell just above the threshold.
- **Sankey nodes carry `id: '1:' + key` / `'2:' + key`** (a value on both sides stays two nodes); `top_n` ranks the first dimension, so "the eight busiest projects + Other → teams" is `[project, team]`, `top_n = 8`.
- **Standalone demo seed order**: `insert_demo_dashboards(conn, field_ids)` writes a dashboard's widgets only in the run that creates it, so it is idempotent and safe on a seeded tenant. On an upgraded demo, open `/t/demo` once first (the pool creation runs the auto-migration and widens the CHECK), confirm `pg_get_constraintdef` lists `sankey`, then run the snippet (`asyncpg.connect` like `seed_demo.apply_schema_and_seed`, inside `conn.transaction()`). Never `down -v` to get the new seed.

## Tried and ruled out
- **Treemap `width: '100%'` / `height: '100%'`** (ECharts' default box is 80 % and centred): after a `resize()` ECharts keeps the centring offset of the first size, so the boxes slide right and down and are cut by the canvas (seen live only — SSR renders at one size). Pinned with `left/top/right/bottom: 0`; `realECharts.test.ts` resizes and checks `layoutInfo`.
- **ECharts' default sankey `right: '20%'`**: on a ~540 px card the second column's labels (right of their nodes, up to 120 px) are cut by the canvas. `right: SANKEY_LABEL_WIDTH + 8`.
- Two-level treemap `levels` written as "parents, children": ECharts' virtual root is level 0 (see `2026-10-24-dashboard-echarts-new-kinds-claude.md`).

## Watch out
- A new widget kind goes **last** in `DASHBOARD_WIDGET_KINDS`: the widening gate looks for `DASHBOARD_WIDGET_KINDS[-1]`.
- The demo projects have **no volume**: a treemap of `project_volume` reads "Nothing to show for this period." on the demo — correct, not a rendering bug.
- The gauge of `utilisation` needs `views.staff` like every capacity measure; a custom role without it sees the permission message on that tile.
- Option-shape unit tests cannot catch layout traps (resize offsets, clipped labels): look at the live chart, then pin it in `realECharts.test.ts`.
