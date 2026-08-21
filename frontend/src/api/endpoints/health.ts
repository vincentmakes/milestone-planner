/**
 * Health endpoint.
 *
 * The only unauthenticated source of the running app version: the backend
 * reads it from /VERSION at import and returns it here. Deliberately not a
 * build-time constant — that would report the version the loaded tab was
 * built from, which keeps showing the old number after an upgrade, i.e. the
 * one case anyone checks the version for.
 */

import { apiGet } from '../client';

interface HealthResponse {
  status: string;
  mode: string;
  version: string;
  backend: string;
  database: string;
}

/**
 * The version the server is running, or null if it could not be reached.
 *
 * Swallows the error rather than throwing, as getInstanceTitle does: a missing
 * version is worth omitting from the UI, never worth surfacing as a failure.
 */
export async function getAppVersion(): Promise<string | null> {
  try {
    const response = await apiGet<HealthResponse>('/api/health');
    return response.version || null;
  } catch {
    return null;
  }
}
