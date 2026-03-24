/**
 * OrganizationDetailsModal
 * Modal showing organization details with SSO configuration and tenant management
 */

import { useState, useEffect } from 'react';
import { useAdminStore } from '@/stores/adminStore';
import { 
  getOrganization, 
  updateOrganization,
  updateOrganizationSSOConfig,
  removeTenantFromOrganization,
  addTenantToOrganization,
  updateTenantGroupAccess,
} from '@/api';
import type { OrganizationDetail, TenantSummary } from '@/api/endpoints/admin';
import styles from './AdminModal.module.css';

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
  
  // Tenant management states
  const [selectedTenantToAdd, setSelectedTenantToAdd] = useState('');
  const [editingTenant, setEditingTenant] = useState<string | null>(null);
  const [tenantGroupIds, setTenantGroupIds] = useState('');
  const [tenantGroupMode, setTenantGroupMode] = useState<'any' | 'all'>('any');

  const redirectHint = typeof window !== 'undefined' 
    ? `${window.location.origin}/api/auth/sso/callback`
    : '/api/auth/sso/callback';

  useEffect(() => {
    loadOrganization();
  }, [organizationId]);

  const loadOrganization = async () => {
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
        setDefaultUserRole(data.sso_config.defaultUserRole);
      } else {
        setRedirectUri(redirectHint);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load organization');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveDetails = async () => {
    if (!organization) return;
    
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
      
      if (clientSecret) {
        config.clientSecret = clientSecret;
      }
      
      await updateOrganizationSSOConfig(organization.id, config);
      setSsoSuccess('SSO configuration saved successfully');
      setClientSecret('');
      await loadOrganization();
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save SSO configuration');
    } finally {
      setIsSavingSSO(false);
    }
  };

  const handleAddTenant = async () => {
    if (!organization || !selectedTenantToAdd) return;
    
    try {
      await addTenantToOrganization(organization.id, selectedTenantToAdd);
      setSelectedTenantToAdd('');
      await loadOrganization();
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add tenant');
    }
  };

  const handleRemoveTenant = async (tenantId: string) => {
    if (!organization) return;
    
    if (!confirm('Remove this tenant from the organization?\n\nThe tenant will no longer use the organization\'s SSO configuration.')) {
      return;
    }
    
    try {
      await removeTenantFromOrganization(organization.id, tenantId);
      await loadOrganization();
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove tenant');
    }
  };

  const handleEditTenantGroups = (tenant: TenantSummary) => {
    setEditingTenant(tenant.id);
    setTenantGroupIds(tenant.required_group_ids.join(', '));
    setTenantGroupMode(tenant.group_membership_mode);
  };

  const handleSaveTenantGroups = async () => {
    if (!editingTenant) return;
    
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
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

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
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={`${styles.modal} ${styles.wide}`} style={{ maxWidth: 800 }}>
        <div className={styles.header}>
          <h2 className={styles.title}>
            {organization?.name || 'Organization Details'}
          </h2>
          <button className={styles.closeBtn} onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
            <div className={styles.error}>{error}</div>
          ) : organization ? (
            <>
              {error && <div className={styles.error} style={{ marginBottom: '1rem' }}>{error}</div>}
              
              {/* Details Tab */}
              {activeTab === 'details' && (
                <div>
                  {isEditing ? (
                    <div className={styles.form}>
                      <div className={styles.formGroup}>
                        <label className={styles.label}>Name</label>
                        <input
                          type="text"
                          className={styles.input}
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                        />
                      </div>
                      <div className={styles.formGroup}>
                        <label className={styles.label}>Description</label>
                        <input
                          type="text"
                          className={styles.input}
                          value={editDescription}
                          onChange={(e) => setEditDescription(e.target.value)}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                        <button 
                          className={`${styles.btn} ${styles.btnPrimary}`}
                          onClick={handleSaveDetails}
                        >
                          Save
                        </button>
                        <button 
                          className={`${styles.btn} ${styles.btnSecondary}`}
                          onClick={() => setIsEditing(false)}
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
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={ssoEnabled}
                        onChange={(e) => setSsoEnabled(e.target.checked)}
                        style={{ width: 18, height: 18 }}
                      />
                      <span style={{ fontWeight: 500 }}>Enable SSO for this organization</span>
                    </label>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                      When enabled, all tenants in this organization can use SSO login.
                    </span>
                  </div>

                  <h4 className={styles.sectionTitle} style={{ marginTop: '1rem' }}>Microsoft Entra Settings</h4>
                  
                  <div className={styles.formGroup}>
                    <label className={styles.label}>Entra Tenant ID *</label>
                    <input
                      type="text"
                      className={styles.input}
                      value={entraTenantId}
                      onChange={(e) => setEntraTenantId(e.target.value)}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      disabled={!ssoEnabled}
                    />
                  </div>

                  <div className={styles.formGroup}>
                    <label className={styles.label}>Client ID (Application ID) *</label>
                    <input
                      type="text"
                      className={styles.input}
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      disabled={!ssoEnabled}
                    />
                  </div>

                  <div className={styles.formGroup}>
                    <label className={styles.label}>Client Secret</label>
                    <input
                      type="password"
                      className={styles.input}
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                      placeholder={organization.sso_config?.configured ? '••••••••••••••••' : 'Enter client secret'}
                      disabled={!ssoEnabled}
                    />
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Leave blank to keep existing secret.
                    </span>
                  </div>

                  <div className={styles.formGroup}>
                    <label className={styles.label}>Redirect URI *</label>
                    <input
                      type="text"
                      className={styles.input}
                      value={redirectUri}
                      onChange={(e) => setRedirectUri(e.target.value)}
                      placeholder={redirectHint}
                      disabled={!ssoEnabled}
                    />
                  </div>

                  <h4 className={styles.sectionTitle}>User Management</h4>
                  
                  <div className={styles.formGroup}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={autoCreateUsers}
                        onChange={(e) => setAutoCreateUsers(e.target.checked)}
                        disabled={!ssoEnabled}
                        style={{ width: 16, height: 16 }}
                      />
                      <span>Auto-create users on first SSO login</span>
                    </label>
                  </div>

                  <div className={styles.formGroup}>
                    <label className={styles.label}>Default role for new users</label>
                    <select
                      className={styles.select}
                      value={defaultUserRole}
                      onChange={(e) => setDefaultUserRole(e.target.value)}
                      disabled={!ssoEnabled || !autoCreateUsers}
                    >
                      <option value="viewer">Viewer</option>
                      <option value="user">User</option>
                      <option value="superuser">SuperUser</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>

                  <button
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={handleSaveSSO}
                    disabled={isSavingSSO}
                    style={{ marginTop: '1rem' }}
                  >
                    {isSavingSSO ? 'Saving...' : 'Save SSO Configuration'}
                  </button>
                </div>
              )}

              {/* Tenants Tab */}
              {activeTab === 'tenants' && (
                <div>
                  {/* Add Tenant */}
                  <div style={{ 
                    display: 'flex', 
                    gap: '0.75rem', 
                    marginBottom: '1.5rem',
                    padding: '1rem',
                    background: 'var(--bg-tertiary)',
                    borderRadius: 'var(--radius-md)',
                  }}>
                    <select
                      className={styles.select}
                      value={selectedTenantToAdd}
                      onChange={(e) => setSelectedTenantToAdd(e.target.value)}
                      style={{ flex: 1 }}
                    >
                      <option value="">Select a tenant to add...</option>
                      {availableTenants.map(t => (
                        <option key={t.id} value={t.id}>{t.name} ({t.slug})</option>
                      ))}
                    </select>
                    <button
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      onClick={handleAddTenant}
                      disabled={!selectedTenantToAdd}
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
                                style={{ padding: '0.375rem 0.75rem', fontSize: '0.8125rem', color: 'var(--accent-red)' }}
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                          
                          {/* Group requirements display/edit */}
                          {editingTenant === tenant.id ? (
                            <div style={{ marginTop: '1rem', padding: '1rem', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)' }}>
                              <div className={styles.formGroup}>
                                <label className={styles.label}>Required Group IDs</label>
                                <input
                                  type="text"
                                  className={styles.input}
                                  value={tenantGroupIds}
                                  onChange={(e) => setTenantGroupIds(e.target.value)}
                                  placeholder="group-id-1, group-id-2"
                                />
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                  Comma-separated Entra group IDs. Leave empty for no group restrictions.
                                </span>
                              </div>
                              <div className={styles.formGroup}>
                                <label className={styles.label}>Membership Mode</label>
                                <select
                                  className={styles.select}
                                  value={tenantGroupMode}
                                  onChange={(e) => setTenantGroupMode(e.target.value as 'any' | 'all')}
                                >
                                  <option value="any">Any (user must be in at least ONE group)</option>
                                  <option value="all">All (user must be in ALL groups)</option>
                                </select>
                              </div>
                              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                                <button
                                  className={`${styles.btn} ${styles.btnPrimary}`}
                                  onClick={handleSaveTenantGroups}
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
