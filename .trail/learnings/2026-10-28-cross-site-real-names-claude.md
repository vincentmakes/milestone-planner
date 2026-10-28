---
title: "Cross-site shows real names for every visible site; the entry is hidden with one site; equipment's [External Project] stays"
author: Claude
date: 2026-10-28
branch: feat/feedback-2
cost: { minutes: 0, tokens: 0 }
touches:
  - frontend/src/components/views/CrossSiteView/CrossSiteView.tsx
  - frontend/src/hooks/useAllowedViews.ts
  - frontend/src/components/layout/MainLayout.tsx
  - app/routers/projects.py
  - app/routers/equipment.py
---

## Decided
- **No more confidential masking** (pilot users' request, 2.1.0): the Cross-site view had masked every site but the current one client-side ("Confidential Project", `***`, bar "Project"), and `GET /projects` had a server `masked()` branch behind `includeOtherSites=true&siteId=` that no frontend code sent. Both are gone; the protection that remains is visibility scoping (`visible_sites_clause`, the `siteId` 403, `views.crosssite` 403 on `includeOtherSites`).
- **`EXTERNAL_PROJECT_NAME` is NOT cross-site masking** and stays: `_booking_project_name` in `app/routers/equipment.py` names the bookings of shared equipment by projects at sites the user *cannot* see (a visibility guard). Its test (`test_bookings_of_shared_equipment_mask_projects_outside`) and docs (routes.md equipment row, auth-and-tenancy.md equipment sentence) stay.
- **Cross-site is hidden, not disabled, below two visible sites** (`useAllowedViews` leaves it out of `visible`; the `disabledReason` / `CROSS_SITE_DISABLED_REASON` plumbing was removed — Navigation was its only consumer).

## Watch out
- With the entry hidden before the data load (no sites yet → zero visible sites), `MainLayout`'s fallback would bounce a persisted `crosssite` to the Gantt on every reload. The fallback now returns early while `appStore.sites` is empty, for **every** view — so a test of the fallback must load sites first (`MainLayout.test.tsx`), and a test that expects the Cross-Site button must put two visible sites in the store (`Sidebar.test.tsx`).
