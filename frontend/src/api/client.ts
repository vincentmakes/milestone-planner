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

interface ApiClientConfig {
  /** Check if What If mode is active (blocks write operations) */
  isWhatIfMode?: () => boolean;
  /** Queue a What-If operation for later execution */
  queueWhatIfOperation?: (op: { method: 'POST' | 'PUT' | 'DELETE'; url: string; body?: unknown }) => void;
}

export let clientConfig: ApiClientConfig = {
  isWhatIfMode: () => false,
  queueWhatIfOperation: undefined,
};

/**
 * Configure the API client
 * Call this during app initialization to connect store state
 */
export function configureApiClient(config: ApiClientConfig): void {
  clientConfig = { ...clientConfig, ...config };
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
  
  // In What If mode, block write operations (except auth and settings) and queue them
  if (clientConfig.isWhatIfMode?.() && ['PUT', 'POST', 'DELETE'].includes(method)) {
    // Card moves and assignments ARE plan operations, so they stay queued.
    // Comments and notifications are not: a queued comment gets a fake id,
    // whatIfStore only snapshots appStore.projects so Discard cannot roll it
    // back, and Apply would replay it into a real second comment.
    const allowedPrefixes = [
      '/api/auth/',
      '/api/settings/',
      '/api/notifications',
      '/api/kanban/comments/',
    ];
    const isCommentWrite = /\/api\/kanban\/cards\/(phase|subphase)\/\d+\/comments/.test(url);
    const isAllowed =
      isCommentWrite || allowedPrefixes.some(prefix => url.includes(prefix));
    
    if (!isAllowed) {
      // Queue the operation for later execution when applying changes
      if (clientConfig.queueWhatIfOperation) {
        // Store the relative URL (without base) for replay
        const relativeUrl = url.replace(baseUrl, '');
        clientConfig.queueWhatIfOperation({
          method: method as 'POST' | 'PUT' | 'DELETE',
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
      throw new Error(`HTTP ${response.status}: Empty response`);
    }
    
    // Try to parse as JSON
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      // Not JSON - might be an HTML error page from proxy
      console.error(`[API Error] Non-JSON response from ${endpoint}:`, text.substring(0, 200));
      throw new Error(`HTTP ${response.status}: Invalid response`);
    }
    
    if (!response.ok) {
      const error = data as Record<string, unknown>;
      // Handle FastAPI validation errors (422) which have detail as array
      if (Array.isArray(error.detail)) {
        const messages = error.detail.map((d: { msg?: string; loc?: string[] }) => {
          const field = d.loc?.slice(-1)[0] || 'field';
          return `${field}: ${d.msg || 'invalid'}`;
        });
        throw new Error(messages.join(', '));
      }
      // Standard error format
      const message = (error.error as string) || (error.detail as string) || `HTTP ${response.status}`;
      throw new Error(message);
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
  const filename = match ? decodeURIComponent(match[1]) : fallbackFilename;

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
}
