---
title: "Project fields: one list, instant saves, the cascade reverses the keep-the-key rule"
author: Claude
date: 2026-10-31
id: l-cb06ffb4
scope: repo
status: active
replaces: l-46da1b
src: agent
touches:
  - frontend/src/components/settings/panels/ProjectFieldsPanel.tsx
  - frontend/src/components/settings/useSettingWriter.ts
  - frontend/src/components/settings/panels/ProjectFieldsPreview.tsx
  - frontend/src/components/gantt/ShiftTooltip/DetailsRows.tsx
  - frontend/src/components/gantt/ShiftTooltip/tooltipData.ts
  - frontend/src/utils/instanceSettings.ts
---

## Decided
- **Hiding a built-in field now also removes it from `project_tooltip_rows`** (the cascade in `ProjectFieldsPanel.toggleShown`: two writes, `project_fields_hidden` then the rows without the key). This reverses the 2026-10-30 decision "the saved list keeps the key, so un-hiding brings the row back as it was". Vincent asked that "hidden in the project ⇒ not in the Gantt" be explicit and stored, not only a render rule: with the list edited in the same row as the dialog switch, a Gantt switch that silently comes back on when the field is shown again surprised more than it helped. Showing the field again leaves its Gantt switch off. `tooltipRowGate` (and `isTooltipRowShown`) keep the hidden check anyway, so a half-failed cascade or data written before stays harmless.
- **Every Project fields setting applies at once** through `components/settings/useSettingWriter.ts`: the store first (synchronously, so the switch flips before the PUT), one PUT per key at a time with the newest value queued, the server's answer re-asserted when the key's last PUT lands (a `change:settings` refetch between click and commit would otherwise snap the switch back), on failure the panel's Notice (or `showFlash` after unmount) plus a reload of `getInstanceSettings()`. One writer per panel: the built-in rows and the custom rows both write `project_tooltip_rows`.
- **List values are computed from `useAppStore.getState()` at click time**, never the render closure, and each rows write drops ids of fields not in the loaded list (only when the fields actually loaded, else every id would be pruned).
- **The preview reuses the real tooltip**: `DetailsRows` + `projectTooltipData` were extracted out of `ShiftTooltip.tsx` (all three bar types, a `shows` gate) so the card cannot drift from the Gantt; the `.static` modifier of `ShiftTooltip.module.css` puts it in the page flow (the `.tagPill` raw 11 px may only live under `components/gantt/`).
- **First container query in the repo** (`@container (min-width: 66rem)` on the panel): the hub's section list takes a variable width, so a window `@media` cannot tell whether the preview fits beside the list.

## Watch out
- **The field rows' grid is `.fieldRow`, not `.mainRow`**: the Items editor's rows reuse `.mainRow`, so the plan's CSS on `.mainRow` would have put item rows on the four-column grid.
- **Label drafts are never reported dirty**: the hub's close button blurs the input on mousedown, which writes before `handleClose` runs. jsdom does not do that — tests call `fireEvent.blur`.
- **Escape on a label stops propagation only when the draft differs** from the stored label; an unchanged field must let a first Escape close the hub.
- **The preview body is `aria-hidden`**: role queries in `ProjectFieldsPanel.test.tsx` skip its duplicated names, but `getByText` / `getByLabelText` do not — scope those with `within(screen.getByTestId('pf-preview-body'))` or the row's test id. New row test ids (`gantt-only-*`, `pf-*`) stay clear of `/^field-/` and `builtin-`.
