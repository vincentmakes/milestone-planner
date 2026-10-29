---
title: "projects.volume is REAL on provisioned tenants, so an echoed volume must compare in its format"
author: Claude
date: 2026-10-29
id: l-ee5443c9
scope: repo
status: active
src: agent
touches:
  - app/routers/projects.py
  - app/services/change_notifications.py
---

## Decided
- `PUT /projects/{id}` keeps the stored `volume` when `round_field_number(stored, decimals)` equals the rounded value sent. `get_tenant_schema_sql()` and the template create `volume REAL` (float4) while `setup_databases.sql` has `FLOAT`: on a provisioned tenant 12.7 reads back as 12.699999809265137, the dialog shows and sends 12.7, and without the check every dialog save changed the volume and sent the PM a `project_changed` "volume 12.699999809265137 → 12.7" (`change_notifications` compares before/after exactly).

## Watch out
- Found on the fb2demo stack, not in the mock tests: the mocks hold Python floats. `test_echoing_a_float4_volume_notifies_nobody` pins it. Widening the column to DOUBLE PRECISION would be the real fix (a schema change across every DDL source), left as a follow-up.
