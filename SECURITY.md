# Security Policy

## Reporting a Vulnerability

Please report vulnerabilities privately via **GitHub's private vulnerability reporting** on this repository ([Security → Report a vulnerability](https://github.com/vincentmakes/milestone-planner/security/advisories/new)). Do **not** open a public issue for security problems.

Include what you can: affected version (`/VERSION` or the `version` field of `/health`), deployment mode (single- vs multi-tenant), reproduction steps, and impact.

## Supported Versions

Only the latest release receives security fixes. There are no maintained release branches — update to the newest version to receive fixes.

## What to Expect

- Security-relevant fixes are released promptly and documented under a **Security** heading in [CHANGELOG.md](CHANGELOG.md).
- Dependency vulnerabilities are caught automatically: CI runs blocking dependency audits (`pip-audit` for the backend, `npm audit` for the frontend) on every pull request and weekly on a schedule.

## Security-Relevant Configuration

Operators should review the [Admin Guide](https://docs-milestone.verdet.me/admin-guide/overview/) — in particular: set a strong `SESSION_SECRET`, set `TENANT_ENCRYPTION_KEY` (multi-tenant), enable `SECURE_COOKIES=true` behind HTTPS, and keep `DEBUG=false` in production.
