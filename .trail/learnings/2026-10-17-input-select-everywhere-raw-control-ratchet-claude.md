---
title: "Input/Select everywhere, raw-control ratchet, screenshots without the Docker image (UI PR 3)"
author: Claude
date: 2026-10-17
branch: fix/ui-guidelines-debt-3
cost: { minutes: 46, tokens: 432646 }
touches:
  - UI_GUIDELINES.md
  - docs/assets/screenshots/gantt-main.png
  - frontend/src/components/__tests__/rawFormControls.test.ts
  - frontend/src/components/__tests__/rawFormControlsAllowlist.json
  - frontend/src/components/common/Select/Select.tsx
  - frontend/src/components/common/__tests__/FormControls.test.tsx
  - frontend/src/components/settings/__tests__/EquipmentPanel.test.tsx
  - frontend/src/components/settings/__tests__/PredefinedPhasesPanel.test.tsx
  - frontend/src/components/settings/__tests__/SitesPanel.test.tsx
  - frontend/src/components/settings/panels/AbsenceTypesPanel.module.css
---

## Decided
- Every text-like `<input>` and `<select>` is the shared `Input` / `Select`; the exceptions (inline row-rename editors, the two ARIA comboboxes, the Gantt cell editor, the header SiteSelector, the phone-only Settings section picker, CredentialsModal copy fields) live in `src/components/__tests__/rawFormControlsAllowlist.json`, pinned by `rawFormControls.test.ts` (count may only fall; the allowlist must not name a file that no longer needs it; comments are stripped before counting). Regenerate with a script that mirrors `rawControlCount`, never by hand.
- `Select` got `groups` (labelled optgroups after the flat options) so the site form keeps its country regions. `placeholder` renders a *disabled* option: a selectable "none"/"Select …" entry stays a normal option.
- `color-scheme` is set per theme block in variables.css / themes.css; no component sets it or inverts the calendar-picker indicator.
- Input/Select ids come from `useId()` (a per-render random id churns the label link).
- Screenshots in a cloud session: start `dockerd` detached (`setsid nohup dockerd &`), run `postgres:15-alpine` in a container, the backend from the Python venv with uvicorn, build the frontend and `bash deploy-react.sh`, then **restart uvicorn** (the `/assets` mount is registered only if `public/assets` exists at startup). Capture with `SCREENSHOT_BASE_URL=http://localhost:8485`. Playwright must match the preinstalled Chromium build (1194 → `playwright==1.56.0`), never `playwright install`.

## Tried and ruled out
- Building the Docker image here: processes inside the build cannot trust the session proxy's CA.
- `pkill -f "uvicorn app.main"` from a command that also contains the start command: it kills the shell running it (exit 144). Kill in its own call with a `[u]vicorn` pattern.
- A Python comment-stripping regex with `re.S` on `^\s*//.*$` swallows the rest of the file; use `[\s\S]*?` for block comments and `re.M` only.

## Watch out
- `seed_demo` on a real PostgreSQL: a `$n` used both in an `INSERT … SELECT` list and in `WHERE col = $n` is deduced as text vs varchar and refused. Pass the natural key as separate placeholders (what `_insert_once` does); `test_no_statement_uses_a_placeholder_twice` pins it. The fake-connection tests cannot see this.
- Parallel Bash calls share one shell cwd in this harness: start every command with an explicit `cd` or use absolute paths.
- `init_db` in multi-tenant mode creates only the master DB; `/health` reports `database: "error"` until the `DB_NAME` database exists (create it for a clean probe).
