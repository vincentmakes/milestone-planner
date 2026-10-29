---
title: "Volume is a built-in column with its own decimals setting, not a project field"
author: Claude
date: 2026-10-29
id: l-ad4e31da
scope: repo
status: active
src: agent
touches:
  - app/services/instance_settings.py
  - app/routers/projects.py
  - app/routers/export.py
  - frontend/src/components/modals/ProjectFieldInputs.tsx
  - frontend/src/components/modals/ProjectModal.tsx
  - frontend/src/components/settings/panels/ProjectFieldsPanel.tsx
  - frontend/src/utils/instanceSettings.ts
  - frontend/src/utils/projectFields.ts
---

## Decided
- **Volume's format is the instance setting `volume_decimals`** (`any` / `0`–`3`, default `1`) in `KNOWN_SETTINGS`, not a `project_fields.decimals` row: `projects.volume` is a built-in Float column (`BUILT_IN_PROJECT_FIELDS`), so it reuses `_choice` and joins `PROJECT_FIELD_SETTING_KEYS` (Settings -> Project fields saves it with `project_fields.manage`). Readers never raise: `volume_decimals_from` (server) and `volumeDecimals` (client) read a missing or malformed row as 1.
- **The server rounds Volume with `round_field_number`** on `POST /projects` and `PUT /projects/{id}` (setting read only when `volume` is sent) and in the site export's Projects sheet; stored values are never rewritten, like custom number fields. `ProjectModal` no longer `parseInt`s the volume (12.7 used to be saved as 12).
- **One number input for both**: `NumberFieldInput` in `ProjectFieldInputs.tsx` (exported, used by `ProjectModal` for Volume). Its controlled `onChange` is gated by `acceptsNumberText(text, decimals)` in `utils/projectFields.ts`, so a keystroke past the format never lands (React restores the controlled value); blur still pads (12 -> 12.0).

## Tried and ruled out
- Rounding a pasted `1.005` on blur at 2 decimals: the gate now refuses the paste outright, so blur only pads. The old ProjectModal test that expected `1.01` was changed to expect the value unchanged.
- A jsdom test typing `1e400` into the Volume box to reach the non-finite guard: jsdom sanitises it to `''` (as browsers do). The guard is reached with a stored `volume: Infinity` instead.

## Watch out
- **Every PUT /projects test that sends `volume` now needs one more `db.execute` result** (the `volume_decimals` read after the project, and after the PM lookup when the PM changes): `test_change_notification_routes.py` (ECHO sends volume) and `test_projects_routes_more.py`.
- The ProjectFieldsPanel number-format tests query "Format" labels and previews: the Volume row has its own picker now, so they are scoped to the "Custom fields" region.
