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
| `POST` | `/t/{slug}/api/staff` | Create staff member |
| `PUT` | `/t/{slug}/api/staff/{id}` | Update staff member |
| `DELETE` | `/t/{slug}/api/staff/{id}` | Delete staff member |

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
| `POST` | `/t/{slug}/api/assignments/staff` | Assign staff to phase |
| `PUT` | `/t/{slug}/api/assignments/staff/{id}` | Update assignment |
| `DELETE` | `/t/{slug}/api/assignments/staff/{id}` | Remove assignment |
| `POST` | `/t/{slug}/api/assignments/equipment` | Assign equipment to phase |
| `PUT` | `/t/{slug}/api/assignments/equipment/{id}` | Update equipment assignment |
| `DELETE` | `/t/{slug}/api/assignments/equipment/{id}` | Remove equipment assignment |

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
| `GET` | `/t/{slug}/api/export/project/{id}/csv` | Export a single project as CSV |
| `GET` | `/t/{slug}/api/export/project/{id}/xml` | Export a single project as Microsoft Project XML |
| `GET` | `/t/{slug}/api/export/site/{site_id}/excel` | Export the full site (multi-sheet `.xlsx`) — admin/superuser only |

### Custom Columns

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/custom-columns` | List custom column definitions |
| `POST` | `/t/{slug}/api/custom-columns` | Create a custom column |
| `PUT` | `/t/{slug}/api/custom-columns/{id}` | Update a custom column |
| `DELETE` | `/t/{slug}/api/custom-columns/{id}` | Delete a custom column |
| `PUT` | `/t/{slug}/api/custom-columns/reorder` | Reorder columns |
| `PUT` | `/t/{slug}/api/custom-columns/{id}/values` | Bulk update column values |

### Presence & Collaboration

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/t/{slug}/api/presence/heartbeat` | Send presence heartbeat (viewing/editing) |
| `DELETE` | `/t/{slug}/api/presence/{project_id}` | Leave project presence |
| `GET` | `/t/{slug}/api/presence/project/{id}` | Get active viewers for a project |
| `GET` | `/t/{slug}/api/presence/site/{id}` | Get presence across all projects in a site |
| `POST` | `/t/{slug}/api/presence/check-conflict/{id}` | Check for conflicts before saving |
| `WS` | `/t/{slug}/ws` | WebSocket for real-time updates |

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
| `PUT` | `/t/{slug}/api/settings` | Update settings |
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
| `POST` | `/api/admin/login` | Admin login |
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

### Presence Heartbeat

```
POST /t/{slug}/api/presence/heartbeat
Content-Type: application/json

{
    "project_id": 5,
    "activity": "editing"
}
```

### Conflict Check Response

```
POST /t/{slug}/api/presence/check-conflict/5

→ 200 OK
{
    "has_conflict": true,
    "message": "Project was modified by another user",
    "last_modified_at": "2026-04-09T14:30:00Z",
    "last_modified_by": "Jane Doe",
    "active_editors": [
        {
            "user_id": 3,
            "first_name": "Jane",
            "last_name": "Doe",
            "activity": "editing",
            "started_at": "2026-04-09T14:25:00Z",
            "last_seen_at": "2026-04-09T14:30:00Z"
        }
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
    "version": "1.0.0",
    "backend": "python-fastapi",
    "default_tenant": "demo",
    "timestamp": "2026-05-06T12:34:56.789012",
    "database": "connected"
}
```

The `version` field is read at startup from the repo-root `/VERSION` file (see [Contributing — Versioning & Changelog](contributing.md#versioning-changelog)). If the database is unreachable the response is still returned with `status: "ok"` but `database` contains an `error: ...` string — useful for distinguishing process-level failure from DB-level failure in monitoring.
