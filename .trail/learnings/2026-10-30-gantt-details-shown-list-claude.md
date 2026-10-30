---
title: "Configurable Shift-hover project details: a shown-list setting, render-time gating, a measured clamp"
author: Claude
date: 2026-10-30
branch: feat/dashboards
cost: { minutes: 0, tokens: 0 }
touches:
  - app/services/instance_settings.py
  - frontend/src/utils/instanceSettings.ts
  - frontend/src/utils/projectFields.ts
  - frontend/src/components/gantt/ShiftTooltip/ShiftTooltip.tsx
  - frontend/src/components/settings/panels/ProjectFieldsPanel.tsx
  - frontend/src/components/settings/__tests__/ProjectFieldsPanel.test.tsx
---

## Decided
- **`project_tooltip_rows` is a shown-list, not a hidden-list.** Built-in row keys (`PROJECT_TOOLTIP_ROWS` in `app/services/instance_settings.py`, mirrored in `frontend/src/utils/instanceSettings.ts`) plus custom project field ids. Only a shown-list can say "a field added later starts off"; the default string is exactly the rows the tooltip had before 2.3.0, so a tenant that never saves sees no change. Canonical form is keys in display order then ids ascending, which `JSON.stringify` and the compact `json.dumps` give byte for byte, so the panel's dirty check compares strings.
- **Field ids are not checked for existence** (the module rule). The panel keeps a deleted field's id in both its saved and edited rows so opening it never reads dirty, and drops unknown ids only when it saves; `ShiftTooltip` skips ids it has no field for.
- **Gating happens once, at render** (`isTooltipRowShown`): the hover handler gathers every value, so a `change:settings` refetch re-renders an open tooltip without a new hover. A built-in field hidden by `project_fields_hidden` is never shown even when listed; the saved list keeps the key.
- **The Status row became the Confirmed field row**: `builtInFieldLabel(settings, 'confirmed')` + `Yes` / `No` (the words a custom toggle gets, and the site export's), because the old "Status: Confirmed / Unconfirmed" ignored the rename.
- **Viewport clamp is measured**, not a hard-coded 340 px: a `useLayoutEffect` on `tooltipData` reads `offsetWidth` / `offsetHeight` (they ignore the fade-in `translateY`) and writes `style.left/top` as `max(8, min(x + 15, inner - size - 8))`. jsdom measures 0, so the clamp test stubs `HTMLElement.prototype.offsetHeight` and `window.innerHeight`, and gives the bar a tall `getBoundingClientRect` so the pointer can sit low.

## Watch out
- **`ProjectFieldsPanel.test.tsx` traps**: the new section repeats every field name, so `findByText('Project type')` became ambiguous — the helper and four inline waits now use `findByTestId('field-1')`. The Gantt details rows use `details-*` test ids (the custom-fields test matches `/^field-/`), the switches are named `Show <caption> in Gantt details` (no clash with `Show Customer`), and the section's buttons carry `aria-label` `Save Gantt details` / `Reset Gantt details` (other tests click the exact names `Save`, `Save Changes`, `Reset`).
