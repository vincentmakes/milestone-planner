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
GET /api/auth/sso/login    → Redirects to Microsoft
GET /api/auth/callback      → Handles OAuth callback
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
| `GET` | `/t/{slug}/api/projects` | List all projects |
| `POST` | `/t/{slug}/api/projects` | Create a project |
| `GET` | `/t/{slug}/api/projects/{id}` | Get project details |
| `PUT` | `/t/{slug}/api/projects/{id}` | Update a project |
| `DELETE` | `/t/{slug}/api/projects/{id}` | Delete a project |

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

### Other Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/t/{slug}/api/sites` | List sites |
| `GET` | `/t/{slug}/api/skills` | List skills |
| `GET` | `/t/{slug}/api/settings` | Get instance settings |
| `PUT` | `/t/{slug}/api/settings` | Update settings |
| `GET` | `/t/{slug}/api/users` | List users |
| `GET` | `/t/{slug}/api/custom-columns` | List custom columns |
| `GET` | `/t/{slug}/api/predefined-phases` | List predefined phases |
| `GET` | `/t/{slug}/api/notes` | List notes |
| `GET` | `/t/{slug}/api/presence` | Get online users |

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

## Health Check

```
GET /health
```

Returns `200 OK` when the application is running.
