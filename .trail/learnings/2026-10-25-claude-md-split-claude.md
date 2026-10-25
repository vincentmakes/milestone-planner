---
title: "CLAUDE.md split (2.1.0 round 6): a ≤ 7 000-word core of rules, the reference moved verbatim into seven Codebase Reference pages"
author: Claude
date: 2026-10-25
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
  - mkdocs.yml
  - tests/test_rbac_schema_sources.py
  - tests/test_teams_schema_sources.py
---

## Decided
- **Detail goes to the page, the rule stays in the core.** `CLAUDE.md` (36 000 words before, auto-loaded by every agent) keeps only what an agent must obey or needs to find things: the conventions as rules, the checklists, Quick Start, Common Commands, a Start-here table naming page *headings*, the Gotchas, the Reference pages list. A sentence that says must / never / always / keep / don't is a rule; everything describing how things work moved.
- **Old section → page** (moved verbatim, then condensed only in the core):
  - Architecture Overview, Terminology, Project Structure, Environment Variables, Import & Export, Docker & Deployment, CI → `docs/developer-guide/codebase-map.md`
  - Database Schema + Migrations → `database-schema.md`
  - API Reference → `routes.md` ("Route auth gates and side effects")
  - Authentication / Sessions / SSO, Multi-Tenancy Internals, Security → `auth-and-tenancy.md`
  - Real-Time Collaboration → `realtime.md`
  - Frontend Architecture + What-If Mode → `frontend-architecture.md`
  - the full text of every long rule bullet (backend / frontend permission gates, broadcast tiers, approval workflow, change notifications, booking segments, metric matrix, store ownership, lazy Dashboards view, What-If exemptions, errors and confirmations, icons, overlays, form fields), the shared-test-helper catalogue and the Documentation Screenshots pipeline → `conventions-in-depth.md`; the core keeps each as rule + invariant + a link to its section.
- Rules that lived in the moved sections were carried into the core as one-liners (no FK on `custom_column_values` / `card_comments`, data fixes in the `tenant_provisioner` constants, widget kinds / notification types appended last, no `DB_*` fallthrough, `destroy_user_sessions`, unauthenticated `GET /settings`, nothing more on `/health`, the two WS `case`s, no query library / router, `partialize` ↔ `merge`, `allocation` on staff updates, dependency `entity`, Gantt section class names, What-If create blocking, the site-export contract, `== 'true'` in the workflows, tenant vs portal `admin`).
- `mkdocs.yml` has `validation: {anchors: warn}`, so `mkdocs build --strict` fails on a dead `page.md#anchor`. The two schema-source tests now assert the migration name in `database-schema.md`, not in `CLAUDE.md` (schema-change checklist item 7).

## Tried and ruled out
- Merging the new pages with `api-reference.md`, `architecture.md`, `admin-guide/database.md`: each got a canonical-page note pointing at the new page instead; merging is a later follow-up.
- Condensing while moving: the text was moved verbatim first so a sentence-level check could prove nothing was lost.

## Watch out
- **Re-verify the pages** after editing `CLAUDE.md` or a page: (1) `mkdocs build --strict` in a venv (`python3 -m venv $TMPDIR/mkdocs-venv && $TMPDIR/mkdocs-venv/bin/pip install -r docs/requirements.txt`); (2) every `](docs/…#anchor)` in `CLAUDE.md` must match an `id="…"` in the built `site/<page>/index.html` (slugs keep code text: `### Gantt architecture (\`src/components/gantt/\`)` → `#gantt-architecture-srccomponentsgantt`); (3) `CLAUDE.md` stays ≤ 7 000 words (`wc -w`); (4) a cross-reference grep on the pages (`see [A-Z]`, `above)`, `below)`, `the … bullet`, `in CLAUDE.md`) finds only links.
- A rule change means editing the rule in `CLAUDE.md` **and** its section in `conventions-in-depth.md`; route, schema, store/hook/util and WS-slice changes update the matching page in the same PR (the sync rows in the Documentation bullet).
- Links from the pages to repo files (`CLAUDE.md`, `UI_GUIDELINES.md`, `scripts/…`) are GitHub `blob/main` URLs: a relative link outside `docs/` fails the strict build.
- Some source comments still say "see CLAUDE.md, <section>" for sections that moved (e.g. `autoCalculation.ts` → "Auto-calculation semantics", now in `frontend-architecture.md`); fix them when the file is next touched.
- `UI_GUIDELINES.md` (11 700 words) deserves the same split.
