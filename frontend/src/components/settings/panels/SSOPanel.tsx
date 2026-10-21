/**
 * SSOPanel (Settings hub > SSO)
 * 
 * Configure Microsoft Entra SSO settings. Admin only.
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

export function SSOPanel() {
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
      setEnabled(Boolean(config.enabled));
      setTenantId(config.tenant_id || '');
      setClientId(config.client_id || '');
      setClientSecretPlaceholder(config.client_secret_masked || 'Enter client secret');
      setRedirectUri(config.redirect_uri || redirectHint);
      setAutoCreateUsers(Boolean(config.auto_create_users));
      setDefaultRole(config.default_role || 'user');
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
  
  const handleSave = async () => {
    setError(null);
    setSuccess(null);
    
    // Validation
    if (enabled) {
      if (!tenantId.trim() || !clientId.trim() || !redirectUri.trim()) {
        setError('Please fill in Tenant ID, Client ID, and Redirect URI to enable SSO');
        return;
      }
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
      
      // Only send client_secret if it was changed
      if (clientSecret) {
        config.client_secret = clientSecret;
      }
      
      await apiPut('/api/sso/config', config);
      setSuccess('SSO configuration saved successfully');
      setClientSecret(''); // Clear the secret field
      
      // Reload to get updated masked secret
      await loadConfig();
    } catch (err) {
      console.error('Failed to save SSO config:', err);
      setError(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      endSave();
    }
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
              onChange={(e) => setTenantId(e.target.value)}
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
              onChange={(e) => setClientId(e.target.value)}
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
              onChange={(e) => setClientSecret(e.target.value)}
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
              onChange={(e) => setRedirectUri(e.target.value)}
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
            <Button onClick={handleSave} disabled={isSaving || orgSSOActive} loading={isSaving}>
              Save Configuration
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
