---
title: "Calculated widgets use a formula typed in one field with measure pills, reversing the earlier divide-only decision (2.6.0)"
author: Claude
date: 2026-11-11
branch: claude/help-link-dashboard-calculations-2
id: l-a6681f7e
scope: repo
status: active
src: agent
touches:
  - CHANGELOG.md
  - CLAUDE.md
  - UI_GUIDELINES.md
  - docs/admin-guide/database.md
  - docs/assets/screenshots/dashboard-builder.png
  - docs/assets/screenshots/dashboard-share.png
  - docs/assets/screenshots/dashboards.png
  - docs/developer-guide/api-reference.md
  - docs/developer-guide/codebase-map.md
  - docs/developer-guide/conventions-in-depth.md
---

## Decided
- The 2.6.0 learning "Help opens the manual…" ruled out a free-form formula language ("A divided by B covers the need"). That is reversed. Users wanted their absorption formula: customer weeks / (capacity weeks × 70 %), and more than a division. The divide-only model was replaced before 2.6.0 merged, so no saved widget ever had the old shape and only one model exists.
- The stored query keeps named terms (`formula: {expression, terms[{name, measure, filters, total}], result}`). The engine runs one pass per term and evaluates on the server only. Terms are internal: the editor never shows term names.
- The editor is ONE formula field: a real textarea over a mirror that paints measure pills, the MentionTextarea technique. Pills are anchors carried through edits by the mention field's `diffEdit`. A pill's text includes its filters ("Booked weeks · Has a customer"). Clicking a pill opens its filters. Field ↔ formula conversion names terms a, b, … by first appearance, and equal pills share a term.
- A capacity term makes booking terms read the people side, like Utilisation, so booked_days / capacity_days == utilisation for every breakdown.
- The seeded absorption gauge is added once to existing instances, with a `_internal.` settings marker so that a deletion is final.

## Tried and ruled out
- A list of term rows (name, measure, filters, total switch, add/remove, operator buttons, chips). The user found it far too many steps for a business user. It was replaced by the single field.
- contenteditable for the field: caret, undo, paste and IME break. Portaling the suggestion list: the editor is a Modal, so the list and the filter panel render inline.

## Watch out
- The grammar and messages are a mirror contract: formula.py ↔ utils/formula.ts, shared FORMULA_CASES with a length pin. The field's own messages (did-you-mean, "Something is missing after ÷") are client-only wording over the same parser.
- While a word is a prefix of a measure name the user is still typing. That is not an error: no red, a neutral hint, and the preview note says "Updates when the formula is complete".
- A pie, treemap or sankey must never offer a formula, because their values must add up. A table never sums formula rows.

In the code: app/services/formula.py, app/services/metrics.py (_formula_result, query_parts, capacity_weeks), app/schemas/dashboard.py (_check_formula), app/services/dashboard_seed.py, app/services/tenant_data_migrations.py (add_absorption_example), frontend/src/utils/formula.ts, frontend/src/utils/formulaField.ts, frontend/src/components/views/DashboardsView/builder/FormulaField.tsx and CalculationSection.tsx.
