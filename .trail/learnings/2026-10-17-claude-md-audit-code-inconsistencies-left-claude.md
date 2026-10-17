---
title: "CLAUDE.md audit: code inconsistencies left as follow-ups"
author: Claude
date: 2026-10-17
branch: chore/fsl-license-readme-badges
cost: { minutes: 60, tokens: 435181 }
touches:
  - CLAUDE.md
  - app/config.py
  - migrations/run_migration.py
  - docker-compose.fresh.yml
  - migrations/upgrade_to_v90.sql
  - ".github/workflows/version-check.yml"
  - frontend/src/contexts/KanbanDragContext.tsx
  - frontend/src/components/gantt/utils/autoCalculation.ts
---

## Decided
CLAUDE.md was re-audited against the code after 1.6.0 (structure tree, API reference, schema, env vars, stores, hooks, utils). Doc-only: these code inconsistencies were documented in CLAUDE.md (Gotchas / env table) but NOT fixed, because each changes behaviour and needs its own PR + version bump.

## Watch out
- MASTER_DB_NAME: app/config.py defaults to milestone_master; run_migration.py, run_migration_master.py, migrate_all_tenants.sh and docker-compose.fresh.yml default to milestone_admin.
- SSO_* settings in app/config.py are read nowhere (dead).
- migrations/upgrade_to_v90.sql adds predefined_phases.is_system/color, which no model or schema has.
- version-check.yml paths-filter runs in REST mode (no token: ""), unlike the other workflows.
- KanbanDragContext open-codes the persist-failure protocol (loadAllProjects + undo clear) instead of recoverFromPersistFailure; loadAllProjects is a What-If no-op.
- autoCalculation.ts header still says dependents cascade on move; they do not (processPhaseMove/processSubphaseMove never cascade).
- TanStack Query provider is configured but nothing uses useQuery/useMutation; clsx is an unused dependency.
- WebSocketContext getChangesForEntity/isRecentlyChanged and useWebSocket isChangeRecent/getChangeInfo have no consumers.

## How to re-verify CLAUDE.md
Scripts used: resolve every backticked path; match every @router decorator against the API Reference (…/{id} shorthand covers sub-routes); require every module stem in app/{models,routers,services,middleware,websocket} and frontend/src/{hooks,utils,stores,contexts,api/endpoints,components/gantt/utils} to appear; check markdown table cell counts.
