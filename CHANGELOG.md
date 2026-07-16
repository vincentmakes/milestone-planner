# Changelog

All notable changes to Milestone Planner are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
