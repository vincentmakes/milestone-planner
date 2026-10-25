---
title: "Tenant SSO test on a shared Entra diagnostic, typed-word confirmation before live SSO changes"
author: Claude
date: 2026-10-25
branch: feat/teams
cost: { minutes: 0, tokens: 0 }
touches:
  - app/services/sso_test.py
  - app/schemas/sso.py
  - app/schemas/auth.py
  - app/routers/auth.py
  - app/routers/admin_organizations.py
  - tests/test_admin_org_sso_test.py
  - frontend/src/components/common/ConfirmDialog/ConfirmDialog.tsx
  - frontend/src/stores/confirmStore.ts
  - frontend/src/components/settings/panels/SSOPanel.tsx
  - frontend/src/components/common/SSOTestResult/SSOTestResult.tsx
  - frontend/src/api/endpoints/sso.ts
---

## Decided
- The Entra diagnostic lives once in `app/services/sso_test.py` (`local_checks`, `outbound_network_check`, `run_entra_test`), called with plain values by the admin-portal organization test (saved values, `shared_callback=True`) and by `POST /api/auth/sso/test` (the values entered in Settings → SSO). The `/t/{slug}/` redirect rule applies only to the shared organization callback, and the unreadable-secret message names `SESSION_SECRET` in single-tenant mode, where it derives the tenant key.
- Secret rule, identical in Test and Save: omitted, `null`, whitespace-only or masked (`****…`) means the stored secret, an exact `""` clears it on Save. `SSOConfigUpdate`'s before-validator therefore maps whitespace-only to `None`, not to `""`: otherwise a green Test of "  " followed by Save would clear the secret.
- The runtime already strips the four SSO values when it builds the effective config (`_clean` in `app/services/sso.py`), so the new trimming is data hygiene, not a bug fix, and has no changelog line.
- The typed-word input of `ConfirmDialog` lives in `RequestDialog`, a child keyed by the request id: state kept in `ConfirmDialog` would survive into the next queued request and open it pre-filled, past its gate. Its focus effect still wins over Modal's container focus because a parent's effects run after its children's.
- SSOPanel compares against a snapshot of the config as displayed (after the `redirectHint` / `'user'` defaults), trimmed on both sides; the dialog fires only over a live config (enabled, both ids, a stored secret) for a change of the ids, the secret, the redirect URI or switching SSO off. Role and auto-create changes never ask.

## Tried and ruled out
- Keeping the router patch targets in `tests/test_admin_org_sso_test.py`: after the move ruff drops the router's `httpx` / `get_settings` imports, so `httpx.AsyncClient` and `get_settings` must be patched on `app.services.sso_test`; `decrypt` stays on `app.routers.admin_organizations`.
- `SSOTestResponse(credentials_ok=...)` in the service: there is no pydantic mypy plugin and only `admin_organizations` has `call-arg` disabled, so the service builds it with the alias `credentialsOk=` (the wire key, unchanged).

## Watch out
- An existing SSOPanel test that edits a live config needs `stubConfirm(true)`; without it the unanswered dialog leaves the save pending forever.
- The no-dialog save path must not `await` before `beginSave()`, or the double-click test sends two PUTs.
- The Bash sandbox denies even `stat` on `.env`: pytest from the repo root fails at collection. Run it from `tests/` with `--ignore=../.env` (then `test_api_routing` 404 fails only because `main.py` looks for `./public` in the cwd). `trail note` is EPERM there too (`~/.trail`).
