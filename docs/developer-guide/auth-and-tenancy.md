# Authentication and tenancy

How a request is authenticated and scoped: the two independent session systems (tenant app and admin portal), the tenant role model (roles, site scoping, the project-manager rule, own assignments), Microsoft Entra SSO, the multi-tenant middleware and pools, and the security measures that hold it together. It was moved verbatim out of the repo-root [`CLAUDE.md`](https://github.com/vincentmakes/milestone-planner/blob/main/CLAUDE.md), which keeps the security rules.

Code described: `app/middleware/auth.py`, `app/middleware/tenant.py`, `app/services/session.py`, `app/services/site_access.py`, `app/services/project_access.py`, `app/services/sso.py`, `app/services/sso_errors.py`, `app/services/login_throttle.py`, `app/services/encryption.py`, `app/services/tenant_manager.py`, `app/services/tenant_provisioner.py`, `app/routers/auth.py`, `app/routers/admin/auth.py`.

## Authentication, Sessions & SSO

### Two independent auth systems

| | Tenant app | Admin portal |
|---|---|---|
| Cookie | `connect.sid` (`s%3A<id>.` express format) | `admin_session` (raw id) |
| Session store | `sessions` table, **tenant DB** | `admin_sessions` table, **master DB** |
| Users | `users` (tenant DB) | `admin_users` (master DB) |
| Roles | `admin` > `superuser` > `user` | `superadmin` > `admin` |
| Password hash | bcrypt (rounds=12), lazy upgrade from legacy PBKDF2/plaintext on login | PBKDF2-SHA512 `pbkdf2_sha512$600000$salt$hash`, lazy upgrade from legacy `salt:hash` |
| Login throttle | 10 failures / 15 min per (`tenant:<slug>`, IP, e-mail) → 429; plus 100 / 15 min per public IP (all scopes) | same, scope `admin` |
| Forced change | — | `must_change_password` → 403 everywhere but change-password / me |
| Dependencies | `get_current_user`, `require_superuser`, `require_admin` (`app/middleware/auth.py`) | `get_current_admin`, `require_superadmin` (`app/routers/admin/auth.py`) |

- `SessionService` (`app/services/session.py`) stores the full user dict (incl. site ids/names) in the session; `get_current_user_optional` builds a lightweight `SessionUser` from it without a DB hit, while `get_current_user` re-reads `active`/`role` from `users` on every request (401 + session destroyed for missing/inactive users; the live role wins over the snapshot) and stashes the user into `scope["state"]` for broadcast attribution. `SessionService.destroy_user_sessions()` is called on deactivate/delete/role change/password set so revocation is immediate — and also closes the user's open WebSockets on this process (`manager.disconnect_user`, close code 4001).
- On startup, `master_db.verify_admin_exists()` auto-creates `admin@milestone.local` (superadmin, random password logged, `must_change_password=true`) if no admin exists.

### Tenant role model

- **Sites scope the UI, not access.** Superusers (and admins) act **tenant-wide** on projects, phases, subphases, assignments, vacations and staff notes — `project_access.py` deliberately has no site check. Site membership is enforced (`site_access.py`: `can_access_sites` / `ensure_site_access`) only for bank holidays, company events, equipment, equipment blocks and equipment types (a type only when *all* its equipment is at the superuser's sites). Don't add site checks to project routes without a product decision.
- `user` — read access (absences: `GET /vacations` without `siteId` returns only their own and those of people sharing a site, and `GET /vacations/{id}` is a 404 for anyone else's) + self-service (own vacations, custom-column **values** (definitions are admin-only), **own staff assignments**: a user may add/update/remove assignments where `staff_id` is their own id at project/phase/subphase level, and join/leave Kanban cards).
- **Project manager rule** — the user whose id is `projects.pm_id` gets superuser rights on *that one project*: all project fields (incl. handing over via `pm_id`, `archived`), phases/subphases, staff and equipment assignments, Kanban moves. Not: deleting the project, creating projects, import, tag/group definitions, exports. Enforced by `app/services/project_access.py`; superuser behaviour is unchanged.
- `superuser` — everything a user can, plus manage projects/phases/assignments, staff-affecting data, equipment, holidays/events, predefined phases, skills (calendar/equipment data within their sites, the rest tenant-wide — see [above](#tenant-role-model)). May edit non-admin users' details/sites/skills but never their email or password (own account excepted) and never an admin account.
- `admin` — everything, plus sites, users, settings, SSO config, custom-column definitions, tags and tag groups (Settings → Tags), API docs access.
- `is_system=true` marks the provisioned admin; deletion is rejected.

### Microsoft Entra SSO

Two configuration levels, resolved by `SSOService.get_effective_sso_config()`:

1. **Organization SSO** (master DB, `organization_sso_config`) — shared by every tenant in the organization; secret encrypted; **takes precedence**. Tenant-level SSO cannot be enabled while org SSO is active (409, `_reject_if_org_sso_active` — covered by `tests/test_sso_guardrails.py`).
2. **Tenant SSO** (`sso_config` singleton in the tenant DB) — per-tenant fallback. Its `client_secret` is encrypted at rest with the same key as tenant credentials (`TENANT_ENCRYPTION_KEY`; single-tenant: derived from `SESSION_SECRET`). If the key changes, `read_tenant_client_secret` logs once and returns `None` → SSO reports "not configured" until the secret is re-entered.

Flow: `GET /auth/sso/login` builds the Entra authorization URL with an **HMAC-signed `state` carrying the tenant slug and a nonce** (org SSO uses one shared callback URL with no `/t/{slug}/` prefix, so the slug must survive the round-trip) and sets the nonce as the `sso_nonce` cookie (10 min) → `GET /auth/sso/callback` verifies the state signature and that its nonce equals this browser's cookie (so the flow only completes in the browser that started it and a callback URL cannot be replayed; the cookie is cleared on every outcome), exchanges the code, fetches the profile from Microsoft Graph `/me`, optionally validates group membership (`fetch_user_groups` pages Graph `/me/memberOf`; `required_group_ids` + `group_membership_mode` `any`/`all` on the tenant), finds or auto-creates the user (`auto_create_users`, `default_role`), creates a session, and redirects to `/t/{slug}/`.

**Failure handling** (`app/routers/auth.py`, `app/services/sso_errors.py`):
- Entra token-endpoint and Graph failures go through `parse_entra_token_error()`: the only remote-derived text a user can see is a regex-validated `AADSTS\d{4,7}` code, mapped to one of our fixed messages; Entra's `error` / `error_description` are never reflected.
- Callback failures redirect to `/t/{slug}/?sso_error=<message>` (`_sso_error_redirect`, slug recovered from the signed state); unexpected exceptions are caught and redirected the same way instead of a 500, and an unreachable identity provider reads "Could not reach the identity provider".
- An organization-SSO lookup or decrypt failure **fails closed** (`OrgSSOLookupError` → "temporarily unavailable"); it never falls back to tenant-level SSO.
- Both hops log a config fingerprint (`_config_fingerprint`, no secrets) so an operator can see which config served a sign-in; config values are whitespace-stripped.
- `SSOConfig.is_configured` requires a client secret, so a row without one hides the sign-in button instead of failing with Entra's misleading "invalid client".
- Admins can test an organization's credentials without a user sign-in: `POST /api/admin/organizations/{id}/sso/test`.

## Multi-Tenancy Internals

- **`TenantMiddleware`** (`app/middleware/tenant.py`) is a **pure ASGI middleware** (not `BaseHTTPMiddleware` — that breaks WebSockets). It matches `/t/{slug}/...`, resolves the tenant through a 60-second in-memory cache (plain dicts, not ORM objects, to avoid session-detachment issues), rewrites `scope["path"]` to strip the prefix, and stores `tenant` / `tenant_slug` / `tenant_engine` in `scope["state"]`. Missing/inactive/unreachable tenants → 404/403/503 (the 503 body is a fixed message; the DB error goes only to the log). **Misses are cached too** (60 s, in a separate `_negative_cache` capped at 1 000 entries, expired/oldest evicted first — hits are never evicted by a miss flood), so a flood of unknown slugs doesn't hit the master DB; `clear_tenant_cache(slug)` drops hits and misses. WebSocket scopes are passed through untouched (the WS handler resolves the tenant itself). Only wraps the app when `MULTI_TENANT=true`.
- **Tenant info lives in `scope["state"]` (a plain dict).** In HTTP handlers, `request.state.tenant_slug` attribute access works — Starlette's `Request.state` lazily wraps `scope["state"]` in a `State` object. In code that handles raw ASGI scopes (middleware, helpers that may not receive a full `Request`), read `scope["state"]["tenant_slug"]` directly; the broadcast helper handles both forms.
- **No fallthrough to `DB_*`**: when a request carries a tenant slug but no pool exists, `get_db` / `get_db_readonly` raise 503 (`resolve_tenant_session_factory` in `app/database.py`) instead of silently serving the default database.
- **`tenant_manager`** (`app/services/tenant_manager.py`) keeps lazy per-tenant engine pools (size 20 + 10 overflow; creation guarded by a per-slug `asyncio.Lock` so concurrent first requests build one pool), closes pools idle > 15 min (cleanup loop every 5 min), decrypts the tenant DB password on first connect, pins the session timezone to UTC like the default engine, and runs idempotent per-tenant auto-migrations on pool creation.
- **`tenant_provisioner`** (`app/services/tenant_provisioner.py`) creates the PG role + database, grants, applies the tenant schema, and seeds defaults (predefined phases, skills, "Main Site", admin user). It validates identifiers against injection and handles **managed PostgreSQL** (Azure/RDS/Cloud SQL) where the admin is not a superuser: grants the tenant role to the admin before `CREATE DATABASE` and reassigns `public` schema ownership.
- Tenant DB credentials are stored AES-256-GCM-encrypted (`iv:tag:ciphertext` hex, key = `TENANT_ENCRYPTION_KEY`) in `tenant_credentials`, Node-compatible format.

## Security

- **Startup/runtime**: the lifespan calls `Settings.check_startup_security()` — with `DEBUG=false` an empty or published `SESSION_SECRET` (`INSECURE_SESSION_SECRETS`) is a `RuntimeError`, so the app does not start; docs endpoints admin-gated; global exception handler returns opaque 500s; `/health` and the tenant 503 never echo DB hosts/users/SQL; Docker runs as non-root `appuser` with a `/health` healthcheck.
- **Secrets at rest**: tenant DB passwords, org SSO secrets **and tenant-level SSO secrets** (`sso_config.client_secret`, since 1.5.0; legacy plaintext encrypted by the tenant auto-migration) AES-256-GCM encrypted (`app/services/encryption.py`); `TENANT_ENCRYPTION_KEY` (64-char hex) required in multi-tenant mode (single-tenant derives a key from `SESSION_SECRET`).
- **Passwords**: bcrypt rounds=12 (tenant users, lazy upgrade from legacy hashes on login, > 72 bytes rejected); PBKDF2-SHA512 600 000 iterations, self-describing `pbkdf2_sha512$…` (admin users, lazy upgrade from legacy `salt:hash`). Minimum 8 characters for new/changed passwords in both systems; existing shorter passwords still log in.
- **Login throttle** (`app/services/login_throttle.py`): sliding window, 10 failures / 15 min per (scope, client IP, e-mail) → 429 with `Retry-After`; success clears the key; plus a per-IP bucket (100 failures / 15 min across scopes and e-mails, **not** cleared by a success) that only applies to *global* addresses — private/loopback/CGNAT ones may be a shared proxy or NAT, where it would be a site-wide lockout switch; ≤ 10 000 tracked keys per bucket. The lockout is per (IP, e-mail), so behind a reverse proxy `FORWARDED_ALLOW_IPS` must list the proxy or every client shares one key. **In-memory and per process** — N workers allow N × 10. Unknown e-mails run a dummy hash (`dummy_verify_user_password` / `dummy_verify_admin_password`) so timing doesn't reveal accounts.
- **Admin portal**: `must_change_password` is enforced server-side (403 from `get_current_admin`).
- **Sessions**: HTTP-only cookies; `SECURE_COOKIES=true` for HTTPS deployments; expired-session cleanup in `SessionService`; every request re-checks `active`/`role`; revocation (deactivate/delete/demote/password reset) destroys sessions and closes WebSockets.
- **WebSocket**: `Origin` checked against the host / CORS origins (close 4003) — cross-site WebSocket hijacking guard; `/api/ws-debug*` admin-only.
- **SSO**: HMAC-signed state bound to the browser by the `sso_nonce` cookie (one-time, 10 min); only a validated `AADSTS` code from Microsoft ever reaches a user, Entra's own error text is never reflected; secrets never returned unmasked (`/sso/config/full` masks; a masked value submitted back keeps the stored secret on every write route); optional Entra group gating per tenant.
- **Multi-tenant isolation**: a tenant request without a pool is a 503, never the `DB_*` database; tenant status/edit/delete changes reset the tenant cache and pool on the handling process.
- **Provisioning**: tenant identifiers validated against SQL injection in `tenant_provisioner`.
- ⚠ `GET /settings` and `GET /settings/{key}` have no auth dependency — never store sensitive values in the tenant `settings` KV table.
- ⚠ `/health` is public and includes the backend identifier and `default_tenant` in its response — don't add further config values to it.
