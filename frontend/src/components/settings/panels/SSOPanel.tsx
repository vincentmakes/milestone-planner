/**
 * SSOPanel (Settings hub > SSO)
 *
 * Configure Microsoft Entra SSO settings (`settings.sso`). "Test
 * configuration" asks Microsoft about the values as entered, before they are
 * saved. Saving a change that can break sign-in over a live configuration
 * asks for the typed word CHANGE first.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Notice } from '@/components/common/Notice';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useAppStore } from '@/stores/appStore';
import { apiGet, apiPut } from '@/api/client';
import { testTenantSSOConfig } from '@/api/endpoints/sso';
import type { SSOTestResult as SSOTestResultData } from '@/api/endpoints/sso';
import { SSOTestResult } from '@/components/common/SSOTestResult';
import { confirmAction } from '@/utils/confirmDialog';
import { useReportDirty } from '../useReportDirty';
import type { SettingsPanelProps } from '../types';
import styles from './SSOPanel.module.css';
import { can } from '@/utils/permissions';
import { useRoles } from '@/hooks/useRoles';
import { ADMIN_ROLE_KEY } from '@/types/permissions';

interface SSOFullConfig {
  // enabled / auto_create_users arrive as the integer columns (0 | 1)
  enabled: boolean | number;
  tenant_id: string;
  client_id: string;
  client_secret_masked?: string;
  redirect_uri: string;
  auto_create_users: boolean | number;
  /** A role key (system or custom; never admin) */
  default_role: string;
  org_sso_active?: boolean;
  organization?: { name?: string };
}

/** The configuration as last loaded or saved, as the form displayed it. */
interface SavedSSO {
  enabled: boolean;
  tenant_id: string;
  client_id: string;
  redirect_uri: string;
  auto_create_users: boolean;
  default_role: string;
  hasSecret: boolean;
}

/**
 * What a save would change that can break Microsoft sign-in, as phrases for
 * the confirmation. Empty when the saved configuration is not live (enabled,
 * both ids and a secret) or the change cannot affect sign-in (auto-create,
 * default role): those save without asking.
 */
function signInChanges(
  saved: SavedSSO | null,
  form: { enabled: boolean; tenantId: string; clientId: string; redirectUri: string; secret: string }
): { changes: string[]; disabling: boolean } {
  const live = Boolean(saved?.enabled && saved.tenant_id.trim() && saved.client_id.trim() && saved.hasSecret);
  if (!saved || !live) return { changes: [], disabling: false };
  if (!form.enabled) return { changes: ['switch single sign-on off'], disabling: true };
  const changes: string[] = [];
  if (form.tenantId.trim() !== saved.tenant_id.trim()) changes.push('change the Directory (tenant) ID');
  if (form.clientId.trim() !== saved.client_id.trim()) changes.push('change the Client ID');
  if (form.secret.trim() !== '') changes.push('replace the client secret');
  if (form.redirectUri.trim() !== saved.redirect_uri.trim()) changes.push('change the redirect URI');
  return { changes, disabling: false };
}

function signInWarning(changes: string[], disabling: boolean): string {
  const list = `Single sign-on is live. You are about to:\n${changes.map((c) => `• ${c}`).join('\n')}`;
  if (disabling) {
    return `${list}\n\nEveryone who signs in with Microsoft only will be unable to sign in until SSO is enabled again. Password sign-in keeps working.`;
  }
  return (
    `${list}\n\nIf these values are wrong, everyone who signs in with Microsoft only will be unable to sign in ` +
    'until an administrator fixes them here. Password sign-in keeps working.\n\nTip: use Test configuration first.'
  );
}

/**
 * The role SSO-created users get: every role but admin (the server refuses
 * it). Its own component so the roles load only when the form shows; while
 * they load, the saved key is the one option.
 */
function DefaultRoleSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (role: string) => void;
  disabled: boolean;
}) {
  const roles = useRoles();
  const options = useMemo(() => {
    const list = roles.filter((r) => r.key !== ADMIN_ROLE_KEY).map((r) => ({ value: r.key, label: r.name }));
    if (!list.some((o) => o.value === value)) list.unshift({ value, label: value });
    return list;
  }, [roles, value]);
  return (
    <Select
      label="Default role for new users"
      fullWidth
      id="defaultRole"
      options={options}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    />
  );
}

export function SSOPanel({ onDirtyChange }: Partial<SettingsPanelProps> = {}) {
  const canConfigure = useAppStore((s) => can(s.currentUser, 'settings.sso'));
  
  // Form state
  const [enabled, setEnabled] = useState(false);
  const [tenantId, setTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [clientSecretPlaceholder, setClientSecretPlaceholder] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [autoCreateUsers, setAutoCreateUsers] = useState(false);
  const [defaultRole, setDefaultRole] = useState('user');

  // When the tenant's organization manages SSO, the tenant-level config below
  // is overridden and never takes effect, so the form is shown read-only.
  const [orgSSOActive, setOrgSSOActive] = useState(false);
  const [orgName, setOrgName] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const { isSubmitting: isSaving, begin: beginSave, end: endSave } = useSubmitGuard();
  const { isSubmitting: isTesting, begin: beginTest, end: endTest } = useSubmitGuard();
  const [testResult, setTestResult] = useState<SSOTestResultData | null>(null);
  const [saved, setSaved] = useState<SavedSSO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  
  // Generate redirect URI hint
  const redirectHint = typeof window !== 'undefined' 
    ? `${window.location.origin}/api/auth/sso/callback`
    : '/api/auth/sso/callback';
  
  const loadConfig = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const config = await apiGet<SSOFullConfig>('/api/sso/config/full');
      const shown: SavedSSO = {
        enabled: Boolean(config.enabled),
        tenant_id: config.tenant_id || '',
        client_id: config.client_id || '',
        redirect_uri: config.redirect_uri || redirectHint,
        auto_create_users: Boolean(config.auto_create_users),
        default_role: config.default_role || 'user',
        hasSecret: Boolean(config.client_secret_masked),
      };
      setEnabled(shown.enabled);
      setTenantId(shown.tenant_id);
      setClientId(shown.client_id);
      setClientSecretPlaceholder(config.client_secret_masked || 'Enter client secret');
      setRedirectUri(shown.redirect_uri);
      setAutoCreateUsers(shown.auto_create_users);
      setDefaultRole(shown.default_role);
      // Compared as displayed (after the defaults above), so an empty config
      // is not dirty on load.
      setSaved(shown);
      setOrgSSOActive(Boolean(config.org_sso_active));
      setOrgName(config.organization?.name || '');
    } catch (err) {
      console.error('Failed to load SSO config:', err);
      setError(err instanceof Error ? err.message : 'Failed to load configuration');
    } finally {
      setIsLoading(false);
    }
  }, [redirectHint]);
  
  // Load config when the panel opens
  useEffect(() => {
    if (canConfigure) {
      loadConfig();
    }
  }, [canConfigure, loadConfig]);
  
  const dirty =
    saved !== null &&
    (enabled !== saved.enabled ||
      tenantId.trim() !== saved.tenant_id.trim() ||
      clientId.trim() !== saved.client_id.trim() ||
      redirectUri.trim() !== saved.redirect_uri.trim() ||
      autoCreateUsers !== saved.auto_create_users ||
      defaultRole !== saved.default_role ||
      clientSecret.trim() !== '');
  useReportDirty(onDirtyChange, dirty);

  /** Missing Entra fields while enabling, or null. */
  const requiredFieldsError = () =>
    enabled && (!tenantId.trim() || !clientId.trim() || !redirectUri.trim())
      ? 'Please fill in Tenant ID, Client ID, and Redirect URI to enable SSO'
      : null;

  const handleSave = async () => {
    setError(null);
    setSuccess(null);

    const missing = requiredFieldsError();
    if (missing) {
      setError(missing);
      return;
    }

    const secret = clientSecret.trim();
    // Over a live configuration, a change that can break Microsoft sign-in is
    // confirmed by typing a word — before taking the guard, so an open
    // dialog never holds it.
    const { changes, disabling } = signInChanges(saved, { enabled, tenantId, clientId, redirectUri, secret });
    if (
      changes.length > 0 &&
      !(await confirmAction({
        title: 'Change Microsoft sign-in settings',
        message: signInWarning(changes, disabling),
        confirmLabel: 'Save changes',
        destructive: true,
        confirmWord: 'CHANGE',
      }))
    ) {
      return;
    }

    if (!beginSave()) return; // a save is already running

    try {
      const config: Record<string, unknown> = {
        enabled,
        tenant_id: tenantId.trim(),
        client_id: clientId.trim(),
        redirect_uri: redirectUri.trim(),
        auto_create_users: autoCreateUsers,
        default_role: defaultRole,
      };

      // Only send client_secret if one was typed (blank keeps the stored one)
      if (secret) {
        config.client_secret = secret;
      }

      await apiPut('/api/sso/config', config);
      setSuccess('SSO configuration saved successfully');
      setClientSecret(''); // Clear the secret field
      setTestResult(null);
      // What was just saved, so a failed reload does not leave the panel dirty.
      setSaved({
        enabled,
        tenant_id: tenantId.trim(),
        client_id: clientId.trim(),
        redirect_uri: redirectUri.trim(),
        auto_create_users: autoCreateUsers,
        default_role: defaultRole,
        hasSecret: Boolean(saved?.hasSecret) || secret !== '',
      });

      // Reload to get updated masked secret
      await loadConfig();
    } catch (err) {
      console.error('Failed to save SSO config:', err);
      setError(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      endSave();
    }
  };

  const handleTest = async () => {
    setError(null);
    setSuccess(null);

    const missing = requiredFieldsError();
    if (missing) {
      setError(missing);
      return;
    }

    if (!beginTest()) return; // a test is already running

    try {
      const secret = clientSecret.trim();
      // A blank secret field tests the stored secret ("leave blank to keep").
      setTestResult(
        await testTenantSSOConfig({
          tenant_id: tenantId.trim(),
          client_id: clientId.trim(),
          redirect_uri: redirectUri.trim(),
          ...(secret ? { client_secret: secret } : {}),
        })
      );
    } catch (err) {
      setTestResult(null);
      setError(err instanceof Error ? err.message : 'Failed to test configuration');
    } finally {
      endTest();
    }
  };

  /** An edit of a tested value: a previous result no longer describes the form. */
  const editTested = (set: (value: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    setTestResult(null);
  };

  // Without settings.sso there is nothing to show (the section is not listed)
  if (!canConfigure) {
    return null;
  }
  
  return (
    <div className={styles.container}>
      {isLoading ? (
        <div className={styles.loading}>Loading configuration...</div>
      ) : (
        <>
          {error && <Notice tone="error">{error}</Notice>}
          {success && <div className={styles.success}>{success}</div>}

          {orgSSOActive && (
            <div className={styles.notice}>
              SSO for this workspace is managed by your organization
              {orgName ? <> <strong>{orgName}</strong></> : null}. Organization
              SSO takes precedence over tenant-level settings, so the values
              below are your organization's and are shown read-only. To change
              SSO, contact your organization administrator.
            </div>
          )}

          {/* Enable SSO Toggle */}
          <div className={styles.toggleSection}>
            <ToggleSwitch
              checked={enabled}
              onChange={setEnabled}
              disabled={orgSSOActive}
              label="Enable SSO"
            />
            <p className={styles.hint}>
              When enabled, users can sign in using Microsoft Entra (Azure AD).
            </p>
          </div>
          
          {/* Microsoft Entra Settings */}
          <div className={styles.section}>
            <h4>Microsoft Entra Settings</h4>
            
            <Input
              label="Tenant ID *"
              hint="Found in Azure Portal → Microsoft Entra ID → Overview"
              fullWidth
              type="text"
              id="tenantId"
              value={tenantId}
              onChange={editTested(setTenantId)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              disabled={!enabled || orgSSOActive}
            />
            
            <Input
              label="Client ID (Application ID) *"
              hint="Found in App Registration → Overview → Application (client) ID"
              fullWidth
              type="text"
              id="clientId"
              value={clientId}
              onChange={editTested(setClientId)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              disabled={!enabled || orgSSOActive}
            />
            
            <Input
              label="Client Secret"
              hint="Leave blank to keep existing secret. Create in App Registration → Certificates & secrets"
              fullWidth
              type="password"
              id="clientSecret"
              value={clientSecret}
              onChange={editTested(setClientSecret)}
              // A password manager must not autofill it (a false 'secret typed').
              autoComplete="new-password"
              placeholder={clientSecretPlaceholder || 'Enter client secret'}
              disabled={!enabled || orgSSOActive}
            />
            
            <Input
              label="Redirect URI *"
              hint="Must be registered in App Registration → Authentication → Redirect URIs"
              fullWidth
              type="text"
              id="redirectUri"
              value={redirectUri}
              onChange={editTested(setRedirectUri)}
              placeholder={redirectHint}
              disabled={!enabled || orgSSOActive}
            />
          </div>
          
          {/* User Management Settings */}
          <div className={styles.section}>
            <h4>User Management</h4>
            
            <ToggleSwitch
              className={styles.checkbox}
              checked={autoCreateUsers}
              onChange={setAutoCreateUsers}
              disabled={!enabled || orgSSOActive}
              label="Auto-create users on first SSO login"
            />
            
            <DefaultRoleSelect
              value={defaultRole}
              onChange={setDefaultRole}
              disabled={!enabled || !autoCreateUsers || orgSSOActive}
            />
          </div>
          
          {/* Actions */}
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onClick={handleTest}
              disabled={isTesting || isSaving || orgSSOActive || !enabled}
              loading={isTesting}
              title="Ask Microsoft whether these values are accepted — nothing is saved"
            >
              Test configuration
            </Button>
            <Button onClick={handleSave} disabled={isSaving || orgSSOActive} loading={isSaving}>
              Save Configuration
            </Button>
          </div>
          <p className={styles.testNote}>The test uses the values above as entered — nothing is saved.</p>

          {testResult && <SSOTestResult result={testResult} />}
        </>
      )}
    </div>
  );
}
