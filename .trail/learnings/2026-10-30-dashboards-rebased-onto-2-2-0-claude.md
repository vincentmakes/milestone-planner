---
title: "feat/dashboards rebased onto main after #87 (feedback Part 2, 2.2.0): the three round-12 commits dropped, dashboards became 2.3.0, main's Staff Overview lines renamed in the rename commit"
author: Claude
date: 2026-10-30
branch: feat/dashboards
cost: { minutes: 0, tokens: 0 }
touches:
  - CHANGELOG.md
  - VERSION
  - UI_GUIDELINES.md
  - docs/developer-guide/conventions-in-depth.md
  - frontend/src/styles/global.css
  - frontend/src/styles/__tests__/fontSizeTokens.test.ts
  - frontend/vitest.config.ts
  - pyproject.toml
---

## Decided
- **`git rebase -i origin/main` with the three round-12 commits deleted** (`96e4dc6`, `8a03d17`, `39d5658`): #87 (a squash of `feat/feedback-3`) already carries them as cherry-picks. 117 commits became 114. Only six stops: two CHANGELOG conflicts, the staff-management drag line, the conventions-in-depth Icons line, `global.css` in the version commit.
- **Version 2.3.0**: at the first CHANGELOG conflict the dashboards block became `## [2.3.0] - 2026-10-30` above main's `## [2.2.0] - 2026-10-30`, both byte-identical otherwise. Dropping `96e4dc6` also drops the text-scale line from the dashboards block: it lives in main's 2.2.0 block now, with main's "Staff Overview" (the view's name in 2.2.0). The version commit was folded with a `--fixup=amend:` commit that rewrote every "2.2.0" on a line `git diff origin/main HEAD` adds (79 lines, the vitest floor comment included) plus `VERSION`, and reworded it. Main's own "pre-2.2" (`global.css`) and "2.2 type scale" (`useHeaderDensity.ts`) stay: the scale shipped in 2.2.0.
- **The version commit's `VERSION` hunk disappeared silently**: its parent said 2.1.0, its own side 2.2.0 and main 2.2.0, so the three-way merge saw the same change on both sides. The same for its `useHeaderDensity.ts` hunks. Check the file list of a version commit after a rebase.
- **Main's round-12 lines say "Staff Overview"** (the rename is dashboards-only). The rename commit got a fixup for them: UI_GUIDELINES Compact scale (twice, once across a line break), the conventions-in-depth Icons sentence, the `fontSizeTokens.test.ts` header, the `global.css` compact-scale comment. The two user-guide sentences of #87 (`staff-management.md`) merged through the rename conflict itself. The fixup re-conflicts once in `96c7f00`, which turns the Icons link into a GitHub URL; a token-level merge resolves both.
- `fontSizeTokens.test.ts` keeps main's sanity floor `> 90` (the dashboards tree has more stylesheets, but the number is a scanner check, not the ratchet).
- Floors: main's are lower, so the dashboards values stay; the totals came out identical on the frontend (94.08 / 93.1 / 94.4 / 86.19) and 93.57 % on the backend. Only the comments and the commit subject moved to 2.3.0.
- If a version commit is marked `edit` and conflicts, `git rebase --continue` commits it and does **not** stop again for the edit: fold the content change in afterwards with a fixup.

## Watch out
- At the next rebase onto a main that carries dashboards-era cherry-picks, diff each original against its pick (`git range-diff A~1..B base..picks`) first: the picks' wording differences (view names, version numbers, links) are exactly the lines to restore.
- `trail check --base origin/main` reports the same 10 keyword false positives as the 2.1.0 rebase (CLAUDE.md, UI_GUIDELINES, kanban.py, tenant_manager.py, tenant_provisioner.py, api-reference.md); only the UI_GUIDELINES line moved (779 → 796).
- A Vitest test that times out at 5 s while pytest runs alongside (`StaffView` filter test) passes alone: run the two suites one after the other.
