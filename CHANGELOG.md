# Changelog

All notable changes to Milestone Planner are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-08-16

### Added
- A **Kanban board** view showing any project's work as cards across four columns — To Do, In Progress, Blocked and Done. The board and the Gantt chart are two views of the same plan: a card is a phase or subphase with no children, so moving a card updates the Gantt chart and vice versa. Parent phases become swimlanes rather than cards.
- Cards can be dragged between columns, grouped into swimlanes by project, by phase, by assignee or by any list-type custom column, and filtered to just your own work with **My Todo**. Choose a single project or **All projects** to see the whole site at once; projects appear in the same order as the Gantt chart, including any custom order you have set there. When several projects are shown, phase lanes are labelled *Project — Phase* so identically named phases stay apart.
- Assigning someone to a card **books their time**: it creates a staff assignment covering the card's dates at that person's maximum capacity, so the Staff workload view reflects it immediately. The booking follows the card whenever its dates change in the Gantt chart. Assigning the same person twice is now refused instead of silently double-booking them.
- **Comments on cards, with `@` mentions.** Type `@` and pick someone from the list — people already on the card are offered first, followed by everyone else at the card's site, administrators included. A picked mention is highlighted as you type, and editing it removes both the highlight and the notification, so what you see is always what will happen when you post. Only names picked from the list notify anyone; one simply typed out is ordinary text. Any signed-in user can comment; you can edit and delete your own comments, and managers can remove any.
- The percentage each assignee is booked at can be **changed from the card itself**, with the same allocation slider the Gantt chart uses, instead of only at the point of assigning. A booking above that person's own maximum capacity is flagged. Changing an allocation requires superuser rights — being assigned to a card lets you move it, not re-plan it.
- An **in-app notification bell** in the header with an unread count. You are notified when someone assigns you to a card, comments on a card you are on, mentions you, or moves one of your cards to another column. Reminders for cards that are due soon or overdue are worked out in your browser from the plan you already have loaded, so they appear without any extra setup — but they only appear while the application is open, and there is no email or push.
- People who are not project managers can now move the cards they are assigned to, and comment. Creating, deleting, assigning and rescheduling still require superuser rights.
- The site export workbook gained a **Kanban status** column on the Projects sheet and a new **Card comments** sheet.
- The **version this instance is running** now appears at the bottom of the user menu. It is read from the server each time the menu is opened, so an upgrade shows up there without reloading the page.
- Clicking a **phase name** in the Gantt chart's table scrolls the timeline to that phase's start date — the same jump the L1/L2 badges already offer on subphases. Useful for finding work that sits far outside the current view.

### Changed
- Editing a comment now updates who it mentions, notifying anyone newly added without re-notifying people who were already mentioned. Previously an edit changed the text but left the mention list untouched.
- A phase or subphase's completion percentage and its Kanban status are now kept in step. Setting a card to Done marks it 100% complete, To Do resets it to 0%, and editing the percentage in the Gantt chart moves the card to the matching column. Marking a card Blocked leaves its percentage untouched, and editing the percentage of a blocked card does not silently unblock it.
- Completion percentages are now validated to be between 0 and 100. Values outside that range were previously accepted and stored.
- Staff allocations on a phase or subphase are now validated to be between 1 and 100. A single booking is a share of one person's time, so it cannot exceed all of it; overlapping bookings are what add up to over-allocation in the workload heatmap. Zero and negative values were previously accepted and quietly distorted that calculation.

### Fixed
- The top menu bar no longer overlaps itself on narrow screens. Below roughly 1600px it now collapses in stages — labels become icons, then the least-used controls (zoom, undo/redo, the view switcher, the theme and What If toggles) move into a **"⋯" menu** — so everything stays reachable down to tablet-portrait width. Previously the bar simply overflowed, leaving the date navigator sitting underneath the site picker.
- The toolbar's zoom buttons now keep the timeline centred while zooming, matching Ctrl+scroll. They previously zoomed from the left edge.

## [1.1.0] - 2026-08-14

### Changed
- Bank-holiday import now uses version 4 of the Nager public-holiday API at its new address, `https://nagerholidays.com/api/v4`. **If your firewall allows only `date.nager.at`, add `nagerholidays.com`** or holiday import will stop working after this upgrade.
- An installation that pins `NAGER_API_URL` to a `/api/v3` URL keeps working — the version is detected automatically and a warning is logged — but version 3 of the holiday API reaches end of life on 31 January 2027.
- Imported holiday names are now in English (for example "Swiss National Day" rather than "Nationalfeiertag"); version 4 of the holiday API no longer publishes local-language names. Existing holidays keep their current names until a site's holidays are refreshed.
- Only public and bank holidays are imported. The holiday API's school, observance, optional and authority entries are ignored, so they no longer count against working days.
- Region filtering now matches subdivision codes exactly, and accepts either form — a site configured with `ZH` or with `CH-ZH` gets the same holidays.
- Changing a site's country now replaces its imported holidays for the current and next year instead of adding to them, so holidays from the previous country no longer linger.

### Fixed
- Refreshing holidays no longer clears a site's existing holidays when the holiday API is unreachable — they are kept until a successful fetch replaces them.
- A single duplicate or malformed holiday returned by the API no longer discards the whole import; it is skipped and the remaining holidays are stored.

## [1.0.21] - 2026-08-10

### Security
- Updated a build-time dependency (`nanoid`) that a newly published advisory flagged as vulnerable. Build tooling only — the shipped application was never affected.

## [1.0.20] - 2026-08-07

### Security
- The MPP import diagnostics endpoints (`/import/test`, `/import/test-upload`) now require a superuser session — previously they were reachable without authentication, including an endpoint that accepted file uploads.
- The browser console no longer logs every API write request in production builds (the diagnostic logging now runs only in development).

### Changed
- The frontend now declares Node.js 24 as its required toolchain (`engines` field), matching the Docker build and CI.
- React hooks-order violations now fail the frontend lint check instead of passing as warnings; the WebSocket hook that carried the only violations was refactored accordingly.
- Deprecated Python `datetime.utcnow()` usage was fully migrated ahead of future Python upgrades. No behaviour change.

### Fixed
- Session expiry timestamps are now recorded as true Unix epochs. They were previously skewed 1–2 hours by the container timezone (self-cancelling in normal operation, but sessions spanning a daylight-saving switch could last up to an hour longer or shorter, and the stored expiry disagreed with the admin-portal sessions). Sessions created before this update will expire up to 2 hours early, once — logging in again is all that's needed.
- The session cookie metadata now records the actual expiry time instead of the session's creation time.

### Removed
- Removed dead code left over from earlier iterations: unused backend exception classes and an unused site-access dependency, and several never-rendered frontend components, hooks and contexts (fill-down editing, touch drag, change-indicator badges, an orphaned theme selector and loading spinner, and duplicated row-position logic).
- Removed the unused `black` and `isort` development dependencies — Ruff handles formatting and import sorting.

### Fixed
- `.env.example` now matches what the application actually reads: the master database is configured via `MASTER_DB_*` variables (the previously documented `MASTER_DATABASE_URL` was ignored), and the proxy and auto-initialization variables are now documented. The ignored `SECRET_KEY` variable was removed from the compose files.

## [1.0.19] - 2026-08-06

### Security
- Updated `cryptography` to 50.0.0, clearing a high-severity advisory about PKCS#7 enveloped-data decryption leaking key information through distinguishable errors and timing. Milestone Planner never used that code path — the library is only used for AES-GCM encryption of stored credentials — so no data was at risk.
- Removed the unused `python-jose`, `authlib` and `itsdangerous` backend dependencies, which no longer ship in the application image.
- Updated the web framework (FastAPI 0.141.1, Starlette 1.4.1, Pydantic 2.13.4), clearing seven Starlette advisories that the previous pins were stuck behind. Two were denial-of-service flaws an unauthenticated visitor could have triggered through form and file uploads; the rest covered request-URL handling. API responses are unchanged.
- Updated the bundled `brace-expansion` and `js-yaml` build-time dependencies to releases without denial-of-service advisories. They are used only when building the app, not at runtime.

### Changed
- Backend CI now audits Python dependencies for known vulnerabilities on every pull request and once a week, matching the existing frontend audit.
- Moved `email-validator` off a yanked release to a properly published version. No behaviour change.

## [1.0.18] - 2026-07-28

### Security
- Removed the unused `react-router-dom` frontend dependency, clearing two React Router advisories (an open-redirect and an SSR hydration flaw) that no longer apply to this app.
- Updated the bundled `js-yaml`, `postcss`, `brace-expansion` and `minimatch` build-time dependencies to versions without known denial-of-service and path-traversal advisories.

## [1.0.17] - 2026-07-18

### Added
- The documentation screenshot pipeline now captures every screenshot in the docs automatically, including the admin portal, all management modals, tags, equipment maintenance blocks, and the read-only tenant SSO form shown when organization SSO applies.
- Fourteen more documentation illustrations: dependency arrows, critical path, context menu, column manager and filters, vacation and equipment booking modals, bank holidays, archived view, dark theme, site editor, staff filter, and the admin portal's create-tenant and organization SSO dialogs.

### Fixed
- Changing the status of a tenant that belongs to an organization no longer fails with an internal server error in the admin portal.
- The screenshot demo-data seed script is now safe to re-run: it no longer duplicates vacations or custom columns.

## [1.0.16] - 2026-07-17

### Changed
- The frontend build and development environments now use Node.js 24 LTS (previously Node 20, which has reached end-of-life). No application behaviour changes.

## [1.0.15] - 2026-07-17

### Added
- The full site export now includes a Staff notes sheet.

### Changed
- Newly provisioned tenants no longer receive unused legacy phase/subphase columns on equipment assignments; equipment bookings are project-level, matching the application.

### Fixed
- Fresh single-tenant installs via `setup_databases.sql` were missing the user work-capacity and system-flag columns, which broke the app on first login; they are now included.
- The master fresh-install script now creates the organizations and organization SSO tables and the tenant organization/group-access columns instead of relying on runtime auto-migration.
- Deleting a site or a project manager on provisioned tenants now detaches their projects and equipment instead of being blocked by the database.
- Other connected users now see a project immediately after an MS Project/CSV import instead of having to reload.
- Importing a project is now blocked while What-If mode is active — it previously bypassed the sandbox and wrote to the server for real.
- The manual tenant schema template was rebuilt to match the actual application schema (it had drifted on a dozen tables: wrong column names, missing columns and constraints).

### Removed
- Unused frontend staff create/update/delete functions that targeted endpoints that never existed.

## [1.0.14] - 2026-07-16

### Fixed
- The manual tenant schema template now includes the equipment blocks, tags and project tags tables it was missing.
- The staff notes table is now created consistently as `staff_notes` on every install path; databases from older installs are migrated automatically (legacy `notes` rows are carried over and the old table removed).
- Assignment endpoints are now correctly listed in the broadcast middleware's skip list, replacing a stale entry for a route that never existed.

### Removed
- Dead HTTP presence endpoints and unused presence polling code; presence has always worked over the WebSocket connection.

## [1.0.13] - 2026-07-16

### Fixed
- Admin portal dialogs no longer close when clicking outside them, which could discard in-progress input (e.g. when a text selection ended on the backdrop); use the close/cancel buttons or press Escape instead. Escape now closes admin portal dialogs.
- The fresh-install schema (`setup_databases.sql`) now includes the previously missing company events, staff notes, custom columns, skills and project presence tables, matching the schema created for provisioned tenants.

## [1.0.12] - 2026-07-16

### Fixed
- Corrected outdated setup and migration documentation: removed references to a nonexistent Alembic setup and `migrate_all_tenants.py` script, documented the master-database migration runner, and completed the list of available migrations.

## [1.0.11] - 2026-07-16

### Fixed
- Organization-level Microsoft Entra SSO sign-in no longer returns a 500 error on the Microsoft callback in multi-tenant mode: the workspace is now carried through the OAuth flow so the shared organization callback URL completes against the correct tenant database and returns the user to their workspace. A single organization SSO configuration and redirect URI now works for every tenant in the organization.

## [1.0.10] - 2026-07-16

### Added
- Guardrails against redundant SSO setup: when a workspace's organization manages SSO, the tenant-level SSO settings form now explains that organization SSO takes precedence and is shown read-only (and the server rejects enabling tenant-level SSO), and the admin panel warns when adding a tenant whose own SSO would be overridden by organization SSO.

### Fixed
- SSO login button no longer stays hidden (and the SSO login/callback flow no longer fails) for multi-tenant instances: SSO configuration is now resolved correctly from the tenant context set by the tenant middleware, so both organization-level and tenant-level Microsoft Entra SSO work when signing in at a tenant URL.

## [1.0.9] - 2026-07-14

### Fixed
- Tenant provisioning now works on managed PostgreSQL (Azure Database, RDS, Cloud SQL) where the admin role is not a superuser: the provisioning admin is granted each new tenant role before creating its database (previously failed with `must be able to SET ROLE "…"`), and the tenant user is explicitly granted `CREATE`/`USAGE` on its `public` schema (previously failed with `permission denied for schema public` when building tables).

## [1.0.8] - 2026-06-23

### Security
- Updated `cryptography` to 48.0.1, fixing a vulnerable OpenSSL version bundled in the wheels.
- Updated `python-multipart` to 0.0.31, addressing denial-of-service and parameter-smuggling issues in querystring and multipart form parsing.
- Updated `vite` to 7.3.5, fixing a `server.fs.deny` bypass and an NTLM hash-disclosure issue in the bundled dev-server tooling.
- Updated bundled frontend dependencies `form-data` (CRLF injection), `js-yaml` (denial-of-service), `@babel/core` (arbitrary file read), `esbuild` (dev-server file read), `ws` (memory disclosure / denial-of-service), and `brace-expansion` (denial-of-service) to patched versions.

## [1.0.7] - 2026-06-10

### Changed
- Bumped `react-router-dom` from 6.30.3 to 6.30.4 (Dependabot npm group update).

## [1.0.6] - 2026-06-02

### Changed
- Bumped `vitest` from 4.0.18 to 4.1.0 (Dependabot npm group update).

## [1.0.5] - 2026-05-18

### Security
- Bumped `authlib` from 1.6.11 to 1.6.12 (Dependabot pip group update) — fixes redirecting to an unvalidated `redirect_uri` on `InvalidScopeError` in `OpenIDImplicitGrant` and `OpenIDHybridGrant`.

## [1.0.4] - 2026-05-07

### Changed
- Bumped `python-multipart` from 0.0.26 to 0.0.27 (Dependabot pip group update).

## [1.0.3] - 2026-05-07

### Changed
- Bumped `authlib` from 1.6.9 to 1.6.11 and `python-dotenv` from 1.0.1 to 1.2.2 (Dependabot pip group update).

## [1.0.2] - 2026-05-07

### Added
- Reproducible screenshot capture pipeline for the docs (`scripts/screenshots/`): two headless Playwright scripts plus a SQL seed for vacations, bank holidays, and populated custom columns. Run against the `demo` tenant from `app.scripts.seed_demo` to refresh every screenshot referenced by the MkDocs site.

### Changed
- Refreshed and expanded screenshot coverage in the user guide:
  - `gantt-main.png` now shows projects expanded into phases with custom columns populated and the today indicator on a real timeline.
  - New combined-view screenshots (`gantt-with-staff-panel.png`, `gantt-with-equipment-panel.png`) demonstrating the **Panels** dock.
  - New `vacations-view.png` for the previously screenshot-less *Vacations & Time Off* page.
  - New `what-if-active.png` showing the active What-If state with Discard/Exit, replacing `what-if.png`.
  - New collaboration screenshots (`collab-online-users.png`, `collab-presence-viewing.png`, `collab-activity-feed.png`) for the previously text-only *Real-Time Collaboration* page.
  - `custom-columns.png` now shows populated values rather than the empty Manage Columns modal.

## [1.0.1] - 2026-05-06

### Fixed
- Docker image now builds again — added `g++` to the Python builder stage so `psutil` and `jpype1` source builds succeed when no precompiled wheel is available for the target platform.
- `/health` and `/api/health` now report the correct version inside Docker. The `VERSION` file is now copied into the runtime image; previously it was missing and `__version__` fell back to `0.0.0`.

## [1.0.0] - 2026-05-06

`1.0.0` is a stability declaration — it captures the current shipping state of
the application and starts the formal SemVer + CHANGELOG discipline. From here
on, every code-impacting change bumps `VERSION` and lands a CHANGELOG entry in
the same PR.

### Added
- Adopted [Semantic Versioning](https://semver.org/) — single source of truth at `/VERSION`.
- Adopted [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format for `CHANGELOG.md`.
- New `.github/workflows/version-check.yml` CI gate that fails PRs whose `VERSION` bump is missing a matching `## [<version>]` heading in `CHANGELOG.md`.
- Backend now reads its version from `/VERSION` at startup (`app/__init__.py`) — exposed via `/health` and `/api/health`.

### Changed
- Backend `__version__` reconciled from the inconsistent hardcoded `2.0.0` down to the canonical `1.0.0` baseline. Frontend `package.json` version aligned to match (and is now static — only `/VERSION` is bumped going forward).

### Removed
- Stale repo-root documentation files that pre-date or duplicate the MkDocs site at `docs/`:
  - `AUDIT.md` — one-off Feb-2026 audit report whose remediation items have either landed or migrated to GitHub issues.
  - `USER_MANUAL.md` — duplicate of the MkDocs `docs/user-guide/` content; the canonical end-user manual is published at [docs-milestone.verdet.me](https://docs-milestone.verdet.me).
  - `DEVELOPMENT.md` — superseded by `docs/developer-guide/`.
