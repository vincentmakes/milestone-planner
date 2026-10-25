# Working on this repo with AI agents

How feature work is run with AI agents on this repository: the shape of a round, which model does what, what to verify and when, and the small habits that keep the cost down. It is process, not code; the rules for the code stay in `CLAUDE.md`.

## The round

A round is one plan carried out in this order:

1. **Plan.** One document that lists the tasks, their order and the rulings.
2. **Critique.** A read-only review of the plan before it is approved.
3. **Implementation tasks.** One agent at a time on the shared working tree; each task ends with a report and its own commits.
4. **Whole-branch review.** A read-only review of the full diff against the base.
5. **One fix wave.** Everything the review found, batched into a single task.
6. **The finishing menu.** Keep the branch, merge it locally, or open a PR.

The artifacts live in `.superpowers/sdd/<plan>/` (git-ignored): the ledger `progress.md`, one brief and one report per task, and the review packages. There is **one plan artifact**: the plan copy in that workspace. Briefs point at page **headings** (`routes.md`, "Assignments"), never "read the whole page".

## Model routing

| Work | Model |
|------|-------|
| Plan, critique, whole-branch review | The most capable |
| Engine, state-machine, security and schema tasks | The most capable |
| Wiring, docs, seed data, renames, CSS polish | A mid-tier model |
| Fix waves made of nits | A mid-tier model |
| Per-task review | Only after an engine, security or state-machine task; the whole-branch review is the gate for everything else |

## Verification policy

| When | What |
|------|------|
| While iterating | Only the touched tests: `npx vitest related --run <files>` or `npx vitest run --changed <ref>` in `frontend/`, `pytest <file>` from `tests/` on the backend |
| End of a frontend task, once | The full suite, `npm run test:coverage`, `npm run lint`, `npm run build` |
| End of a backend task, once | The full suite, `ruff check app/ && ruff format --check app/`, `mypy app/` |
| Per round | **One** Docker rebuild in place and **one** Playwright pass; none for polish unless a screenshot is wanted |
| Docs | `mkdocs build --strict`, only when `docs/` or `mkdocs.yml` changed |

Coverage floors are raised, never lowered.

The two frontend commands are Vitest's dependency-aware runs, from `frontend/`:

- `npx vitest related --run src/utils/date.ts src/components/Foo.tsx` runs the tests that import the given source files (without `--run` it would sit in watch mode).
- `NODE_OPTIONS=--no-experimental-webstorage npx vitest run --changed origin/main` runs the tests affected by the files changed since a git ref (no ref means the uncommitted changes). It calls git, so in the sandbox prefix it with `GIT_CONFIG_GLOBAL=/dev/null`. A change to `package.json` itself re-runs everything.

## Agent reuse

Resume the previous implementer for the next related task: its context and prompt cache are still warm. A fresh agent re-reads `CLAUDE.md`, the reference pages and the code before it can start.

## Batch follow-ups

Collect nits and review findings into the fix wave. One agent per nit is the most expensive pattern there is.

## The brief template

```text
Goal: <one line>.
Read first: <path to the brief> — it is your requirements, with the exact values.
Interfaces and rulings from earlier tasks: <names, signatures, decisions>.
Do not touch: <paths>.
Report: write it to <path>.
Return: status, commits (hash + subject), a one-line test summary, concerns.
```

## Sandbox notes

These cost agents time:

- `GIT_CONFIG_GLOBAL=/dev/null` on every git command, and on `vitest --changed`, which calls git.
- Backend tests run from `tests/` with `-p no:cacheprovider --ignore=../.env`.
- Vitest needs `NODE_OPTIONS=--no-experimental-webstorage`.
- Docker and local ports need the sandbox off.
- Never `docker compose down -v` unasked: it deletes the demo's data.
- Never the user's connected Chrome: use headless Playwright from its own venv.
- `mkdocs` lives in a venv under `$TMPDIR` (`python3 -m venv $TMPDIR/mkdocs-venv && $TMPDIR/mkdocs-venv/bin/pip install -r docs/requirements.txt`).
- Three backend tests fail locally and pass in CI: two site-export tests (`openpyxl` is missing from the local Python) and `test_unknown_api_route_returns_404` (it depends on the working directory). Do not chase them.
- The commit footer follows **Commit & PR conventions** in `CLAUDE.md`.

## Costs seen

The auto-loaded `CLAUDE.md` is the fixed cost of every agent, so it stays short and the detail lives in the reference pages. `UI_GUIDELINES.md` is the next file worth splitting the same way.
