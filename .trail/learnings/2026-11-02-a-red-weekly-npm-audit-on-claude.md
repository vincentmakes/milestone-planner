---
title: "A red weekly npm audit on the ESLint chain is fixed with a plain override to the patched major, not by waiting for upstream"
author: Claude
date: 2026-11-02
branch: fix/minimatch-audit
cost: { minutes: 1, tokens: 1724 }
id: l-a94aeb04
scope: repo
status: active
src: agent
touches:
  - frontend/package.json
  - ".github/workflows/frontend.yml"
---

## Decided
- The weekly scheduled Frontend CI run can go red with no code change: a new advisory lands on an unchanged lockfile. This one (GHSA-g3hv-75wg-m249, minimatch < 11.0.1, moderate) had no backport to 10.x, and every consumer (eslint, @eslint/config-array, @eslint/eslintrc, typescript-estree), even at its latest release, still asks for minimatch ^10. Bumping the toolchain therefore cannot fix it; only an override can.
- Use a plain-name override, not a version-qualified selector: `"minimatch@3": ...` left typescript-estree's nested 9.x copy in place, while `"minimatch": "^11.0.4"` collapses the lockfile to one copy.
- Before forcing a new major on a transitive dep, unpack the new and old versions plus each consumer at its locked version (`npm pack` into the scratchpad), diff the exported names and grep the consumers for what they use. minimatch 11 dropped `makeRe` and `AST`; the toolchain uses only the `Minimatch` class, `minimatch()` and `flipNegate`.

In the code: `frontend/package.json` overrides `"minimatch": "^11.0.4"`; the gate is `npm audit --audit-level=moderate` in `.github/workflows/frontend.yml` (job Audit, cron Mondays 06:17 UTC).

## Tried and ruled out
- `--omit=dev` or lowering `--audit-level`: the repo rule is that a red Audit job is fixed at the pin.
- Upgrading eslint / typescript-eslint: their newest versions still pin minimatch ^10.

## Watch out
- A grep for `makeRe` in eslint matches `makeReturn()`. Check each hit before concluding an API is used.
- The real compatibility proof is `npm run lint` run after `npm run build`: the warning count stays the same and nothing under `dist/` is linted, which shows the flat-config ignore globs still match.
- Cloud containers default to Node 22; Node 24 is at `/opt/node24/bin`. Prepend it to PATH before `npm install`, or the lockfile is written by npm 10 instead of 11.
- When upstream eslint moves to minimatch 11 itself, this override can go.
