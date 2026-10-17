/**
 * OrganizationDetailsModal
 * Modal showing organization details with SSO configuration and tenant management
 */

import { useId, useState, useEffect, useCallback } from 'react';
import { Notice } from '@/components/common/Notice';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
import { useAdminStore } from '@/stores/adminStore';
import { 
  getOrganization, 
  updateOrganization,
  updateOrganizationSSOConfig,
  testOrganizationSSOConfig,
  removeTenantFromOrganization,
  addTenantToOrganization,
  updateTenantGroupAccess,
} from '@/api';
import type { OrganizationDetail, OrganizationSSOTestResult, TenantSummary } from '@/api/endpoints/admin';
import { useEscapeKey } from '@/hooks';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { confirmAction } from '@/utils/confirmDialog';
import styles from './AdminModal.module.css';

/** Roles a tenant `users.role` CHECK accepts -- the only valid SSO default roles */
const SSO_DEFAULT_ROLES = ['user', 'superuser', 'admin'] as const;
type SsoDefaultRole = (typeof SSO_DEFAULT_ROLES)[number];

const DEFAULT_ROLE_OPTIONS = [
  { value: 'user', label: 'User' },
  { value: 'superuser', label: 'SuperUser' },
  { value: 'admin', label: 'Admin' },
];

const MEMBERSHIP_MODE_OPTIONS = [
  { value: 'any', label: 'Any (user must be in at least ONE group)' },
  { value: 'all', label: 'All (user must be in ALL groups)' },
];

interface OrganizationDetailsModalProps {
  organizationId: string;
  onClose: () => void;
  onRefresh?: () => void;
}

type Tab = 'details' | 'sso' | 'tenants';

export function OrganizationDetailsModal({ organizationId, onClose, onRefresh }: OrganizationDetailsModalProps) {
  const allTenants = useAdminStore((s) => s.tenants);
  
  const [organization, setOrganization] = useState<OrganizationDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('details');
  
  // Edit states
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  
  // SSO states
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [entraTenantId, setEntraTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [autoCreateUsers, setAutoCreateUsers] = useState(false);
  const [defaultUserRole, setDefaultUserRole] = useState('user');
  const [isSavingSSO, setIsSavingSSO] = useState(false);
  const [ssoSuccess, setSsoSuccess] = useState<string | null>(null);
  const [isTestingSSO, setIsTestingSSO] = useState(false);
  const [ssoTestResult, setSsoTestResult] = useState<OrganizationSSOTestResult | null>(null);
  
  // Tenant management states
  const [tenantNotice, setTenantNotice] = useState<string | null>(null);
  const [selectedTenantToAdd, setSelectedTenantToAdd] = useState('');
  const [editingTenant, setEditingTenant] = useState<string | null>(null);
  const [tenantGroupIds, setTenantGroupIds] = useState('');
  const [tenantGroupMode, setTenantGroupMode] = useState<'any' | 'all'>('any');

  // One write at a time (save details / SSO, add / remove tenant, save
  // groups): a double click must not send the request twice.
  const { isSubmitting: isBusy, begin: beginWrite, end: endWrite } = useSubmitGuard();

  const redirectHint = typeof window !== 'undefined' 
    ? `${window.location.origin}/api/auth/sso/callback`
    : '/api/auth/sso/callback';

  const loadOrganization = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await getOrganization(organizationId);
      setOrganization(data);

      // Set edit fields
      setEditName(data.name);
      setEditDescription(data.description || '');

      // Set SSO fields
      if (data.sso_config) {
        setSsoEnabled(data.sso_config.enabled);
        setEntraTenantId(data.sso_config.entraTenantId || '');
        setClientId(data.sso_config.clientId || '');
        setRedirectUri(data.sso_config.redirectUri || redirectHint);
        setAutoCreateUsers(data.sso_config.autoCreateUsers);
        // Tenant users.role only allows these three; an older config may hold
        // an invalid value (e.g. "viewer") -- fall back to "user".
        setDefaultUserRole(
          SSO_DEFAULT_ROLES.includes(data.sso_config.defaultUserRole as SsoDefaultRole)
            ? data.sso_config.defaultUserRole
            : 'user'
        );
      } else {
        setRedirectUri(redirectHint);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load organization');
    } finally {
      setIsLoading(false);
    }
  }, [organizationId, redirectHint]);

  useEffect(() => {
    loadOrganization();
  }, [loadOrganization]);

  const handleSaveDetails = async () => {
    if (!organization) return;
    if (!beginWrite()) return;
    
    try {
      await updateOrganization(organization.id, {
        name: editName.trim(),
        description: editDescription.trim() || undefined,
      });
      await loadOrganization();
      setIsEditing(false);
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update organization');
    } finally {
      endWrite();
    }
  };

  /** Leave the inline details edit, dropping what was typed */
  const cancelDetailsEdit = () => {
    setIsEditing(false);
    if (organization) {
      setEditName(organization.name);
      setEditDescription(organization.description || '');
    }
  };

  const handleSaveSSO = async () => {
    if (!organization) return;
    
    setError(null);
    setSsoSuccess(null);
    
    // Validate if enabling
    if (ssoEnabled && (!entraTenantId.trim() || !clientId.trim() || !redirectUri.trim())) {
      setError('Tenant ID, Client ID, and Redirect URI are required to enable SSO');
      return;
    }
    
    if (!beginWrite()) return;
    setIsSavingSSO(true);
    
    try {
      const config: Record<string, unknown> = {
        enabled: ssoEnabled,
        entraTenantId: entraTenantId.trim(),
        clientId: clientId.trim(),
        redirectUri: redirectUri.trim(),
        autoCreateUsers,
        defaultUserRole,
      };
      
      if (clientSecret.trim()) {
        config.clientSecret = clientSecret.trim();
      }
      
      await updateOrganizationSSOConfig(organization.id, config);
      setSsoSuccess('SSO configuration saved successfully');
      setSsoTestResult(null);
      setClientSecret('');
      await loadOrganization();
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save SSO configuration');
    } finally {
      setIsSavingSSO(false);
      endWrite();
    }
  };

  const handleTestSSO = async () => {
    if (!organization) return;

    setError(null);
    setSsoSuccess(null);
    setSsoTestResult(null);
    setIsTestingSSO(true);

    try {
      setSsoTestResult(await testOrganizationSSOConfig(organization.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to test SSO configuration');
    } finally {
      setIsTestingSSO(false);
    }
  };

  const handleAddTenant = async () => {
    if (!organization || !selectedTenantToAdd) return;
    if (!beginWrite()) return;

    setTenantNotice(null);
    try {
      const result = await addTenantToOrganization(organization.id, selectedTenantToAdd);
      setSelectedTenantToAdd('');
      if (result?.tenant_had_own_sso) {
        setTenantNotice(
          'This tenant already had its own SSO configured. Organization SSO takes '
          + 'precedence, so the tenant-level SSO will no longer be used.'
        );
      }
      await loadOrganization();
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add tenant');
    } finally {
      endWrite();
    }
  };

  const handleRemoveTenant = async (tenantId: string) => {
    if (!organization) return;
    // Ask first, then take the guard: an open confirm must not hold the
    // in-flight flag and disable every other write while the user decides.
    if (!(await confirmAction({
      message: 'Remove this tenant from the organization?\n\nThe tenant will no longer use the organization\'s SSO configuration.',
      title: 'Detach tenant',
      confirmLabel: 'Remove',
      destructive: true,
    }))) {
      return;
    }
    if (!beginWrite()) return;
    try {
      await removeTenantFromOrganization(organization.id, tenantId);
      await loadOrganization();
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove tenant');
    } finally {
      endWrite();
    }
  };

  const handleEditTenantGroups = (tenant: TenantSummary) => {
    setEditingTenant(tenant.id);
    setTenantGroupIds(tenant.required_group_ids.join(', '));
    setTenantGroupMode(tenant.group_membership_mode);
  };

  const handleSaveTenantGroups = async () => {
    if (!editingTenant) return;
    if (!beginWrite()) return;
    
    try {
      const groupIds = tenantGroupIds
        .split(',')
        .map(id => id.trim())
        .filter(id => id);
      
      await updateTenantGroupAccess(editingTenant, {
        requiredGroupIds: groupIds,
        groupMembershipMode: tenantGroupMode,
      });
      
      setEditingTenant(null);
      await loadOrganization();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update tenant groups');
    } finally {
      endWrite();
    }
  };

  // Escape first leaves an open inline edit (details, tenant groups); only
  // with none open does it close the dialog, so typed input isn't lost.
  const titleId = useId();
  useEscapeKey(() => {
    if (isEditing) {
      cancelDetailsEdit();
    } else if (editingTenant) {
      setEditingTenant(null);
    } else {
      onClose();
    }
  });

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Get available tenants (not already in this organization)
  const availableTenants = allTenants.filter(t => 
    !organization?.tenants.some(ot => ot.id === t.id)
  );

  return (
    <div className={styles.overlay}>
      <div className={`${styles.modal} ${styles.wide}`} style={{ maxWidth: 800 }} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {organization?.name || 'Organization Details'}
          </h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close dialog">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Tab Navigation */}
        <div style={{
          display: 'flex',
          gap: '0.25rem',
          padding: '0.75rem 1.25rem',
          borderBottom: '1px solid var(--border-color)',
          background: 'var(--bg-tertiary)',
          flexShrink: 0,
        }}>
          {(['details', 'sso', 'tenants'] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '0.5rem 1rem',
                fontSize: '0.875rem',
                fontWeight: 500,
                background: activeTab === tab ? 'var(--bg-secondary)' : 'transparent',
                border: activeTab === tab ? '1px solid var(--border-color)' : '1px solid transparent',
                borderBottom: activeTab === tab ? '1px solid var(--bg-secondary)' : '1px solid transparent',
                borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
                color: activeTab === tab ? 'var(--accent-blue)' : 'var(--text-secondary)',
                cursor: 'pointer',
                marginBottom: '-1px',
                textTransform: 'capitalize',
              }}
            >
              {tab === 'sso' ? 'SSO Configuration' : tab}
            </button>
          ))}
        </div>

        <div className={styles.body}>
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
              Loading...
            </div>
          ) : error && !organization ? (
            <Notice tone="error">{error}</Notice>
          ) : organization ? (
            <>
              {error && <Notice tone="error" style={{ marginBottom: '1rem' }}>{error}</Notice>}
              
              {/* Details Tab */}
              {activeTab === 'details' && (
                <div>
                  {isEditing ? (
                    <div className={styles.form}>
                      <Input
                        label="Name"
                        type="text"
                        fullWidth
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                      />
                      <Input
                        label="Description"
                        type="text"
                        fullWidth
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                      />
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                        <button 
                          className={`${styles.btn} ${styles.btnPrimary}`}
                          onClick={handleSaveDetails}
                          disabled={isBusy}
                        >
                          Save
                        </button>
                        <button 
                          className={`${styles.btn} ${styles.btnSecondary}`}
                          onClick={cancelDetailsEdit}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className={styles.infoGrid}>
                        <div className={styles.infoRow}>
                          <span className={styles.infoLabel}>Name</span>
                          <span className={styles.infoValue}>{organization.name}</span>
                        </div>
                        <div className={styles.infoRow}>
                          <span className={styles.infoLabel}>Slug</span>
                          <code className={styles.infoValue}>{organization.slug}</code>
                        </div>
                        <div className={styles.infoRow}>
                          <span className={styles.infoLabel}>Description</span>
                          <span className={styles.infoValue}>{organization.description || '—'}</span>
                        </div>
                        <div className={styles.infoRow}>
                          <span className={styles.infoLabel}>SSO Status</span>
                          <span className={styles.infoValue}>
                            {organization.sso_config?.enabled ? (
                              <span className={`${styles.badge} ${styles.badgeSuccess}`}>Enabled</span>
                            ) : organization.sso_config?.configured ? (
                              <span className={`${styles.badge} ${styles.badgeWarning}`}>Configured (Disabled)</span>
                            ) : (
                              <span className={`${styles.badge} ${styles.badgeInfo}`}>Not configured</span>
                            )}
                          </span>
                        </div>
                        <div className={styles.infoRow}>
                          <span className={styles.infoLabel}>Tenants</span>
                          <span className={styles.infoValue}>{organization.tenants.length}</span>
                        </div>
                        <div className={styles.infoRow}>
                          <span className={styles.infoLabel}>Created</span>
                          <span className={styles.infoValue}>{formatDate(organization.created_at)}</span>
                        </div>
                      </div>
                      <button 
                        className={`${styles.btn} ${styles.btnSecondary}`}
                        onClick={() => setIsEditing(true)}
                        style={{ marginTop: '1rem' }}
                      >
                        Edit Details
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* SSO Configuration Tab */}
              {activeTab === 'sso' && (
                <div className={styles.form}>
                  {ssoSuccess && (
                    <div style={{ 
                      padding: '0.75rem', 
                      background: 'rgba(16, 185, 129, 0.15)', 
                      color: 'var(--accent-green)',
                      borderRadius: 'var(--radius-md)',
                      marginBottom: '1rem',
                      fontSize: '0.875rem'
                    }}>
                      {ssoSuccess}
                    </div>
                  )}
                  
                  {/* Enable Toggle */}
                  <div className={styles.formGroup}>
                    <ToggleSwitch
                      checked={ssoEnabled}
                      onChange={setSsoEnabled}
                      label="Enable SSO for this organization"
                    />
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                      When enabled, all tenants in this organization can use SSO login.
                      Organization SSO takes precedence over any SSO a member tenant
                      configured for itself, so tenant-level SSO settings are overridden.
                    </span>
                  </div>

                  <h4 className={styles.sectionTitle} style={{ marginTop: '1rem' }}>Microsoft Entra Settings</h4>
                  
                  <Input
                    label="Entra Tenant ID *"
                    type="text"
                    fullWidth
                    value={entraTenantId}
                    onChange={(e) => setEntraTenantId(e.target.value)}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    disabled={!ssoEnabled}
                  />

                  <Input
                    label="Client ID (Application ID) *"
                    type="text"
                    fullWidth
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    disabled={!ssoEnabled}
                  />

                  <Input
                    label="Client Secret"
                    type="password"
                    fullWidth
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder={organization.sso_config?.configured ? '••••••••••••••••' : 'Enter client secret'}
                    disabled={!ssoEnabled}
                    hint="Leave blank to keep existing secret."
                  />

                  <Input
                    label="Redirect URI *"
                    type="text"
                    fullWidth
                    value={redirectUri}
                    onChange={(e) => setRedirectUri(e.target.value)}
                    placeholder={redirectHint}
                    disabled={!ssoEnabled}
                  />

                  <h4 className={styles.sectionTitle}>User Management</h4>
                  
                  <div className={styles.formGroup}>
                    <ToggleSwitch
                      checked={autoCreateUsers}
                      onChange={setAutoCreateUsers}
                      disabled={!ssoEnabled}
                      label="Auto-create users on first SSO login"
                    />
                  </div>

                  <Select
                    label="Default role for new users"
                    fullWidth
                    value={defaultUserRole}
                    onChange={(e) => setDefaultUserRole(e.target.value)}
                    disabled={!ssoEnabled || !autoCreateUsers}
                    options={DEFAULT_ROLE_OPTIONS}
                  />

                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginTop: '1rem' }}>
                    <button
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      onClick={handleSaveSSO}
                      disabled={isBusy}
                    >
                      {isSavingSSO ? 'Saving...' : 'Save SSO Configuration'}
                    </button>
                    <button
                      className={styles.btn}
                      onClick={handleTestSSO}
                      disabled={isTestingSSO || isSavingSSO || !organization?.sso_config?.configured}
                      title="Ask Microsoft whether the saved credentials are accepted"
                    >
                      {isTestingSSO ? 'Testing...' : 'Test configuration'}
                    </button>
                  </div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem', display: 'block' }}>
                    The test checks the configuration that is <strong>saved</strong> — save your
                    changes first.
                  </span>

                  {ssoTestResult && (
                    <div style={{
                      marginTop: '1rem',
                      padding: '1rem',
                      background: 'var(--bg-tertiary)',
                      borderRadius: 'var(--radius-md)',
                      fontSize: '0.875rem',
                    }}>
                      <div style={{ fontWeight: 500, marginBottom: '0.75rem' }}>
                        {ssoTestResult.summary}
                      </div>
                      {ssoTestResult.checks.map((check, index) => (
                        <div
                          key={`${check.name}-${index}`}
                          style={{ display: 'flex', gap: '0.6rem', marginBottom: '0.6rem' }}
                        >
                          <span
                            aria-hidden="true"
                            style={{
                              flexShrink: 0,
                              color: check.status === 'pass' ? 'var(--accent-green)'
                                : check.status === 'fail' ? 'var(--accent-red)'
                                : 'var(--text-muted)',
                            }}
                          >
                            {check.status === 'pass' ? '✓'
                              : check.status === 'fail' ? '✕'
                              : check.status === 'warn' ? '!' : '?'}
                          </span>
                          <div>
                            <div style={{ fontWeight: 500 }}>
                              {check.name}
                              {check.code && (
                                <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                                  {' '}({check.code})
                                </span>
                              )}
                            </div>
                            <div style={{ color: 'var(--text-muted)' }}>{check.message}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Tenants Tab */}
              {activeTab === 'tenants' && (
                <div>
                  {tenantNotice && (
                    <div style={{
                      padding: '0.75rem 1rem',
                      background: 'rgba(59, 130, 246, 0.1)',
                      border: '1px solid rgba(59, 130, 246, 0.3)',
                      color: 'var(--text-primary)',
                      borderRadius: 'var(--radius-md)',
                      marginBottom: '1rem',
                      fontSize: '0.875rem',
                    }}>
                      {tenantNotice}
                    </div>
                  )}
                  {/* Add Tenant */}
                  <div style={{
                    display: 'flex', 
                    alignItems: 'center',
                    gap: '0.75rem', 
                    marginBottom: '1.5rem',
                    padding: '1rem',
                    background: 'var(--bg-tertiary)',
                    borderRadius: 'var(--radius-md)',
                  }}>
                    <Select
                      className={styles.addTenantSelect}
                      aria-label="Tenant to add"
                      value={selectedTenantToAdd}
                      onChange={(e) => setSelectedTenantToAdd(e.target.value)}
                      placeholder="Select a tenant to add..."
                      options={availableTenants.map((t) => ({ value: t.id, label: `${t.name} (${t.slug})` }))}
                    />
                    <button
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      onClick={handleAddTenant}
                      disabled={!selectedTenantToAdd || isBusy}
                    >
                      Add Tenant
                    </button>
                  </div>

                  {/* Tenant List */}
                  {organization.tenants.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                      No tenants assigned to this organization yet.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {organization.tenants.map((tenant) => (
                        <div
                          key={tenant.id}
                          style={{
                            padding: '1rem',
                            background: 'var(--bg-tertiary)',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--border-color)',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div>
                              <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                                {tenant.name}
                              </div>
                              <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                                <code>{tenant.slug}</code> • {tenant.status}
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                              <button
                                className={`${styles.btn} ${styles.btnSecondary}`}
                                onClick={() => handleEditTenantGroups(tenant)}
                                style={{ padding: '0.375rem 0.75rem', fontSize: '0.8125rem' }}
                              >
                                Configure Groups
                              </button>
                              <button
                                className={`${styles.btn} ${styles.btnSecondary}`}
                                onClick={() => handleRemoveTenant(tenant.id)}
                                disabled={isBusy}
                                style={{ padding: '0.375rem 0.75rem', fontSize: '0.8125rem', color: 'var(--accent-red)' }}
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                          
                          {/* Group requirements display/edit */}
                          {editingTenant === tenant.id ? (
                            <div style={{ marginTop: '1rem', padding: '1rem', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)' }}>
                              <Input
                                label="Required Group IDs"
                                type="text"
                                fullWidth
                                value={tenantGroupIds}
                                onChange={(e) => setTenantGroupIds(e.target.value)}
                                placeholder="group-id-1, group-id-2"
                                hint="Comma-separated Entra group IDs. Leave empty for no group restrictions."
                              />
                              <Select
                                label="Membership Mode"
                                fullWidth
                                value={tenantGroupMode}
                                onChange={(e) => setTenantGroupMode(e.target.value as 'any' | 'all')}
                                options={MEMBERSHIP_MODE_OPTIONS}
                              />
                              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                                <button
                                  className={`${styles.btn} ${styles.btnPrimary}`}
                                  onClick={handleSaveTenantGroups}
                                  disabled={isBusy}
                                  style={{ padding: '0.375rem 0.75rem', fontSize: '0.8125rem' }}
                                >
                                  Save
                                </button>
                                <button
                                  className={`${styles.btn} ${styles.btnSecondary}`}
                                  onClick={() => setEditingTenant(null)}
                                  style={{ padding: '0.375rem 0.75rem', fontSize: '0.8125rem' }}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : tenant.required_group_ids.length > 0 ? (
                            <div style={{ marginTop: '0.75rem', fontSize: '0.8125rem' }}>
                              <span style={{ color: 'var(--text-muted)' }}>Required groups: </span>
                              <span style={{ color: 'var(--text-secondary)' }}>
                                {tenant.required_group_ids.length} group(s) ({tenant.group_membership_mode} mode)
                              </span>
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : null}
        </div>

        <div className={styles.footer}>
          <button
            className={`${styles.btn} ${styles.btnSecondary}`}
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
