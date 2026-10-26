---
title: "feat/dashboards rebased onto main after #85 and #83: the dashboards commits replayed with main's split CLAUDE.md pinned, the dashboards rules and reference re-added in one commit"
author: Claude
date: 2026-10-26
branch: feat/dashboards
cost: { minutes: 0, tokens: 0 }
touches:
  - CLAUDE.md
  - docs/developer-guide/codebase-map.md
  - docs/developer-guide/database-schema.md
  - docs/developer-guide/routes.md
  - docs/developer-guide/auth-and-tenancy.md
  - docs/developer-guide/realtime.md
  - docs/developer-guide/frontend-architecture.md
  - docs/developer-guide/conventions-in-depth.md
  - docs/developer-guide/ai-workflow.md
  - tests/test_tenant_manager_more.py
  - migrations/README.md
---

## Decided
- **Only the dashboards commits were replayed**: `git rebase --onto origin/main 7af920f feat/dashboards`. #83 was a squash, so the old feat/teams commits under 7af920f are not in main and must not be replayed.
- **Main's split core and pages were pinned through the replay** by an `--exec` script: after each commit it reset `CLAUDE.md` and the eight reference pages to their state in the previous commit and amended the commit, or dropped it when nothing else was left. Conflicts on those files were resolved by keeping HEAD. Four commits ended up empty and were dropped: the round-6 split (30d1155, 49a0130, 3949276, b7e292c). Main's #85 already holds the same pages, and its pointer edits are identical.
- **The dashboards text came back in one final commit** through a line-level three-way merge per page. Main's page is "ours", the pre-rebase dashboards page "theirs", and 7af920f's monolithic `CLAUDE.md` serves as the "base" set. It worked like this:
  - A dashboards line not in the base is added, as its whole paragraph, so table headers come along.
  - A main line still in the base that dashboards rewrote is replaced.
  - A hunk where both sides hold new lines is a conflict, resolved by hand.
- **Core budget**: the dashboards rules took main's 6 903-word core to 7 339 words. It is back at 7 000 because:
  - the dashboards bullets were condensed to a rule plus a link;
  - new `conventions-in-depth.md` sections were added: "People you may name", and the schema-source-tests paragraph under "Shared test helpers";
  - a few main bullets were cut where their sentences already sit verbatim on a page: the What-If snapshot reason, the broadcast middleware detail, the change-intent builders, `change_intents`, and the auto-migration transaction note;
  - two details moved verbatim to a page: the badge reasons to `codebase-map.md` → CI, and the `TAGS_UPGRADE_SQL` guard to `database-schema.md`.
- `tests/test_tenant_manager_more.py` COMMIT counts are main's plus the dashboards steps: legacy 24 + 4 = 28, current 7 + 3 = 10. Each dashboards schema commit was re-counted as it replayed.

## Watch out
- In this sandbox, `git stash` cannot touch `.claude/` because it is write-protected. Trail's PreToolUse hook also blocks any shell command that names its hook script. Rebase in a `$TMPDIR` worktree while the main tree is detached at the same commit, then check the branch out again. The uncommitted Trail files carry across because they are identical in both commits.
- `ai-workflow.md` on this branch documents the `test:related` / `test:changed` npm scripts. Main documents the raw `npx vitest` commands because a `package.json` edit trips its version gate. The `NODE_OPTIONS=--no-experimental-webstorage` prefix main uses was kept on `test:changed`.
