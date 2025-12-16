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

// Admin endpoints (multi-tenant management)
export * from './endpoints/admin';
