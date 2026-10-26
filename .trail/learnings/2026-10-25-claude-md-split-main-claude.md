---
title: "CLAUDE.md split on main (1.11.0): a short core of rules, the reference moved verbatim into seven Codebase Reference pages, plus the AI workflow page"
author: Claude
date: 2026-10-25
branch: chore/claude-md-reference-pages
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
  - mkdocs.yml
---

## Decided
- **Detail goes to the page, the rule stays in the core.** `CLAUDE.md` (21 256 words before, auto-loaded by every agent) keeps only what an agent must obey or needs to find things: the conventions as rules, the checklists, Quick Start, Common Commands, a Start-here table naming page *headings*, the Gotchas, the Reference pages list (about 5 900 words now). A sentence that says must / never / always / keep / don't is a rule; everything describing how things work moved.
- **Old section → page** (moved verbatim, then condensed only in the core):
  - Architecture Overview, Terminology, Project Structure, Environment Variables, Import & Export, Docker & Deployment, CI → `docs/developer-guide/codebase-map.md`
  - Database Schema + Migrations → `database-schema.md`
  - API Reference → `routes.md` ("Route auth gates and side effects")
  - Authentication / Sessions / SSO, Multi-Tenancy Internals, Security → `auth-and-tenancy.md`
  - Real-Time Collaboration → `realtime.md`
  - Frontend Architecture + What-If Mode → `frontend-architecture.md`
  - the full text of the two long rule bullets (What-If exemptions, errors and confirmations) and the Documentation Screenshots pipeline → `conventions-in-depth.md`; the core keeps each as rule + invariant + a link to its section.
- Rules that lived in the moved sections were carried into the core as one-liners: no FK on `custom_column_values` / `card_comments`, data fixes in the `tenant_provisioner` constants, sites scope the UI not access (no site checks on project routes without a product decision), no `DB_*` fallthrough, `destroy_user_sessions`, unauthenticated `GET /settings`, nothing more on `/health`, tenant vs portal `admin`, the own `case` for `notification:new`, no query library / router, `partialize` ↔ `merge`, `allocation` on staff updates, dependency `entity`, Gantt section class names, What-If create blocking and `loadAllProjects()` being a no-op there, the site-export contract, `== 'true'` in the workflows, the `coverage` branch, fixing a red `Audit` at the pin.
- `mkdocs.yml` has `validation: {anchors: warn}`, so `mkdocs build --strict` fails on a dead `page.md#anchor`.
- `docs/developer-guide/ai-workflow.md` is the process page (round shape, model routing, verification policy, sandbox notes); on main it documents the raw `npx vitest related --run <files>` and `NODE_OPTIONS=--no-experimental-webstorage npx vitest run --changed <ref>` commands, because a `frontend/package.json` script would trip the version-bump gate.

## Merge note
- `feat/teams` and `feat/dashboards` still carry the monolithic `CLAUDE.md` (`feat/dashboards` also its own split, done there first). When either lands on `main`, `CLAUDE.md` conflicts (monolithic vs split): keep the split core, and move the branch's added content into the matching pages instead of the core — the `feat/dashboards` pages already hold its teams / RBAC / dashboards text, its core the matching rules. Re-run the checks below after the merge.

## Tried and ruled out
- Merging the new pages with `api-reference.md`, `architecture.md`, `admin-guide/database.md`: each got a canonical-page note pointing at the new page instead; merging is a later follow-up.
- Condensing while moving: the text was moved verbatim first so a sentence-level check could prove nothing was lost.
- Fixing the stale "see CLAUDE.md" source comments (`autoCalculation.ts`, `endpoints.contract.test.ts`) in this change: any `frontend/src/**` edit trips the version-bump gate, and this change is docs-only.

## Watch out
- **Re-verify the pages** after editing `CLAUDE.md` or a page: (1) `mkdocs build --strict` in a venv (`python3 -m venv $TMPDIR/mkdocs-venv && $TMPDIR/mkdocs-venv/bin/pip install -r docs/requirements.txt`); (2) every `](docs/…#anchor)` in `CLAUDE.md` must match an `id="…"` in the built `site/<page>/index.html` (slugs keep code text: `### Gantt architecture (\`src/components/gantt/\`)` → `#gantt-architecture-srccomponentsgantt`); (3) `CLAUDE.md` stays ≤ 7 000 words (`wc -w`); (4) a cross-reference grep on the pages (`see [A-Z]`, `above)`, `below)`, `the … bullet`, `in CLAUDE.md`) finds only links.
- A rule change means editing the rule in `CLAUDE.md` **and** its section in `conventions-in-depth.md`; route, schema, store/hook/util and WS-slice changes update the matching page in the same PR (the sync rows in the Documentation bullet).
- Links from the pages to repo files (`CLAUDE.md`, `UI_GUIDELINES.md`, `scripts/…`, `migrations/README.md`) are GitHub `blob/main` URLs: a relative link outside `docs/` fails the strict build.
- Source comments that still say "see CLAUDE.md, <section>" for sections that moved: `autoCalculation.ts` ("Auto-calculation semantics", now in `frontend-architecture.md` → Gantt architecture) and `endpoints.contract.test.ts` ("the API reference", now `routes.md`); fix them when those files are next touched in a versioned change.
- `UI_GUIDELINES.md` (8 900 words) deserves the same split.
