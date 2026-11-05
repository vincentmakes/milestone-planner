---
title: "Dashboard sharing (2.1.0 round 2): one any-match Shared-with list of roles, sites, teams and people; a separate migration step; the editor draft carries the lists"
author: Claude
date: 2026-10-24
branch: feat/dashboards
cost: { minutes: 0, tokens: 0 }
touches:
  - app/models/dashboard.py
  - app/schemas/dashboard.py
  - app/routers/dashboards.py
  - app/routers/kanban.py
  - app/services/dashboard_access.py
  - app/services/people_lists.py
  - app/services/tenant_manager.py
  - app/services/tenant_provisioner.py
  - migrations/add_dashboard_sharing.sql
  - migrations/add_dashboards.sql
  - tests/test_dashboard_sharing_schema.py
  - frontend/src/components/views/DashboardsView/builder/DashboardDialog.tsx
  - frontend/src/components/views/DashboardsView/builder/useDashboardEditor.ts
  - frontend/src/components/views/DashboardsView/builder/widgetDraft.ts
  - frontend/src/components/views/DashboardsView/SharedWithLine.tsx
  - frontend/src/contexts/wsSlices.ts
---

## Decided
- **One "Shared with" list, any match**: visibility is `private` / `shared` / `everyone` (the pre-release value `roles` became `shared`); a `shared` dashboard holds roles + sites + teams + people together (`dashboard_roles` / `_sites` / `_teams` / `_users`) and a viewer matching **one** of them opens it. Shared access is view only; edit / share / delete stay with the owner holding `dashboards.manage` and admins.
- **A site means its members** (live `user_sites`), not everyone who can see it: a `sites.view_all` holder who is not a member does not match by site (admins see everything anyway). The viewer's scope is resolved once per request (`load_viewer_scope` → `ViewerScope(user_id, is_admin, role_id, site_ids, team_ids)`), sites through `site_access._load_user_site_ids` (raw membership, never the `None` sentinel of `visible_site_ids`). `visible_dashboards_clause` has one `exists()` per kind and is tested to agree with `can_view` on SQLite.
- **The link tables have their own auto-migration step** right after the dashboards step (probe-gated, no seed). Adding them to `DASHBOARD_TABLES` would make the dashboards probe report "missing" on every 2.1.0 tenant and re-run the one-shot Overview seed + permission backfill.
- **The visibility rename is a self-gated DO block** (`DASHBOARD_VISIBILITY_CHECK_SQL`: `dashboards` exists and the CHECK lacks `shared` → DROP CONSTRAINT, UPDATE `roles` → `shared`, ADD CONSTRAINT — the UPDATE between the two) that runs on every pool creation and lives only in the auto-migration step and `add_dashboard_sharing.sql`. 2.1.0 was unreleased, so the fresh sources and `add_dashboards.sql` got the new CHECK in place. Tested textually (SQLite cannot run it).
- **PUT keeps targets already on the dashboard without re-checking them**; only newly added ids must be pickable. Deactivation keeps a `dashboard_users` link (only deletes cascade), and the editor re-sends the lists on every save, so the strict rule would 404 `Person not found` on the first widget save after someone is deactivated (or after the owner leaves a shared site). The dialog mirrors this: targets in `shared_with` the picker no longer offers are appended to its options so `MultiSelectDropdown` does not drop them on the next toggle.
- **One people statement behind two pickers**: `people_lists.shareable_users_statement(site_ids)` (active members of the sites + every active user whose role sees every site; `IN` subqueries, so no duplicates) feeds the Kanban mention picker and `GET /dashboards/shareable-users`, and the PUT/POST person check (`set(user_ids) ⊆ shareable ids`, one query).
- `shared_with` names are resolved server-side (one query per kind over every listed id) and shown to anyone who can open the dashboard; the client never joins ids to names.

## Tried and ruled out
- Separate visibility values per kind (`roles` / `sites` / …): a dashboard often needs a team **and** two people; one list with any-match is simpler to explain and to query.
- A 403 for out-of-scope targets: one 404 per kind (`Role / Site / Team / Person not found`) leaks nothing and keeps the dialog's message plain.
- Moving `SiteChecklist` into the dialog for sites: every kind uses `MultiSelectDropdown searchable` (teams with the site as hint, people with job title · sites); roles keep `RoleChecklist`.

## Watch out
- **The un-share trap**: the builder's draft (`useDashboardEditor` `draftOf` / `setMeta` / `save`, `widgetDraft.DashboardMeta`) must carry all four lists. Without them every widget Save PUTs empty lists and silently un-shares the dashboard. `save` sends them only for `shared` (`savedTargets`); `comparableDraft` compares sorted copies so a reorder is not "dirty".
- Share… PUTs **without** `widgets` and must still send the current name and description (the dialog has no name fields in share mode).
- A copy (`source_id`) takes the widgets only; the client sends `private` with empty lists.
- Every other auto-migration test's fake connection must answer the sharing probe and the visibility block, or the step ROLLBACKs as "another step" and their expected logs break.
- `site`, `team` and `role` WS entities refresh the `dashboards` slice too: a membership or role change moves who matches.
