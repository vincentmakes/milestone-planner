---
title: "feat/dashboards rebased onto main after #86 (feedback-2, 2.1.0): dashboards became 2.2.0; the real conflicts were step counts, the removed Cross-site disabled state and the Staff & Calendar rename"
author: Claude
date: 2026-10-29
branch: feat/dashboards
cost: { minutes: 0, tokens: 0 }
touches:
  - CHANGELOG.md
  - VERSION
  - tests/test_tenant_manager_more.py
  - tests/test_project_fields_schema.py
  - tests/test_teams_schema_sources.py
  - frontend/src/components/layout/Sidebar/Navigation.tsx
  - frontend/src/hooks/__tests__/useAllowedViews.test.tsx
  - frontend/src/contexts/wsSlices.ts
  - frontend/vitest.config.ts
---

## Decided
- **Plain `git rebase origin/main`** (114 commits, none dropped). #86 did not touch `CLAUDE.md`, so unlike the #85 rebase there was no core to pin.
- **Version**: #86 shipped as 2.1.0, so the dashboards release is **2.2.0**. The dashboards block of `CHANGELOG.md` was renamed `## [2.2.0] - 2026-10-29` at its first conflict and placed above main's `## [2.1.0]`; both blocks stay byte-identical to their sources. A final commit moved `VERSION` and every "2.1.0" the dashboards commits wrote (code comments, migrations, tests, docs) to 2.2.0. The rewrite worked line by line on the lines `git diff origin/main HEAD` adds, so main's own 2.1.0 mentions stay. One merged line keeps main's "no masking since 2.1.0" (`auth-and-tenancy.md`). Learnings are left as written.
- **Auto-migration step counts merge "cleanly" and wrongly.** Both sides moved `count("COMMIT")` from 24 to 25, so git took 25. Every schema commit that adds a step must be re-counted by hand: legacy 24 + decimals + dashboards + sharing ×2 + widget kinds = **29**, current 7 + decimals + sharing ×2 + widget kinds = **11**. The step logs in `test_project_fields_schema.py` and `test_teams_schema_sources.py` carry `DECIMALS, "COMMIT"` before the dashboards' commits. The failure test now finds the decimals step after the failed statement instead of counting from the end, so a further dashboards step will not break it again.
- **Main removed the disabled Cross-site state** (`disabledReason`, `CROSS_SITE_DISABLED_REASON`, `unavailable` in `Navigation`): the entry is hidden when only one site is visible. The dashboards commits still used it in two places: the Navigation `onClick` conflict and, through a clean auto-merge, the Dashboards sub-list (`subDisabled` / `subTitle`). Only `tsc -b` caught the second one, and it was fixed in the commit that introduced the sub-list.
- **The "Staff Overview" → "Staff & Calendar" rename** also had to be applied to main's new text: the team-closure paragraph in `settings.md`, the Assign me… bullet in `staff-management.md`, and a new Navigation test looking up `button('Staff Overview')`.
- **Main gave each bell row a × button** named `Delete "<title>"`, so a `getByRole('button', { name: /Bob commented/ })` matches two buttons. The dashboards leave-guard test now uses main's anchored `/^Bob commented/`. When that test threw before its `unregister()`, the refusing guard stayed registered and 13 later bell tests failed: look for the first failure in a file.
- `change:site` reloads the union of both sides: `…teams, currentUser, staff, dashboards`.
- Coverage floors: at each floor conflict the comment was rebuilt from the dashboards commit's file, with main's 2.1.0 sentence added, and each threshold set to the higher of the two sides.

## Watch out
- `git add <dir>` in a worktree whose `frontend/node_modules` is a **symlink** stages the symlink: `node_modules/` in `.gitignore` matches directories only. It was filtered out with `git filter-branch --index-filter 'git rm --cached --ignore-unmatch frontend/node_modules'`. Stage with `git add -u` or by path, never by directory.
- Long doc paragraphs that both sides edit (`realtime.md`, `auth-and-tenancy.md`, `database-schema.md`, `frontend-architecture.md`) were merged by a token-level three-way merge script, and only the overlapping edits were resolved by hand. Review the result with `git diff --word-diff`.
