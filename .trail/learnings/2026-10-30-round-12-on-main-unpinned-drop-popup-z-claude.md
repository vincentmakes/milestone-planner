---
title: "Round-12 scale cherry-picked onto main (2.2.0); the resource drop is unpinned through an `unpinned` flag; an overlay that can sit under a dialog stays below --z-modal-backdrop"
author: Claude
date: 2026-10-30
branch: feat/feedback-3
cost: { minutes: 0, tokens: 0 }
touches:
  - CHANGELOG.md
  - UI_GUIDELINES.md
  - docs/developer-guide/conventions-in-depth.md
  - frontend/src/styles/__tests__/fontSizeTokens.test.ts
  - frontend/src/hooks/useHeaderDensity.ts
  - app/routers/assignments.py
  - frontend/src/components/gantt/Timeline/ResourceDropOverlay.tsx
  - frontend/src/components/gantt/Timeline/DependencyPopup.tsx
  - frontend/src/components/gantt/Timeline/DependencyPopup.module.css
  - app/routers/export.py
---

## Decided
- **Round 12 (96e4dc6, 8a03d17, 39d5658 of feat/dashboards) cherry-picked with `-x` onto origin/main 790e1ec.** Real conflicts only in CHANGELOG.md (their context was the dashboards 2.2.0 block: the one round-12 line was rewritten by hand under a new `## [2.2.0] - 2026-10-30`), conventions-in-depth.md (Icons paragraph: main links `UI_GUIDELINES.md` plainly, dashboards with a GitHub URL — kept main's link) and UI_GUIDELINES.md (Compact scale paragraph, commit 3). Every other file applied byte-for-byte (checked by comparing each file's +/- lines with the source commit).
- **Dashboards-only words that auto-merged cleanly had to be fixed by hand**: the view is "Staff Overview" on main ("Staff & Calendar" is a dashboards rename) in UI_GUIDELINES, conventions-in-depth, global.css and the fontSizeTokens test header; "pre-2.1" / "the 2.1 type scale" / "Before 2.1" comments became 2.2. The two cherry-picked learnings were left untouched (they say `branch: feat/dashboards` and "Staff & Calendar").
- **fontSizeTokens.test.ts sanity floor** `files.length > 100` failed on main (98 stylesheets without the dashboards ones): lowered to 90 in a fixup folded into the first pick. It is a scanner sanity check, not a ratchet.
- **`unpinned: bool = False` on the phase / subphase staff create** (`SegmentCreateDates`, a 422 validator beside `_both_dates_or_neither`). `_plan_create(..., unpinned)` calls `plan_placement(link_first=not unpinned)` and files `placement=None if plan.first and unpinned else AUTO_PLACEMENT`, exactly the Kanban rule (learning 2026-10-28-unpinned-first-booking). The dateless dialog path ("Follow the phase dates") keeps `unpinned=False` and stays linked. The project-level POST ignores the field (pydantic default `extra="ignore"`), pinned by a schema test.
- **Dependency delete has no confirm** (Vincent's decision): the popup is the second step already. The popup reads `--z-dropdown`; the bug was a raw `z-index: 2000` above `--z-modal` (1001) while `useDismissableOverlay` keeps an overlay open during a pending confirm, so the confirm drew under the popup and its live button queued a second confirm.
- **Export number formats**: `_number_cell(value, decimals)` returns a `_FormattedNumber(value, "0.0")` that `add_sheet` writes as the value and then stamps `cell.number_format`; As typed keeps the int-collapse and General.

## Tried and ruled out
- Raising the Vitest floors: the file's own rule is "0.3 under the local totals"; the local totals (lines 93.16, statements 92.14, functions 93.59, branches 84.29) give floors below the current ones, so they stay.

## Watch out
- **An overlay that can be open while a dialog is up must sit below `--z-modal-backdrop`** (UI_GUIDELINES §2.11): a popover that opens `confirmAction` stays open under the confirm by design.
- When feat/dashboards is rebased next, drop the three round-12 commits from its sequence (`git rebase --onto`), renumber its 2.2.0 to 2.3.0, and expect its CHANGELOG / UI_GUIDELINES context to differ from main by the Staff Overview naming.
- `add_sheet` stamps formats with `ws.cell(row=..., column=...)` only for `_FormattedNumber` values, never `ws.max_row`: the fake sheets of `test_export_formula_injection.py` / `test_tags_groups.py` have no `max_row` (only those two failed, and only in the full suite).
- `trail check` flags `app/routers/export.py` "brings back round decimal" (the 2026-10-29 learning on rounding a pasted value on blur): a keyword match; the export has rounded stored values for display since 2.1.0, and nothing on the typing gate changed.
- `trail note` is EPERM in the sandbox; this file was written by hand.
