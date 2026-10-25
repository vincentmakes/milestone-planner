/**
 * Microsoft Entra SSO diagnostic.
 *
 * One result shape for both tests: the tenant's (`POST /api/auth/sso/test`,
 * the values entered in Settings → SSO, nothing saved) and the admin portal's
 * organization test (`testOrganizationSSOConfig` in `admin.ts`, the saved
 * values). Both run `app/services/sso_test.py` on the server.
 */

import { apiPost } from '../client';

export interface SSOTestCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail' | 'manual';
  message: string;
  /** Microsoft's AADSTS code, when it supplied one. */
  code?: string | null;
}

export interface SSOTestResult {
  /**
   * Whether Microsoft accepted the client ID and secret — NOT whether a user
   * sign-in will succeed. The test signs in as the application itself, which
   * never involves a redirect URI, so it cannot see a redirect URI registered
   * under the wrong platform. That comes back as a 'manual' check.
   */
  credentialsOk: boolean;
  summary: string;
  checks: SSOTestCheck[];
}

export interface TenantSSOTestBody {
  tenant_id: string;
  client_id: string;
  redirect_uri: string;
  /** Omitted (or blank, or the masked `****abcd`): the server tests the stored secret. */
  client_secret?: string;
}

/** Test the tenant SSO values as entered. Needs `settings.sso`; 409 while organization SSO is active. */
export async function testTenantSSOConfig(body: TenantSSOTestBody): Promise<SSOTestResult> {
  return apiPost<SSOTestResult>('/api/auth/sso/test', body);
}
