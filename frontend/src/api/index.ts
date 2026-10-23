/**
 * API module exports
 * Import from '@/api' for clean access to all API functions
 */

// Core client
export { 
  apiRequest, 
  apiGet, 
  apiPost, 
  apiPut, 
  apiDelete,
  apiPatch,
  getTenantPrefix,
  configureApiClient,
} from './client';

// Auth endpoints
export * from './endpoints/auth';

// Data endpoints
export * from './endpoints/projects';
export * from './endpoints/sites';
export * from './endpoints/staff';
export * from './endpoints/equipment';
export * from './endpoints/vacations';
export * from './endpoints/users';
export * from './endpoints/settings';
export * from './endpoints/customColumns';
export * from './endpoints/skills';
export * from './endpoints/tags';
export * from './endpoints/projectFields';
export * from './endpoints/teams';
export * from './endpoints/roles';
export * from './endpoints/absenceTypes';
export * from './endpoints/health';

// Admin endpoints (multi-tenant management)
export * from './endpoints/admin';
