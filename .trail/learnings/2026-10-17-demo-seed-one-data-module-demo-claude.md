---
title: "Demo seed: one data module (demo_data.py) + a guarded loader; screenshot extras folded in"
author: Claude
date: 2026-10-17
branch: feat/demo-seed-refresh
cost: { minutes: 9, tokens: 57571 }
touches:
  - CHANGELOG.md
  - CLAUDE.md
  - README.md
  - VERSION
  - docs/admin-guide/installation.md
  - docs/index.md
  - scripts/screenshots/README.md
  - scripts/screenshots/capture_collab.py
  - scripts/screenshots/seed_extras.sql
  - tests/test_demo_data.py
---

## Decided
- The demo tenant's data lives in `app/scripts/demo_data.py` as plain dicts keyed by names (e-mails, project/phase/equipment/tag names) with every date relative to `today`; `build_demo(today)` is pure and tested without a DB (`tests/test_demo_data.py`: referential integrity, single-select tags, site-restricted tags, card_status pairs, dependency `entity` + no cycles, PM site membership, `[R:…]` pattern, mention placeholders, ordered ranges, holiday years).
- `seed_demo.insert_demo_data(conn, demo)` resolves names → ids with `INSERT … SELECT … WHERE NOT EXISTS` + `SELECT id` per row (`_insert_id` / `_insert_once`), so a partially seeded DB is completed, never duplicated; dependencies are written only where empty; comment bodies use `{mention:<email>}` placeholders that become `@[Full Name](id)` and `mentioned_user_ids` comes from `parse_mention_ids(body)`. `tests/test_seed_demo.py` runs it against a recording asyncpg fake (every INSERT guarded, FK order, ids, JSON, read_at).
- `scripts/screenshots/seed_extras.sql` is gone; the pipeline is seed_demo alone. `capture_collab.py` looks the Catalyst phase up and restores its dates in `finally` instead of PUTting hard-coded 2026 dates on phase 8.
- Bank holidays are static rules (`easter_sunday`, `swiss_holidays` ZH, `german_holidays` HE) for this year and next — no Nager call in the seed.
- Kept the skip-if-seeded check (no `--reset`, user decision: a fresh Codespace is enough).

## Tried and ruled out
- Keeping SQL in the screenshot pipeline: hard-coded ids (staff 2–5, site 1) and fixed 2026 dates went stale within months.

## Watch out
- `ruff check tests/` has pre-existing failures in old test files (import order / unused imports); CI lints `app/` only. Don't "fix" them in an unrelated PR.
- `tests/test_init_db.py` has its own `FakePg`; the seed tests use a separate `RecordingConn` because the loader only needs execute/fetchval.
