---
title: "Number field decimals: a separate schema step, model_fields_set for the null reset, half-up rounding mirrored on the decimal string"
author: Claude
date: 2026-10-28
branch: feat/feedback-2
cost: { minutes: 0, tokens: 0 }
touches:
  - app/services/tenant_provisioner.py
  - app/services/tenant_manager.py
  - app/services/project_field_rules.py
  - app/routers/project_fields.py
  - frontend/src/utils/projectFields.ts
  - frontend/src/components/settings/panels/ProjectFieldsPanel.tsx
---

## Decided
- **`project_fields.decimals` is its own step** (`PROJECT_FIELD_DECIMALS_SQL`, an `_add_column_if_missing` DO block with a named `project_fields_decimals_check`), never an edit of `PROJECT_FIELDS_TABLE_SQL`: that text must stay verbatim in `migrations/add_project_fields.sql`. The same DO block sits right after `CREATE TABLE project_fields` in `get_tenant_schema_sql()`, `setup_databases.sql` and the template (`test_project_field_decimals_schema.py` checks the position), and runs as its own auto-migration step after the project-fields step.
- **PUT applies `decimals` whenever it is in `data.model_fields_set`** — `null` is a real value (back to "as typed"). A non-null value on a non-number field is 422; `null` on another type passes (clients send whole fields back).
- **Rounding = `Decimal(repr(v)).quantize(10**-d, ROUND_HALF_UP)` server-side, the same on `String(v)` with a BigInt carry client-side.** Python `round` is half-to-even on the binary double and JS `toFixed(2)` gives 1.00 for 1.005. Doubles ≥ 2**53 are returned as is (no fraction; also keeps `quantize` inside the default 28-digit context near 1e308). The shared `ROUNDING_CASES` tables (`tests/test_project_field_rules.py` ↔ `utils/__tests__/projectFields.test.ts`) are the contract.
- Stored values are never rewritten: the dialog drafts a stored value rounded, and `normalizeStoredValue` rounds the same way, so an untouched value is not re-sent; the site export rounds on output.

## Watch out
- **Adding an always-run auto-migration step shifts every fake-connection log**: `test_project_fields_schema` and `test_teams_schema_sources` fakes had to learn the new statement (else it logs an extra ROLLBACK), and `test_tenant_manager_more` counts COMMITs (legacy 24 → 25, current 7 → 8).
- `validate_field_values` now selects `(id, name, field_type, decimals)`: the `FIELDS` row fixtures in `test_project_field_values.py` / `test_projects_field_values_routes.py` build 4-tuples (`decimals={id: n}` keyword).
