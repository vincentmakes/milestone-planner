---
title: "Weekends flag read case-insensitively on both sides (2.5.0 fix wave)"
author: Claude
date: 2026-11-06
branch: feat/weekends-and-polish
id: l-8b5b78b6
scope: repo
status: active
src: agent
touches:
  - frontend/src/utils/instanceSettings.ts
  - app/services/instance_settings.py
---

## Decided
- `selectWeekendsWorking` now reads `weekend_working_days?.trim().toLowerCase() === 'true'`, the same as the backend's `weekends_working_from` (`value.strip().lower() == "true"`). This supersedes the `=== 'true'` in the 2026-11-06 "Weekends are working days" learning. Before, a hand-written `True` row counted weekends in the dashboards but not in the Staff heatmap. The flag is still **not a switch**: a missing or stray row reads as off.

## Watch out
- The PUT only ever stores `true` / `false`, so the mismatch needed a hand-edited row. Keep the two reads identical anyway: they are two halves of the working-day mirror.
