---
title: "The manual PDF prints unhinted glyphs, and a screenshot too tall to shrink goes after the text that follows it"
author: Claude
date: 2026-11-11
branch: claude/help-link-dashboard-calculations-2
id: l-71590123
scope: repo
status: active
src: agent
touches:
  - ".github/workflows/manual-pdf.yml"
  - docs/admin-guide/hosting-the-documentation.md
  - scripts/docs/export_manual_pdf.py
  - tests/test_export_manual_pdf.py
---

## Decided
GitHub's Manual PDF build differed from local runs because its Chromium hinted the glyphs: every glyph origin sat on a whole CSS pixel (0.75 pt) and advances were rounded, so body text ran about 3-4 % wider (one line of page 4 already broke differently) and page 103 ended 40 % early before "Team Filter". Same Chromium (m153), same web fonts (Roboto, Roboto Mono) and the same embedded fallback fonts on both sides; `--font-render-hinting=full` locally reproduced GitHub's page 103 word for word. The export now launches Chromium with `--font-render-hinting=none` and logs whether the glyph positions are on the pixel grid. The workflow installs the fallback fonts by name (fonts-dejavu-core, fonts-liberation).

The fitter escalates for a kept group (heading, introduction, screenshot) that does not fit: shrink the screenshot down to 65 % of its print height (MAX_SHRINK 0.35, the legibility floor: UI text in the screenshots is already about 5 pt at full print size); beyond that, move the screenshot after the text that follows it in its section (only to the end of a block that does not end with a colon, never past the next heading or picture), so the page fills and the picture opens the next one; only then fail, with a remedy for that case (crop the screenshot, or move a paragraph after it).

## Tried and ruled out
- Blaming fallback fonts: both PDFs embed the same DejaVu and Liberation fonts; the first difference is in plain Roboto text.
- Changing fontconfig hinting (hintslight/hintfull): Chromium's PDF glyph positions did not change; only the --font-render-hinting switch did.
- A hand-placed break in the Markdown for page 103: it would hide the weakness for the next text change.

## Watch out
Prove a layout change with `--family` (default, hinted, system fonts, text ±2 %, letter spacing ±1 %, hinted with text +2 %), not with one lucky run. The exact reason the runner's headless Chromium defaulted to hinting was not identified; the explicit switch makes it irrelevant.

In the code: scripts/docs/export_manual_pdf.py `figure_moves`, `MOVE_FIGURE`, `ROBUSTNESS_FAMILY`, `export_family`, `snapped_share`; .github/workflows/manual-pdf.yml.
