---
title: "Help opens the manual from the profile menu; the manual's address is a setting; the PDF comes from a print page, published on a rolling pre-release (2.6.0)"
author: Claude
date: 2026-11-11
branch: claude/help-link-dashboard-calculations
id: l-343b32ce
scope: repo
status: active
src: agent
touches:
  - ".github/workflows/manual-pdf.yml"
  - docs/developer-guide/codebase-map.md
  - frontend/src/utils/instanceSettings.ts
  - app/services/instance_settings.py
  - frontend/src/utils/helpLinks.ts
  - frontend/src/components/settings/panels/DefaultsPanel.tsx
  - docs/admin-guide/hosting-the-documentation.md
  - mkdocs.yml
  - docs/hooks/manual_version.py
  - docs/stylesheets/print.css
---

## Decided
- **Help is a link in the profile (user) menu**, opening the online manual in a new tab at the chapter of the current view; the user chose it over an embedded side panel.
- **The manual's address is a setting** (`help_url`, Settings → Features & defaults), prefilled with the public site, so an organisation can host the manual internally. The value lands in an `<a href>`, so only http/https addresses with a host are accepted — on the server and again in the browser, which falls back to the public manual for a bad stored row.
- **How to host the manual is a page of the manual** (Admin Guide): Azure Static Web Apps as the worked example ("Azure Pages" does not exist; Static Web Apps is the equivalent), an Azure Storage static website as the simpler option, any static host otherwise. The Azure commands were checked against learn.microsoft.com.
- **PDF = a print page + headless Chromium in CI.** The pure-Python print-site plugin builds one page with the User Guide and Admin Guide (cover with the version, contents); GitHub Actions prints it on every merge to main that changes the manual or the version and replaces one file on the rolling pre-release `manual-latest`. "Every merge to main" over "only on releases": the repo publishes no regular GitHub releases (last tag v2.0.0 while main was at 2.5.1), so a release-only PDF would lag.
- **Dashboards 2.6.0**: Utilisation takes the project filters on its booked side only (capacity stays the people in scope); a "Has a customer" filter; "Show as % of target" (client-side); a gauge target can be a goal (red, amber within 15 % below, green from it) because an absorption target is something to reach, not a limit; calculated widgets divide two summed or counted measures (KPI, gauge, bar/line by period), zero denominators as `ratio_percent`.

## Tried and ruled out
- An embedded help side panel (iframe): dropped at the user's request; a plain link is enough.
- Bundling the manual into the Docker image for offline use: not wanted; self-hosting plus the setting covers it.
- PDF plugins that render at build time (WeasyPrint-based or Chromium-based exporters): Cloudflare Pages builds the site with `pip install` only — no system libraries, no browser.
- A free-form formula language for widgets: every term would need its own validation, permission check and frontend mirror; "A divided by B" covers the need.
- Excluding the Developer Guide by nav surgery: the print-site plugin cannot exclude a nav section (it keeps the emptied section heading and numbers excluded items), so `exclude:` drops the pages, `enumerate_headings` is off, and a `:has()` rule in the print stylesheet hides sections with no page left and their contents entries.
- Plugin 2.9: only two months old and caps `mkdocs<=1.6.1`; 2.8 (Aug 2025, needs material>=7.3) works with MkDocs 1.6.1 / Material 9.8.1.

## Watch out
- The "Download the manual as PDF" link works only after the PDF workflow's first run on main; the workflow could not be exercised outside GitHub.
- The print page leaves out the Developer Guide and the Release Notes on purpose.
- The `manual-latest` tag stays on the commit of its first release; only the asset and the notes are replaced.
- `help_url` is per workspace; `GET /settings` is public, so never put anything secret there.
- Screenshots are `loading=lazy`: the export script forces them eager and waits for them, or they print blank.
- Material 9.8's copy button is `.md-code__nav` / `.md-code__button`, not `.md-clipboard`.

## In the code
- `app/services/instance_settings.py` `_help_url`, `DEFAULT_HELP_URL`; `frontend/src/utils/instanceSettings.ts` `normaliseHelpUrl` / `helpBaseUrl`; `frontend/src/utils/helpLinks.ts` `helpUrl(view, base)`; `frontend/src/components/settings/panels/DefaultsPanel.tsx` (Documentation URL).
- `docs/admin-guide/hosting-the-documentation.md`; `mkdocs.yml` `print-site` (last plugin, `exclude: [index.md, developer-guide/, release-notes.md]`), `docs/hooks/manual_version.py` (/VERSION → `config.extra.version`), `docs/print-templates/`, `docs/stylesheets/print.css`.
- `scripts/docs/export_manual_pdf.py --site-dir site --output Milestone-Manual.pdf` (Playwright 1.63.0 matches the preinstalled Chromium 1243 here); `.github/workflows/manual-pdf.yml`.
- Dashboards: `app/services/metrics.py` (`MEASURE_FILTER_OVERRIDES["utilisation"]`, `_project_attributes_pass`, `DIVISIBLE_MEASURES`, `divisor_query`, `_ratio_result`), `app/schemas/dashboard.py` (`DivideBy`, `DivisorFilters`, `WidgetOptions.percent_of_target` / `target_is_goal`), `charts/toOption.ts` `gaugeScale(…, isGoal)` / `percentOfTargetScale`, `builder/FilterSection.tsx`.
