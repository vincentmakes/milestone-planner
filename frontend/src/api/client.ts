/**
 * API Client for Milestone
 * Handles all HTTP communication with the backend, including:
 * - Tenant prefix detection for multi-tenant routes
 * - What If mode request blocking
 * - Error handling and response parsing
 */

import type { } from '@/types';

// =============================================================================
// API BASE URL
// =============================================================================

/**
 * Get the API base URL
 * In development, this points to the backend on port 8485
 * In production (same origin), this is empty
 */
function getApiBaseUrl(): string {
  // Check if we're on a different port (development)
  if (window.location.port === '3333') {
    // Development: API is on port 8485 on same host
    return `${window.location.protocol}//${window.location.hostname}:8485`;
  }
  // Production: same origin
  return '';
}

// =============================================================================
// TENANT PREFIX DETECTION
// =============================================================================

/**
 * Extracts tenant prefix from current URL path
 * e.g., /t/acme/dashboard -> /t/acme
 */
export function getTenantPrefix(): string {
  const match = window.location.pathname.match(/^(\/t\/[a-z0-9][a-z0-9-]*)/);
  return match ? match[1] : '';
}

// =============================================================================
// REQUEST CONFIGURATION
// =============================================================================

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

/** HTTP methods that write, and are therefore queued while What-If mode is active. */
export type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const WRITE_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

interface ApiClientConfig {
  /** Check if What If mode is active (blocks write operations) */
  isWhatIfMode?: () => boolean;
  /** Queue a What-If operation for later execution */
  queueWhatIfOperation?: (op: { method: WriteMethod; url: string; body?: unknown }) => void;
  /**
   * Called when a tenant API request comes back 401 (the session expired or
   * was revoked). Not called for the login or change-password requests (a
   * wrong password must never end the session) nor for the admin portal,
   * which has its own session.
   */
  onUnauthorized?: () => void;
}

export let clientConfig: ApiClientConfig = {
  isWhatIfMode: () => false,
  queueWhatIfOperation: undefined,
  onUnauthorized: undefined,
};

/**
 * Whether a 401 from this URL means "the tenant session is gone".
 * The login call answers 401 for bad credentials; change-password is excluded
 * too so a mistyped current password can never log the user out (the backend
 * answers 400 for that, but the dialog must not depend on it); and
 * /api/admin/* belongs to the separate admin-portal session (adminStore
 * handles it).
 */
function isSessionExpiry(url: string): boolean {
  const path = url.split('?')[0];
  return (
    !/\/api\/auth\/(login|change-password)$/.test(path) && !path.includes('/api/admin/')
  );
}

/**
 * Configure the API client
 * Call this during app initialization to connect store state
 */
export function configureApiClient(config: ApiClientConfig): void {
  clientConfig = { ...clientConfig, ...config };
}

/**
 * Whether writes are currently being queued by What-If mode.
 *
 * Read through the client config (not whatIfStore) so the API layer stays free
 * of store imports; it is false while whatIfStore replays the queue on Apply.
 */
export function isWhatIfActive(): boolean {
  return clientConfig.isWhatIfMode?.() ?? false;
}

// =============================================================================
// WHAT-IF EXEMPTIONS
// =============================================================================

/**
 * Writes that bypass the What-If queue, as path prefixes. /api/admin/ is the
 * admin portal, a separate app with its own session and no Gantt to sandbox —
 * What-If never applies there, and queuing its writes would silently swallow
 * them. Kanban comments and notifications are not plan operations: a queued
 * comment gets a fake id, whatIfStore only snapshots appStore.projects so
 * Discard cannot roll it back, and Apply would replay it into a real second
 * comment. (Card moves and assignments ARE plan operations and stay queued.)
 */
const WHAT_IF_EXEMPT_PREFIXES: readonly string[] = [
  '/api/auth/',
  '/api/settings/',
  '/api/admin/',
  '/api/notifications',
  '/api/kanban/comments/',
];

/**
 * Configuration endpoints, exempt like settings: the What-If snapshot covers
 * only appStore.projects, so a queued configuration write (absence type,
 * skill, equipment type, phase template, user, tag, project field or item,
 * team, site or equipment definition) could not be rolled back on Discard and its local
 * edit would vanish on the next reload. Assigning tags, teams or project field
 * values to a project goes through PUT /api/projects/{id} and stays queued. Calendar and booking data
 * stays queued: /api/sites/{id}/holidays…, /api/sites/{id}/events…,
 * /api/events…, /api/equipment-blocks…, /api/equipment-assignments… and the
 * /api/equipment/{id}/… sub-resources.
 */
const WHAT_IF_EXEMPT_PATTERNS: readonly RegExp[] = [
  /^\/api\/kanban\/cards\/(phase|subphase)\/\d+\/comments/,
  /^\/api\/(absence-types|skills|equipment-types|predefined-phases|users|tags|project-fields|teams)(\/|$)/,
  // RBAC. Roles, permissions and approval policies are configuration; todos
  // are private rows like notifications; an approval decision (approve,
  // reject, cancel) is a message to a person: queued, Discard would silently
  // un-decide it. Own bookings stay queued on the assignment routes (a 202 on
  // Apply becomes a request).
  /^\/api\/(roles|permissions|approval-policies|todos|approval-requests)(\/|$)/,
  /^\/api\/sites(\/\d+)?$/,
  /^\/api\/equipment(\/\d+)?$/,
];

/**
 * Whether a write to `endpoint` is sent for real while What-If mode is active.
 * Matches the endpoint as the API layer passes it (`/api/...`, no tenant
 * prefix, no base URL); a query string or fragment is ignored.
 */
export function isWhatIfExempt(endpoint: string): boolean {
  let path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  path = path.replace(/^\/t\/[a-z0-9][a-z0-9-]*(?=\/api\/)/, '').split(/[?#]/)[0];
  return (
    WHAT_IF_EXEMPT_PREFIXES.some(prefix => path.startsWith(prefix)) ||
    WHAT_IF_EXEMPT_PATTERNS.some(pattern => pattern.test(path))
  );
}

// =============================================================================
// ERRORS
// =============================================================================

/** A non-2xx API response; `message` is the server's detail, `status` the HTTP code. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * A 403: the role lacks the key the route needs. Loaders of view-gated
 * slices treat it as an empty slice, not as a failure.
 */
export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

// =============================================================================
// CORE REQUEST FUNCTION
// =============================================================================

/**
 * Make an API request with automatic tenant prefix handling
 * @param endpoint - API endpoint (e.g., '/api/projects')
 * @param options - Fetch options including body, method, headers
 * @returns Parsed JSON response
 * @throws Error with message from API or HTTP status
 */
export async function apiRequest<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const baseUrl = getApiBaseUrl();
  const tenantPrefix = getTenantPrefix();
  let url = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  
  // Add tenant prefix to /api/ routes
  if (url.startsWith('/api/') && tenantPrefix) {
    url = tenantPrefix + url;
  }
  
  // Prepend base URL for cross-origin requests
  url = baseUrl + url;
  
  const method = options.method || 'GET';
  
  // In What If mode, queue write operations unless isWhatIfExempt() lets them through.
  // PATCH is a write like the others (BroadcastMiddleware treats it as one).
  if (clientConfig.isWhatIfMode?.() && WRITE_METHODS.includes(method)) {
    const isAllowed = isWhatIfExempt(endpoint);
    
    if (!isAllowed) {
      // Queue the operation for later execution when applying changes
      if (clientConfig.queueWhatIfOperation) {
        // Store the relative URL (without base) for replay
        const relativeUrl = url.replace(baseUrl, '');
        clientConfig.queueWhatIfOperation({
          method: method as WriteMethod,
          url: relativeUrl,
          body: options.body,
        });
      }
      
      // Return fake success response for blocked operations
      return { success: true, whatIfMode: true, id: Date.now() } as T;
    }
  }
  
  // Build fetch config
  const { body, headers: optHeaders, ...restOptions } = options;
  
  const config: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...optHeaders,
    },
    credentials: 'include', // Include cookies for session auth
    ...restOptions,
  };
  
  // Serialize body if present
  if (body !== undefined) {
    config.body = JSON.stringify(body);
  }
  
  try {
    const response = await fetch(url, config);

    // Diagnostic (dev only): log every state-changing request so we can see
    // at a glance whether a Gantt drag/resize is actually hitting the API and
    // what status the backend returned. Helpful for tracking down sync issues.
    if (import.meta.env.DEV && method !== 'GET') {
      console.info('[API]', method, url, '->', response.status);
    }

    if (response.status === 401 && isSessionExpiry(url)) {
      clientConfig.onUnauthorized?.();
    }

    // Handle empty responses (204 No Content)
    if (response.status === 204) {
      return {} as T;
    }
    
    // Handle no content or empty body
    const text = await response.text();
    if (!text || text.trim() === '') {
      if (response.ok) {
        return {} as T;
      }
      throw new ApiError(`HTTP ${response.status}: Empty response`, response.status);
    }
    
    // Try to parse as JSON
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      // Not JSON - might be an HTML error page from proxy
      console.error(`[API Error] Non-JSON response from ${endpoint}:`, text.substring(0, 200));
      throw new ApiError(`HTTP ${response.status}: Invalid response`, response.status);
    }
    
    if (!response.ok) {
      const error = data as Record<string, unknown>;
      // Handle FastAPI validation errors (422) which have detail as array
      if (Array.isArray(error.detail)) {
        const messages = error.detail.map((d: { msg?: string; loc?: string[] }) => {
          const field = d.loc?.slice(-1)[0] || 'field';
          return `${field}: ${d.msg || 'invalid'}`;
        });
        throw new ApiError(messages.join(', '), response.status);
      }
      // Standard error format
      const message = (error.error as string) || (error.detail as string) || `HTTP ${response.status}`;
      throw new ApiError(message, response.status);
    }
    
    return data as T;
  } catch (err) {
    // Re-throw API errors
    if (err instanceof Error) {
      console.error(`[API Error] ${method} ${endpoint}:`, err.message);
      throw err;
    }
    // Wrap unknown errors
    throw new Error('An unexpected error occurred');
  }
}

// =============================================================================
// CONVENIENCE METHODS
// =============================================================================

/**
 * GET request helper
 */
export function apiGet<T>(endpoint: string): Promise<T> {
  return apiRequest<T>(endpoint, { method: 'GET' });
}

/**
 * POST request helper
 */
export function apiPost<T>(endpoint: string, body?: unknown): Promise<T> {
  return apiRequest<T>(endpoint, { method: 'POST', body });
}

/**
 * PUT request helper
 */
export function apiPut<T>(endpoint: string, body?: unknown): Promise<T> {
  return apiRequest<T>(endpoint, { method: 'PUT', body });
}

/**
 * DELETE request helper
 */
export function apiDelete<T>(endpoint: string): Promise<T> {
  return apiRequest<T>(endpoint, { method: 'DELETE' });
}

/**
 * PATCH request helper
 */
export function apiPatch<T>(endpoint: string, body?: unknown): Promise<T> {
  return apiRequest<T>(endpoint, { method: 'PATCH', body });
}

/**
 * Percent-decode a Content-Disposition filename. A malformed escape (a `%`
 * not followed by two hex digits) makes decodeURIComponent throw URIError;
 * the download must not fail over the name, so fall back instead.
 */
export function decodeFilename(raw: string, fallback: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return fallback;
  }
}

/**
 * Download a binary file from the API and trigger a browser save dialog.
 * Filename comes from the Content-Disposition header when available, or the
 * provided fallback otherwise.
 */
export async function downloadFile(endpoint: string, fallbackFilename: string): Promise<void> {
  const baseUrl = getApiBaseUrl();
  const tenantPrefix = getTenantPrefix();
  let url = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (url.startsWith('/api/') && tenantPrefix) {
    url = tenantPrefix + url;
  }
  url = baseUrl + url;

  const response = await fetch(url, { method: 'GET', credentials: 'include' });
  if (response.status === 401 && isSessionExpiry(url)) {
    clientConfig.onUnauthorized?.();
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const data = await response.json();
      detail = (data?.detail as string) || (data?.error as string) || detail;
    } catch {
      // Body wasn't JSON; keep the status code.
    }
    throw new Error(detail);
  }

  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const filename = match ? decodeFilename(match[1], fallbackFilename) : fallbackFilename;

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
}
