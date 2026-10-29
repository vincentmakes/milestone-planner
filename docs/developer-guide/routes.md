# Route auth gates and side effects

Every tenant and admin-portal route, grouped by router: its permission gate, its visible-site scoping and the side effects a change must keep (broadcasts, notifications, approval 202s, validation rules). It was moved verbatim out of the repo-root [`CLAUDE.md`](https://github.com/vincentmakes/milestone-planner/blob/main/CLAUDE.md). The request and response shapes for API users are in the [API Reference](api-reference.md).

Code described: `app/routers/` (one file per resource domain, registered in `create_app()` in `app/main.py`), the dependencies in `app/middleware/auth.py` and the access services in `app/services/`.

## API Reference

All routers are mounted under `/api` (multi-tenant deployments reach them at `/t/{slug}/api/...`; the admin portal is always at `/api/admin/*` with no tenant prefix). Auth column (every gate is a permission key of `app/services/permissions.py`; the label names the system roles whose shipped defaults hold it): **user** = `get_current_user`, **superuser** = `require_permission(<key>)` held by superusers and admins by default, **admin** = `require_permission(<key>)` held only by admins by default (`require_admin` itself guards only the roles/approval-policy writes), **portal** = `get_current_admin` (master DB), **superadmin** = `require_superadmin`, **public** = no auth. **user (PM)** = `get_current_user` + `require_project_editor` / `require_on_project` from `app/services/project_access.py` (the key, or the project's `pm_id` through the PM bundle); **user (PM/own-assignment)** = `resolve_self_booking` / `approvals.resolve_row_write` (`assignments.manage_others` or the PM, else an own row in the mode of `assignments.self_*`: allow → as before, approval → **202** approval request, none → 403). Both are checked after loading the entity, against the server-derived `project_id`. On top of the auth column, every tenant route is limited to the caller's **visible sites** and reads gate on the `views.*` keys (see [Tenant role model](auth-and-tenancy.md#tenant-role-model)).

### Health & diagnostics (`app/routers/health.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` and `/api/health` | public | Status, mode, version, backend id, `default_tenant`, DB reachability (`database: "error"` on failure — details only in the log) |
| GET | `/api/ws-debug` | admin (`system.ws_debug`) | WebSocket diagnostics (tenant, connection/online counts) |
| POST | `/api/ws-debug/broadcast` | admin (`system.ws_debug`) | Fire a synthetic `change:project` broadcast |
| GET | `/api/docs`, `/api/redoc`, `/api/openapi.json` | admin (`system.api_docs`) | Swagger / ReDoc / schema, defined in `app/main.py` (not a router). Checked against the session user's **live** `PermissionSet` (`get_current_user_from_session` re-reads role and matrix), 401 otherwise |

### Authentication & SSO (`app/routers/auth.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/login` | public | Email/password login → session + `connect.sid` cookie. Throttled: 10 failures / 15 min per (tenant, IP, e-mail) → 429 + `Retry-After`; password > 72 bytes → 400 |
| POST | `/auth/logout` | session | Destroy session, clear cookie |
| GET | `/auth/me` | public | Current user (fresh from DB) with `roleName`, `permissions` (allow keys; admin: every key; feature-disabled keys left out — `effective_permission_set`), `approvalRequired` (keys in approval mode), `canSeeAllSites` and `isResource`, or `{user: null}` (login answers the same shape) |
| POST | `/auth/change-password` | user | Change own password (verifies current; new ≥ 8 chars) |
| GET | `/sso/config` | public | Public SSO info for the login page (no secret) |
| GET | `/sso/config/full` | admin (`settings.sso`) | Full SSO config incl. masked secret (`****` + last 4, never the plaintext) + org-precedence info |
| PUT | `/sso/config` | admin (`settings.sso`) | Update tenant SSO (409 if org SSO active; `default_role` any existing non-admin role key, else 400). Secret: omitted or masked value keeps the stored one, `""` clears it; stored encrypted (same on every SSO write route) |
| GET | `/auth/sso/config` | public | Public SSO config (`SSOConfigResponse`) |
| PUT | `/auth/sso/config` | admin (`settings.sso`) | Update tenant SSO (alternate path, same guardrails) |
| GET | `/auth/sso/status` | public | Effective SSO status (org vs tenant) + group requirements |
| POST | `/auth/sso/test` | admin (`settings.sso`) | Test the entered tenant SSO values against Microsoft, nothing saved (`app/services/sso_test.py`) → `{credentialsOk, summary, checks[]}`. A missing, blank or masked secret tests the stored one; 409 while org SSO is active; `tenant_id` limited to `[A-Za-z0-9.-]` (422) |
| GET | `/auth/sso/login` | public | Build the Entra authorization URL (HMAC-signed `state` carries the slug + a nonce; sets the one-time `sso_nonce` cookie, 10 min) |
| GET | `/auth/sso/callback` | public | OAuth callback: verify state **and** that its nonce matches this browser's `sso_nonce` cookie (cleared whatever the outcome), token exchange, Graph `/me`, group validation, find/auto-create user, create session |

### Users & staff (`users.py`, `staff.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/users`, `/users/{id}` | superuser (`users.view`) | List / detail |
| POST | `/users` | admin (`users.create`) | Create user (password ≥ 8 chars; optional `team_ids`, each at one of its sites; sites and teams within the caller's visible sites). A role other than `user` also needs `users.change_role` and the escalation guard. `is_resource` defaults to `role != 'admin'` |
| PUT | `/users/{id}` | any of `users.edit` / `edit_admins` / `edit_credentials` / `change_role` / `toggle_active` | Update user, one key per kind of change: profile fields (incl. `is_resource`), sites, teams, skills `users.edit`; any change to an admin account `users.edit_admins`; another user's email/password `users.edit_credentials` (own: always); role `users.change_role` + escalation guard; `active` `users.toggle_active`. Nobody changes their own role or deactivates themself; the system admin and the last active admin stay active admins; password ≥ 8 chars, > 72 bytes → 400; unknown site/skill ids rejected; sites only within the caller's visible sites. `team_ids` replaces the memberships (unknown → 404, only teams at the caller's visible sites → 403, each team at one of the user's sites → 400); `site_ids` alone drops the teams of removed sites |
| DELETE | `/users/{id}` | admin (`users.delete`) | Delete (rejects self, `is_system`, the last active admin; an admin target also needs `users.edit_admins`) |
| PUT | `/users/{id}/toggle-active` | admin (`users.toggle_active`) | Enable/disable (same self / system / last-admin / `users.edit_admins` rules as delete) |
| GET | `/staff`, `/staff/{id}` | user (visible sites; `/staff/{id}` 404 outside) | Staff read views (staff *are* users — created via `/users`). `GET /staff` lists only bookable people (`users.is_resource`, whatever the role); `/staff/{id}` returns anyone visible. `team_ids`: on `/staff` rows the user's teams at that row's site, on `/staff/{id}` all of them |
| GET | `/staff/{id}/availability` | user (`views.staff`) | Availability calculation (`startDate`/`endDate` validated, ≤ 366 days, else 400) |
| GET | `/staff/{id}/assignments` | user (`views.staff`) | All assignments for a staff member at visible sites, with `approval_status` (in `assignments.py`) |

User list/detail responses carry `team_ids` + `team_names` (sorted by id).

### Sites, holidays & events (`sites.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/sites` | user | The caller's visible sites |
| GET | `/sites/all` | admin (`sites.manage`) | All sites |
| GET | `/sites/{id}` | user | Site detail (404 outside the visible sites) |
| POST / PUT / DELETE | `/sites`, `/sites/{id}` | admin (`sites.manage`) | Site CRUD. A create with a country, or an update changing the country, fetches the Nager holidays automatically — only while `nager_enabled` is on (read only when a fetch would happen; turned off, a country change keeps the old holidays). PUT: an explicit `null` clears `location`/`city`/`country_code`/`region_code` (`model_fields_set`; omitted = unchanged). DELETE deletes the site's projects (FK CASCADE) and their polymorphic comments/custom-column values; equipment linked to other sites survives. DELETE of an active site locks every active site row `FOR UPDATE` (id order) and answers 409 `LAST_SITE_DETAIL` when it is the last one (2.1.0; an inactive site takes no lock). The rule guards deletes only: deactivating the last active site through PUT (`active: 0`) is not checked; Settings → Sites offers it behind a typed-name `confirmAction`, then `loadAllData()` |
| GET | `/sites/{id}/holidays`, `/holidays` | user | Holidays per site / cross-site (`?startDate=&endDate=` returns every holiday that overlaps the window) |
| POST | `/sites/{id}/holidays` | superuser (`bank_holidays.manage`) | Add custom holiday (a span over 366 days → 400, like every holiday/event write and import) |
| PUT | `/sites/{id}/holidays/{hid}` | superuser (`bank_holidays.manage`) | Edit any holiday (sets `is_custom = 1`) |
| DELETE | `/sites/{id}/holidays/{hid}` | superuser (`bank_holidays.manage`) | Delete any holiday — custom or Nager (a Nager one returns on the next refresh, if Nager is on) |
| POST | `/sites/{id}/holidays/import` | superuser (`bank_holidays.manage`) | Bulk import `{items:[{date,end_date,name}]}` (≤ 1 000 items, else 422) as custom; dedup on (date, name) → `{created, skipped}` |
| POST | `/sites/{id}/holidays/refresh` | superuser (`bank_holidays.manage`) | Fetch public holidays from the Nager API. 409 `Holiday refresh from Nager is turned off` while the `nager_enabled` setting is `false` (checked after the permission, before the site lookup) |
| GET | `/sites/{id}/events`, `/events?siteId=` | user | Company events linked to a site (via `company_event_sites`; date bounds match overlapping events, each bound optional); responses carry `site_ids` + legacy `site_id` + `counts_as_unavailable` |
| POST / PUT / DELETE | `/events`, `/events/{id}` | superuser (`company_events.manage`) | Multi-site event CRUD (`site_ids` + `counts_as_unavailable` + optional `team_ids` on create/update — each team at one of the event's sites, 400 otherwise; PUT `team_ids` replaces them, a `site_ids` change alone drops the teams of removed sites; DELETE removes it from every site). Responses carry `team_ids`. Import and the legacy single-site create stay whole-site |
| POST | `/events/import` | superuser (`company_events.manage`) | Bulk import `{site_ids, color, counts_as_unavailable, items}` (≤ 1 000 items, else 422; the flag applies to newly created events only); an existing (date, end_date, name) gains missing site links → `{created, linked, skipped}` |
| POST / DELETE | `/sites/{id}/events`, `…/{eid}` | superuser (`company_events.manage`) | Legacy single-site create / unlink (event deleted only when no site is left) |

All holiday/event writes also require every site involved to be visible (`ensure_site_access` from `app/services/site_access.py`; `sites.view_all` holders any site), and the calendar reads 403 on a site outside the visible ones.

### Projects, phases & subphases (`projects.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/projects` | user | List (visible sites; `includeOtherSites` needs `views.crosssite` and lists every visible site, `siteId` notwithstanding, each project in full — no masking since 2.1.0). Without `views.archived`, `archived=true` is a 403 but `archived=all` degrades to active projects only (no 403 — `fetchAllProjects()` asks for `all`) |
| GET | `/projects/{id}` | user | Detail with phases/subphases/assignments (403 outside the visible sites; an archived one needs `views.archived`) |
| POST / DELETE | `/projects`, `/projects/{id}` | superuser (`projects.create` / `projects.delete`) | Create (at a visible site; site-less needs `sites.view_all`) / delete project (not in the PM bundle — a PM may **not** delete) |
| PUT | `/projects/{id}` | user (PM) | Update project (`projects.edit_any`; a change of `archived` needs `projects.archive`, and a request flipping only `archived` needs nothing else) — through the PM bundle the PM may change every field, incl. `pm_id` (hand-over; an explicit `null` clears it), `archived`, `tag_ids` and `team_ids` |
| POST | `/projects/{id}/phases` | user (PM) | Add phase |
| PUT / DELETE | `/phases/{id}` | user (PM) | Update / delete phase. PUT: explicit `"completion": null` → 0 % via `apply_completion` (omitted = unchanged); a date change fits the phase's unlinked bookings and the dates in their open requests (`approvals.fit_card_bookings`, translate or clamp, same transaction; response unchanged). DELETE also removes its subphases, their assignments, comments and custom-column values |
| PUT | `/projects/{id}/phases/reorder` | user (PM) | Reorder phases |
| POST | `/phases/{id}/subphases` | user (PM) | Add subphase to a phase (`project_id` taken from the phase, body value ignored) |
| POST | `/subphases/{id}/children` | user (PM) | Add nested subphase (`project_id` taken from the parent) |
| PUT / DELETE | `/subphases/{id}` | user (PM) | Update / delete subphase (404 if missing; PUT `completion: null` → 0 % and the booking fit like phases) |
| PUT | `/subphases/{parent}/reorder` | user (PM) | Reorder subphases (parent resolved first; 404 if missing) |

These handlers call rich `broadcast_change()` — their paths are in `BroadcastMiddleware.SKIP_PATTERNS`.

**Validation (all write routes):** dates where `end < start` → 422 (`DateRangeOrdered` mixin in `app/schemas/base.py` on request bodies, `ensure_date_order()` in `app/services/date_range.py` for merged partial updates) on projects, phases, subphases, assignments, equipment bookings/blocks and absences. Unknown referenced ids (site, `pm_id`, staff, skill, …) → 400/404 instead of an FK 500. Date query filters are parsed with `parse_day` / `parse_day_range` (400 on malformed input; availability ranges capped at 366 days).

### Assignments (`assignments.py` — note the three per-level route families)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/projects/{id}/staff` | user (PM/own-assignment) | Assign staff at project level (404 unknown person, 400 `This person is not bookable as a resource` — `require_bookable_staff`, before any 202) |
| PUT / DELETE | `/assignments/{id}` | user (PM/own-assignment) | Update / remove project-level assignment |
| POST | `/phases/{id}/staff` | user (PM/own-assignment) | Assign staff at phase level (`project_id` resolved from the phase, body value ignored; same 404/400 bookable check). Optional `start_date` / `end_date` = an unlinked segment (422 `Give both dates or neither`; 400 `Booking dates must lie within the phase`; 409 `This person is already booked on this card for overlapping dates`). None = **placed**: linked when the person has no row there, else the largest free stretch or the second half of their one full-span booking (shortened, listed in `adjusted: [{id, start_date, end_date, linked}]`, `[]` otherwise); 409 `CARD_FULL_DETAIL` (their bookings cover the card) / `ALREADY_PENDING_DETAIL` (the full-span row is pending) |
| PUT / DELETE | `/phase-staff/{id}` | user (PM/own-assignment) | Update / remove phase-level assignment. PUT: `allocation?`, `start_date?` / `end_date?` (same 422/400/409 rules, overlap checked only when the dates change, the row itself excluded); explicit `null` on both = relink. Direct write → `{success, linked}` |
| POST | `/subphases/{id}/staff` | user (PM/own-assignment) | Assign staff at subphase level (`project_id` resolved from the subphase; same 404/400 bookable check; optional dates and the dateless placement as at phase level, 400 `… within the subphase`) |
| PUT / DELETE | `/subphase-staff/{id}` | user (PM/own-assignment) | Update / remove subphase-level assignment (same body and response as `/phase-staff/{id}`) |
| POST | `/projects/{id}/equipment` | user (PM) (`equipment_bookings.manage`) | Book equipment on a project (no self-service). Optional `note` (≤ 2000, blank = none), appended to the PM's `project_changed` body. The only equipment create: bookings are project-level, there is no `/phases/{id}/equipment` / `/subphases/{id}/equipment` |

The nine staff routes (the three POSTs, PUTs and DELETEs) and the two Kanban join/leave routes answer **202** `{success: true, pending: true, request_id, id}` when the caller's own `assignments.self_*` key is in approval mode (see [Approval workflow](conventions-in-depth.md#approval-workflow)); cancelling one's own pending create through DELETE answers 200 `{success, cancelled: true, request_id, id}`. The POSTs 409 when the person is already booked on the target (a pending booking counts, `This booking already awaits approval`; at project level only with the same dates; on a phase/subphase only for explicit dates overlapping theirs — a linked row spans the card — while a dateless one is placed, 409 only when their bookings cover the card); PUT/DELETE on someone else's pending create → 409. Rows carry `approval_status` (`approved` / `pending`), phase/subphase rows the **effective** `start_date` / `end_date` (own, else the card's) and `linked` (project rows `linked: false`), and, in `GET /projects/{id}`, `approval: null | {request_id, action, requester_id, requested, previous, created_at, can_decide}`.

The three staff POSTs take an optional `comment` (≤ 4000, blank = none; not the Kanban assignee POST). **Direct**: it is posted to the booking's thread (`card_comments.stage_booking_comment`: the card's, the project thread for a project-level booking) as the actor's comment in the booking's transaction, after a 403 `kanban.comment` check that runs before any write (right after the 202 return, before a shortening); `mention` to the mentioned users and `comment` to the thread's approved assignees, minus the actor, the booked person and the PM — whose `assignment_changed` / `project_changed` bodies end with the comment's preview — and those recipients are passed to `deliver` as `already_notified`; after the commit a `change:card_comment` broadcast. Response unchanged. **Approval mode**: it is the request's `note` (no `kanban.comment` needed), previewed in the approvers' `approval_requested` body; the 202 body is unchanged.

`PUT/DELETE /equipment-assignments/{id}` live in `equipment.py` only (the shadowed duplicates that once sat in `assignments.py` were removed).

### Equipment (`equipment.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/equipment-types` | user | Distinct equipment types (no create route — types come from equipment; not site-scoped) |
| PUT / DELETE | `/equipment-types/{name}` | superuser (`equipment_types.manage`) | Rename (`?new_type=`) / delete a type. Only when every equipment of that type is at a visible site (403 otherwise; site-less items need `sites.view_all`). DELETE → 409 while any equipment uses the type |
| GET | `/equipment?siteId=&includeAllSites=` | user (`views.equipment`) | Active equipment at visible sites, plain array (no pagination), **one row per equipment–site pair** (like `GET /staff`): `site_id`/`site_name` = that pair, plus `site_ids`/`site_names` |
| GET | `/equipment/all` | superuser (`equipment.manage`) | All equipment at visible sites incl. inactive, one row each (with `site_ids`) |
| GET | `/equipment/{id}` | user (`views.equipment`) | Detail (one row, `site_ids`; 404 unless linked to a visible site) |
| POST / PUT / DELETE | `/equipment`, `/equipment/{id}` | superuser (`equipment.manage`) | Equipment CRUD; `site_ids: int[]` (legacy `site_id` accepted as `[site_id]`; empty → 422); optional `team_ids` (each at one of its sites, 400; per site, no team = whole site; a `site_ids` change alone drops the teams of removed sites). Responses carry `team_ids` / `team_names`. Only for equipment whose sites are **all** visible (`ensure_site_access`; `sites.view_all` any) |
| GET | `/equipment/{id}/assignments` | user (`views.equipment`) | Bookings for one piece of equipment (bookings by projects outside the visible sites show `[External Project]`) |
| PUT / DELETE | `/equipment-assignments/{id}` | user (PM) (`equipment_bookings.manage`) | Update / delete booking. PUT `note`: left out = kept, `null` or blank = cleared (`model_fields_set`); a note-only edit notifies nobody (only equipment / date changes tell the PM). Responses, the booking list and `GET /projects/{id}`'s `equipmentAssignments` carry `note` |
| GET | `/equipment/{id}/availability` | user (`views.equipment`) | Availability calculation (`startDate`/`endDate` validated, ≤ 366 days, else 400) |
| GET | `/equipment-blocks`, `/equipment/{id}/blocks` | user (`views.equipment`) | Maintenance blocks (all / per equipment; `?siteId=` joins through `equipment_sites`) |
| POST / PUT / DELETE | `/equipment-blocks`, `…/{id}` | superuser (`equipment_blocks.manage`) | Block CRUD (same visible-site rule as the equipment) |

### Vacations, absence types, notes, skills, tags (`vacations.py`, `absence_types.py`, `notes.py`, `skills.py`, `tags.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET / POST / PUT / DELETE | `/vacations`, `/vacations/{id}` | user | Vacation CRUD (own-user checks inside handlers; `absences.manage_others` for people sharing a visible site); optional `absence_type_id`. `GET` with `siteId`: `absences.view_others` + a visible site (403); without: own + members of the visible sites with `absences.view_others` (`sites.view_all`: all), own only without it; `GET /vacations/{id}` is a 404 outside that scope |
| POST | `/vacations/import` | user | Bulk import `{staff_id, items:[{start_date,end_date,description,absence_type_id}]}` (≤ 1 000 items, else 422); same own-user rule; dedup on (staff, start, end) → `{created, skipped}` |
| GET | `/absence-types` | user | Absence types (active and inactive) |
| POST / PUT / DELETE | `/absence-types`, `/absence-types/{id}` | admin (`absence_types.manage`) | Absence type CRUD; DELETE → 409 while any vacation uses the type |
| PUT | `/absence-types/reorder` | admin (`absence_types.manage`) | Reorder (`{type_order: [ids]}`) |
| GET | `/notes` | user | List staff notes (a site outside the visible ones → 403) |
| POST / DELETE | `/notes`, `/notes/{id}` | superuser (`staff_notes.manage`) | Create / delete note (visible sites) |
| GET | `/skills`, `/skills/{id}` | user | Skills list / detail |
| POST / PUT / DELETE | `/skills`, `/skills/{id}` | superuser (`skills.manage`) | Skill CRUD |
| GET | `/skills/user/{uid}` | user | A user's skills (404 for a person outside the visible sites) |
| PUT | `/skills/user/{uid}` | superuser (`skills.assign`) | Replace a user's skills (the target must be editable: `users.edit`, or `users.edit_admins` for an admin, and visible) |
| POST / DELETE | `/skills/user/{uid}/{sid}` | superuser (`skills.assign`) | Add / remove one skill (same target rule) |
| GET | `/tags` | user | List tags (`all_sites`, `site_ids`, `team_ids`, `sort_order`; ordered by sort order, name) |
| POST / PUT / DELETE | `/tags`, `/tags/{id}` | admin (`tags.manage`) | Tag CRUD (bodies `extra="forbid"`: an unknown key such as `group_id` → 422; new tags appended last; `all_sites` true clears `site_ids`; unknown site/team → 404; `team_ids` must be at one of the tag's sites unless `all_sites`, 400). PUT → 409 (string detail with the count) when restricting sites while projects at a removed site use it, or when narrowing `team_ids` while projects at those teams' sites outside them use it |
| PUT | `/tags/reorder` | admin (`tags.manage`) | `{tag_order: [ids]}` → `sort_order = index` |

Project writes (`POST /projects`, `PUT /projects/{id}`) validate `tag_ids` with `validate_project_tags()` (`app/services/tag_rules.py`): a tag that does not apply to the project's site, or a tag limited to teams at that site the project shares none of → 400; unknown ids are dropped silently (What-If replay). Inline project tags are `{id, name, color}`. `team_ids` (list/detail responses, create/update bodies) must all be at the project's site (400; a site-less project cannot have teams); unknown team ids are dropped silently too, and a team change re-validates the current tags and field items.

**Project field values** (`validate_field_values` / `apply_field_values` / `load_project_field_values` in `app/services/project_field_rules.py`): list and detail carry `field_values` — `{"<field id>": value}`, text → string, number → number, toggle → boolean (`false` kept), select → item id, multiselect → item ids in item order; fields without a value are absent (two column queries per list page, every row of the page included, the list query `noload`s the relationships). `POST` / `PUT` accept `field_values: {field_id: value}` (≤ 500 keys, else 422): only the fields given change; `null` / `""` / `[]` / blank text clear; select takes an id or a one-item list, multiselect a list (≤ 500, duplicates folded). 422 `Invalid value for "<field>"` (wrong type, non-finite) / `"<field>" can be at most 2000 characters`; 400 `The item "<item>" is not an item of "<field>"`, `Only one item of "<field>" can be chosen`, `The item "<item>" of "<field>" is not available at this project's site`, `… is limited to teams this project is not part of`. Unknown field and item ids are dropped silently (What-If replay). Field values never produce change notifications.

### Project fields (`project_fields.py`, prefix `/project-fields`)

Reads: any user; writes: `project_fields.manage` (admin-only by default). Coarse-broadcast `change:project_field` (refreshes the `projectFields` and `projects` slices); What-If-exempt (configuration).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/project-fields` | user | Fields in `sort_order, id`: `{id, name, field_type, sort_order, decimals, options: [{id, name, color, sort_order, all_sites, site_ids, team_ids}]}` (`options: []` for text/number/toggle) |
| GET | `/project-fields/{id}/usage` | user | `{projects: n}` (a value row or a selection of its items) — the delete confirm's count |
| POST / PUT / DELETE | `/project-fields`, `/project-fields/{id}` | admin (`project_fields.manage`) | `{name, field_type, decimals?}` → 201, appended; blank name 400 `Field name cannot be empty`, taken (case-insensitive) 400; a different `field_type` on PUT → 422 `The type of a project field cannot be changed`; `decimals` (0–3 or `null` = as typed, 2.1.0) is applied on PUT whenever sent (`model_fields_set`: `null` resets), a non-null value on a field that is not `number` → 422 `Only number fields have decimals`, out of range → 422; new number values are rounded half-up to it on project writes (`project_field_rules.round_field_number`), stored ones are never rewritten; DELETE 204 cascades items, values, selections |
| PUT | `/project-fields/reorder` | admin (`project_fields.manage`) | `{field_order: [ids]}` (≤ 500, unknown ids ignored) |
| POST | `/project-fields/{id}/options` | admin (`project_fields.manage`) | Add an item `{name, color?, all_sites?, site_ids?, team_ids?}` → 201 (non-dropdown field → 400 `Only dropdown fields (select, multiselect) have items`; name unique per field, 400) |
| PUT / DELETE | `/project-fields/options/{oid}` | admin (`project_fields.manage`) | Update (the tag scoping rules: colour `#rrggbb`, restricted needs a site, each team at one of its sites 400, `site_ids` / `team_ids` ≤ 200; 409 `N projects at other sites use this item` / `N projects outside these teams use this item` when narrowing) / delete (selections cascade) |
| PUT | `/project-fields/{id}/options/reorder` | admin (`project_fields.manage`) | `{option_order: [ids]}`, only that field's items move |

### Teams (`teams.py`, prefix `/teams`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/teams?siteId=` | user | Every team at the visible sites, inactive ones included (`{id, site_id, name, description, color, active, member_ids, created_at, updated_at}`), ordered by site then name; `siteId` limits to one site |
| GET | `/teams/{id}` | user | One team with `member_ids` (404 if missing or outside the visible sites) |
| POST | `/teams` | superuser (`teams.manage`) | Create `{site_id, name, description?, color?, active?, member_ids?}` — only at a visible site (403); unknown site → 404; a spaces-only or duplicate name at the site → 400 (empty → 422); a member not at the site → 400 |
| PUT | `/teams/{id}` | superuser (`teams.manage`) | Partial update (site cannot change); explicit `null` clears `description` / `color`; `member_ids` replaces the members (same 400 rule) |
| DELETE | `/teams/{id}` | superuser (`teams.manage`) | Delete; its member, project, tag, field-item, event and equipment links cascade. 409 while a project of the team would keep a tag or field item limited to other teams of the site (`team_rules.count_projects_stranded_by_team_delete`) |

Writes are What-If-exempt (configuration) and coarse-broadcast as `change:team` (refreshes the `teams`, `staff`, `projects`, `tags`, `projectFields`, `equipment` and `siteCalendar` slices).

### Kanban (`kanban.py`, prefix `/kanban`)

The board itself has **no read endpoint** — `GET /projects/{id}` already returns the tree, so the client derives cards from `appStore.projects`. Card = leaf phase/subphase (`frontend/src/utils/kanbanCards.ts`).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/kanban/projects/{id}/comment-counts` | user (`views.kanban`) | Comment counts per card (kept out of `GET /projects/{id}`, which `fetchAllProjects()` calls once per project) |
| GET | `/kanban/sites/{site_id}/comment-counts` | user (`views.kanban`) | Counts for every card of a site in one query (the board's "All projects" mode) |
| GET | `/kanban/sites/{site_id}/mentionable-users` | user (site visible; no `views.kanban` since 2.0.0) | Mention picker: active members of the site plus every active user whose role sees all sites (admins, and roles allowing `sites.view_all`) → `{id, name, job_title}`. Deliberately not `GET /staff`, which leaves admins out |
| PUT | `/kanban/cards/{entity_type}/{id}/status` | user **+ `kanban.move_any` or approved assignee** | Move a card (`kanban.move_any`, the PM through the bundle, or an approved assignee of that card holding `kanban.move_assigned`); echoes the derived `{status, completion}` so the client reconciles without a refetch |
| POST / DELETE | `/kanban/cards/{et}/{id}/assignees`, `…/{staff_id}` | user (PM/own-assignment) | Assign/unassign (editors manage anyone; any user may join/leave a card themself — **202** approval request in approval mode) — **creates the phase/subphase staff assignment** at `allocation` (1–100) or the assignee's `max_capacity`, placed like a dateless phase/subphase POST except that a first booking is **unpinned** — the card's own dates, read under the card's `FOR UPDATE` lock (`plan_placement(..., link_first=False)`), filed without the `placement` marker in approval mode (response adds `start_date` / `end_date` / `linked` of the new row and `adjusted`; 409 `CARD_FULL_DETAIL` / `ALREADY_PENDING_DETAIL`; the `assigned` body names the dates and a shortened booking — `placement_body`; POST 400 for a person not bookable, before any 202). DELETE is per person: 409 `This person has several bookings on this card — remove them one by one` when they hold 2+ rows there (the UI uses the per-row `/phase-staff` / `/subphase-staff` routes) |
| GET / POST | `/kanban/cards/{et}/{id}/comments` | user | A thread: `et` `phase` / `subphase` (the card's, shared with its booking dialog) or `project` with the project id (`CommentEntityType`; another type 422; `_load_comment_target` per type, no fallback, unknown target 404). GET needs only the project visible (no `views.kanban` since 2.0.0; an archived project needs `views.archived`), POST `kanban.comment` (every user by default). Mentions are parsed from the body (`@[Name](id)`, unknown ids dropped) into `mentioned_user_ids`; POST notifies the mentioned users and the target's approved assignees (`card_assignee_ids`: for `project` the approved project-level bookings; someone both gets only the mention) |
| PUT / DELETE | `/kanban/comments/{id}` | user (author with `kanban.comment`; deleting others' comments `kanban.moderate_comments`) | Edit / delete a comment; an edit re-reads the mentions and notifies only people newly mentioned |

⚠ `require_card_status_write` (`app/services/card_access.py`): `kanban.move_any` (the route passes `can_move_any=await can_on_project(..., "kanban.move_any", ...)`, so the PM too), **or** an approved assignee of that card holding `kanban.move_assigned`. It takes `user_id`/boolean primitives, not a `User`, because `get_current_user` often returns the lightweight `SessionUser`.

### Notifications (`notifications.py`, prefix `/notifications`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/notifications?unread_only&limit` | user | Own notifications, newest first. First purges the caller's rows read more than `READ_RETENTION_DAYS` (30) ago (`purge_read_notifications`, `app/services/notifications.py`; unread rows never), so it uses `get_db` and commits, not `get_db_readonly` |
| GET | `/notifications/unread-count` | user | Badge count (served by the partial unread index) |
| PUT | `/notifications/{id}/read`, `/notifications/read-all` | user | Mark read |
| DELETE | `/notifications/{id}` | user | Delete one own row → 204; another user's or a missing id → 404 |
| DELETE | `/notifications` | user | Delete every own row, read or not → `{deleted: n}` |

⚠ Every query is pinned to `Notification.user_id == user.id` — there is **no `user_id` parameter**, by design (it would be an IDOR). Due-soon/overdue are derived client-side (`useDerivedDueNotifications`), never stored. The whole prefix is broadcast-skipped (`SKIP_PATTERNS`, any method) and What-If-exempt (`isWhatIfExempt`). The change-notification coalescing reads its candidate row `FOR UPDATE`, so a delete or a purge of that row waits for the short `deliver` transaction instead of failing its batch.

### Permissions & roles (`roles.py`)

Role writes use `require_admin` (the lockout-proof surface: `roles.manage` is locked to the admin role). Coarse-broadcast as `change:role`; What-If-exempt.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/permissions` | user | The catalogue for the matrix: `{groups: [{name, permissions: [{key, label, description, approvable, locked, defaults: {superuser, user}}]}], pm_bundle}` |
| GET | `/roles`, `/roles/{id}` | user | Roles in `sort_order`: `{id, key, name, description, is_system, sort_order, permissions: {key: mode}, user_count}` (the admin role lists every key as `allow`; `projects.view` is always `allow`) |
| POST | `/roles` | `require_admin` | Create `{key, name, description?, sort_order?, permissions}` → 201. Key `^[a-z][a-z0-9_]{1,19}$` (422), taken (system keys included) or a duplicate / blank name (case-insensitive) → 400; unknown key 422 `Unknown permission: x`; `approval` on a non-approvable key 422; a locked key changed 422 `Permission is locked: x` |
| PUT | `/roles/{id}` | `require_admin` | Partial update; the admin role is 403 (`Administrator permissions cannot be edited`); a different `key` is 422 (the key never changes); `permissions` replaces the matrix (same 422 rules); explicit `null` clears `description` |
| DELETE | `/roles/{id}` | `require_admin` | 204; a system role 403; a role held by users 409 `N users hold this role. Give them another role first.` |

A matrix edit applies on the holders' next request (`get_current_user` resolves the role live) and, through `change:role`, refreshes `/auth/me` in open clients.

### Approval policies (`approval_policies.py`, prefix `/approval-policies`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/approval-policies` | user | One entry per approvable action, in catalogue order: `{action, label, pm_approves, role_ids}` (a missing row reads as the seeded default: PM approves, no roles) |
| PUT | `/approval-policies/{action}` | `require_admin` | Full replace `{pm_approves, role_ids}`; unknown action or role id → 404. Admins approve whatever the policy says |

### Approval requests (`approvals.py`, prefix `/approval-requests`)

Requests are filed by the self-booking routes (202, see [Assignments](#assignments-assignmentspy-note-the-three-per-level-route-families)); this router reads and decides them. Rich `change:approval_request` broadcasts (the path is in `SKIP_PATTERNS`) plus per-user `approval:changed` pushes.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/approval-requests?scope=mine\|to_decide\|all&status=&limit=` | user (`all`: `approvals.view_all`, else 403) | `mine` = own requests; `to_decide` = pending requests the caller may decide (visible sites, never their own); `all` = every request at the visible sites. Newest first; items `{id, action, status, close_reason, requester_id/_name, project_id/_name, level, target_id/_name, assignment_id, requested, previous, note, decided_by/_name, decided_at, decision_note, superseded_by_id, created_at, updated_at, can_decide}` |
| GET | `/approval-requests/{id}` | user (requester, eligible approver, or `approvals.view_all`) | One request; 404 for anyone else |
| POST | `/approval-requests/{id}/approve`, `…/reject` | eligible approver, never the requester (403) | Body `{note?}` (≤ 2000). Approve re-validates and applies; if the booking can no longer apply the request closes `expired` → 409 `{detail, status: "expired", close_reason}`. Approving a **create** whose request carries a `note` (the requester's `comment`) posts it to the booking's thread as the requester's comment when they hold `kanban.comment` (else it stays on the request): `mention` from the requester to the mentioned users, never the approver, no `comment` notifications, `change:card_comment` broadcast; those people are skipped by the change notifications. Reject deletes a pending create's row / drops a pending change. 409 `{detail: "Request already <status>", status}` when not pending; 404 unknown |
| POST | `/approval-requests/{id}/cancel` | requester or admin (403) | Withdraw (`{note?}`); the requester is notified only when an admin cancelled |

### Custom columns (`custom_columns.py`, prefix `/custom-columns`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/custom-columns`, `/custom-columns/with-values` | user | Columns / columns with values (values only of projects at visible sites; a site outside → 403) |
| POST / PATCH / DELETE | `/custom-columns`, `…/{id}` | admin (`custom_columns.manage`) | Column CRUD |
| PATCH | `/custom-columns/reorder` | admin (`custom_columns.manage`) | Reorder columns |
| PUT | `/custom-columns/values`, `…/values/batch` | user (`custom_columns.set_values`, or the PM bundle on every entity's project) | Write values (single / batch ≤ 500, one transaction, validated like single writes) on projects at visible sites; every role holds the key by default |
| DELETE | `/custom-columns/values/{col}/{etype}/{eid}` | user (same rule) | Clear a value |

### Predefined phases & settings (`predefined_phases.py`, `settings.py`)

**Settings keys** (`KNOWN_SETTINGS` in `app/services/instance_settings.py`, mirrored by `INSTANCE_SETTING_DEFAULTS` in `frontend/src/api/endpoints/settings.ts` and edited in Settings → Features & defaults; the two `project_field*` keys and `volume_decimals` in Settings → Project fields). Shape is validated, not existence: consumers ignore skill ids and type names that no longer exist. A switch is on unless stored as exactly `false` (`is_enabled` / client `isSettingOn`), which also covers rows written before validation.

| Key | Canonical value | Default | Consumer |
|-----|-----------------|---------|----------|
| `gantt_default_panel` | `none` / `staff` / `equipment` | `none` | `GanttContainer` opens that overview panel once per mount (for users who may see the overview); `none` keeps the per-browser choice |
| `staff_panel_default_skills` | compact JSON array of unique positive ints, ≤ 500 (`[1,2]`) | `[]` | The Staff panel below the Gantt (`StaffView` `embedded`): initial skill filter (∩ existing skills), per mount; the standalone Staff view opens unfiltered |
| `equipment_panel_default_types` | compact JSON array of unique trimmed strings, 1–100 chars | `[]` | The Equipment panel below the Gantt (`EquipmentView` `embedded`): initial type filter (∩ the site's types), per mount and site; the standalone Equipment view opens unfiltered |
| `kanban_enabled` | `true` / `false` | `true` | Feature switch: `false` disables `views.kanban` for everyone (see [Tenant role model](auth-and-tenancy.md#tenant-role-model)) |
| `nager_enabled` | `true` / `false` | `true` | Holiday refresh route (409), automatic fetch on site create/update, the Nager buttons in `SiteForm` / `BankHolidaysPanel` |
| `new_project_preselect_phases` | `true` / `false` | `true` | `ProjectModal` create: all active predefined phases pre-selected, or none |
| `gantt_completion_badges` | `true` / `false` | `true` | `false` hides the % badges of `ProjectRow` / `PhaseRow` / `SubphaseRow` (2.1.0); bar fill, tooltips and the slider (badge click, or the context menu's *Set progress…*) unchanged |
| `project_field_labels` | compact JSON object, keys ⊆ `customer`/`sales_pm`/`volume`/`confirmed` in that order, labels trimmed 1–60 chars (`{"customer":"Client"}`) | `{}` | Built-in field labels (`builtInFieldLabel(settings, key)` in `utils/instanceSettings.ts`: one default per field, the short names of `BUILT_IN_FIELD_DEFAULTS`; a label replaces the name wherever it appears): `ProjectModal`, `ShiftTooltip`, Archived view |
| `project_fields_hidden` | compact JSON array ⊆ `customer`/`sales_pm`/`volume` in that order (`confirmed` → 422) | `[]` | Built-in fields hidden from the dialog and the views (`isBuiltInFieldHidden`); values stay stored and writable (UI only) |
| `volume_decimals` | `any` / `0` / `1` / `2` / `3` | `1` | Volume's Format (2.1.0): `POST /projects` and `PUT /projects/{id}` round `volume` half-up to it (`round_field_number`, read once per request, only when `volume` is sent), and the site export's Projects sheet shows it rounded; `any` = as typed. Stored volumes are never rewritten, and a PUT whose rounded `volume` equals the stored one rounded keeps the stored value (provisioned tenants store `volume REAL`: 12.7 reads back as 12.699999809…, so a dialog echo is no change and notifies nobody). Reader `volume_decimals_from` never raises (missing / malformed → 1); client `volumeDecimals(settings)`, used by `ProjectModal` (`NumberFieldInput`) |

Booleans accept `true/false/1/0/yes/no/on/off` (case-insensitive) and store `true` / `false`. Saving a key broadcasts `change:settings`, which refreshes the `settings` **and** `currentUser` slices (the Kanban switch changes `/auth/me`); the saving admin is excluded from the broadcast, so `DefaultsPanel` re-reads `/auth/me` itself after a `kanban_enabled` change.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/predefined-phases` | user | Active phase templates |
| GET | `/predefined-phases/all` | superuser (`predefined_phases.manage`) | All templates |
| POST / PUT / DELETE | `/predefined-phases`, `…/reorder`, `…/{id}` | superuser (`predefined_phases.manage`) | Template CRUD + reorder |
| GET | `/settings`, `/settings/{key}` | ⚠ none | Instance settings (no auth dependency — do not store secrets in `settings`). Known keys without a row read as their default (merged into `GET /settings`; nothing written) |
| PUT | `/settings/{key}` | admin (`settings.general`; `project_field_labels` / `project_fields_hidden` / `volume_decimals` also `project_fields.manage`) | Update setting. A known key stores its canonical form (422 `Invalid value for <key>` otherwise) and `value: null` deletes its row (answered with the default); any other key is stored as given |
| GET / PUT | `/settings/sso` | none / admin (`settings.sso`) | Tenant SSO settings (read / write) |

### Import & export (`mpp_import.py`, `export.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/import/mpp/test` | superuser (`projects.import`) | Verify the MPP parser (Java/mpxj) is functional |
| POST | `/import/mpp` | superuser (`projects.import`) | Parse an uploaded MS Project file (preview) |
| POST | `/import/project` | superuser (`projects.import`) | Upload + parse (CSV/XML/MPP/MPT/MPX) and create the project at a visible site with its phase tree (completion clamped 0–100 via `apply_completion`, so finished tasks → Done) |
| GET / POST | `/import/test`, `/import/test-upload` | superuser (`projects.import`) | Import diagnostics |
| POST | `/export/mpp/{pid}` | superuser (`projects.export`) | Export project to MPP (visible sites) |
| GET / POST | `/export/csv/{pid}` | superuser (`projects.export`) | Export project to CSV (visible sites) |
| GET | `/export/site/{sid}/excel` | superuser (`sites.export`) | Full site export of a visible site to `.xlsx` (see [Site Export contract](codebase-map.md#site-export-to-excel)) |

All `/import/*` uploads are read with `read_upload_capped()` — **20 MB** cap (`MAX_IMPORT_UPLOAD_BYTES`, else 413) — and parsing runs via `run_in_threadpool` so mpxj/JPype never blocks the event loop.

### Admin portal (`routers/admin/*` → `/api/admin/*`, master DB, `admin_session` cookie)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/admin/auth/login` / `/admin/auth/logout` | public / public | Portal login/logout (login throttled like `/auth/login`, scope `admin`; logout has no auth dependency — it deletes the cookie's session if there is one) |
| GET | `/admin/auth/me` | optional | Current admin (also while `must_change_password`) |
| POST | `/admin/auth/change-password` | portal* | Change password (min 8 chars; clears `must_change_password`). *The only write an admin with `must_change_password` may call — every other portal route returns 403 until then |
| GET | `/admin/tenants`, `/admin/tenants/{id}` | portal | Tenant list / detail |
| POST / PUT / DELETE | `/admin/tenants`, `…/{id}` | portal | Tenant CRUD |
| PUT | `/admin/tenants/{id}/status` | portal | active / suspended / archived |
| POST | `/admin/tenants/{id}/provision` | portal | Provision the tenant database (the seeded tenant admin gets a bcrypt hash; an admin password > 72 bytes → 400). Body `{adminEmail?, adminPassword?, seedDemoData?}`: with `seedDemoData` the demo set (`app/scripts/demo_data.py`, loaded by `app/services/demo_seed.py`) replaces the bare defaults — the tenant admin is its system admin with the returned password, the tenant name its instance title, sample people get a random discarded password (`demo1234` is the Codespaces tenant only), no "Main Site" |
| POST | `/admin/tenants/{id}/reset-admin-password` | portal | Reset the tenant's admin password |
| GET | `/admin/tenants/{id}/audit` | portal | Tenant audit log |
| GET | `/admin/stats` | portal | System statistics |
| GET / POST | `/admin/users` | superadmin | List / create portal admins |
| PUT / DELETE | `/admin/users/{id}` | superadmin | Update / delete a portal admin (there is no `GET /admin/users/{id}`) |

### Organizations (`admin_organizations.py` → `/api/admin/organizations`, all portal auth)

| Method | Path | Description |
|--------|------|-------------|
| GET / POST / PUT / DELETE | ``, `/{id}` | Organization CRUD |
| GET / PUT / DELETE | `/{id}/sso` | Organization SSO config (encrypted secret) |
| POST | `/{id}/sso/test` | SSO diagnostic: local checks, outbound-proxy report, Entra discovery and a client-credentials token request → `{credentialsOk, summary, checks[]}` (`app/services/sso_test.py`). Proves the directory id, client id and secret, not the redirect URI (reported as a manual check); failures go through `parse_entra_token_error` |
| PUT / DELETE | `/{id}/tenants/{tid}` | Attach / detach a tenant |
| PATCH | `/tenants/{tid}/groups` | Set tenant SSO group access (`required_group_ids`, `group_membership_mode`) |

### No HTTP presence API

There are no HTTP presence endpoints — presence works exclusively through the WebSocket layer. (A never-registered `presence.py` router and its frontend polling counterpart were removed as dead code.)
