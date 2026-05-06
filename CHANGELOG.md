# Changelog

All notable changes to Milestone Planner are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
