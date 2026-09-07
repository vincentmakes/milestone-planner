# API Reference

## Interactive Documentation

When the application is running, interactive API documentation is available at:

- **Swagger UI**: [http://localhost:8485/api/docs](http://localhost:8485/api/docs)

## Authentication

All API endpoints (except `/health` and `/api/auth/*`) require authentication via session cookie.

### Login

```
POST /api/auth/login
Content-Type: application/json

{
    "email": "user@example.com",
    "password": "password"
}
```

### SSO Login (Microsoft Entra ID)

```
GET /api/auth/sso/login     → Returns the Microsoft authorization URL
GET /api/auth/sso/callback  → Handles the OAuth callback from Microsoft
```

### Logout

```
POST /api/auth/logout
```

## Tenant API Routes

All tenant routes are prefixed with `/t/{slug}/api/`:

### Projects

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/projects` | List all projects (with phases, subphases, assignments) |
| `POST` | `/t/{slug}/api/projects` | Create a project |
| `GET` | `/t/{slug}/api/projects/{id}` | Get project details with full hierarchy |
| `PUT` | `/t/{slug}/api/projects/{id}` | Update a project |
| `DELETE` | `/t/{slug}/api/projects/{id}` | Delete a project |

### Phases & Subphases

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/t/{slug}/api/projects/{id}/phases` | Create a phase |
| `PUT` | `/t/{slug}/api/phases/{id}` | Update a phase (dates, name, dependencies) |
| `DELETE` | `/t/{slug}/api/phases/{id}` | Delete a phase |
| `PUT` | `/t/{slug}/api/projects/{id}/phases/reorder` | Reorder phases |
| `POST` | `/t/{slug}/api/phases/{id}/subphases` | Create a subphase |
| `PUT` | `/t/{slug}/api/subphases/{id}` | Update a subphase (dates, name, dependencies) |
| `DELETE` | `/t/{slug}/api/subphases/{id}` | Delete a subphase |
| `PUT` | `/t/{slug}/api/phases/{id}/subphases/reorder` | Reorder subphases |

### Staff

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/staff` | List all staff |
| `GET` | `/t/{slug}/api/staff/{id}` | Get a staff member |
| `GET` | `/t/{slug}/api/staff/{id}/availability` | Availability calculation |

Staff endpoints are read-only — staff members *are* users and are created and managed via the `/users` endpoints.

### Equipment

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/equipment` | List all equipment |
| `POST` | `/t/{slug}/api/equipment` | Create equipment item |
| `PUT` | `/t/{slug}/api/equipment/{id}` | Update equipment item |
| `DELETE` | `/t/{slug}/api/equipment/{id}` | Delete equipment item |
| `GET` | `/t/{slug}/api/equipment/{id}/availability?startDate=&endDate=` | Per-day availability for a date range |

### Equipment Blocks (Maintenance / Out-of-service)

Block periods mark equipment as unavailable for booking. See [Equipment Booking — Maintenance Blocks](../user-guide/equipment-booking.md#maintenance-blocks) for the user-facing behaviour.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/equipment-blocks?siteId=&equipmentId=` | List equipment blocks (optional filters) |
| `GET` | `/t/{slug}/api/equipment/{id}/blocks` | List blocks for one equipment item |
| `POST` | `/t/{slug}/api/equipment-blocks` | Create a block (admin/superuser) |
| `PUT` | `/t/{slug}/api/equipment-blocks/{id}` | Update a block |
| `DELETE` | `/t/{slug}/api/equipment-blocks/{id}` | Delete a block |

### Assignments

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/t/{slug}/api/projects/{id}/staff` | Assign staff at project level |
| `PUT` / `DELETE` | `/t/{slug}/api/assignments/{id}` | Update / remove project-level assignment |
| `POST` | `/t/{slug}/api/phases/{id}/staff` | Assign staff at phase level |
| `PUT` / `DELETE` | `/t/{slug}/api/phase-staff/{id}` | Update / remove phase-level assignment |
| `POST` | `/t/{slug}/api/subphases/{id}/staff` | Assign staff at subphase level |
| `PUT` / `DELETE` | `/t/{slug}/api/subphase-staff/{id}` | Update / remove subphase-level assignment |
| `POST` | `/t/{slug}/api/projects/{id}/equipment` | Book equipment on a project |
| `PUT` / `DELETE` | `/t/{slug}/api/equipment-assignments/{id}` | Update / remove equipment booking |

### Vacations

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/vacations` | List all vacations |
| `POST` | `/t/{slug}/api/vacations` | Create a vacation |
| `PUT` | `/t/{slug}/api/vacations/{id}` | Update a vacation |
| `DELETE` | `/t/{slug}/api/vacations/{id}` | Delete a vacation |

### Equipment Types

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/equipment-types` | List all equipment types |
| `PUT` | `/t/{slug}/api/equipment-types/{old_type}` | Rename an equipment type |
| `DELETE` | `/t/{slug}/api/equipment-types/{type_name}` | Delete an equipment type |

### Tags

Project tags are colored labels shared across all projects in the instance. See [Gantt Charts — Tags](../user-guide/gantt-charts.md#tags) for the user-facing behaviour. To attach or detach tags from a project, send a `tag_ids` array in the project `PUT` payload.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/tags` | List all tags (with project usage counts) |
| `POST` | `/t/{slug}/api/tags` | Create a tag (admin/superuser) |
| `PUT` | `/t/{slug}/api/tags/{id}` | Update a tag's name or color (admin/superuser) |
| `DELETE` | `/t/{slug}/api/tags/{id}` | Delete a tag from every project (admin/superuser) |

### Import & Export

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/t/{slug}/api/import/project` | Import a project from CSV / XML (multipart upload) |
| `POST` | `/t/{slug}/api/import/mpp` | Import a project from Microsoft Project (`.mpp`/`.mpt`/`.mpx`) — requires Java |
| `GET` | `/t/{slug}/api/import/mpp/test` | Diagnostic — verify Java/MPP toolchain is available |
| `GET` / `POST` | `/t/{slug}/api/export/csv/{id}` | Export a single project as CSV |
| `POST` | `/t/{slug}/api/export/mpp/{id}` | Export a single project for Microsoft Project |
| `GET` | `/t/{slug}/api/export/site/{site_id}/excel` | Export the full site (multi-sheet `.xlsx`) — admin/superuser only |

### Custom Columns

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/custom-columns` | List custom column definitions |
| `POST` | `/t/{slug}/api/custom-columns` | Create a custom column |
| `PATCH` | `/t/{slug}/api/custom-columns/{id}` | Update a custom column |
| `DELETE` | `/t/{slug}/api/custom-columns/{id}` | Delete a custom column |
| `PATCH` | `/t/{slug}/api/custom-columns/reorder` | Reorder columns |
| `PUT` | `/t/{slug}/api/custom-columns/values` | Write a column value (`/values/batch` for bulk) |

### Kanban

The board has no read endpoint of its own — `GET /projects/{id}` already returns the full phase/subphase tree, and the client derives cards from it. A card is a *leaf* phase or subphase.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/kanban/projects/{id}/comment-counts` | Comment counts per card for one project |
| `PUT` | `/t/{slug}/api/kanban/cards/{entity_type}/{id}/status` | Move a card between columns (`entity_type` is `phase` or `subphase`) |
| `POST` | `/t/{slug}/api/kanban/cards/{entity_type}/{id}/assignees` | Assign staff — also books their time |
| `DELETE` | `/t/{slug}/api/kanban/cards/{entity_type}/{id}/assignees/{staff_id}` | Unassign and release the booking |
| `GET` / `POST` | `/t/{slug}/api/kanban/cards/{entity_type}/{id}/comments` | Read / post comments |
| `PUT` / `DELETE` | `/t/{slug}/api/kanban/comments/{id}` | Edit / delete a comment |

Permissions differ from the rest of the API: moving a card is allowed for admins, superusers **and the card's own assignees**, and any authenticated user may comment. Assigning, creating and deleting still require superuser rights.

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

### Other Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/sites` | List sites |
| `POST` | `/t/{slug}/api/sites` | Create a site |
| `PUT` | `/t/{slug}/api/sites/{id}` | Update a site |
| `GET` | `/t/{slug}/api/skills` | List skills |
| `POST` | `/t/{slug}/api/skills` | Create a skill |
| `PUT` | `/t/{slug}/api/skills/{id}` | Update a skill |
| `DELETE` | `/t/{slug}/api/skills/{id}` | Delete a skill |
| `GET` | `/t/{slug}/api/settings` | Get instance settings |
| `PUT` | `/t/{slug}/api/settings/{key}` | Update one setting |
| `GET` | `/t/{slug}/api/users` | List users |
| `POST` | `/t/{slug}/api/users` | Create a user |
| `PUT` | `/t/{slug}/api/users/{id}` | Update a user |
| `DELETE` | `/t/{slug}/api/users/{id}` | Delete a user |
| `GET` | `/t/{slug}/api/predefined-phases` | List predefined phases |
| `POST` | `/t/{slug}/api/predefined-phases` | Create a predefined phase |
| `PUT` | `/t/{slug}/api/predefined-phases/{id}` | Update a predefined phase |
| `DELETE` | `/t/{slug}/api/predefined-phases/{id}` | Delete a predefined phase |
| `GET` | `/t/{slug}/api/notes` | List notes |
| `POST` | `/t/{slug}/api/notes` | Create a note |
| `DELETE` | `/t/{slug}/api/notes/{id}` | Delete a note |

## Admin API Routes

Admin routes are at `/api/admin/`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/admin/auth/login` | Admin login |
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

The `version` field is read at startup from the repo-root `/VERSION` file (see [Contributing — Versioning & Changelog](contributing.md#versioning-changelog)). If the database is unreachable the response is still returned with `status: "ok"` but `database` contains an `error: ...` string — useful for distinguishing process-level failure from DB-level failure in monitoring.
