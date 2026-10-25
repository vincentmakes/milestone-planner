# Conventions in depth

The full text of the conventions that the repo-root [`CLAUDE.md`](https://github.com/vincentmakes/milestone-planner/blob/main/CLAUDE.md) states as one short rule each: the What-If exemption list, the error and confirmation protocol, and the documentation-screenshot pipeline. Each section is the original convention, moved verbatim; `CLAUDE.md` links here from the matching rule. When a convention changes, change the rule in `CLAUDE.md` and its detail here together.

Code described: `frontend/src/api/client.ts`, `frontend/src/utils/confirmDialog.ts`, `frontend/src/components/common/` (`Notice`, `ConfirmDialog`), `frontend/src/test/confirmDialog.ts`, and `scripts/screenshots/`.

## Frontend

### What-If exemptions

**New write endpoints are What-If-intercepted by default.** The API client queues every POST/PUT/PATCH/DELETE while What-If mode is active, except URLs under `/api/auth/`, `/api/settings/`, `/api/admin/`, `/api/notifications`, the Kanban *comment* paths, and the **configuration endpoints** `/api/tags`, `/api/tag-groups`, `/api/absence-types`, `/api/skills`, `/api/equipment-types`, `/api/predefined-phases`, `/api/users`, plus site and equipment *definitions* only (`/api/sites`, `/api/sites/{id}`, `/api/equipment`, `/api/equipment/{id}` — their calendar and booking sub-resources `/api/sites/{id}/holidays|events`, `/api/events`, `/api/equipment-blocks`, `/api/equipment-assignments` stay queued, they are plan data). Configuration is never part of the What-If snapshot, so queuing it only makes edits vanish and deletes fail on Apply; `isWhatIfExempt()` in `src/api/client.ts` is the one list (card moves and assignments stay queued — they are plan operations; comments are not, and a queued comment cannot be rolled back on Discard and would be duplicated on Apply). If a new endpoint must bypass What-If (rare), extend the exemption list in `src/api/client.ts` deliberately — and if it must be queued, ensure the local optimistic update is complete since the server won't respond for real.

### Errors and confirmations

**Errors show in place, never in `alert()`.** A form or panel renders its message with the shared `Notice` (`src/components/common/Notice`, `tone` error/warning/info/success, `role="alert"` for errors); an action with no form of its own reports through `uiStore.showFlash()` (rendered by `layout/FlashNotice`). **Confirmations go through `confirmAction()`** (`src/utils/confirmDialog.ts`): `await confirmAction({ message, title?, destructive?, confirmLabel?, cancelLabel? })` resolves `true`/`false`; the one host `ConfirmDialog` (`src/components/common/ConfirmDialog`, mounted in `App.tsx` so the admin portal is covered too) renders it on the shared `Modal` with a `danger` **Delete** button when `destructive`. Never call `window.confirm` — a handler that confirms must be `async` and `await` the result, and confirm *before* taking a submit guard. Tests stub the service with `stubConfirm(result)` from `src/test/confirmDialog.ts` (restored after each test by `test/setup.ts`) and assert `expect.objectContaining({ message })`, never `vi.spyOn(window, 'confirm')`.

## Documentation Screenshots

When asked to **add, update, or refresh screenshots in the MkDocs docs** (`docs/`), use the canonical capture pipeline in [scripts/screenshots/](https://github.com/vincentmakes/milestone-planner/tree/main/scripts/screenshots) — do not capture by hand.

**Pipeline:**
1. **Spin up the demo instance** (self-contained Postgres + app on port 8486):
   ```bash
   cp .env.example .env  # if missing — generate SESSION_SECRET and TENANT_ENCRYPTION_KEY (64-char hex each)
   docker compose -f docker-compose.fresh.yml up -d --build
   docker exec milestone-fresh python -m app.scripts.seed_demo
   ```
   This produces tenant `demo` (Demo Company) with the canonical projects (Bioprocess Scale-Up, Catalyst Optimization, Analytical Method Transfer, Quality System Upgrade) and everything the screenshots show: tag groups, subphases, dependencies, staff and equipment bookings, blocks, Swiss and German bank holidays, a site closure, every absence type, custom columns, Kanban comments and notifications. The data is one Python module, `app/scripts/demo_data.py` (dates relative to the day you seed); the same seed runs in Codespaces, so there is no second SQL step. Login: `admin@demo.local` / `demo1234` (and `bob.brown@demo.local` for multi-user collab shots). **`.env` must set `MULTI_TENANT=true`, a `TENANT_ENCRYPTION_KEY`, and `INIT_ADMIN_PASSWORD`** (deterministic admin-portal login for `capture_admin.py`) — see `scripts/screenshots/README.md`.
2. **Install Playwright** once:
   ```bash
   python3 -m venv /tmp/pw-venv
   /tmp/pw-venv/bin/pip install playwright
   /tmp/pw-venv/bin/playwright install chromium
   ```
3. **Capture** — all scripts are idempotent and headless, output to `docs/assets/screenshots/`, and must run in this order (`capture_admin.py` temporarily attaches the demo tenant to an SSO org and cleans up after itself):
   ```bash
   /tmp/pw-venv/bin/python scripts/screenshots/capture.py          # single-user shots
   /tmp/pw-venv/bin/python scripts/screenshots/capture_collab.py   # multi-user collab shots
   INIT_ADMIN_PASSWORD=... /tmp/pw-venv/bin/python scripts/screenshots/capture_admin.py  # admin portal
   ```
4. **Verify** with `mkdocs build --strict` (catches broken image refs).

All three capture scripts default to `http://localhost:8486`; set `SCREENSHOT_BASE_URL` (e.g. `http://localhost:8487`) to capture from another instance.

**Without the Docker image** (cloud sessions, where the image build cannot trust the session proxy's CA): run PostgreSQL alone in a container, the backend from a Python venv with uvicorn on 8485, build and `deploy-react.sh` the frontend **before** starting uvicorn, seed with `python -m app.scripts.init_db` then `seed_demo`, and capture with `SCREENSHOT_BASE_URL=http://localhost:8485`. Playwright must match the preinstalled Chromium (never `playwright install`). The step list is in `scripts/screenshots/README.md` → "Capturing without the Docker image".

**Conventions** the scripts enforce:
- Viewport **1440×900**, **light theme**, **en-US locale** (pinned on the browser context), Gantt **Q (Quarter)** zoom — matches the existing screenshots' visual style.
- Capture against the **demo tenant only** — project names and dates are referenced in alt text and prose.
- Multi-user shots use **two Playwright `BrowserContext`s in one browser** (independent cookies, real WebSockets); User B drives events through `ctx_b.request.*` API calls so the WS broadcast fires naturally.

**Adding a new shot:** add a `shot_<key>` function to `capture.py` or `capture_collab.py`, register it in the `targets` map, reference the new PNG from a markdown page, then re-run capture + `mkdocs build --strict`. See [scripts/screenshots/README.md](https://github.com/vincentmakes/milestone-planner/blob/main/scripts/screenshots/README.md) for full details.

The `scripts/screenshots/` Python scripts run their own Chromium and are always headless — they do **not** depend on the Claude Code Playwright MCP plugin. (If the user asks to make that plugin headless-by-default, edit both copies of `.mcp.json` under `~/.claude/plugins/.../playwright/` to add `"--headless"` to the `args` list and reload Claude Code.)
