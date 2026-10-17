---
title: "Follow-ups PR: defaults aligned, dead code removed, undefined CSS tokens, UI_GUIDELINES.md"
author: Claude
date: 2026-10-17
branch: fix/claude-md-audit-follow-ups
cost: { minutes: 90, tokens: 714184 }
touches:
  - UI_GUIDELINES.md
  - frontend/src/styles/variables.css
  - frontend/src/styles/__tests__/cssTokens.test.ts
  - migrations/run_migration.py
  - app/config.py
  - ".github/workflows/version-check.yml"
---

## Decided
- Migration runners default MASTER_DB_NAME to milestone_master like the app; docker-compose.fresh.yml, the devcontainer and the admin docs keep milestone_admin on purpose (existing volumes hold that database). tests/test_follow_up_defaults.py keeps the runner defaults equal to Settings.master_db_name.
- SSO_* settings removed from app/config.py and .env.example (extra=ignore keeps old .env files loading). upgrade_to_v90.sql no longer adds predefined_phases.is_system/color.
- UI guidelines live in UI_GUIDELINES.md at the repo root (turbo-ea structure, Milestone content, every token named per theme); docs/developer-guide/frontend-ui.md was removed from the docs site.
- src/styles/__tests__/cssTokens.test.ts guards that every var(--x) read is defined (global token, component-scoped CSS property, or inline style via '--x': / ['--x' as string]: / setProperty). It found 12 undefined tokens (--space-2/3/4, --accent-teal, --radius-xs, --primary, --border-primary, --status-danger, --accent-green-alpha, --text-warning, --bg-tertiary-rgb, --border-color-subtle); all replaced with canonical tokens, --accent-teal and --accent-green-alpha added.
- @types/node added as a devDependency so a Vitest test can read the filesystem (tsconfig includes src, and Vitest returns a CSS-module stub, not text, for import.meta.glob('*.module.css', '?raw')).

## Tried and ruled out
- Removing cascadeDependentPhases/Subphases: they are dead but tested (6 cases); deleting them only lowers the coverage total the CI floor sits under, so the header comment was fixed instead.
- npm uninstall from the wrong directory: a Bash cwd reset dropped a stray package.json/package-lock.json in the repo root; always cd inside the same command and check git status for root manifests.

## Watch out
- Python 3.13 has no wheels for asyncpg/psycopg2-binary: run the backend tests from a Python 3.11 venv (uv venv --python 3.11).
- Node 22 in the sandbox vs engines >=24: npm only warns; lockfile diffs stayed minimal.
- UI_GUIDELINES.md debt lists (raw inputs, checkbox vs ToggleSwitch, overlay close rules, row-action sizes, aria labels, alert(), focus trap) are the backlog for the next UI PR.
