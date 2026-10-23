---
title: "RBAC visible sites: every read and write scoped server-side, view keys gate reads, site_links fixture serves the lookups"
author: Claude
date: 2026-10-21
branch: feat/rbac
cost: { minutes: 0, tokens: 0 }
touches:
  - app/services/site_access.py
  - app/routers/projects.py
  - app/routers/vacations.py
  - app/routers/equipment.py
  - app/routers/kanban.py
  - app/routers/users.py
  - tests/conftest.py
  - tests/test_site_visibility.py
---

## Decided
- One module, `app/services/site_access.py`: `visible_site_ids` (None = `sites.view_all`), `ensure_site_visible` (site param / body `site_id`, 403; None = site-less, view_all only), `visible_sites_clause` (list filters), `ensure_project_visible` (403, also on every project-editor/assignment/booking/Kanban write, even with `projects.edit_any`), `ensure_equipment_visible` (404), `person_is_visible` / `ensure_person_visible` (oneself or a shared visible site). view_all never queries.
- Status codes: a site/project parameter outside = 403; reading a site, team, equipment, staff member or user outside = 404 (hide existence); writing on a person outside = 403.
- `archived=true` without `views.archived` = 403, but `archived=all` just drops archived projects: `fetchAllProjects()` calls `archived=all`, a 403 there would break the whole Gantt load for a role without the key.
- Vacations: `absences.view_others` = own + members of the visible sites (view_all: all); without it own only; `?siteId=` needs the key and a visible site. Superusers lost tenant-wide absence reads (deliberate).

## Tried and ruled out
- Putting the site check inside `project_access` helpers: they take no `request` (no per-request cache) and the change would ripple through every key-helper unit test. Routes call `ensure_project_visible` right before the key check instead.
- Querying the project's/equipment's/person's sites inline in route tests: dozens of existing `side_effect` lists would shift. The lookups are module functions (`_load_project_site_id`, `_load_equipment_site_ids`, `_load_user_site_ids`) that `authed_client` patches; the `site_links` fixture places people/projects/equipment (default: at the caller's sites). Their real queries are pinned in `tests/test_visible_site_ids.py`.

## Open
- Not scoped: `GET /equipment-types` (configuration). Fix round 1 scoped custom-column values (read filter through the owning project, `ensure_project_visible` on writes), `GET /skills/user/{id}` (404) and masks other sites' project names in `/equipment/{id}/assignments` as `[External Project]`.
