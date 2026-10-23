---
title: "Project fields (2.0.0): a separate model from custom columns; tag groups converted into dropdown fields and dropped"
author: Claude
date: 2026-10-23
branch: feat/project-fields
cost: { minutes: 0, tokens: 0 }
touches:
  - app/models/project_field.py
  - app/routers/project_fields.py
  - app/schemas/project_field.py
  - app/services/project_field_rules.py
  - app/services/tag_rules.py
  - app/services/team_rules.py
  - app/services/tenant_provisioner.py
  - app/services/tenant_manager.py
  - app/services/instance_settings.py
  - app/routers/projects.py
  - app/routers/export.py
  - migrations/add_project_fields.sql
  - frontend/src/utils/projectFields.ts
  - frontend/src/utils/projectFilters.ts
  - frontend/src/utils/tags.ts
  - frontend/src/stores/viewStore.ts
  - frontend/src/hooks/useProjectFilter.ts
  - frontend/src/components/common/ProjectFilterDropdown/ProjectFilterDropdown.tsx
  - frontend/src/components/common/OptionPicker/OptionPicker.tsx
  - frontend/src/components/settings/panels/ProjectFieldsPanel.tsx
  - frontend/src/components/modals/ProjectFieldInputs.tsx
  - scripts/screenshots/capture.py
  - CLAUDE.md
---

## Decided
- Project fields are their **own model**, not a variant of the Gantt custom columns: `project_fields` (type `text`/`number`/`toggle`/`select`/`multiselect`, immutable), `project_field_options` (items, scoped to sites/teams exactly like tags via `project_field_option_sites` / `_teams`), `project_field_values` (one row per text/number/toggle value) and `project_field_selections` (the `project_tags` shape). Custom columns stay cells on project/phase/subphase rows; the two share nothing.
- **Tag groups were converted, then removed** — hence **2.0.0** (breaking: `/api/tag-groups`, `tags.group_id`, `tag_groups` gone). One DO block (`PROJECT_FIELDS_MIGRATION_SQL`, in `migrations/add_project_fields.sql` and the tenant auto-migration, never in the fresh-schema sources) runs only while `tag_groups` exists: group → field (`single_select` → `select`, else `multiselect`; a clashing name gets ` (tags)`, ` (tags 2)`…), grouped tag → item with its colour, order, `all_sites`, sites and teams, each `project_tags` row → a selection; then the grouped tags are deleted, the rest renumbered, and the column/table dropped. The migration is **linked**: projects keep exactly what they had selected. Verified live on the demo volume (1.17.0 → 2.0.0): "Project type" (select: Internal, Customer) and "Area" (multiselect: Process, Analytics, QA) with all 9 selections; Settings → Tags shows Critical / Tech Transfer / GMP only.
- Built-in Customer / Sales PM / Volume can be renamed and hidden instance-wide (`project_field_labels` / `project_fields_hidden` in `KNOWN_SETTINGS`); **Confirmed is never hidden** (it drives stripes, ordering and counts; `confirmed` in the hidden list is a 422). Hidden = UI only: values stay stored and writable.
- `field_values` wire shape: `{"<field id>": value}`, absent = empty, masked cross-site rows `{}`; unknown field and item ids are dropped silently (What-If replay, like unknown tag ids). Field values never notify.
- The Gantt/Kanban **Filter** shape changed: `viewStore.projectFilters` `{optionIds, noneFieldIds, tagIds}` (OR within a field, AND across fields + one tag bucket). Group by = dropdown fields; Colour by = dropdown fields + `'tags'`. Only fields with an item at the site are offered.

## Tried and ruled out
- Reusing custom columns for project fields: they are per-row Gantt cells with site-scoped definitions and EAV values — no per-item colour, no site/team scoping, no project-dialog editing.
- Keeping tag groups alongside fields: two ways to express the same categorisation, and the filter/group/colour code paths would have to merge both.
- A 400 for an unknown field id in `field_values`: a What-If replay after a field delete would then fail on Apply.

## Watch out
- **One-off view-store reset**: `viewStore` persist `version` 0 → 1 (`migrateViewState`) drops `tagFilters`, `ganttGrouping`, `ganttColorBy` and `collapsedGanttSections` once — an old tag-group id could collide with a new field id. Never re-add those fields to a version-0 payload path; bump the version again for the next shape change.
- `TAGS_UPGRADE_SQL` still carries the `tags.group_id` block (ruled for databases older than the 1.6 tag columns), **guarded by `tag_groups` existing** — unguarded it fails on every 2.0.0 schema. Don't add `group_id` / `tag_groups` back to a fresh source.
- The built-in field settings are saved through `PUT /settings/{key}` (`settings.general`), while the panel is gated on `project_fields.manage`: a custom role holding only the latter can open the panel but not save the built-in block.
- Screenshot pipeline: the `project-filter` shot scrolls the Filter panel to its Tags section (the panel's max height cuts the first field heading); `OptionPicker` opens on click / typing / ArrowDown, not on focus — click it in capture scripts.
