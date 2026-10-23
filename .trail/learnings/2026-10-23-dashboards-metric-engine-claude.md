---
title: "Dashboards (2.1.0): own metric engine over planned bookings, working days per project site, one-shot Overview seed, the first lazy view"
author: Claude
date: 2026-10-23
branch: feat/dashboards
cost: { minutes: 0, tokens: 0 }
touches:
  - app/services/metrics.py
  - app/schemas/dashboard.py
  - app/routers/dashboards.py
  - app/services/dashboard_access.py
  - app/services/dashboard_seed.py
  - app/services/tenant_manager.py
  - app/services/tenant_provisioner.py
  - app/scripts/init_db.py
  - migrations/add_dashboards.sql
  - shared/metric-matrix.json
  - tests/sqlite_support.py
  - frontend/src/utils/metrics.ts
  - frontend/src/stores/dashboardStore.ts
  - frontend/src/components/layout/MainLayout.tsx
  - frontend/src/components/common/ErrorBoundary/ErrorBoundary.tsx
  - frontend/src/components/views/DashboardsView/charts/EChart.tsx
  - frontend/src/components/views/DashboardsView/DashboardGrid.tsx
  - frontend/vite.config.ts
---

## Decided
- **Own metric builder + Apache ECharts 6.1.0 + react-grid-layout 2.3.0**, not Graphic Walker: its last React-18 build is 0.4.82 (later releases are React 19 only, with an open breakage report), ~1.4 MB gzip, a Tailwind UI in a Shadow DOM our tokens cannot style, a Kanaries logo unless a white-label licence is bought, and no open PostgreSQL translator for its server-compute mode. Our engine is ~1 module and themes from the tokens.
- **Booked time = planned bookings**: approved rows at the three levels, Σ allocation / 100 × working days of (span ∩ period ∩ bucket); weeks = days / 5. Pending bookings excluded; absences and closures do not subtract (v1).
- **Working day = Mon–Fri minus the bank holidays of the *project's* site** (multi-day rows expanded to weekdays; site-less projects skip weekends only). Counted **arithmetically** per bucket (weekday arithmetic + a sorted per-site holiday list with `bisect`), never by expanding days.
- **Booking spans are clipped to their card** (`effective_dates` then clip): legacy segments can lie outside the card and must not count there.
- **Aggregation in Python over one bulk load** (`load_facts`, then the pure `aggregate`); `/data` loads once for the union of its widgets' periods and filters per widget; caps `MAX_FACT_ROWS` 200 000 (422 *Narrow the filters*) and five-year periods. `all` = extent of the projects in scope, per archived mode, and when > 5 years it ends ≤ today + 365 d (planning data is in the future) and starts five years before.
- **Distinct / non-additive measures** (`booking_count`, `people_booked`, `project_count`, `project_volume`, `phase_count`) recompute total, *Other* and percent denominators over distinct facts — a project with two tags counts in both rows, once in the total. `project_volume` / `people_booked` refuse a `period` dimension.
- **One-shot seed gated on table creation**: the auto-migration step (after RBAC — `dashboard_roles` → `roles`) seeds the Overview and backfills `views.dashboards` (superuser, user) / `dashboards.manage` (superuser) only in the run that creates the tables, so an admin's deletion or revocation is never undone. `init_db` probes first for the same reason (AUTO_INIT_DB re-applies the schema on every start).
- **`shared/metric-matrix.json` is a second generated mirror** beside `permission-keys.json`: `metrics.metric_matrix_json()` writes it, `tests/test_metric_matrix.py` fails when stale, `utils/__tests__/metrics.test.ts` compares the hand-written frontend `MATRIX` with it (imported by the test, never at runtime).
- **The Dashboards view is the app's first lazy view** (`lazy()` in `MainLayout`, inside `Suspense` + the first `ErrorBoundary` with Retry), kept out of the `components/views` barrel so ECharts and the grid stay in `DashboardsView-*.js` (~229 kB gzip); the main chunk grew ~2.4 kB.
- **Tests mock `echarts/core`** with a fake instance (`setOption` / `resize` / `dispose` / `setTheme` spies) so `EChart.tsx` is covered in jsdom; the grid runs for real (mocked container width); `ResizeObserver` is stubbed in `src/test/setup.ts`. Backend route and loader tests run on in-memory SQLite through `tests/sqlite_support.py` (an `AsyncSession` facade; aiosqlite is not a dependency).

## Tried and ruled out
- Graphic Walker (see above); SQL-side aggregation (the per-site holiday rule and distinct recomputation are simpler and testable as pure Python; volumes per tenant are small).
- Expanding every booking into days for the working-day count: O(days) per fact; arithmetic + `bisect` is O(log holidays).
- Re-seeding the Overview on every pool creation (`ON CONFLICT` alone): it would resurrect a deleted Overview and re-grant revoked keys.
- `gridConfig` on rgl's `Responsive`: 2.3.0 omits it — `rowHeight` / `margin` are top-level props; `useContainerWidth()` needs `measureBeforeMount: true`, else the first render uses width 1280.
- ECharts dispose + re-init on a theme switch: 6.x has `chart.setTheme()`; the option is rebuilt too because series colours come from the palette.

## Watch out
- **Running `add_dashboards.sql` by hand before 2.1.0 first starts** creates the tables, so the auto-migration seeds neither the Overview nor the grants. Let the app upgrade the tenant; the file header, `migrations/README.md` and `docs/admin-guide/database.md` say so.
- **Custom roles get no dashboard key from the backfill** — an admin grants `views.dashboards` in Settings → Roles.
- `/api/dashboards/query` and `/{id}/data` are POST **reads**: they must stay in `BroadcastMiddleware.SKIP_PATTERNS`, or two open viewers reload each other forever.
- Seed SQL binds every value (no JSON literal in `text()`: `:0` inside JSON becomes a bind) and uses two bind names where a value repeats (asyncpg infers one type per `$n`).
- The partial unique index `dashboards_one_default` needs both `postgresql_where` and `sqlite_where` on the ORM `Index`, or the SQLite-backed tests allow two defaults.
- rgl fires `onLayoutChange` on mount and compaction: the editor compares positions and returns the same state when nothing moved, or a freshly opened dashboard reads dirty.
- A `change:dashboard` while a draft is open is held back (`dashboardStore.editing`) and replayed after; concurrent edits of one dashboard are last-write-wins.
