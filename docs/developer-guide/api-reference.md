# API Reference

## Interactive Documentation

When the application is running, interactive API documentation is available at:

- **Swagger UI**: [http://localhost:8485/api/docs](http://localhost:8485/api/docs)

## Authentication

All API endpoints (except `/health` and `/api/auth/*`) require authentication via session cookie. Every authenticated request re-checks the account's live `active` flag and role; a deactivated, deleted or demoted user's sessions are destroyed and further requests get `401`.

The interactive docs (`/api/docs`, `/api/redoc`, `/api/openapi.json`) require a signed-in tenant **admin**; in multi-tenant mode open them under the workspace URL (`/t/{slug}/api/docs`).

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

The **Auth** column used below:

| Level | Who passes |
|-------|------------|
| **user** | Any authenticated user |
| **superuser** | Admin or superuser |
| **admin** | Admin only |
| **user (PM)** | Admin or superuser, **or the project's manager** (`projects.pm_id == user.id`) |
| **user (PM/own-assignment)** | Anyone passing *user (PM)*, **or the staff member the assignment books** (`staff_id == user.id`) |

The two per-project levels are checked inside the handler (`app/services/project_access.py`) after the entity is loaded, against a `project_id` derived server-side from the path or the loaded phase/subphase/assignment row — a `project_id` in the request body is never used for the check. Failures return `403`; a missing project/phase/subphase returns `404`.

**Sites scope the UI, not access.** *superuser* means tenant-wide for projects, phases, subphases, assignments, vacations and notes — there is no site check on those routes, by design. Site membership is enforced only on bank holidays, company events, equipment, equipment blocks, equipment types and teams (`app/services/site_access.py`).

### Validation

- **Date order**: a body whose `end_date` is before its `start_date` is rejected with `422` on projects, phases, subphases, staff assignments, equipment bookings, equipment blocks and absences. Partial updates are checked against the merged row.
- **References**: unknown ids in a body (site, project manager, staff member, skill, absence type, …) return `400` or `404` instead of a database error.
- **Date query parameters** (`startDate` / `endDate` on availability, holidays, events, notes) must be `YYYY-MM-DD` (`400` otherwise). The staff and equipment availability endpoints also require `startDate <= endDate` and cap the range at 366 days.
- **Allocation**: every staff assignment — project, phase and subphase level, create and update, and Kanban assignees — takes an integer `allocation` of **1–100** (`422` otherwise).

### Projects

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/t/{slug}/api/projects` | user | List all projects (with phases, subphases, assignments) |
| `POST` | `/t/{slug}/api/projects` | superuser | Create a project |
| `GET` | `/t/{slug}/api/projects/{id}` | user | Get project details with full hierarchy |
| `PUT` | `/t/{slug}/api/projects/{id}` | user (PM) | Update a project — every field, including `pm_id` (so a manager can hand the project over), `archived`, `tag_ids` and `team_ids` |
| `DELETE` | `/t/{slug}/api/projects/{id}` | superuser | Delete a project (a project manager cannot) |

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
| `GET` | `/t/{slug}/api/staff/{id}/availability?startDate=&endDate=` | Availability calculation (validated dates, at most 366 days) |

Staff endpoints are read-only — staff members *are* users and are created and managed via the `/users` endpoints.

`GET /staff` returns one row per user–site pair; each row's `team_ids` are the user's teams **at that row's site**. `GET /staff/{id}` returns all of them.

### Equipment

Equipment can belong to several sites (`equipment_sites`), like staff. Every response carries `site_ids` / `site_names` (all linked sites) next to the legacy `site_id` / `site_name`.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/t/{slug}/api/equipment?siteId=&includeAllSites=` | user | Active equipment as a plain array (no pagination envelope), **one row per equipment–site pair** — like `GET /staff`. Each row's `site_id`/`site_name` is that pair's site; `siteId` limits the rows to one site |
| `GET` | `/t/{slug}/api/equipment/all` | superuser | All equipment, including inactive — one row per item |
| `GET` | `/t/{slug}/api/equipment/{id}` | user | One item (one row, with `site_ids`) |
| `POST` | `/t/{slug}/api/equipment` | superuser | Create an item — `{name, type, description?, site_ids: [..]}` |
| `PUT` | `/t/{slug}/api/equipment/{id}` | superuser | Update an item; `site_ids`, when given, replaces its site links |
| `DELETE` | `/t/{slug}/api/equipment/{id}` | superuser | Delete an item |
| `GET` | `/t/{slug}/api/equipment/{id}/availability?startDate=&endDate=` | user | Per-day availability for a date range (validated, at most 366 days) |

Equipment can also be limited to teams: `team_ids` on create and update (omitted = unchanged on update), `team_ids` / `team_names` in every response. The rule is **per site** — a site with none of the equipment's teams keeps it open to the whole site; at a site with listed teams only those teams see it under the team filter. Every team must be at one of the equipment's sites (`400`); a `site_ids` change without `team_ids` drops the teams of the sites removed.

`site_ids` must not be empty (`422`). Clients that predate multi-site equipment may still send `site_id`, which is taken as `[site_id]`. The legacy `equipment.site_id` column is kept as the "primary site" — the lowest linked site id. Superusers may only create, edit or delete equipment (and its blocks) whose sites are **all** among their own sites (`403` otherwise); admins any.

Deleting a site removes its links: equipment still linked to another site survives (its `site_id` is re-pointed), and only equipment left with no site is deleted.

### Equipment Blocks (Maintenance / Out-of-service)

Block periods mark equipment as unavailable for booking. See [Equipment Booking — Maintenance Blocks](../user-guide/equipment-booking.md#maintenance-blocks) for the user-facing behaviour.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/equipment-blocks?siteId=&equipmentId=` | List equipment blocks (optional filters; `siteId` matches any site the equipment is linked to) |
| `GET` | `/t/{slug}/api/equipment/{id}/blocks` | List blocks for one equipment item |
| `POST` | `/t/{slug}/api/equipment-blocks` | Create a block (admin/superuser) |
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
| `POST` | `/t/{slug}/api/projects/{id}/equipment` | user (PM) | Book equipment on a project |
| `PUT` / `DELETE` | `/t/{slug}/api/equipment-assignments/{id}` | user (PM) | Update / remove equipment booking |

The *own-assignment* rule lets any user add, change and remove the assignments that book **their own** time (`staff_id` equal to their id) — self-assignment — without being able to touch anyone else's. For phase- and subphase-level writes the project is derived from the loaded phase/subphase; a `project_id` in the body is ignored.

`PUT` / `DELETE /equipment-assignments/{id}` are implemented once, in `app/routers/equipment.py`; the duplicate (shadowed) handlers that used to live in `assignments.py` were removed.

### Vacations (Absences)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/vacations?siteId=` | List vacations — with `siteId`, those of that site's staff; without it, all for admins/superusers, and for a plain user only their own plus those of people sharing a site with them |
| `POST` | `/t/{slug}/api/vacations` | Create a vacation |
| `POST` | `/t/{slug}/api/vacations/import` | Bulk-import absences for one person (e.g. parsed from an `.ics` file) |
| `PUT` | `/t/{slug}/api/vacations/{id}` | Update a vacation |
| `DELETE` | `/t/{slug}/api/vacations/{id}` | Delete a vacation |

Create, update and the response carry an optional `absence_type_id` (see [Absence Types](#absence-types)). A `null` type is treated as *unavailable*, matching the behaviour before absence types existed. An unknown id is rejected with `400`. Recurring absences are still encoded in `description` as `[R:1,3]` (days of week, 0 = Sunday).

Users may only create or import absences for themselves; admins and superusers for anyone, at any site. The import skips items whose `(start_date, end_date)` already exists for that person (or repeats within the batch), writes everything in one transaction, and accepts at most 1000 items:

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

Tenant-wide categories of time off. Reading is open to any authenticated user; every write is **admin only**.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/absence-types` | List all types (active and inactive), ordered by `sort_order` |
| `POST` | `/t/{slug}/api/absence-types` | Create a type — `{name, color, counts_as_unavailable?, is_active?}`; appended at the end |
| `PUT` | `/t/{slug}/api/absence-types/reorder` | Reorder — `{type_order: [ids...]}` |
| `PUT` | `/t/{slug}/api/absence-types/{id}` | Partial update of `name`, `color`, `counts_as_unavailable`, `is_active` |
| `DELETE` | `/t/{slug}/api/absence-types/{id}` | Delete — `409` while any vacation still uses the type (deactivate it instead) |

`color` must be `#RRGGBB`; names are unique (`400` on a duplicate). Response fields: `id`, `name`, `color`, `counts_as_unavailable`, `sort_order`, `is_active`, `created_at`, `updated_at`. Inactive types are still returned so existing absences keep their label and color; clients hide them from pickers.

### Bank Holidays

Holiday writes require admin or superuser; superusers only for sites they belong to (`403` otherwise).

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

An event can be linked to several sites. Responses include `site_ids` (all linked sites, sorted) and, for compatibility, `site_id` (the first of them), plus `counts_as_unavailable` — `true` marks the event as a **site closure**: staff on its sites are unavailable for its dates (default `false`: displayed only). Writes require admin or superuser; superusers must belong to every site involved.

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
| `PUT` | `/t/{slug}/api/equipment-types/{old_type}?new_type=` | Rename an equipment type on every item that uses it (superuser) |
| `DELETE` | `/t/{slug}/api/equipment-types/{type_name}` | Delete an equipment type (superuser) — `409` while any equipment uses it |

There is no create endpoint: a type exists as long as some equipment carries it. A superuser may rename or delete a type only when every piece of equipment of that type is at one of their sites (`403` otherwise); admins any.

### Tags

Project tags are colored labels shared across all projects in the instance. See [Gantt Charts — Tags](../user-guide/gantt-charts.md#tags) for the user-facing behaviour. To attach or detach tags from a project, send a `tag_ids` array in the project `PUT` payload.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/tags` | List all tags (`group_id`, `all_sites`, `site_ids`, `team_ids`, `sort_order`) |
| `POST` | `/t/{slug}/api/tags` | Create a tag (admin) |
| `PUT` | `/t/{slug}/api/tags/{id}` | Update a tag — name, color, group, sites, teams (admin) |
| `DELETE` | `/t/{slug}/api/tags/{id}` | Delete a tag from every project (admin) |

A tag can be limited to teams with `team_ids`. Per site: no team of the tag at a site means every project there may carry it; otherwise only projects sharing one of those teams (`400` on the project write). Each team must be at one of the tag's sites unless the tag applies to all sites (`400`). Narrowing `team_ids` while projects at those teams' sites outside them use the tag is refused with `409`; narrowing the sites without `team_ids` drops the teams of the sites removed.

### Teams

A team is a named group of people at **one** site. Every authenticated user can read teams; admins manage them at every site, superusers only at the sites they belong to (`403` otherwise). Team writes are configuration: they bypass What-If queuing and broadcast a `change:team` event. See [Settings — Teams](../user-guide/settings.md#teams) for the user-facing behaviour.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/t/{slug}/api/teams?siteId=` | user | Every team, inactive ones included, ordered by site then name; `siteId` limits the list to one site |
| `GET` | `/t/{slug}/api/teams/{id}` | user | One team (`404` if missing) |
| `POST` | `/t/{slug}/api/teams` | superuser | Create a team — `{site_id, name, description?, color?, active?, member_ids?}` |
| `PUT` | `/t/{slug}/api/teams/{id}` | superuser | Partial update — `{name?, description?, color?, active?, member_ids?}`; the site cannot change |
| `DELETE` | `/t/{slug}/api/teams/{id}` | superuser | Delete the team; its memberships and its project, tag, equipment and event links go with it |

Response: `{id, site_id, name, description, color, active, member_ids, created_at, updated_at}`.

- **Name**: 1–100 characters (`422` otherwise), trimmed, unique per site — a name of only spaces or a duplicate at the site is `400`. An unknown `site_id` is `404`.
- **Members**: `member_ids` replaces the member list; every member must belong to the team's site (`400` otherwise).
- **Clearing**: an explicit `null` clears `description` or `color`; other omitted or `null` fields are left unchanged. `color` is `#RRGGBB`.
- **Inactive teams** keep scoping everything they are linked to; only the header team filter leaves them out.
- **Deleting a site** deletes its teams with all their links.

`team_ids` on other resources:

| Resource | Field | Rule |
|----------|-------|------|
| Projects | `team_ids` (read, create, update) | Teams at the project's site |
| Staff | `team_ids` (read) | Per `/staff` row: the teams at that row's site |
| Users | `team_ids`, `team_names` (read); `team_ids` on `POST` / `PUT /users` | Each team at one of the user's sites; a superuser may only assign teams at their sites; removing a site from a user drops that site's teams |
| Equipment | `team_ids`, `team_names` (read); `team_ids` on create / update | Per site; no team at a site = the whole site |
| Tags | `team_ids` (read, create, update) | Per site, as above; `409` when narrowing would strand projects |
| Company events | `team_ids` on `POST /events` and `PUT /events/{id}` | Per site, as above |

### Import & Export

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/t/{slug}/api/import/project` | Import a project from CSV / XML / MPP (multipart upload) |
| `POST` | `/t/{slug}/api/import/mpp` | Parse a Microsoft Project file (`.mpp`/`.mpt`/`.mpx`) for preview — requires Java |
| `GET` | `/t/{slug}/api/import/mpp/test` | Diagnostic — verify Java/MPP toolchain is available |
| `GET` / `POST` | `/t/{slug}/api/export/csv/{id}` | Export a single project as CSV |
| `POST` | `/t/{slug}/api/export/mpp/{id}` | Export a single project for Microsoft Project |
| `GET` | `/t/{slug}/api/export/site/{site_id}/excel` | Export the full site (multi-sheet `.xlsx`) — admin/superuser only |

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

Column definitions (create, update, delete, reorder) are **admin only**; values can be written by **any authenticated user**. `PUT /values/batch` takes `{updates: [...]}` with at most 500 items, validates each like a single write and applies them in one transaction.

### Kanban

The board has no read endpoint of its own — `GET /projects/{id}` already returns the full phase/subphase tree, and the client derives cards from it. A card is a *leaf* phase or subphase.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/kanban/projects/{id}/comment-counts` | Comment counts per card for one project |
| `PUT` | `/t/{slug}/api/kanban/cards/{entity_type}/{id}/status` | Move a card between columns (`entity_type` is `phase` or `subphase`) — user (PM) or the card's assignee |
| `POST` | `/t/{slug}/api/kanban/cards/{entity_type}/{id}/assignees` | Assign staff — also books their time — user (PM/own-assignment) |
| `DELETE` | `/t/{slug}/api/kanban/cards/{entity_type}/{id}/assignees/{staff_id}` | Unassign and release the booking — user (PM/own-assignment) |
| `GET` / `POST` | `/t/{slug}/api/kanban/cards/{entity_type}/{id}/comments` | Read / post comments |
| `PUT` / `DELETE` | `/t/{slug}/api/kanban/comments/{id}` | Edit / delete a comment |

Permissions: moving a card is allowed for admins, superusers, the project's manager **and the card's own assignees**, and any authenticated user may comment. Assigning or unassigning other people requires a superuser or the project's manager; anyone may join or leave a card themselves (`staff_id` = their own id). The assignee body takes an optional `allocation` (1–100; default: the person's `max_capacity`).

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
| `GET` | `/api/ws-debug` | admin | WebSocket diagnostics |
| `POST` | `/api/ws-debug/broadcast` | admin | Send a synthetic `change:project` event |

### Other Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/sites` | List sites |
| `POST` | `/t/{slug}/api/sites` | Create a site |
| `PUT` | `/t/{slug}/api/sites/{id}` | Update a site — an explicit `null` clears `location`, `city`, `country_code` or `region_code`; an omitted field is unchanged |
| `DELETE` | `/t/{slug}/api/sites/{id}` | Delete a site **and its projects** (with their comments and custom-column values); equipment and company events shared with other sites are kept |
| `GET` | `/t/{slug}/api/skills` | List skills |
| `POST` | `/t/{slug}/api/skills` | Create a skill |
| `PUT` | `/t/{slug}/api/skills/{id}` | Update a skill |
| `DELETE` | `/t/{slug}/api/skills/{id}` | Delete a skill |
| `GET` | `/t/{slug}/api/settings` | Get instance settings |
| `PUT` | `/t/{slug}/api/settings/{key}` | Update one setting |
| `GET` | `/t/{slug}/api/users` | List users |
| `POST` | `/t/{slug}/api/users` | Create a user (optional `team_ids`) |
| `PUT` | `/t/{slug}/api/users/{id}` | Update a user (`team_ids`, when given, replaces the memberships) |
| `DELETE` | `/t/{slug}/api/users/{id}` | Delete a user |
| `GET` | `/t/{slug}/api/predefined-phases` | List predefined phases |
| `POST` | `/t/{slug}/api/predefined-phases` | Create a predefined phase |
| `PUT` | `/t/{slug}/api/predefined-phases/{id}` | Update a predefined phase |
| `DELETE` | `/t/{slug}/api/predefined-phases/{id}` | Delete a predefined phase |
| `GET` | `/t/{slug}/api/notes` | List notes |
| `POST` | `/t/{slug}/api/notes` | Create a note |
| `DELETE` | `/t/{slug}/api/notes/{id}` | Delete a note |

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
