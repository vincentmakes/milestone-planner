---
title: "feat/teams absorbs the CLAUDE.md split (#85): the teams-era text regenerated into the reference pages, the teams rules condensed into the core"
author: Claude
date: 2026-10-26
branch: feat/teams
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
  - docs/developer-guide/api-reference.md
  - tests/test_rbac_schema_sources.py
  - tests/test_teams_schema_sources.py
---

## Decided
- **Merging `main` + #85 into `feat/teams` conflicts only in `CLAUDE.md`** (monolithic vs split). Resolution: the pages are the #85 pages **regenerated from `feat/teams`'s monolithic `CLAUDE.md`** with #85's own slicing script (same headings, scope lines and cross-reference links, only the line ranges moved: codebase-map 245–598 / 655–687 / 1322–1334 / 1352–1389, database-schema 689–806, routes 810–1116, auth 1120–1175 / 1336–1350, realtime 1177–1194, frontend 1198–1320). The script reproduces #85's pages byte for byte from `main`'s file, so the diff against #85's pages is exactly the teams-era text. New cross-references in the teams text were linked the way `feat/dashboards` did ("see Tenant role model", "see the Approval workflow bullet", "see Assignments", "the Settings keys above", "see Frontend Conventions" in What-If → What-If exemptions).
- **The core is #85's core plus the teams rules**, condensed exactly as `feat/dashboards`'s core condensed them (permission gates backend/frontend, approval workflow, change notifications, booking segments, store ownership, icons, dropdowns, form fields, shared test helpers: rule + invariant + a link into `conventions-in-depth.md`, whose sections hold the full teams bullets verbatim). Rules #85 had and teams changed were rewritten from the teams text: "Sites scope the UI, not access" became **Visible sites scope every read and write**; API docs gate on `system.api_docs`; the What-If exemption summary names comments, RBAC and approval requests; the WebSocket `case` rule names `approval:changed`. Round 7's lines: the `sso_test.py` sentence joins the org-SSO guardrail in Security Requirements, `confirmWord` the confirm rule. Carried as a new one-liner: a new notification type goes at the **end** of `NOTIFICATION_TYPES`. Schema checklist item 7 (the two schema-source tests read `database-schema.md`).
- **Tests**: `test_migration_is_documented` in `tests/test_rbac_schema_sources.py` / `tests/test_teams_schema_sources.py` read `docs/developer-guide/database-schema.md` instead of `CLAUDE.md` (the migration history moved there).
- `api-reference.md`'s canonical-page note says "permission gate, visible-site scoping … approval 202s" again (#85 had dropped the approvals wording because `main` has none).

## Tried and ruled out
- Copying `feat/dashboards`'s pages and stripping dashboards content: its pages carry dashboards edits inside teams-era sentences, so the sentence-level check against `feat/teams` would have needed a hand review of every hunk. Regenerating from the teams file is mechanical and provably complete.
- Keeping the teams bullets verbatim in the core: about 8 100 words, over the 7 000 budget.

## Watch out
- **`feat/dashboards` meets the same conflict** when it merges `main` (after #85 and #83 land): keep its own split (core and pages), which already holds teams + dashboards, then re-apply only what landed on `main` after its split (round 7's SSO lines: `sso_test.py` in the core's guardrail, `confirmWord`, the `POST /auth/sso/test` row, the org/tenant test bullet, the project-tree entries) and re-run the completeness check against `main`'s file.
- The completeness check against `feat/teams`'s `CLAUDE.md`: 1 479 units, 19 not verbatim even with links reduced — 14 are #85's own rewrites (site-export pointer, no-router, nav description, hooks-catalog code comment, schema-checklist pointer, three What-If "see Frontend Conventions", five dropped Gotchas), 5 are cross-references turned into section links.
- `/tmp/claude-501/venv313` was found broken (pyvenv.cfg and package contents purged by the macOS `/private/tmp` cleaner); a fresh 3.13 venv needs `asyncpg 0.30.0`, `psycopg2-binary 2.9.10`, `psutil 6.1.0`, `jpype1 1.5.1`, `sqlalchemy 2.0.36` (the pinned ones have no 3.13 wheels).
- Source comments still pointing at moved `CLAUDE.md` sections (`autoCalculation.ts`, `endpoints.contract.test.ts`) are untouched: editing `frontend/src` trips the version gate.
