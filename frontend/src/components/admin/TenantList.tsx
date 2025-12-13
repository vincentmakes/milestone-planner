/**
 * TenantList
 * List of tenants with actions
 */

import { useState } from 'react';
import { useAdminStore } from '@/stores/adminStore';
import { 
  updateTenantStatus, 
  provisionTenant, 
  resetTenantAdminPassword,
  deleteTenant,
} from '@/api';
import type { Tenant } from '@/api/endpoints/admin';
import styles from './TenantList.module.css';

interface TenantListProps {
  onCreateNew: () => void;
  onViewDetails: (id: string) => void;
  onShowCredentials: (title: string, email: string, password: string) => void;
  onRefresh: () => void;
}

export function TenantList({ onCreateNew, onViewDetails, onShowCredentials, onRefresh }: TenantListProps) {
  const tenants = useAdminStore((s) => s.tenants);
  const systemStats = useAdminStore((s) => s.systemStats);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleProvision = async (tenant: Tenant) => {
    if (!confirm('This will create the database for this tenant. Continue?')) return;
    
    setActionLoading(tenant.id);
    try {
      const result = await provisionTenant(tenant.id);
      onShowCredentials('Database Provisioned!', result.adminEmail, result.adminPassword);
      onRefresh();
    } catch (err) {
      alert('Error: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleResetPassword = async (tenant: Tenant) => {
    if (!confirm('This will generate a new password for the tenant admin. Continue?')) return;
    
    setActionLoading(tenant.id);
    try {
      const result = await resetTenantAdminPassword(tenant.id);
      onShowCredentials('Password Reset!', result.email, result.password);
    } catch (err) {
      alert('Error: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleStatusChange = async (tenant: Tenant, status: Tenant['status']) => {
    if (!confirm(`Change tenant status to ${status}?`)) return;
    
    setActionLoading(tenant.id);
    try {
      await updateTenantStatus(tenant.id, status);
      onRefresh();
    } catch (err) {
      alert('Error: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (tenant: Tenant) => {
    if (!confirm(`Delete tenant "${tenant.name}"? This action cannot be undone.`)) return;
    
    setActionLoading(tenant.id);
    try {
      await deleteTenant(tenant.id);
      onRefresh();
    } catch (err) {
      alert('Error: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setActionLoading(null);
    }
  };

  const getStatusBadge = (status: Tenant['status']) => {
    const classes: Record<string, string> = {
      active: styles.badgeSuccess,
      pending: styles.badgeWarning,
      suspended: styles.badgeDanger,
      archived: styles.badgeInfo,
    };
    return <span className={`${styles.badge} ${classes[status] || ''}`}>{status}</span>;
  };

  const getDbStatusBadge = (dbStatus?: { exists: boolean; accessible: boolean }) => {
    if (!dbStatus) return <span className={styles.badge}>Unknown</span>;
    if (dbStatus.accessible) return <span className={`${styles.badge} ${styles.badgeSuccess}`}>Connected</span>;
    if (dbStatus.exists) return <span className={`${styles.badge} ${styles.badgeWarning}`}>Exists</span>;
    return <span className={`${styles.badge} ${styles.badgeDanger}`}>Not provisioned</span>;
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <div className={styles.container}>
      {/* Stats Cards */}
      {systemStats && (
        <div className={styles.statsGrid}>
          <div className={styles.statCard}>
            <h3>Total Tenants</h3>
            <div className={styles.statValue}>{systemStats.tenants.total}</div>
          </div>
          <div className={`${styles.statCard} ${styles.success}`}>
            <h3>Active</h3>
            <div className={styles.statValue}>{systemStats.tenants.active}</div>
          </div>
          <div className={`${styles.statCard} ${styles.warning}`}>
            <h3>Pending</h3>
            <div className={styles.statValue}>{systemStats.tenants.pending}</div>
          </div>
          <div className={`${styles.statCard} ${styles.danger}`}>
            <h3>Suspended</h3>
            <div className={styles.statValue}>{systemStats.tenants.suspended}</div>
          </div>
        </div>
      )}

      {/* Tenant Table */}
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <h2>Tenants</h2>
          <button className={styles.btnPrimary} onClick={onCreateNew}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Create Tenant
          </button>
        </div>

        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Status</th>
                <th>Database</th>
                <th>Admin Email</th>
                <th>Plan</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tenants.length === 0 ? (
                <tr>
                  <td colSpan={8} className={styles.emptyMessage}>
                    No tenants found. Create your first tenant to get started.
                  </td>
                </tr>
              ) : (
                tenants.map((tenant) => (
                  <tr key={tenant.id}>
                    <td>
                      <button 
                        className={styles.tenantName}
                        onClick={() => onViewDetails(tenant.id)}
                      >
                        {tenant.name}
                      </button>
                      {tenant.company_name && (
                        <div className={styles.companyName}>{tenant.company_name}</div>
                      )}
                    </td>
                    <td>
                      <code className={styles.slug}>{tenant.slug}</code>
                    </td>
                    <td>{getStatusBadge(tenant.status)}</td>
                    <td>{getDbStatusBadge(tenant.database_status)}</td>
                    <td>{tenant.admin_email}</td>
                    <td>{tenant.plan}</td>
                    <td>{formatDate(tenant.created_at)}</td>
                    <td>
                      <div className={styles.actions}>
                        {actionLoading === tenant.id ? (
                          <span className={styles.loading}>Loading...</span>
                        ) : (
                          <>
                            <button
                              className={styles.btnSmall}
                              onClick={() => onViewDetails(tenant.id)}
                              title="View Details"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                <circle cx="12" cy="12" r="3" />
                              </svg>
                            </button>
                            
                            {!tenant.database_status?.accessible && (
                              <button
                                className={`${styles.btnSmall} ${styles.btnSuccess}`}
                                onClick={() => handleProvision(tenant)}
                                title="Provision Database"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <ellipse cx="12" cy="5" rx="9" ry="3" />
                                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                                  <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                                </svg>
                              </button>
                            )}
                            
                            {tenant.database_status?.accessible && (
                              <button
                                className={styles.btnSmall}
                                onClick={() => handleResetPassword(tenant)}
                                title="Reset Admin Password"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                </svg>
                              </button>
                            )}
                            
                            {tenant.status === 'active' && (
                              <button
                                className={`${styles.btnSmall} ${styles.btnWarning}`}
                                onClick={() => handleStatusChange(tenant, 'suspended')}
                                title="Suspend"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <rect x="6" y="4" width="4" height="16" />
                                  <rect x="14" y="4" width="4" height="16" />
                                </svg>
                              </button>
                            )}
                            
                            {tenant.status === 'suspended' && (
                              <button
                                className={`${styles.btnSmall} ${styles.btnSuccess}`}
                                onClick={() => handleStatusChange(tenant, 'active')}
                                title="Activate"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polygon points="5 3 19 12 5 21 5 3" />
                                </svg>
                              </button>
                            )}
                            
                            <button
                              className={`${styles.btnSmall} ${styles.btnDanger}`}
                              onClick={() => handleDelete(tenant)}
                              title="Delete Tenant"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              </svg>
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
