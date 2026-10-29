---
title: "Hidden completion badges reach the slider through uiStore.completionSliderFor; site delete refuses the last active site under a FOR UPDATE lock"
author: Claude
date: 2026-10-28
branch: feat/feedback-2
cost: { minutes: 0, tokens: 0 }
touches:
  - frontend/src/components/gantt/ContextMenuContainer.tsx
  - frontend/src/components/gantt/ProjectPanel/PhaseRow.tsx
  - frontend/src/components/gantt/ProjectPanel/SubphaseRow.tsx
  - frontend/src/stores/uiStore.ts
  - app/routers/sites.py
  - frontend/src/components/settings/panels/SitesPanel.tsx
  - frontend/src/contexts/wsSlices.ts
---

## Decided
- **`gantt_completion_badges`** (KNOWN_SETTINGS boolean, default true) hides only the % badges of ProjectRow / PhaseRow / SubphaseRow. The slider stays reachable through the phase / subphase context menu's **Set progress…**, shown always (also with badges on), with the badge click's guards (editors only; disabled with "Calculated from children").
- **The slider needs an anchor element** (`CompletionSlider` positions from `anchorEl`), and the menu has none. The menu sets `uiStore.completionSliderFor = {level, id}`; each row subscribes with a **boolean** selector (`… level === 'phase' && id === phase.id`, so only the matching row re-renders), anchors the slider to its name element (phase type badge / subphase name span) and clears the request. The fallback (open the Kanban card dialog) was not needed.
- `effectiveCompletion()` now lives once in `components/gantt/utils/completionStatus.ts` (PhaseRow and SubphaseRow import it; ProjectRow and ShiftTooltip still carry their own copies).
- **Last active site**: `DELETE /sites/{id}` of an *active* site locks every active site row `FOR UPDATE` in id order, then 409s when no other one is left. Under READ COMMITTED the second of two concurrent deletes waits, re-evaluates and no longer sees the first's (deleted) row. Deleting an inactive site takes no lock (it never lowers the count) — which also keeps the older site-delete tests' `Site(...)` fixtures (no `active`) on their old statement order.
- After a site delete the panel calls `loadAllData()` (it falls back to the first visible site); the `site` WebSocket slice now also reloads `currentUser` and `staff`, so other users whose only site vanished are re-evaluated.
