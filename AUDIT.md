# Codebase Audit & Optimization Plan

**Date**: 2026-02-26
**Scope**: Full-stack audit — backend (Python/FastAPI), frontend (React/TypeScript), infrastructure (Docker, CI, migrations)

---

## Executive Summary

The codebase has a solid multi-tenant architecture foundation, but suffers from significant code duplication (both backend and frontend), monolithic files, inconsistent patterns, and missing performance optimizations. Below is the full diagnostic organized by severity, followed by a prioritized remediation plan.

---

## PART 1: DIAGNOSTIC

---

### A. BACKEND (Python / FastAPI)

#### A1. Code Duplication — Response Builders (HIGH)

Multiple routers implement near-identical `build_*_response()` helper functions that manually convert ORM objects to dicts:

| Location | Pattern |
|----------|---------|
| `app/routers/users.py:29-85` | `build_user_response()` — manual dict from User |
| `app/routers/staff.py:35-60` | `build_staff_response()` — same pattern |
| `app/routers/equipment.py:124-135` | `build_equipment_response()` — same pattern |
| `app/routers/vacations.py:26-41` | `build_vacation_response()` — same pattern |
| `app/routers/notes.py:24-38` | `build_note_response()` — same pattern |

**Fix**: Create a shared response builder utility or use Pydantic `model_dump()` with `response_model` on route decorators consistently.

#### A2. Duplicated User/Site Relationship Queries (HIGH)

Repeated across `users.py`, `staff.py`, `vacations.py`:
```python
sites = user.sites if hasattr(user, "sites") and user.sites else []
sorted_sites = sorted(sites, key=lambda s: s.id)
site_ids = [s.id for s in sorted_sites]
site_names = [s.name for s in sorted_sites]
```

**Fix**: Add a helper method to the User model (e.g., `get_sorted_site_info()`).

#### A3. Staff Name Building (MEDIUM)

Repeated in `vacations.py:29-30`, `notes.py:26-27`, `staff.py:48-52` — manually concatenating `first_name + last_name`. The User model already has a `full_name` property at `user.py:107-109`.

**Fix**: Use `user.full_name` consistently everywhere.

#### A4. N+1 Query Problem (HIGH)

`app/routers/notes.py:68-79` — iterates over notes and executes a separate query per note to load related staff:
```python
for note in notes:
    if note.staff_id:
        staff_result = await db.execute(select(User).where(User.id == note.staff_id))
```

**Fix**: Use `selectinload(Note.staff)` on the initial query.

#### A5. Missing Eager Loading (MEDIUM)

Several routers lack `selectinload()` for common relationships:
- `equipment.py:145+` — Equipment list doesn't eager-load Site
- `projects.py:241-246` — Project detail doesn't eager-load all needed relationships
- Various site-related queries

#### A6. Oversized Router Files (HIGH)

| File | Lines | Problem |
|------|-------|---------|
| `app/routers/mpp_import.py` | 1,172 | Complex import logic, no separation |
| `app/routers/projects.py` | 1,064 | CRUD + tree building + assignments mixed |
| `app/routers/admin.py` | 1,046 | Admin auth + tenant CRUD mixed |
| `app/routers/sites.py` | 712 | Sites + bank holidays + company events |

**Fix**: Extract into sub-modules (e.g., `projects/crud.py`, `projects/tree.py`, `admin/auth.py`, `admin/tenants.py`).

#### A7. Inconsistent Error Handling (MEDIUM)

- `admin.py:47` — complex exception handling with JSON parsing
- `equipment.py:72-80` — inconsistent detail messages
- `notes.py:138` — minimal error details
- `main.py:428-439` — global `Exception` handler catches everything (masks bugs)

**Fix**: Create a custom exception hierarchy with consistent error response shapes.

#### A8. Dual Authentication Patterns (MEDIUM)

- Regular auth: session-based (`middleware/auth.py:18-124`)
- Admin auth: cookie-based with express-session JSON parsing (`admin.py:64-138`)
- Both duplicate session lookup, expiration checking, and user validation

**Fix**: Unify into a single auth service with configurable scopes.

#### A9. Inconsistent Datetime Serialization (MEDIUM)

Two approaches exist:
- `main.py:22-41` — `CustomJSONResponse` with `format_datetime_js()` (no timezone offset)
- `schemas/base.py:82-100` — `serialize_datetime_js()` (applies timezone offset)

**Fix**: Consolidate to one approach.

#### A10. No Pagination (MEDIUM)

All list endpoints (`GET /projects`, `GET /users`, `GET /equipment`) return full result sets with no limit/offset.

**Fix**: Add standardized pagination (offset/limit or cursor-based) to all list endpoints.

#### A11. Missing Database Indexes (MEDIUM)

Common lookup patterns lack indexes:
- `User.email` (auth lookups)
- `tenants.database_name` (connection routing)
- `organization_sso_config.enabled` (login flow)

#### A12. `print()` Instead of `logging` (LOW)

15+ `print()` statements in production code (`main.py:110-124`, `tenant_manager.py:68`, `middleware/tenant.py:96`). No structured logging, no log levels.

**Fix**: Replace with Python `logging` module throughout.

#### A13. Connection Pool Inconsistency (LOW)

Three different pool configurations with no documented rationale:
- `database.py:37-49` — `pool_size=20, max_overflow=10`
- `master_db.py:51-54` — `pool_size=10, max_overflow=5`
- `tenant_manager.py:193-200` — `pool_size=5, max_overflow=5`

---

### B. FRONTEND (React / TypeScript)

#### B1. Assignment Modal Duplication (HIGH)

- `components/modals/StaffAssignmentModal.tsx` (341 lines)
- `components/modals/EquipmentAssignmentModal.tsx` (244 lines)

~90% code duplication: same form state, same lookup logic, same lifecycle patterns, same CSS file.

**Fix**: Refactor into a generic `<AssignmentModal<T>>` component with prop-driven differences.

#### B2. Recursive Subphase Search Duplication (MEDIUM)

The same recursive search logic is duplicated in 3+ files:
- `StaffAssignmentModal.tsx:69-79`
- `EquipmentAssignmentModal.tsx:52-65`
- `SubphaseModal.tsx:18-35`

**Fix**: Extract to `utils/subphaseUtils.ts` with `findSubphaseById()`, `findPhaseContainingSubphase()`.

#### B3. Admin Modal Duplication (MEDIUM)

- `admin/modals/CreateAdminModal.tsx` (151 lines)
- `admin/modals/CreateOrganizationModal.tsx` (156 lines)

Both share identical form structure, validation, and error handling.

**Fix**: Extract shared form/modal primitives.

#### B4. Monolithic State Store (HIGH)

`stores/appStore.ts` — **1,106 lines** with 50+ state properties and 60+ actions:
- Auth, data, UI, what-if mode, critical path, custom columns, and expansion states all in one store
- Lines 810-858: critical path calculation embedded in store
- Lines 867-900: what-if mode snapshot/replay logic
- Lines 532-577: custom column filtering

**Fix**: Split into focused stores: `projectStore`, `resourceStore`, `viewStore`, `whatIfStore`, `customColumnStore`.

#### B5. UIStore Overloaded (MEDIUM)

`stores/uiStore.ts` — 724 lines with 48 modal type variants (lines 25-48), mixed tooltip/editing/modal state.

**Fix**: Separate modal state management from transient UI state.

#### B6. `any` Types in API Layer (HIGH)

17+ instances of `any` in API endpoints:
- `api/endpoints/auth.ts:11,33,47`
- `api/endpoints/projects.ts:136,147,166+`

```typescript
function transformUser(apiUser: any): User { ... }
function transformProject(project: any): Project { ... }
```

**Fix**: Create proper API response interfaces (e.g., `APIUser`, `APIProject`) and use them in transform functions.

#### B7. Repetitive API Transform Functions (MEDIUM)

`api/endpoints/projects.ts:136-333` — `transformProject`, `transformPhase`, `transformSubphase` follow identical mapping patterns with no reusable helpers.

#### B8. Console Logs in Production (HIGH)

50+ `console.log` statements across:
- `hooks/useDataLoader.ts:63,75-82,101-102,108,110,113,116,122,134,143`
- `hooks/useWebSocket.ts` — multiple
- `api/client.ts:106,165,188`
- `components/gantt/Timeline/ProjectTimeline.tsx`

**Fix**: Remove or gate behind `import.meta.env.DEV`.

#### B9. No Code Splitting for Modals (MEDIUM)

`components/modals/ModalContainer.tsx` eagerly imports and renders all 22 modals simultaneously. No `React.lazy()`.

**Fix**: Lazy-load modals on demand.

#### B10. Zero `React.memo()` Usage (MEDIUM)

No memoized components despite 199 files. Large list/row components (SubphaseRow, ProjectRow, assignment rows) re-render on any parent state change.

**Fix**: Memoize row-level components in lists/tables.

#### B11. Oversized Components (MEDIUM)

| File | Lines |
|------|-------|
| `gantt/Timeline/ProjectTimeline.tsx` | 1,104 |
| `gantt/ProjectPanel/SubphaseRow.tsx` | 550 |
| `gantt/ProjectPanel/ProjectRow.tsx` | 549 |

**Fix**: Break into smaller focused components.

#### B12. Missing Barrel Exports for Modals (LOW)

`components/modals/` has no `index.ts`. Other directories (`common/`, `hooks/`, `api/`) properly have barrel exports.

#### B13. Store Selectors Pull Entire Branches (MEDIUM)

```typescript
// Triggers re-render on ANY store change:
const { staff, projects, currentSite } = useAppStore();
// Should be:
const staff = useAppStore((s) => s.staff);
```

---

### C. INFRASTRUCTURE

#### C1. Default Admin Credentials in Repo (CRITICAL)

`setup_databases.sql:123-132` contains a hardcoded bcrypt hash for password "admin":
```sql
INSERT INTO admin_users (email, password_hash, name, role, active)
VALUES ('admin@milestone.local', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOY...', ...)
```

**Fix**: Remove default admin from SQL; rely on `app/scripts/init_db.py` with interactive setup.

#### C2. Source Maps in Production Build (MEDIUM)

`frontend/vite.config.ts:53` — `sourcemap: true` adds 30-50% bundle size and exposes source code.

**Fix**: `sourcemap: process.env.NODE_ENV === 'development'`

#### C3. Fragile SQL Migration Parsing (MEDIUM)

`migrations/run_migration_master.py:57-61` splits SQL on `;` — breaks `DO $$ ... END $$;` blocks (documented gotcha in CLAUDE.md).

**Fix**: Use proper SQL parsing or single-statement-per-file convention.

#### C4. CI Allows No Tests to Pass (MEDIUM)

`.github/workflows/ci.yml:152` — `npx vitest run --passWithNoTests` means CI passes even if all tests are deleted.

**Fix**: Remove `--passWithNoTests`, ensure tests exist.

#### C5. MyPy Errors Ignored in CI (MEDIUM)

`.github/workflows/ci.yml:47` — `continue-on-error: true` for mypy. Real type errors can be merged.

#### C6. Minimal Test Coverage (HIGH)

Only 3 test files (`conftest.py`, `test_config.py`, `test_models.py`) for ~71 Python modules. Estimated <5% coverage. No integration tests for multi-tenant routing, admin APIs, SSO flows.

#### C7. Deploy Script Deletes Before Verifying Build (MEDIUM)

`deploy-react.sh:21-26` — removes `public/` contents before verifying the new build succeeded.

**Fix**: Build to temp dir, verify, then atomic swap.

#### C8. Docker Image Includes Java Unconditionally (LOW)

`Dockerfile:48` — `default-jre-headless` adds ~150-200MB for MPP import, even when not needed.

**Fix**: Make Java optional via `ARG BUILD_WITH_JAVA=false`.

#### C9. Dev Compose Files Run `npm install` Every Startup (LOW)

`docker-compose.dev.yml:64`, `docker-compose.react-dev.yml:65` — reinstalls node_modules on every container start.

**Fix**: Use `npm ci` with proper volume caching.

---

## PART 2: PRIORITIZED REMEDIATION PLAN

### Phase 1 — Critical & Quick Wins (Week 1)

| # | Task | Impact | Files |
|---|------|--------|-------|
| 1 | Remove hardcoded default admin from `setup_databases.sql` | Security | `setup_databases.sql` |
| 2 | Remove 50+ `console.log` statements from frontend | Performance/Security | `hooks/`, `api/`, `components/` |
| 3 | Fix N+1 query in `notes.py` with `selectinload` | Performance | `app/routers/notes.py` |
| 4 | Add proper API response types, eliminate `any` | Type Safety | `frontend/src/api/endpoints/` |
| 5 | Replace `print()` with `logging` module in backend | Observability | `app/main.py`, `app/services/`, `app/middleware/` |

### Phase 2 — Code Deduplication (Weeks 2-3)

| # | Task | Impact | Files |
|---|------|--------|-------|
| 6 | Extract shared response builder utility for backend routers | Maintainability | New `app/services/response_builder.py`, all routers |
| 7 | Merge StaffAssignmentModal + EquipmentAssignmentModal into generic component | Saves ~300 lines | `frontend/src/components/modals/` |
| 8 | Extract recursive subphase search to shared utility | Eliminates 3x duplication | New `frontend/src/utils/subphaseUtils.ts` |
| 9 | Use `user.full_name` property consistently | Consistency | `vacations.py`, `notes.py`, `staff.py` |
| 10 | Consolidate datetime serialization to single approach | Consistency | `app/main.py`, `app/schemas/base.py` |

### Phase 3 — Architecture Refactoring (Weeks 3-5)

| # | Task | Impact | Files |
|---|------|--------|-------|
| 11 | Split `appStore.ts` (1,106 lines) into focused stores | Testability, Performance | `frontend/src/stores/` |
| 12 | Split large routers (`projects.py`, `admin.py`, `mpp_import.py`) into sub-modules | Maintainability | `app/routers/` |
| 13 | Unify authentication logic (regular + admin) | Security, Maintainability | `app/middleware/auth.py`, `app/routers/admin.py` |
| 14 | Add pagination to all list endpoints | Performance | All routers with GET list endpoints |
| 15 | Create custom exception hierarchy with consistent error responses | Reliability | New `app/exceptions.py`, all routers |

### Phase 4 — Performance Optimization (Weeks 5-6)

| # | Task | Impact | Files |
|---|------|--------|-------|
| 16 | Add `React.memo()` to row-level components | Render Performance | `SubphaseRow`, `ProjectRow`, assignment rows |
| 17 | Lazy-load modals with `React.lazy()` | Bundle Size | `ModalContainer.tsx`, all 22 modals |
| 18 | Add `selectinload()` to remaining eager-load gaps | Query Performance | `equipment.py`, `projects.py`, `sites.py` |
| 19 | Add database indexes for common lookups | Query Performance | New migration file |
| 20 | Disable source maps in production Vite build | Bundle Size | `frontend/vite.config.ts` |
| 21 | Fix store selectors to use atomic selectors | Render Performance | All components using `useAppStore()` |

### Phase 5 — Testing & CI Hardening (Weeks 6-8)

| # | Task | Impact | Files |
|---|------|--------|-------|
| 22 | Add integration tests for critical backend flows (auth, multi-tenant, CRUD) | Reliability | `tests/` |
| 23 | Remove `--passWithNoTests` from CI | CI Integrity | `.github/workflows/ci.yml` |
| 24 | Fix MyPy `continue-on-error` in CI | Type Safety | `.github/workflows/ci.yml` |
| 25 | Fix SQL migration parsing for `DO $$` blocks | Correctness | `migrations/run_migration_master.py` |
| 26 | Make deploy script atomic (build, verify, swap) | Reliability | `deploy-react.sh` |

### Phase 6 — Polish (Ongoing)

| # | Task | Impact | Files |
|---|------|--------|-------|
| 27 | Split oversized frontend components (`ProjectTimeline` 1,104 lines) | Maintainability | `gantt/Timeline/`, `gantt/ProjectPanel/` |
| 28 | Add barrel exports for modals directory | DX | `components/modals/index.ts` |
| 29 | Standardize connection pool config with documentation | Clarity | `app/database.py`, `app/config.py` |
| 30 | Make Docker Java optional via build arg | Image Size | `Dockerfile` |

---

## Summary Statistics

| Category | Issues Found |
|----------|-------------|
| Code Duplication (Backend) | 5 major patterns |
| Code Duplication (Frontend) | 4 major patterns |
| Performance Issues | 10+ |
| Security Issues | 2 (1 critical) |
| Type Safety Issues | 17+ `any` types + missing types |
| Architecture Issues | 6 oversized files (>700 lines each) |
| Infrastructure Issues | 9 |
| **Total actionable items** | **30 in remediation plan** |

**Files most in need of refactoring**:
- Backend: `projects.py` (1,064), `admin.py` (1,046), `mpp_import.py` (1,172)
- Frontend: `appStore.ts` (1,106), `ProjectTimeline.tsx` (1,104), `uiStore.ts` (724)
- Infrastructure: `setup_databases.sql`, `deploy-react.sh`, `ci.yml`
