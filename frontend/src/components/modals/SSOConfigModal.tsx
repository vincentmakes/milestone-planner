/**
 * SSOConfigModal
 * 
 * Admin modal for configuring Microsoft Entra SSO settings.
 * Only admins can access this modal.
 */

import { useState, useEffect } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { apiGet, apiPut } from '@/api/client';
import styles from './SSOConfigModal.module.css';

interface SSOFullConfig {
  enabled: boolean;
  tenant_id: string;
  client_id: string;
  client_secret_masked?: string;
  redirect_uri: string;
  auto_create_users: boolean;
  default_role: 'user' | 'superuser' | 'admin';
}

export function SSOConfigModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const currentUser = useAppStore((s) => s.currentUser);
  
  const isOpen = activeModal === 'ssoConfig';
  const isAdmin = currentUser?.role === 'admin';
  
  // Form state
  const [enabled, setEnabled] = useState(false);
  const [tenantId, setTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [clientSecretPlaceholder, setClientSecretPlaceholder] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [autoCreateUsers, setAutoCreateUsers] = useState(false);
  const [defaultRole, setDefaultRole] = useState<'user' | 'superuser' | 'admin'>('user');
  
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  
  // Generate redirect URI hint
  const redirectHint = typeof window !== 'undefined' 
    ? `${window.location.origin}/api/auth/sso/callback`
    : '/api/auth/sso/callback';
  
  // Load config when modal opens
  useEffect(() => {
    if (isOpen && isAdmin) {
      loadConfig();
    }
  }, [isOpen, isAdmin]);
  
  const loadConfig = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const config = await apiGet<SSOFullConfig>('/api/sso/config/full');
      setEnabled(config.enabled);
      setTenantId(config.tenant_id || '');
      setClientId(config.client_id || '');
      setClientSecretPlaceholder(config.client_secret_masked || 'Enter client secret');
      setRedirectUri(config.redirect_uri || redirectHint);
      setAutoCreateUsers(config.auto_create_users);
      setDefaultRole(config.default_role || 'user');
    } catch (err) {
      console.error('Failed to load SSO config:', err);
      setError(err instanceof Error ? err.message : 'Failed to load configuration');
    } finally {
      setIsLoading(false);
    }
  };
  
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
    
    setIsSaving(true);
    
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
      setIsSaving(false);
    }
  };
  
  // Non-admin users can't access this modal
  if (!isAdmin) {
    return null;
  }
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title="SSO Configuration"
      size="md"
    >
      <div className={styles.container}>
        {isLoading ? (
          <div className={styles.loading}>Loading configuration...</div>
        ) : (
          <>
            {error && <div className={styles.error}>{error}</div>}
            {success && <div className={styles.success}>{success}</div>}
            
            {/* Enable SSO Toggle */}
            <div className={styles.toggleSection}>
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span className={styles.toggleSwitch}></span>
                <span className={styles.toggleLabel}>Enable SSO</span>
              </label>
              <p className={styles.hint}>
                When enabled, users can sign in using Microsoft Entra (Azure AD).
              </p>
            </div>
            
            {/* Microsoft Entra Settings */}
            <div className={styles.section}>
              <h4>Microsoft Entra Settings</h4>
              
              <div className={styles.field}>
                <label htmlFor="tenantId">Tenant ID *</label>
                <input
                  type="text"
                  id="tenantId"
                  value={tenantId}
                  onChange={(e) => setTenantId(e.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  disabled={!enabled}
                />
                <span className={styles.hint}>
                  Found in Azure Portal → Microsoft Entra ID → Overview
                </span>
              </div>
              
              <div className={styles.field}>
                <label htmlFor="clientId">Client ID (Application ID) *</label>
                <input
                  type="text"
                  id="clientId"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  disabled={!enabled}
                />
                <span className={styles.hint}>
                  Found in App Registration → Overview → Application (client) ID
                </span>
              </div>
              
              <div className={styles.field}>
                <label htmlFor="clientSecret">Client Secret</label>
                <input
                  type="password"
                  id="clientSecret"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={clientSecretPlaceholder || 'Enter client secret'}
                  disabled={!enabled}
                />
                <span className={styles.hint}>
                  Leave blank to keep existing secret. Create in App Registration → Certificates & secrets
                </span>
              </div>
              
              <div className={styles.field}>
                <label htmlFor="redirectUri">Redirect URI *</label>
                <input
                  type="text"
                  id="redirectUri"
                  value={redirectUri}
                  onChange={(e) => setRedirectUri(e.target.value)}
                  placeholder={redirectHint}
                  disabled={!enabled}
                />
                <span className={styles.hint}>
                  Must be registered in App Registration → Authentication → Redirect URIs
                </span>
              </div>
            </div>
            
            {/* User Management Settings */}
            <div className={styles.section}>
              <h4>User Management</h4>
              
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={autoCreateUsers}
                  onChange={(e) => setAutoCreateUsers(e.target.checked)}
                  disabled={!enabled}
                />
                <span>Auto-create users on first SSO login</span>
              </label>
              
              <div className={styles.field}>
                <label htmlFor="defaultRole">Default role for new users</label>
                <select
                  id="defaultRole"
                  value={defaultRole}
                  onChange={(e) => setDefaultRole(e.target.value as 'user' | 'superuser' | 'admin')}
                  disabled={!enabled || !autoCreateUsers}
                >
                  <option value="user">User</option>
                  <option value="superuser">SuperUser</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>
            
            {/* Actions */}
            <div className={styles.actions}>
              <Button variant="secondary" onClick={closeModal}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving ? 'Saving...' : 'Save Configuration'}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
