---
title: "Seed demo data when provisioning a tenant: loader moved to a service, demo admin parameterised"
author: Claude
date: 2026-10-18
branch: feat/seed-demo-on-provision
cost: { minutes: 45, tokens: 330000 }
touches:
  - app/services/demo_seed.py
  - app/services/tenant_provisioner.py
  - app/scripts/demo_data.py
  - app/scripts/seed_demo.py
  - app/schemas/tenant.py
  - frontend/src/components/admin/modals/ProvisionTenantModal.tsx
  - frontend/src/components/admin/modals/CreateTenantModal.tsx
  - docs/admin-guide/multi-tenant.md
---

## Decided
- `POST /api/admin/tenants/{id}/provision` takes `seedDemoData` (`TenantProvisionRequest.seed_demo_data`). `provision_tenant_database(seed_demo_data=True, instance_title=tenant.name)` runs `insert_demo_data(...)` *instead of* `run_seed_data` — so no "Main Site"; the demo set brings sso_config, phase templates, skills, Winterthur/Frankfurt. Absence types come from the schema SQL either way.
- The loader (`insert_demo_data`, `_insert_once`, `_insert_id`, `render_mentions`) moved from `app/scripts/seed_demo.py` to `app/services/demo_seed.py`: a service must not import from `app/scripts/`, and the loader was only kept out of coverage by the `omit` on seed_demo.py. `seed_demo.py` is the CLI only (provision/register/apply + printing the counts). `app/scripts/demo_data.py` stays where it is (pure data; the provisioner imports `build_demo` from there).
- `build_demo(today, *, admin_email=DEMO_ADMIN_EMAIL, instance_title="Demo Instance")` and `DemoData.admin_email`: the tenant's admin e-mail replaces admin@demo.local everywhere (user row, the mention in a comment, three notifications). `insert_demo_data(conn, demo, admin_password_hash=…)` puts the portal-generated hash on that row only; everyone else keeps `demo1234` (user decision — lets you sign in as Bob for multi-user demos; documented as evaluation-only).
- Frontend: the Provision button opens `ProvisionTenantModal` (a standalone admin modal with a `ToggleSwitch`, the caller still runs the API call) instead of `confirmAction` — a confirm cannot carry an option. The Create Tenant dialog has the same switch; on, it chains `createTenant` → `provisionTenant(id, {seedDemoData: true})` → `onShowCredentials` + `onCreated`. If provisioning fails after the create succeeded, the dialog locks the form, shows "created, but provisioning failed" and its Cancel becomes Close → `onCreated` (list refresh; Provision offers the switch again).
- `createTenant()` really returns `{success, tenant, credentials, message}`; the type said `Tenant` and the dashboard ignored the argument. Fixed as `TenantCreateResponse`.

## Tried and ruled out
- Storing the choice on the tenant row (a master-DB column): it is a one-time provisioning option, not a tenant attribute, and would need a migration for nothing.
- Provisioning inside the create route when the flag is set: a failure after the insert would have to answer 201-with-error or lose the record; two calls from the dialog keep each route's semantics.

## Watch out
- `MagicMock(name="Acme")` names the mock, it does not set `.name` — assign `tenant.name = ...` after construction when a route reads `tenant.name`.
- `patch.object(module, "async_fn")` yields an AsyncMock whose *children* are AsyncMocks too: `(await fn()).items()` is then a coroutine. Give it `return_value={}`.
- Python 3.13 has no wheels for asyncpg/psycopg2-binary: run the backend tests from a Python 3.11 venv (`uv venv -p /usr/bin/python3.11`).
- `docs/assets/screenshots/admin-create-tenant-modal.png` predates the switch; refresh it with `scripts/screenshots/capture_admin.py` when the pipeline can run.
