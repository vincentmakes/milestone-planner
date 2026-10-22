# API Reference

## Interactive Documentation

When the application is running, interactive API documentation is available at:

- **Swagger UI**: [http://localhost:8485/api/docs](http://localhost:8485/api/docs)

## Authentication

All API endpoints (except `/health` and `/api/auth/*`) require authentication via session cookie. Every authenticated request re-checks the account's live `active` flag, its role and the role's permissions; a deactivated, deleted or demoted user's sessions are destroyed and further requests get `401`, and an edit of a role's permissions applies on its holders' next request.

`GET /api/auth/me` (and the login response) carry the user's `roleName`, `permissions` (the keys the role allows; an administrator gets every key), `approvalRequired` (the own-booking keys in approval mode) and `canSeeAllSites`. Clients gate their UI on these — never on the role key.

The interactive docs (`/api/docs`, `/api/redoc`, `/api/openapi.json`) require a signed-in tenant user whose role holds `system.api_docs` (administrators by default); in multi-tenant mode open them under the workspace URL (`/t/{slug}/api/docs`).

### Login

```
POST /api/auth/login
Content-Type: application/json

{
    "email": "user@example.com",
    "password": "password"
}
```

Failed logins are throttled: after **10 failures within 15 minutes** for the same `(workspace, client IP, e-mail)` further attempts return `429 Too Many Requests` with a `Retry-After` header, without checking the password. A success clears the counter. A second window caps a *public* client IP at **100 failures per 15 minutes** across all e-mails and scopes (not cleared by a success; private, loopback and CGNAT addresses are exempt because a proxy or NAT may share them). The client IP is `request.client.host`, i.e. the `X-Forwarded-For` address only when the proxy is listed in `FORWARDED_ALLOW_IPS`. The counter is in memory **per server process**. Unknown e-mails take as long as wrong passwords (a dummy hash is verified). A password longer than 72 bytes returns `400`.

New or changed passwords (`POST /users`, `PUT /users/{id}`, `POST /auth/change-password`, admin-portal equivalents) must be **at least 8 characters** (`422` otherwise); existing shorter passwords still log in.

### SSO Login (Microsoft Entra ID)

```
GET /api/auth/sso/login     → Returns the Microsoft authorization URL, sets the sso_nonce cookie
GET /api/auth/sso/callback  → Handles the OAuth callback from Microsoft
```

The OAuth `state` is HMAC-signed and carries the workspace slug plus a nonce. `/auth/sso/login` also sets that nonce as a one-time `sso_nonce` cookie (HttpOnly, SameSite=Lax, path `/`, 10 minutes); the callback only proceeds when the signature is valid **and** the nonce equals the cookie, and clears the cookie whatever the outcome. A callback opened in another browser, replayed, or more than 10 minutes late is refused.

Tenant SSO configuration (`GET /api/sso/config/full`, `PUT /api/sso/config`, `PUT /api/auth/sso/config`, `PUT /api/settings/sso`) never returns the client secret in clear — only `****` plus its last four characters. On write, an omitted secret or the masked value keeps the stored secret, any other value replaces it and `""` clears it. The secret is stored AES-256-GCM encrypted.

### Logout

```
POST /api/auth/logout
```

## Tenant API Routes

All tenant routes are prefixed with `/t/{slug}/api/`.

### Access levels

Every route is gated on a **permission key** from the catalogue in `app/services/permissions.py` (59 keys; `GET /api/permissions` lists them). A role holds each key as `allow`, as `approval` (only the three own-booking keys) or not at all. The Administrator role holds every key. A missing key returns `403` with `detail` `Permission required: <key>` (several alternatives: `… <a> or <b>`).

The **Auth** column used below names the key; the label says who holds it with the shipped roles:

| Level | Who passes |
|-------|------------|
| **user** | Any authenticated user |
| **superuser** (`key`) | Holders of the key — Superuser and Administrator by default |
| **admin** (`key`) | Holders of the key — Administrator only by default |
| **admin role** | The Administrator role itself (`require_admin`): role and approval-policy writes only, so nobody can lock the tenant out |
| **user (PM)** (`key`) | Holders of the key, **or the project's manager** (`projects.pm_id == user.id`) when the key is in the PM bundle and the role holds `projects.manage_as_pm` |
| **user (PM/own-assignment)** | Holders of `assignments.manage_others` or the project's manager (*editor first*); otherwise **the staff member the assignment books**, in the mode of `assignments.self_create` / `self_update` / `self_remove`: `allow` → done, `approval` → `202` approval request, no mode → `403` |

The PM bundle is `projects.edit_any`, `projects.archive`, `assignments.manage_others`, `equipment_bookings.manage`, `kanban.move_any`, `custom_columns.set_values` and `todos.assign_others`.

The per-project levels are checked inside the handler (`app/services/project_access.py`) after the entity is loaded, against a `project_id` derived server-side from the path or the loaded phase/subphase/assignment row — a `project_id` in the request body is never used for the check. Failures return `403`; a missing project/phase/subphase returns `404`.

**Visible sites.** Every route is also limited to the caller's visible sites: every site with `sites.view_all` (administrators by default), otherwise the sites in their account (`app/services/site_access.py`). A `siteId` parameter or body `site_id` outside them, and any write on a project or site outside them, return `403`; reading a site, team, person, equipment item or absence outside them returns `404`; lists are filtered. Site-less projects and equipment need `sites.view_all`. The `views.*` keys gate the reads behind their views: `views.kanban` (Kanban reads), `views.staff` (per-person availability and assignments), `views.equipment` (equipment, bookings, blocks), `views.crosssite` (`includeOtherSites=true`) and `views.archived` (`archived=true`; `archived=all` leaves archived projects out without it).

### Validation

- **Date order**: a body whose `end_date` is before its `start_date` is rejected with `422` on projects, phases, subphases, staff assignments, equipment bookings, equipment blocks and absences. Partial updates are checked against the merged row.
- **References**: unknown ids in a body (site, project manager, staff member, skill, absence type, …) return `400` or `404` instead of a database error.
- **Date query parameters** (`startDate` / `endDate` on availability, holidays, events, notes) must be `YYYY-MM-DD` (`400` otherwise). The staff and equipment availability endpoints also require `startDate <= endDate` and cap the range at 366 days.
- **Allocation**: every staff assignment — project, phase and subphase level, create and update, and Kanban assignees — takes an integer `allocation` of **1–100** (`422` otherwise).

### Projects

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/t/{slug}/api/projects` | user | List all projects (with phases, subphases, assignments) |
| `POST` | `/t/{slug}/api/projects` | superuser (`projects.create`) | Create a project at a visible site |
| `GET` | `/t/{slug}/api/projects/{id}` | user | Get project details with full hierarchy |
| `PUT` | `/t/{slug}/api/projects/{id}` | user (PM) (`projects.edit_any`) | Update a project — every field, including `pm_id` (so a manager can hand the project over), `archived` (needs `projects.archive`), `tag_ids` and `team_ids` |
| `DELETE` | `/t/{slug}/api/projects/{id}` | superuser (`projects.delete`) | Delete a project (not in the PM bundle: a project manager cannot) |

Project list and detail responses carry `team_ids`; create and update accept `team_ids` (omitted = unchanged, `[]` = no team). Every team must be at the project's site (`400`; a project without a site cannot have teams). Unknown team ids are dropped silently, like unknown tag ids, so a What-If replay survives a team deleted in the meantime. Changing the teams re-checks the project's tags: a tag limited to teams the project no longer shares is refused (`400`).

### Phases & Subphases

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/t/{slug}/api/projects/{id}/phases` | user (PM) | Create a phase |
| `PUT` | `/t/{slug}/api/phases/{id}` | user (PM) | Update a phase (dates, name, dependencies, completion) |
| `DELETE` | `/t/{slug}/api/phases/{id}` | user (PM) | Delete a phase with its subphases and their assignments, comments and custom-column values |
| `PUT` | `/t/{slug}/api/projects/{id}/phases/reorder` | user (PM) | Reorder phases |
| `POST` | `/t/{slug}/api/phases/{id}/subphases` | user (PM) | Create a subphase |
| `POST` | `/t/{slug}/api/subphases/{id}/children` | user (PM) | Create a nested subphase |
| `PUT` | `/t/{slug}/api/subphases/{id}` | user (PM) | Update a subphase (dates, name, dependencies) |
| `DELETE` | `/t/{slug}/api/subphases/{id}` | user (PM) | Delete a subphase |
| `PUT` | `/t/{slug}/api/subphases/{parent_id}/reorder` | user (PM) | Reorder the subphases under a parent |

`completion` on phase/subphase updates: an omitted field leaves it unchanged; an explicit `null` resets it to 0 % (and the Kanban status to To Do). Status and completion are always derived together server-side (`apply_completion`).

**Dependencies** are a JSON array on each phase/subphase: `[{"id": 41, "type": "FS", "lag": 0, "entity": "phase"}]`. `type` is `FS`/`SS`/`FF`/`SF` (missing = `FS`), `lag` is in days, and `entity` (`phase` or `subphase`) names the predecessor's kind, because phase and subphase ids are separate sequences. Clients always write `entity`; legacy entries without it are resolved phase-first.

### Staff

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/staff` | List all staff |
| `GET` | `/t/{slug}/api/staff/{id}` | Get a staff member |
| `GET` | `/t/{slug}/api/staff/{id}/availability?startDate=&endDate=` | Availability calculation (validated dates, at most 366 days; `views.staff`; approved bookings only) |

Staff endpoints are read-only — staff members *are* users and are created and managed via the `/users` endpoints.

`GET /staff` returns one row per user–site pair; each row's `team_ids` are the user's teams **at that row's site**. `GET /staff/{id}` returns all of them.

### Equipment

Equipment can belong to several sites (`equipment_sites`), like staff. Every response carries `site_ids` / `site_names` (all linked sites) next to the legacy `site_id` / `site_name`.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/t/{slug}/api/equipment?siteId=&includeAllSites=` | user (`views.equipment`) | Active equipment at the visible sites as a plain array (no pagination envelope), **one row per equipment–site pair** — like `GET /staff`. Each row's `site_id`/`site_name` is that pair's site; `siteId` limits the rows to one site |
| `GET` | `/t/{slug}/api/equipment/all` | superuser (`equipment.manage`) | All equipment at the visible sites, including inactive — one row per item |
| `GET` | `/t/{slug}/api/equipment/{id}` | user (`views.equipment`) | One item (one row, with `site_ids`; `404` unless linked to a visible site) |
| `POST` | `/t/{slug}/api/equipment` | superuser (`equipment.manage`) | Create an item — `{name, type, description?, site_ids: [..]}` |
| `PUT` | `/t/{slug}/api/equipment/{id}` | superuser (`equipment.manage`) | Update an item; `site_ids`, when given, replaces its site links |
| `DELETE` | `/t/{slug}/api/equipment/{id}` | superuser (`equipment.manage`) | Delete an item |
| `GET` | `/t/{slug}/api/equipment/{id}/availability?startDate=&endDate=` | user (`views.equipment`) | Per-day availability for a date range (validated, at most 366 days) |

Equipment can also be limited to teams: `team_ids` on create and update (omitted = unchanged on update), `team_ids` / `team_names` in every response. The rule is **per site** — a site with none of the equipment's teams keeps it open to the whole site; at a site with listed teams only those teams see it under the team filter. Every team must be at one of the equipment's sites (`400`); a `site_ids` change without `team_ids` drops the teams of the sites removed.

`site_ids` must not be empty (`422`). Clients that predate multi-site equipment may still send `site_id`, which is taken as `[site_id]`. The legacy `equipment.site_id` column is kept as the "primary site" — the lowest linked site id. Equipment (and its blocks) may only be created, edited or deleted when its sites are **all** among the caller's visible sites (`403` otherwise); with `sites.view_all`, any.

Deleting a site removes its links: equipment still linked to another site survives (its `site_id` is re-pointed), and only equipment left with no site is deleted.

### Equipment Blocks (Maintenance / Out-of-service)

Block periods mark equipment as unavailable for booking. See [Equipment Booking — Maintenance Blocks](../user-guide/equipment-booking.md#maintenance-blocks) for the user-facing behaviour.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/equipment-blocks?siteId=&equipmentId=` | List equipment blocks (optional filters; `siteId` matches any site the equipment is linked to) |
| `GET` | `/t/{slug}/api/equipment/{id}/blocks` | List blocks for one equipment item |
| `POST` | `/t/{slug}/api/equipment-blocks` | Create a block (`equipment_blocks.manage`) |
| `PUT` | `/t/{slug}/api/equipment-blocks/{id}` | Update a block |
| `DELETE` | `/t/{slug}/api/equipment-blocks/{id}` | Delete a block |

### Assignments

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/t/{slug}/api/projects/{id}/staff` | user (PM/own-assignment) | Assign staff at project level |
| `PUT` / `DELETE` | `/t/{slug}/api/assignments/{id}` | user (PM/own-assignment) | Update / remove project-level assignment |
| `POST` | `/t/{slug}/api/phases/{id}/staff` | user (PM/own-assignment) | Assign staff at phase level |
| `PUT` / `DELETE` | `/t/{slug}/api/phase-staff/{id}` | user (PM/own-assignment) | Update / remove phase-level assignment |
| `POST` | `/t/{slug}/api/subphases/{id}/staff` | user (PM/own-assignment) | Assign staff at subphase level |
| `PUT` / `DELETE` | `/t/{slug}/api/subphase-staff/{id}` | user (PM/own-assignment) | Update / remove subphase-level assignment |
| `POST` | `/t/{slug}/api/projects/{id}/equipment` | user (PM) (`equipment_bookings.manage`) | Book equipment on a project |
| `PUT` / `DELETE` | `/t/{slug}/api/equipment-assignments/{id}` | user (PM) (`equipment_bookings.manage`) | Update / remove equipment booking |

The *own-assignment* rule lets a user add, change and remove the assignments that book **their own** time (`staff_id` equal to their id) — self-assignment — without being able to touch anyone else's, as far as their role's `assignments.self_*` keys allow. For phase- and subphase-level writes the project is derived from the loaded phase/subphase; a `project_id` in the body is ignored.

**Own bookings that need approval.** When the caller books themself and the matching `assignments.self_*` key is in `approval` mode, the nine staff routes above and the two Kanban join/leave routes answer **`202`** `{success: true, pending: true, request_id, id}` instead of writing:

- a create inserts the row with `approval_status: "pending"` (excluded from availability, card moves and assignee notifications) and files the request;
- an update or removal leaves the row as it is and files the request with the `requested` (and `previous`) values;
- deleting one's own pending create cancels it and answers `200` `{success: true, cancelled: true, request_id, id}`; updating it amends the request.

Related rules: the `POST`s return `409` when the person is already booked on the target (a pending booking counts; at project level only with the same dates); an editor's `PUT`/`DELETE` on someone else's pending create returns `409` (*approve or reject it instead*); an editor's direct write on a row with an open request closes that request as `expired` (`overtaken`). Assignment rows carry `approval_status`, and in `GET /projects/{id}` an `approval` object (`{request_id, action, requester_id, requested, previous, created_at, can_decide}` or `null`).

`PUT` / `DELETE /equipment-assignments/{id}` are implemented once, in `app/routers/equipment.py`; the duplicate (shadowed) handlers that used to live in `assignments.py` were removed.

### Vacations (Absences)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/vacations?siteId=` | List vacations — with `siteId` (needs `absences.view_others` and a visible site, `403` otherwise), those of that site's staff; without it, the caller's own plus, with `absences.view_others`, those of the people at their visible sites (every site with `sites.view_all`). `GET /vacations/{id}` is `404` outside that scope |
| `POST` | `/t/{slug}/api/vacations` | Create a vacation |
| `POST` | `/t/{slug}/api/vacations/import` | Bulk-import absences for one person (e.g. parsed from an `.ics` file) |
| `PUT` | `/t/{slug}/api/vacations/{id}` | Update a vacation |
| `DELETE` | `/t/{slug}/api/vacations/{id}` | Delete a vacation |

Create, update and the response carry an optional `absence_type_id` (see [Absence Types](#absence-types)). A `null` type is treated as *unavailable*, matching the behaviour before absence types existed. An unknown id is rejected with `400`. Recurring absences are still encoded in `description` as `[R:1,3]` (days of week, 0 = Sunday).

Creating or importing one's own absences needs `absences.manage_own`; anyone else's `absences.manage_others` (superusers and administrators by default), for people sharing a visible site. The import skips items whose `(start_date, end_date)` already exists for that person (or repeats within the batch), writes everything in one transaction, and accepts at most 1000 items:

```
POST /t/{slug}/api/vacations/import
Content-Type: application/json

{
    "staff_id": 12,
    "items": [
        {"start_date": "2026-12-21", "end_date": "2026-12-31", "description": "Christmas", "absence_type_id": 1},
        {"start_date": "2027-01-15", "end_date": "2027-01-15", "description": "Working from home", "absence_type_id": 2}
    ]
}

→ {"created": 2, "skipped": 0}
```

### Absence Types

Tenant-wide categories of time off. Reading is open to any authenticated user; every write needs `absence_types.manage` (administrators by default).

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/absence-types` | List all types (active and inactive), ordered by `sort_order` |
| `POST` | `/t/{slug}/api/absence-types` | Create a type — `{name, color, counts_as_unavailable?, is_active?}`; appended at the end |
| `PUT` | `/t/{slug}/api/absence-types/reorder` | Reorder — `{type_order: [ids...]}` |
| `PUT` | `/t/{slug}/api/absence-types/{id}` | Partial update of `name`, `color`, `counts_as_unavailable`, `is_active` |
| `DELETE` | `/t/{slug}/api/absence-types/{id}` | Delete — `409` while any vacation still uses the type (deactivate it instead) |

`color` must be `#RRGGBB`; names are unique (`400` on a duplicate). Response fields: `id`, `name`, `color`, `counts_as_unavailable`, `sort_order`, `is_active`, `created_at`, `updated_at`. Inactive types are still returned so existing absences keep their label and color; clients hide them from pickers.

### Bank Holidays

Holiday writes need `bank_holidays.manage` (superusers and administrators by default) and a visible site (`403` otherwise); reads of a site outside the visible ones are `403` too.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/sites/{id}/holidays?year=` | Holidays of a site |
| `GET` | `/t/{slug}/api/holidays?siteId=&startDate=&endDate=` | Holidays of a site within a date range |
| `POST` | `/t/{slug}/api/sites/{id}/holidays` | Add a custom holiday — `{date, end_date?, name}` |
| `PUT` | `/t/{slug}/api/sites/{id}/holidays/{holiday_id}` | Edit any holiday (partial `date`, `end_date`, `name`). The holiday becomes custom (`is_custom = 1`) |
| `DELETE` | `/t/{slug}/api/sites/{id}/holidays/{holiday_id}` | Delete any holiday, custom or fetched; a fetched one returns on the next refresh |
| `POST` | `/t/{slug}/api/sites/{id}/holidays/import` | Bulk-import custom holidays — `{items: [{date, end_date?, name}]}` → `{created, skipped}` |
| `POST` | `/t/{slug}/api/sites/{id}/holidays/refresh` | Re-fetch public holidays from the Nager API |

Imported items whose `(date, name)` already exists on the site, or repeat within the batch, are skipped. A refresh replaces the site's non-custom holidays and skips any Nager holiday falling on a day already covered by a custom holiday, so edited and imported holidays are never overwritten or duplicated.

### Company Events

An event can be linked to several sites. Responses include `site_ids` (all linked sites, sorted) and, for compatibility, `site_id` (the first of them), plus `counts_as_unavailable` — `true` marks the event as a **site closure**: staff on its sites are unavailable for its dates (default `false`: displayed only). Writes need `company_events.manage` and every site involved must be visible.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/sites/{id}/events?year=` | Events linked to a site |
| `GET` | `/t/{slug}/api/events?siteId=&startDate=&endDate=` | Events linked to a site within a date range |
| `POST` | `/t/{slug}/api/events` | Create an event on one or more sites — `{date, end_date?, name, color?, site_ids, counts_as_unavailable?, team_ids?}` |
| `PUT` | `/t/{slug}/api/events/{id}` | Partial update (incl. `counts_as_unavailable`); `site_ids`, when given, replaces the event's site links; `team_ids`, when given, replaces its teams |
| `DELETE` | `/t/{slug}/api/events/{id}` | Delete the event from every site |
| `POST` | `/t/{slug}/api/events/import` | Bulk import — `{site_ids, color?, counts_as_unavailable?, items: [{date, end_date?, name}]}` → `{created, linked, skipped}` |
| `POST` | `/t/{slug}/api/sites/{id}/events` | Legacy: create an event on a single site (also accepts `counts_as_unavailable`) |
| `DELETE` | `/t/{slug}/api/sites/{id}/events/{event_id}` | Legacy: unlink the event from that site; it is deleted only when no site is left |

On import, an existing event with the same `(date, end_date, name)` is reused: it gains any missing target-site links (counted in `linked`) instead of being duplicated. Events already linked to every target site, and repeats within the batch, count as `skipped`. The request-level `counts_as_unavailable` applies to newly created events only; reused events keep their own setting.

Responses also carry `team_ids`. An event can be limited to teams of its sites, per site: a site with none of the event's teams gets the whole event. Each team must be at one of the event's sites (`400`); a `site_ids` change without `team_ids` drops the teams of the sites removed. The import and the legacy single-site create always make whole-site events.

Closures are evaluated client-side (`frontend/src/utils/siteClosure.ts`): there is no availability endpoint change, and bank holidays still do not reduce availability. A closure limited to teams makes only those teams' members unavailable at that site; it never shades the calendar header. A plain event limited to teams is still shown to the whole site.

### Equipment Types

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/equipment-types` | List all equipment types |
| `PUT` | `/t/{slug}/api/equipment-types/{old_type}?new_type=` | Rename an equipment type on every item that uses it (`equipment_types.manage`) |
| `DELETE` | `/t/{slug}/api/equipment-types/{type_name}` | Delete an equipment type (`equipment_types.manage`) — `409` while any equipment uses it |

There is no create endpoint: a type exists as long as some equipment carries it. A type may be renamed or deleted only when every piece of equipment of that type is at one of the caller's visible sites (`403` otherwise).

### Tags

Project tags are colored labels shared across all projects in the instance. See [Gantt Charts — Tags](../user-guide/gantt-charts.md#tags) for the user-facing behaviour. To attach or detach tags from a project, send a `tag_ids` array in the project `PUT` payload.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/tags` | List all tags (`group_id`, `all_sites`, `site_ids`, `team_ids`, `sort_order`) |
| `POST` | `/t/{slug}/api/tags` | Create a tag (`tags.manage`) |
| `PUT` | `/t/{slug}/api/tags/{id}` | Update a tag — name, color, group, sites, teams (`tags.manage`) |
| `DELETE` | `/t/{slug}/api/tags/{id}` | Delete a tag from every project (`tags.manage`) |

A tag can be limited to teams with `team_ids`. Per site: no team of the tag at a site means every project there may carry it; otherwise only projects sharing one of those teams (`400` on the project write). Each team must be at one of the tag's sites unless the tag applies to all sites (`400`). Narrowing `team_ids` while projects at those teams' sites outside them use the tag is refused with `409`; narrowing the sites without `team_ids` drops the teams of the sites removed.

### Teams

A team is a named group of people at **one** site. Every authenticated user can read the teams of their visible sites; `teams.manage` holders manage them at their visible sites (`403` otherwise). Team writes are configuration: they bypass What-If queuing and broadcast a `change:team` event. See [Settings — Teams](../user-guide/settings.md#teams) for the user-facing behaviour.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/t/{slug}/api/teams?siteId=` | user | Every team, inactive ones included, ordered by site then name; `siteId` limits the list to one site |
| `GET` | `/t/{slug}/api/teams/{id}` | user | One team (`404` if missing) |
| `POST` | `/t/{slug}/api/teams` | superuser (`teams.manage`) | Create a team — `{site_id, name, description?, color?, active?, member_ids?}` |
| `PUT` | `/t/{slug}/api/teams/{id}` | superuser (`teams.manage`) | Partial update — `{name?, description?, color?, active?, member_ids?}`; the site cannot change |
| `DELETE` | `/t/{slug}/api/teams/{id}` | superuser (`teams.manage`) | Delete the team; its memberships and its project, tag, equipment and event links go with it. `409` when it would strand projects (see below) |

Response: `{id, site_id, name, description, color, active, member_ids, created_at, updated_at}`.

- **Name**: 1–100 characters (`422` otherwise), trimmed, unique per site — a name of only spaces or a duplicate at the site is `400`. An unknown `site_id` is `404`.
- **Members**: `member_ids` replaces the member list; every member must belong to the team's site (`400` otherwise).
- **Clearing**: an explicit `null` clears `description` or `color`; other omitted or `null` fields are left unchanged. `color` is `#RRGGBB`.
- **Inactive teams** keep scoping everything they are linked to; only the header team filter leaves them out.
- **Deleting a team** is `409` while a project of the team holds a tag also limited to other teams at the site, none of which the project is in (the tag would no longer apply to it); `detail` counts those projects.
- **Deleting a site** deletes its teams with all their links.

`team_ids` on other resources:

| Resource | Field | Rule |
|----------|-------|------|
| Projects | `team_ids` (read, create, update) | Teams at the project's site |
| Staff | `team_ids` (read) | Per `/staff` row: the teams at that row's site |
| Users | `team_ids`, `team_names` (read); `team_ids` on `POST` / `PUT /users` | Each team at one of the user's sites; only teams at the caller's visible sites; removing a site from a user drops that site's teams |
| Equipment | `team_ids`, `team_names` (read); `team_ids` on create / update | Per site; no team at a site = the whole site |
| Tags | `team_ids` (read, create, update) | Per site, as above; `409` when narrowing would strand projects |
| Company events | `team_ids` on `POST /events` and `PUT /events/{id}` | Per site, as above |

### Import & Export

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/t/{slug}/api/import/project` | Import a project from CSV / XML / MPP (multipart upload) at a visible site (`projects.import`, like every import route) |
| `POST` | `/t/{slug}/api/import/mpp` | Parse a Microsoft Project file (`.mpp`/`.mpt`/`.mpx`) for preview — requires Java |
| `GET` | `/t/{slug}/api/import/mpp/test` | Diagnostic — verify Java/MPP toolchain is available |
| `GET` / `POST` | `/t/{slug}/api/export/csv/{id}` | Export a single project as CSV (`projects.export`) |
| `POST` | `/t/{slug}/api/export/mpp/{id}` | Export a single project for Microsoft Project (`projects.export`) |
| `GET` | `/t/{slug}/api/export/site/{site_id}/excel` | Export the full site (multi-sheet `.xlsx`) — `sites.export`, visible sites only |

Import uploads are limited to **20 MB** (`413` above that) and are parsed in a worker thread. Exports prefix text cells that start with `=`, `+`, `-`, `@`, tab or CR with `'` (spreadsheet formula injection guard).

### Custom Columns

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/custom-columns` | List custom column definitions |
| `POST` | `/t/{slug}/api/custom-columns` | Create a custom column |
| `PATCH` | `/t/{slug}/api/custom-columns/{id}` | Update a custom column |
| `DELETE` | `/t/{slug}/api/custom-columns/{id}` | Delete a custom column |
| `PATCH` | `/t/{slug}/api/custom-columns/reorder` | Reorder columns |
| `PUT` | `/t/{slug}/api/custom-columns/values` | Write a column value (`/values/batch` for bulk) |
| `DELETE` | `/t/{slug}/api/custom-columns/values/{column_id}/{entity_type}/{entity_id}` | Clear a value |

Column definitions (create, update, delete, reorder) need `custom_columns.manage` (administrators by default); values need `custom_columns.set_values` (every built-in role) or the PM bundle on the entity's project, on projects at visible sites. `PUT /values/batch` takes `{updates: [...]}` with at most 500 items, validates each like a single write and applies them in one transaction.

### Kanban

The board has no read endpoint of its own — `GET /projects/{id}` already returns the full phase/subphase tree, and the client derives cards from it. A card is a *leaf* phase or subphase.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/kanban/projects/{id}/comment-counts` | Comment counts per card for one project |
| `PUT` | `/t/{slug}/api/kanban/cards/{entity_type}/{id}/status` | Move a card between columns (`entity_type` is `phase` or `subphase`) — `kanban.move_any` (PM bundle) or an approved assignee with `kanban.move_assigned` |
| `POST` | `/t/{slug}/api/kanban/cards/{entity_type}/{id}/assignees` | Assign staff — also books their time — user (PM/own-assignment) |
| `DELETE` | `/t/{slug}/api/kanban/cards/{entity_type}/{id}/assignees/{staff_id}` | Unassign and release the booking — user (PM/own-assignment) |
| `GET` / `POST` | `/t/{slug}/api/kanban/cards/{entity_type}/{id}/comments` | Read / post comments |
| `PUT` / `DELETE` | `/t/{slug}/api/kanban/comments/{id}` | Edit / delete a comment |

Permissions: moving a card needs `kanban.move_any` (the project's manager through the PM bundle) or an **approved** assignment on the card plus `kanban.move_assigned`; reads need `views.kanban`; commenting needs `kanban.comment`, deleting someone else's comment `kanban.moderate_comments`. Assigning or unassigning other people follows *user (PM/own-assignment)*: editors manage anyone, and a user may join or leave a card themselves (`staff_id` = their own id) — with a `202` approval request when their role needs approval. The assignee body takes an optional `allocation` (1–100; default: the person's `max_capacity`).

Comments keep a nullable `author_id`: when the author's account is deleted the comment remains with `author_id: null` (shown as *Deleted user*).

The status endpoint returns the resulting `{status, completion}` pair, because the two fields are kept in sync server-side — clients apply the change optimistically and reconcile against this echo.

### Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/notifications?unread_only=&limit=` | The signed-in user's notifications, newest first |
| `GET` | `/t/{slug}/api/notifications/unread-count` | Unread count for the bell badge |
| `PUT` | `/t/{slug}/api/notifications/{id}/read` | Mark one as read |
| `PUT` | `/t/{slug}/api/notifications/read-all` | Mark all as read |

Every endpoint is implicitly scoped to the session user; there is no user id to pass. Requesting another user's notification returns `404`, not `403`, so the endpoint cannot be used to probe for their existence.

Due-soon and overdue reminders are **not** served here — they are derived in the browser from loaded project data.

### Real-Time Collaboration

| Method | Endpoint | Description |
|--------|----------|-------------|
| `WS` | `/t/{slug}/ws` | WebSocket for real-time updates and presence |

Presence (who is online, who is viewing a project) is handled entirely over the WebSocket connection — there are no HTTP presence endpoints.

The handshake is refused when the `Origin` header names another site (it must match `Host` / `X-Forwarded-Host` or a `CORS_ORIGINS` entry). Close codes:

| Code | Meaning | Client reaction |
|------|---------|-----------------|
| 4001 | No, invalid or expired session — or the session was revoked | Re-check the session; back to login if gone; no reconnect |
| 4002 | Authentication error | No reconnect |
| 4003 | Origin not allowed, or user disabled | Re-check the session; no reconnect |
| 4004 / 4005 / 4006 | Tenant not found / not active / database not configured | No reconnect |

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/ws-debug` | admin (`system.ws_debug`) | WebSocket diagnostics |
| `POST` | `/api/ws-debug/broadcast` | admin (`system.ws_debug`) | Send a synthetic `change:project` event |

Besides the tenant-wide `change:<entity>` events (now also `change:role`, `change:approval_policy` and `change:approval_request`), the server pushes per-user events: `notification:new`, `approval:changed` (to a request's requester and approvers) and `todo:changed` (to a todo's assignee and creator) — hints to refetch, never the data itself.

### Other Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/sites` | List the caller's visible sites |
| `POST` | `/t/{slug}/api/sites` | Create a site (`sites.manage`, like update and delete) |
| `PUT` | `/t/{slug}/api/sites/{id}` | Update a site — an explicit `null` clears `location`, `city`, `country_code` or `region_code`; an omitted field is unchanged |
| `DELETE` | `/t/{slug}/api/sites/{id}` | Delete a site **and its projects** (with their comments and custom-column values); equipment and company events shared with other sites are kept |
| `GET` | `/t/{slug}/api/skills` | List skills |
| `POST` | `/t/{slug}/api/skills` | Create a skill |
| `PUT` | `/t/{slug}/api/skills/{id}` | Update a skill |
| `DELETE` | `/t/{slug}/api/skills/{id}` | Delete a skill |
| `GET` | `/t/{slug}/api/settings` | Get instance settings |
| `PUT` | `/t/{slug}/api/settings/{key}` | Update one setting |
| `GET` | `/t/{slug}/api/users` | List users at the visible sites (`users.view`); responses carry `role` (the key) and `role_name` |
| `POST` | `/t/{slug}/api/users` | Create a user (`users.create`; optional `team_ids`). A `role` other than `user` also needs `users.change_role` and must be within the caller's own permissions (`403`); an unknown role key is `404`, a malformed one `422` |
| `PUT` | `/t/{slug}/api/users/{id}` | Update a user — one key per kind of change: profile, sites, teams, skills `users.edit`; an admin target `users.edit_admins`; another user's email or password `users.edit_credentials`; `role` `users.change_role` (both the old and the new role must be within the caller's); `active` `users.toggle_active`. Nobody changes their own role or deactivates themself (`400`); the last active admin stays one (`400`). `team_ids`, when given, replaces the memberships |
| `DELETE` | `/t/{slug}/api/users/{id}` | Delete a user (`users.delete`) |
| `GET` | `/t/{slug}/api/predefined-phases` | List predefined phases |
| `POST` | `/t/{slug}/api/predefined-phases` | Create a predefined phase |
| `PUT` | `/t/{slug}/api/predefined-phases/{id}` | Update a predefined phase |
| `DELETE` | `/t/{slug}/api/predefined-phases/{id}` | Delete a predefined phase |
| `GET` | `/t/{slug}/api/notes` | List notes |
| `POST` | `/t/{slug}/api/notes` | Create a note |
| `DELETE` | `/t/{slug}/api/notes/{id}` | Delete a note |

### Permissions & Roles

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/t/{slug}/api/permissions` | user | The catalogue, grouped for the role matrix |
| `GET` | `/t/{slug}/api/roles` | user | Every role, in display order |
| `GET` | `/t/{slug}/api/roles/{id}` | user | One role (`404` if missing) |
| `POST` | `/t/{slug}/api/roles` | admin role | Create a role → `201` |
| `PUT` | `/t/{slug}/api/roles/{id}` | admin role | Partial update; `permissions`, when given, replaces the matrix |
| `DELETE` | `/t/{slug}/api/roles/{id}` | admin role | Delete a custom role → `204` |

`GET /permissions` returns `{groups: [{name, permissions: [{key, label, description, approvable, locked, defaults: {superuser, user}}]}], pm_bundle: [...]}`. A role is `{id, key, name, description, is_system, sort_order, permissions: {key: "allow" | "approval"}, user_count}`; a key that is absent is denied. The Administrator role lists every key as `allow`.

```
POST /t/{slug}/api/roles
Content-Type: application/json

{
    "key": "team_lead",
    "name": "Team Lead",
    "description": "Leads a lab team",
    "permissions": {"projects.view": "allow", "projects.create": "allow", "assignments.self_create": "approval"}
}
```

| Status | When |
|--------|------|
| `400` | Key already taken (system keys included); name blank or already taken (case-insensitive) |
| `403` | Editing the Administrator role (`Administrator permissions cannot be edited`); deleting a system role; caller is not an administrator |
| `404` | Unknown role id |
| `409` | Deleting a role users still hold (`N users hold this role. Give them another role first.`) |
| `422` | Key not matching `^[a-z][a-z0-9_]{1,19}$`; a `PUT` with a different `key` (keys never change); unknown permission (`Unknown permission: x`); `approval` on a key that is not an own-booking key; a locked key changed (`Permission is locked: x` — `projects.view` is always `allow`, `roles.manage` is the Administrator's alone); a mode other than `allow` / `approval` |

Role writes are configuration: they bypass What-If queuing and broadcast `change:role`, which makes open clients re-read `/auth/me`.

### Approval Policies

Who approves each own-booking action. Administrators can always approve, whatever the policy says.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/t/{slug}/api/approval-policies` | user | One entry per approvable action, in catalogue order: `{action, label, pm_approves, role_ids}` |
| `PUT` | `/t/{slug}/api/approval-policies/{action}` | admin role | Replace the policy — `{pm_approves, role_ids}` (both required) |

`action` is `assignments.self_create`, `assignments.self_update` or `assignments.self_remove`; an unknown action or role id is `404`. A missing policy row reads as the default: the project's manager approves, no roles.

### Approval Requests

Own-booking requests are filed by the assignment and Kanban routes (`202`, see [Assignments](#assignments)); these routes read and decide them.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/t/{slug}/api/approval-requests?scope=&status=&limit=` | user | `scope=mine` (default: the caller's requests), `to_decide` (pending requests the caller may decide) or `all` (every request at the visible sites; needs `approvals.view_all`, `403` otherwise); newest first |
| `GET` | `/t/{slug}/api/approval-requests/{id}` | user | One request — for its requester, an eligible approver or an `approvals.view_all` holder; `404` for anyone else |
| `POST` | `/t/{slug}/api/approval-requests/{id}/approve` | eligible approver | Apply the booking — body `{note?}` |
| `POST` | `/t/{slug}/api/approval-requests/{id}/reject` | eligible approver | Reject — body `{note?}` (the reason the requester sees) |
| `POST` | `/t/{slug}/api/approval-requests/{id}/cancel` | requester or admin | Withdraw a pending request |

A request: `{id, action, status, close_reason, requester_id, requester_name, project_id, project_name, level, target_id, target_name, assignment_id, requested, previous, note, decided_by, decided_by_name, decided_at, decision_note, superseded_by_id, created_at, updated_at, can_decide}`. `level` is `project`, `phase` or `subphase`; `requested` / `previous` hold `{allocation, start_date?, end_date?}`.

**Statuses**: `pending` → `approved`, `rejected`, `cancelled`, `superseded` (the requester changed it before a decision) or `expired`, with `close_reason` one of `target_deleted`, `requester_inactive`, `permission_lost`, `overtaken`, `duplicate`.

**Eligible approvers** are resolved live: administrators; the project's manager when the policy's `pm_approves`; holders of the policy's roles — active, able to see the project's site, and never the requester.

| Status | When |
|--------|------|
| `403` | Deciding your own request (`You cannot approve your own request`); not an eligible approver; cancelling someone else's request without being an admin |
| `404` | Unknown request, or one the caller may not see |
| `409` | The request is no longer pending — `{detail: "Request already <status>", status}`; or approving found that the booking can no longer apply, which closes it — `{detail, status: "expired", close_reason}`; or the stored requested values are not valid for the request's level (`The requested values are not valid — reject the request instead`), which leaves the request pending |
| `422` | `note` longer than 2000 characters; an unknown `scope` |

Every transition notifies (`approval_requested` to the approvers, `approval_decided` to the requester), broadcasts `change:approval_request` (approve and reject also `change:staff_assignment`) and pushes `approval:changed` to the requester and the approvers.

### Todos

Personal tasks for **My Todos**. Private like notifications: only a todo's assignee and creator see it (`404` for anyone else), and it is never broadcast tenant-wide — the people concerned get a `todo:changed` push.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/t/{slug}/api/todos/mine?status=` | user | `status` is `open` (default) or `all`. The caller's tasks (assigned to or created by them, `kind: "task"`) plus the pending requests they may decide (`kind: "approval"`, id `approval:<n>`, the request in `approval_request`); open first, then by due date (none last), then oldest. A `status` other than `open` / `all` is `422` |
| `POST` | `/t/{slug}/api/todos` | `todos.manage_own` (own) / `todos.assign_others` (someone else) | Create — `{title, notes?, due_date?, assignee_id?, project_id?, entity_type?, entity_id?}` → `201`; the assignee defaults to the caller |
| `PUT` | `/t/{slug}/api/todos/{id}` | assignee or creator | Partial update, incl. `status` (`open` / `done` / `cancelled`; `done` sets `completed_at`) and reassignment; an explicit `null` clears `notes`, `due_date` or the link |
| `DELETE` | `/t/{slug}/api/todos/{id}` | creator | Delete (the assignee may once the creator's account is gone) → `200` `{success: true, id}` |

A todo: `{id, kind, title, notes, due_date, status, assignee_id, assignee_name, created_by, created_by_name, project_id, project_name, entity_type, entity_id, completed_at, approval_request, created_at, updated_at}`.

- **Giving a todo to someone else** needs `todos.assign_others` — or, through the PM bundle, being the manager of the linked project. Rights are checked on the todo as it is and as it becomes.
- **Assignee**: must exist and be visible to the caller (`404`), and be active (`400`). The new assignee gets a `todo_assigned` notification.
- **Link**: `entity_type` (`phase` / `subphase`) + `entity_id` resolve their own project — an unknown card is `404`, a different `project_id` `400`; an unknown project is `404`, one at an invisible site `403`.
- **Delete**: the assignee of someone else's todo gets `403` (`Only the creator can delete this todo`).

## Admin API Routes

Admin routes are at `/api/admin/`. Login is throttled like the tenant login (scope `admin`). An admin with `must_change_password` gets `403` from every route except `POST /api/admin/auth/change-password` and `GET /api/admin/auth/me`. Roles are validated (`admin` / `superadmin`), and tenant `status` must be one of `pending`, `active`, `suspended`, `archived`; status changes, edits and deletion take effect immediately (tenant cache entry dropped, pool closed).

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/admin/auth/login` | Admin login |
| `POST` | `/api/admin/auth/change-password` | Change own password (min 8 characters) |
| `GET` | `/api/admin/tenants` | List tenants |
| `POST` | `/api/admin/tenants` | Create tenant |
| `PUT` | `/api/admin/tenants/{id}` | Update tenant |
| `DELETE` | `/api/admin/tenants/{id}` | Delete tenant |
| `GET` | `/api/admin/organizations` | List organizations |
| `POST` | `/api/admin/organizations` | Create organization |
| `GET` | `/api/admin/users` | List admin users |
| `GET` | `/api/admin/stats` | System statistics |

## Request & Response Examples

### Create a Project

```
POST /t/{slug}/api/projects
Content-Type: application/json

{
    "name": "New Drug Formulation",
    "start_date": "2026-05-01",
    "end_date": "2026-09-30",
    "confirmed": true,
    "site_id": 1,
    "project_manager": "Dr. Smith",
    "customer": "PharmaCorp",
    "predefined_phase_ids": [1, 2, 3]
}
```

### Update a Phase (with Dependencies)

```
PUT /t/{slug}/api/phases/42
Content-Type: application/json

{
    "name": "Analytical Development",
    "start_date": "2026-06-01",
    "end_date": "2026-07-15",
    "dependencies": [
        {"id": 41, "type": "FS"},
        {"id": 38, "type": "SS"}
    ]
}
```

## Health Check

```
GET /health
GET /api/health
```

Both endpoints return identical content. They require **no authentication** and are safe for load-balancer probes.

```json
{
    "status": "ok",
    "mode": "multi-tenant",
    "version": "1.0.20",
    "backend": "python-fastapi",
    "default_tenant": "demo",
    "timestamp": "2026-05-06T12:34:56.789012",
    "database": "connected"
}
```

The `version` field is read at startup from the repo-root `/VERSION` file (see [Contributing — Versioning & Changelog](contributing.md#versioning-changelog)). If the database is unreachable the response is still returned with `status: "ok"` but `database` is `"error"` — useful for distinguishing process-level failure from DB-level failure in monitoring. The driver error itself is only written to the server log, since the endpoint is public.
