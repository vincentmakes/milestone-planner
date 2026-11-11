---
title: "Help opens the Documentation URL exactly as entered, nothing appended; validation keeps only what makes the link safe"
author: Claude
date: 2026-11-11
branch: claude/help-link-dashboard-calculations-2
id: l-c1a8c54b
scope: repo
status: active
src: agent
touches:
  - CHANGELOG.md
  - app/services/instance_settings.py
  - docs/admin-guide/hosting-the-documentation.md
  - docs/developer-guide/api-reference.md
  - docs/developer-guide/codebase-map.md
  - docs/developer-guide/frontend-architecture.md
  - docs/developer-guide/routes.md
  - docs/print-templates/cover_page.tpl
  - docs/stylesheets/print.css
  - docs/user-guide/getting-started.md
---

## Decided
Help in the user menu opens the `help_url` setting exactly as stored (trimmed), with nothing appended, from every view. An organisation may point Help at the manual's PDF on SharePoint, whose link carries a query string (`?csf=1&web=1&e=…`) and a `#page=` fragment; appending a chapter path or a slash breaks such a link. The validation (server `_help_url`, client `safeHelpUrl`) keeps only what makes an `<a href>` safe: http/https, a host, no `user:password@`, no whitespace or control character, at most 2000 characters. "How calculations work" opens the custom address as is, and the public calculations chapter only when no custom address is set (`calculationsHelpUrl(customHelpUrl(settings))`; the public manual's own address counts as no custom one).

## Tried and ruled out
- A chapter per view (`HELP_PAGES` / `helpUrl(view, base)`): it only works for a copy built with the same folder structure, never for a PDF or any other single address.
- Canonicalising the address (lower-cased scheme and host, exactly one trailing slash, query and fragment refused): it rewrote valid links and refused SharePoint ones.

## Watch out
Server and client must stay the same rule (tests on both sides share the SharePoint-style case, 2000 accepted / 2001 refused). The Settings field shows the address as stored, so the panel's dirty check is a plain trimmed comparison.

In the code: app/services/instance_settings.py `_help_url`, `MAX_HELP_URL_LENGTH`; frontend/src/utils/instanceSettings.ts `safeHelpUrl` / `customHelpUrl` / `helpAddress`; frontend/src/utils/helpLinks.ts `calculationsHelpUrl`.
