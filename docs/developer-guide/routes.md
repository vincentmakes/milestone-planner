# Route auth gates and side effects

Every tenant and admin-portal route, grouped by router: its auth gate, its site scoping and the side effects a change must keep (broadcasts, notifications, validation rules). It was moved verbatim out of the repo-root [`CLAUDE.md`](https://github.com/vincentmakes/milestone-planner/blob/main/CLAUDE.md). The request and response shapes for API users are in the [API Reference](api-reference.md).

Code described: `app/routers/` (one file per resource domain, registered in `create_app()` in `app/main.py`), the dependencies in `app/middleware/auth.py` and the access services in `app/services/`.

## API Reference

All routers are mounted under `/api` (multi-tenant deployments reach them at `/t/{slug}/api/...`; the admin portal is always at `/api/admin/*` with no tenant prefix). Auth column: **user** = `get_current_user`, **superuser** = `require_superuser` (admin OR superuser), **admin** = `require_admin`, **portal** = `get_current_admin` (master DB), **superadmin** = `require_superadmin`, **public** = no auth. **user (PM)** = `get_current_user` + `require_project_editor` from `app/services/project_access.py` (admin, superuser, or the project's `pm_id`); **user (PM/own-assignment)** = `require_assignment_write` (project editor, or `staff_id == user.id`). Both are checked after loading the entity, against the server-derived `project_id`.

### Health & diagnostics (`app/routers/health.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` and `/api/health` | public | Status, mode, version, backend id, `default_tenant`, DB reachability (`database: "error"` on failure — details only in the log) |
| GET | `/api/ws-debug` | admin | WebSocket diagnostics (tenant, connection/online counts) |
| POST | `/api/ws-debug/broadcast` | admin | Fire a synthetic `change:project` broadcast |
| GET | `/api/docs`, `/api/redoc`, `/api/openapi.json` | admin | Swagger / ReDoc / schema, defined in `app/main.py` (not a router). Checked against the **session snapshot** role (`get_current_user_from_session`), 401 otherwise |

### Authentication & SSO (`app/routers/auth.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/login` | public | Email/password login → session + `connect.sid` cookie. Throttled: 10 failures / 15 min per (tenant, IP, e-mail) → 429 + `Retry-After`; password > 72 bytes → 400 |
| POST | `/auth/logout` | session | Destroy session, clear cookie |
| GET | `/auth/me` | public | Current user (fresh from DB) or `{user: null}` |
| POST | `/auth/change-password` | user | Change own password (verifies current; new ≥ 8 chars) |
| GET | `/sso/config` | public | Public SSO info for the login page (no secret) |
| GET | `/sso/config/full` | admin | Full SSO config incl. masked secret (`****` + last 4, never the plaintext) + org-precedence info |
| PUT | `/sso/config` | admin | Update tenant SSO (409 if org SSO active). Secret: omitted or masked value keeps the stored one, `""` clears it; stored encrypted (same on every SSO write route) |
| GET | `/auth/sso/config` | public | Public SSO config (`SSOConfigResponse`) |
| PUT | `/auth/sso/config` | admin | Update tenant SSO (alternate path, same guardrail) |
| GET | `/auth/sso/status` | public | Effective SSO status (org vs tenant) + group requirements |
| GET | `/auth/sso/login` | public | Build the Entra authorization URL (HMAC-signed `state` carries the slug + a nonce; sets the one-time `sso_nonce` cookie, 10 min) |
| GET | `/auth/sso/callback` | public | OAuth callback: verify state **and** that its nonce matches this browser's `sso_nonce` cookie (cleared whatever the outcome), token exchange, Graph `/me`, group validation, find/auto-create user, create session |

### Users & staff (`users.py`, `staff.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/users`, `/users/{id}` | superuser | List / detail |
| POST | `/users` | admin | Create user (password ≥ 8 chars) |
| PUT | `/users/{id}` | superuser | Update user (superusers: non-admin targets only, no email/password changes except their own; role/active admin-only; an admin cannot change their own role; password ≥ 8 chars, > 72 bytes → 400; unknown site/skill ids rejected) |
| DELETE | `/users/{id}` | admin | Delete (rejects `is_system`) |
| PUT | `/users/{id}/toggle-active` | admin | Enable/disable |
| GET | `/staff`, `/staff/{id}` | user | Staff read views (staff *are* users — created via `/users`) |
| GET | `/staff/{id}/availability` | user | Availability calculation (`startDate`/`endDate` validated, ≤ 366 days, else 400) |
| GET | `/staff/{id}/assignments` | user | All assignments for a staff member (in `assignments.py`) |

### Sites, holidays & events (`sites.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/sites` | user | Current user's sites |
| GET | `/sites/all` | admin | All sites |
| GET | `/sites/{id}` | user | Site detail |
| POST / PUT / DELETE | `/sites`, `/sites/{id}` | admin | Site CRUD. PUT: an explicit `null` clears `location`/`city`/`country_code`/`region_code` (`model_fields_set`; omitted = unchanged). DELETE deletes the site's projects (FK CASCADE) and their polymorphic comments/custom-column values; equipment linked to other sites survives |
| GET | `/sites/{id}/holidays`, `/holidays` | user | Holidays per site / cross-site (`?startDate=&endDate=` returns every holiday that overlaps the window) |
| POST | `/sites/{id}/holidays` | superuser | Add custom holiday (a span over 366 days → 400, like every holiday/event write and import) |
| PUT | `/sites/{id}/holidays/{hid}` | superuser | Edit any holiday (sets `is_custom = 1`) |
| DELETE | `/sites/{id}/holidays/{hid}` | superuser | Delete any holiday — custom or Nager (a Nager one returns on the next refresh) |
| POST | `/sites/{id}/holidays/import` | superuser | Bulk import `{items:[{date,end_date,name}]}` (≤ 1 000 items, else 422) as custom; dedup on (date, name) → `{created, skipped}` |
| POST | `/sites/{id}/holidays/refresh` | superuser | Fetch public holidays from the Nager API |
| GET | `/sites/{id}/events`, `/events?siteId=` | user | Company events linked to a site (via `company_event_sites`; date bounds match overlapping events, each bound optional); responses carry `site_ids` + legacy `site_id` + `counts_as_unavailable` |
| POST / PUT / DELETE | `/events`, `/events/{id}` | superuser | Multi-site event CRUD (`site_ids` + `counts_as_unavailable` on create/update; DELETE removes it from every site) |
| POST | `/events/import` | superuser | Bulk import `{site_ids, color, counts_as_unavailable, items}` (≤ 1 000 items, else 422; the flag applies to newly created events only); an existing (date, end_date, name) gains missing site links → `{created, linked, skipped}` |
| POST / DELETE | `/sites/{id}/events`, `…/{eid}` | superuser | Legacy single-site create / unlink (event deleted only when no site is left) |

All holiday/event writes also enforce site membership for superusers (`ensure_site_access` from `app/services/site_access.py`; admins any site).

### Projects, phases & subphases (`projects.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/projects` | user | List (site-scoped, filters) |
| GET | `/projects/{id}` | user | Detail with phases/subphases/assignments |
| POST / DELETE | `/projects`, `/projects/{id}` | superuser | Create / delete project (a PM may **not** delete) |
| PUT | `/projects/{id}` | user (PM) | Update project — the PM may change every field, incl. `pm_id` (hand-over) and `archived` |
| POST | `/projects/{id}/phases` | user (PM) | Add phase |
| PUT / DELETE | `/phases/{id}` | user (PM) | Update / delete phase. PUT: explicit `"completion": null` → 0 % via `apply_completion` (omitted = unchanged). DELETE also removes its subphases, their assignments, comments and custom-column values |
| PUT | `/projects/{id}/phases/reorder` | user (PM) | Reorder phases |
| POST | `/phases/{id}/subphases` | user (PM) | Add subphase to a phase (`project_id` taken from the phase, body value ignored) |
| POST | `/subphases/{id}/children` | user (PM) | Add nested subphase (`project_id` taken from the parent) |
| PUT / DELETE | `/subphases/{id}` | user (PM) | Update / delete subphase (404 if missing; PUT `completion: null` → 0 % like phases) |
| PUT | `/subphases/{parent}/reorder` | user (PM) | Reorder subphases (parent resolved first; 404 if missing) |

These handlers call rich `broadcast_change()` — their paths are in `BroadcastMiddleware.SKIP_PATTERNS`.

**Validation (all write routes):** dates where `end < start` → 422 (`DateRangeOrdered` mixin in `app/schemas/base.py` on request bodies, `ensure_date_order()` in `app/services/date_range.py` for merged partial updates) on projects, phases, subphases, assignments, equipment bookings/blocks and absences. Unknown referenced ids (site, `pm_id`, staff, skill, …) → 400/404 instead of an FK 500. Date query filters are parsed with `parse_day` / `parse_day_range` (400 on malformed input; availability ranges capped at 366 days).

### Assignments (`assignments.py` — note the three per-level route families)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/projects/{id}/staff` | user (PM/own-assignment) | Assign staff at project level |
| PUT / DELETE | `/assignments/{id}` | user (PM/own-assignment) | Update / remove project-level assignment |
| POST | `/phases/{id}/staff` | user (PM/own-assignment) | Assign staff at phase level (`project_id` resolved from the phase, body value ignored) |
| PUT / DELETE | `/phase-staff/{id}` | user (PM/own-assignment) | Update / remove phase-level assignment |
| POST | `/subphases/{id}/staff` | user (PM/own-assignment) | Assign staff at subphase level (`project_id` resolved from the subphase) |
| PUT / DELETE | `/subphase-staff/{id}` | user (PM/own-assignment) | Update / remove subphase-level assignment |
| POST | `/projects/{id}/equipment` | user (PM) | Book equipment on a project (no self-service) |

`PUT/DELETE /equipment-assignments/{id}` live in `equipment.py` only (the shadowed duplicates that once sat in `assignments.py` were removed).

### Equipment (`equipment.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/equipment-types` | user | Distinct equipment types (no create route — types come from equipment) |
| PUT / DELETE | `/equipment-types/{name}` | superuser | Rename (`?new_type=`) / delete a type. Superusers only when every equipment of that type is at their sites (403 otherwise). DELETE → 409 while any equipment uses the type |
| GET | `/equipment?siteId=&includeAllSites=` | user | Active equipment, plain array (no pagination), **one row per equipment–site pair** (like `GET /staff`): `site_id`/`site_name` = that pair, plus `site_ids`/`site_names` |
| GET | `/equipment/all` | superuser | All equipment incl. inactive, one row each (with `site_ids`) |
| GET | `/equipment/{id}` | user | Detail (one row, `site_ids`) |
| POST / PUT / DELETE | `/equipment`, `/equipment/{id}` | superuser | Equipment CRUD; `site_ids: int[]` (legacy `site_id` accepted as `[site_id]`; empty → 422). Superusers only for equipment whose sites are **all** theirs (`ensure_site_access`; admins any) |
| GET | `/equipment/{id}/assignments` | user | Bookings for one piece of equipment |
| PUT / DELETE | `/equipment-assignments/{id}` | user (PM) | Update / delete booking |
| GET | `/equipment/{id}/availability` | user | Availability calculation (`startDate`/`endDate` validated, ≤ 366 days, else 400) |
| GET | `/equipment-blocks`, `/equipment/{id}/blocks` | user | Maintenance blocks (all / per equipment; `?siteId=` joins through `equipment_sites`) |
| POST / PUT / DELETE | `/equipment-blocks`, `…/{id}` | superuser | Block CRUD (same superuser site rule as the equipment) |

### Vacations, absence types, notes, skills, tags (`vacations.py`, `absence_types.py`, `notes.py`, `skills.py`, `tags.py`, `tag_groups.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET / POST / PUT / DELETE | `/vacations`, `/vacations/{id}` | user | Vacation CRUD (own-user checks inside handlers; superusers any staff, tenant-wide); optional `absence_type_id`. `GET` without `siteId`: admins/superusers get all, a plain user only their own + colleagues sharing a site; `GET /vacations/{id}` answers 404 to a plain user for an absence of someone outside their sites |
| POST | `/vacations/import` | user | Bulk import `{staff_id, items:[{start_date,end_date,description,absence_type_id}]}` (≤ 1 000 items, else 422); same own-user rule; dedup on (staff, start, end) → `{created, skipped}` |
| GET | `/absence-types` | user | Absence types (active and inactive) |
| POST / PUT / DELETE | `/absence-types`, `/absence-types/{id}` | admin | Absence type CRUD; DELETE → 409 while any vacation uses the type |
| PUT | `/absence-types/reorder` | admin | Reorder (`{type_order: [ids]}`) |
| GET | `/notes` | user | List staff notes |
| POST / DELETE | `/notes`, `/notes/{id}` | superuser | Create / delete note |
| GET | `/skills`, `/skills/{id}` | user | Skills list / detail |
| POST / PUT / DELETE | `/skills`, `/skills/{id}` | superuser | Skill CRUD |
| GET | `/skills/user/{uid}` | user | A user's skills |
| PUT | `/skills/user/{uid}` | superuser | Replace a user's skills |
| POST / DELETE | `/skills/user/{uid}/{sid}` | superuser | Add / remove one skill |
| GET | `/tags` | user | List tags (`group_id`, `all_sites`, `site_ids`, `sort_order`; ordered by group, sort order, name) |
| POST / PUT / DELETE | `/tags`, `/tags/{id}` | admin | Tag CRUD (`all_sites` true clears `site_ids`; unknown group/site → 404). PUT → 409 (string detail with the count) when moving the tag into a single-select group a project already has another tag of, or when restricting sites while projects at a removed site use it |
| PUT | `/tags/reorder` | admin | `{tag_order: [ids]}` → `sort_order = index` |
| GET | `/tag-groups` | user | List groups |
| POST / PUT / DELETE | `/tag-groups`, `/tag-groups/{id}` | admin | Group CRUD. PUT `single_select: true` → 409 while a project holds 2+ tags of the group. DELETE ungroups the tags |
| PUT | `/tag-groups/reorder` | admin | `{group_order: [ids]}` |

Project writes (`POST /projects`, `PUT /projects/{id}`) validate `tag_ids` with `validate_project_tags()` (`app/services/tag_rules.py`): a tag that does not apply to the project's site, or two tags of one single-select group → 400; unknown ids are dropped silently (What-If replay). Inline project tags are `{id, name, color, group_id}`.

### Kanban (`kanban.py`, prefix `/kanban`)

The board itself has **no read endpoint** — `GET /projects/{id}` already returns the tree, so the client derives cards from `appStore.projects`. Card = leaf phase/subphase (`frontend/src/utils/kanbanCards.ts`).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/kanban/projects/{id}/comment-counts` | user | Comment counts per card (kept out of `GET /projects/{id}`, which `fetchAllProjects()` calls once per project) |
| GET | `/kanban/sites/{site_id}/comment-counts` | user | Counts for every card of a site in one query (the board's "All projects" mode) |
| GET | `/kanban/sites/{site_id}/mentionable-users` | user | Mention picker: active members of the site plus all active admins → `{id, name, job_title}`. Deliberately not `GET /staff`, which leaves admins out |
| PUT | `/kanban/cards/{entity_type}/{id}/status` | user **+ assignee-or-project-editor** | Move a card (superuser, the PM, or an assignee of that card); echoes the derived `{status, completion}` so the client reconciles without a refetch |
| POST / DELETE | `/kanban/cards/{et}/{id}/assignees`, `…/{staff_id}` | user (PM/own-assignment) | Assign/unassign (editors manage anyone; any user may join/leave a card themself) — **creates the phase/subphase staff assignment** at `allocation` (1–100) or the assignee's `max_capacity` (409 on duplicate) |
| GET / POST | `/kanban/cards/{et}/{id}/comments` | user | Comment thread; POST is open to **any authenticated user**. Mentions are parsed from the body (`@[Name](id)`, unknown ids dropped) into `mentioned_user_ids`; POST notifies the mentioned users and the card's assignees (someone both gets only the mention) |
| PUT / DELETE | `/kanban/comments/{id}` | user (author; delete also admin/superuser) | Edit / delete a comment; an edit re-reads the mentions and notifies only people newly mentioned |

⚠ `require_card_status_write` (`app/services/card_access.py`): project editor (the route passes `is_privileged=await can_edit_project(...)`, so superuser/admin/PM), **or** an assignee of that card. It takes `user_id`/`is_privileged` primitives, not a `User`, because `get_current_user` often returns the lightweight `SessionUser`.

### Notifications (`notifications.py`, prefix `/notifications`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/notifications?unread_only&limit` | user | Own notifications, newest first |
| GET | `/notifications/unread-count` | user | Badge count (served by the partial unread index) |
| PUT | `/notifications/{id}/read`, `/notifications/read-all` | user | Mark read |

⚠ Every query is pinned to `Notification.user_id == user.id` — there is **no `user_id` parameter**, by design (it would be an IDOR). Due-soon/overdue are derived client-side (`useDerivedDueNotifications`), never stored.

### Custom columns (`custom_columns.py`, prefix `/custom-columns`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/custom-columns`, `/custom-columns/with-values` | user | Columns / columns with values |
| POST / PATCH / DELETE | `/custom-columns`, `…/{id}` | admin | Column CRUD |
| PATCH | `/custom-columns/reorder` | admin | Reorder columns |
| PUT | `/custom-columns/values`, `…/values/batch` | user | Write values (single / batch ≤ 500, one transaction, validated like single writes). Any authenticated user; definitions stay admin-only |
| DELETE | `/custom-columns/values/{col}/{etype}/{eid}` | user | Clear a value |

### Predefined phases & settings (`predefined_phases.py`, `settings.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/predefined-phases` | user | Active phase templates |
| GET | `/predefined-phases/all` | superuser | All templates |
| POST / PUT / DELETE | `/predefined-phases`, `…/reorder`, `…/{id}` | superuser | Template CRUD + reorder |
| GET | `/settings`, `/settings/{key}` | ⚠ none | Instance settings (no auth dependency — do not store secrets in `settings`) |
| PUT | `/settings/{key}` | admin | Update setting |
| GET / PUT | `/settings/sso` | none / admin | Tenant SSO settings (read / write) |

### Import & export (`mpp_import.py`, `export.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/import/mpp/test` | superuser | Verify the MPP parser (Java/mpxj) is functional |
| POST | `/import/mpp` | superuser | Parse an uploaded MS Project file (preview) |
| POST | `/import/project` | superuser | Upload + parse (CSV/XML/MPP/MPT/MPX) and create the project with its phase tree (completion clamped 0–100 via `apply_completion`, so finished tasks → Done) |
| GET / POST | `/import/test`, `/import/test-upload` | superuser | Import diagnostics |
| POST | `/export/mpp/{pid}` | superuser | Export project to MPP |
| GET / POST | `/export/csv/{pid}` | superuser | Export project to CSV |
| GET | `/export/site/{sid}/excel` | superuser | Full site export to `.xlsx` (see [Site Export contract](codebase-map.md#site-export-to-excel)) |

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
| POST | `/{id}/sso/test` | SSO diagnostic: local checks, outbound-proxy report, Entra discovery and a client-credentials token request → `{credentials_ok, summary, checks[]}`. Proves the directory id, client id and secret, not the redirect URI (reported as a manual check); failures go through `parse_entra_token_error` |
| PUT / DELETE | `/{id}/tenants/{tid}` | Attach / detach a tenant |
| PATCH | `/tenants/{tid}/groups` | Set tenant SSO group access (`required_group_ids`, `group_membership_mode`) |

### No HTTP presence API

There are no HTTP presence endpoints — presence works exclusively through the WebSocket layer. (A never-registered `presence.py` router and its frontend polling counterpart were removed as dead code.)
