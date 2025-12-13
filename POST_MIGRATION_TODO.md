# Milestone API - Post-Migration TODO

This document tracks items to address after the Node.js → Python/FastAPI migration is complete.

## Database & Schema Issues

### 1. Notes Table - Not Implemented
- **Status**: Feature was planned but never implemented in Node.js
- **Impact**: Both backends return "table does not exist" error
- **Action Required**: 
  - Create `notes` table in PostgreSQL
  - Implement CRUD endpoints
- **Spec Reference**: "Add notes/information to specific days for employees to track important events"
- **Priority**: Low (feature was never used)

### 2. Timestamp Storage - Local Time vs UTC
- **Status**: Database stores timestamps as local CET time, not UTC
- **Impact**: 
  - Works fine for single-timezone deployments
  - Will cause issues for global/multi-timezone deployments
  - DST transitions could cause data inconsistencies
- **Action Required**:
  - Migrate to `TIMESTAMPTZ` columns
  - Store all times explicitly in UTC
  - Update Node.js INSERT/UPDATE statements to use UTC
  - Migrate existing data: `UPDATE table SET created_at = created_at AT TIME ZONE 'Europe/Zurich' AT TIME ZONE 'UTC'`
- **Priority**: Medium (important for global deployment)

## Node.js Issues (to fix before full cutover)

### 3. SPA Fallback Catching API Routes
- **Status**: Routes like `/api/sites/1`, `/api/staff/2`, `/api/equipment/1` return HTML instead of JSON
- **Impact**: Single-item GET requests fail in Node.js
- **Root Cause**: Express SPA fallback route is too greedy
- **Action Required**: Fix route ordering in Node.js server.js
- **Priority**: High (breaks functionality)

## Features to Implement Post-Migration

### 4. Notes Feature (Epic 8 from Specs)
- Add notes to specific dates for staff members
- Track important events, holidays, special circumstances
- Fields: site_id, staff_id (optional), date, text, type
- **Priority**: Low

### 5. Real-time Collaboration (Phase 4 from Roadmap)
- WebSocket support for live updates
- Multiple users editing simultaneously
- **Priority**: Future enhancement

## Testing Improvements

### 6. Test Script Enhancements
- Better handling of large response comparisons (current truncation causes false positives)
- Add mutation tests (POST, PUT, DELETE)
- Add performance benchmarks
- **Priority**: Low

## Documentation Needed

### 7. API Documentation
- Generate OpenAPI/Swagger docs from FastAPI
- Document authentication flows
- Document multi-tenant configuration
- **Priority**: Medium

### 8. Deployment Guide
- Docker Compose for production
- nginx configuration for hybrid mode
- Environment variables reference
- Database backup/restore procedures
- **Priority**: High (needed for deployment)

---

## Completed Items

- [x] Phase 1: Settings, Sites, Holidays, Predefined Phases
- [x] Phase 2: Staff, Equipment, Vacations
- [x] Phase 3: Authentication, Users, Sessions
- [x] DST-aware datetime serialization
- [x] API response format parity with Node.js
- [x] Phase 4: Projects, Phases, Subphases
- [x] Phase 5: Assignments (project/phase/subphase staff, equipment)
- [x] Phase 6: Staff Availability, MPP Import

## Migration Complete! 🎉

All Node.js API endpoints have been migrated to Python/FastAPI.

---

*Last updated: December 9, 2025*
