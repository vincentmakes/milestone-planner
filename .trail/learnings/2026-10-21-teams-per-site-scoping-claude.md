---
title: "Teams per site: per-site 'no rows = whole site' scoping for tags, equipment and events; team-aware closures"
author: Claude
date: 2026-10-21
branch: feat/teams
cost: { minutes: 0, tokens: 0 }
touches:
  - app/models/team.py
  - app/routers/teams.py
  - app/services/team_rules.py
  - app/services/tag_rules.py
  - app/routers/projects.py
  - app/routers/users.py
  - app/routers/equipment.py
  - app/routers/tags.py
  - app/routers/sites.py
  - app/routers/export.py
  - migrations/add_teams.sql
  - frontend/src/utils/teams.ts
  - frontend/src/utils/siteClosure.ts
  - frontend/src/hooks/useTeamFilter.ts
  - frontend/src/stores/viewStore.ts
  - frontend/src/components/layout/Header/TeamSelector.tsx
  - frontend/src/components/settings/panels/TeamsPanel.tsx
  - frontend/src/components/settings/panels/TeamScope.tsx
  - CLAUDE.md
  - docs/user-guide/settings.md
  - docs/developer-guide/api-reference.md
---

## Decided
- Data model: `teams` belongs to one site (`site_id`, name unique per site, description, colour, `active`); `team_members`, `project_teams`, `tag_teams`, `company_event_teams`, `equipment_teams` are plain M:N tables, every FK `ON DELETE CASCADE` (site delete removes teams and every link). `migrations/add_teams.sql` = `tenant_provisioner.TEAMS_SCHEMA_STATEMENTS`, also run by the tenant auto-migration.
- Members must belong to the team's site (`load_site_members`, 400). Project teams must be at the project's site (a site-less project has none); unknown team ids on project writes are dropped silently (What-If replay), like tag ids. Users: `team_ids` strict (404), superuser only teams at their sites (403); a `site_ids` change alone prunes the memberships of removed sites.
- Tags, equipment and company events: per site, **no team row at a site = the whole site**; rows = only those teams there. Their `team_ids` are one flat list across sites — the API checks each id is at one of the entity's sites (`ensure_teams_within_sites`), and the client restricts it to the current site's teams (`teamIdsOnSite`) before every predicate. A tag limited to teams at S applies to a project at S only if the project shares one (`tag_applies_to_project`); narrowing a tag's teams under existing projects → 409.
- Scoping considers all teams, inactive included; only the header filter (`useTeamFilter`) offers active teams. Equipment limited solely to an inactive team is therefore hidden under any team filter.
- Closures: a team-limited closure takes out only its teams' members at the shared sites (`getClosureOn(..., staffTeamIds, teamSiteById)`) and never shades the calendar header (`timeline.ts` treats it as a plain event); the Closure badge tooltip names the teams. A plain team-limited event shows to the whole site.
- The header filter lives in `viewStore.teamFilters`, keyed by `tagFilterKey(siteId)` (tenant + site), absent = Whole site. viewStore's `merge` is field by field, so `teamFilters` is listed there (with `sanitizeTeamFilters`) — forgetting it silently resets the filter on every reload.
- No team data in the session or `/auth/me`: the current user's teams come from the staff rows (`team_ids` per user–site row; `selectStaffTeamIds` unions them).

## Tried and ruled out
- Nothing substantial was tried and dropped; the per-site rule held through implementation and review.

## Watch out
- Every `getClosureOn` caller must pass the person's team set and `selectTeamSiteById`; the defaults treat a team-limited closure as whole-site, so a missed caller silently over-blocks.
- Node 25's built-in `localStorage` shadows jsdom's: run vitest with `NODE_OPTIONS="--no-experimental-webstorage"`.
- In the sandbox, pytest must run from a temp cwd (running it from the repo root fails with a PermissionError on the unreadable `.env`) — use the wrapper script.
- `docs/assets/screenshots/settings-teams.png` and `team-filter.png` do not exist yet: the `settings-teams` / `team-filter` shots are registered in `scripts/screenshots/capture.py` but were not captured; add the image references to `docs/user-guide/settings.md#teams` after capturing.
