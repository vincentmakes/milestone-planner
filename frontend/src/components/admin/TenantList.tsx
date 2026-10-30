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
import type { Tenant, TenantProvisionOptions } from '@/api/endpoints/admin';
import { Button } from '@/components/common/Button';
import { Notice } from '@/components/common/Notice';
import { Icon, PlusIcon, TrashIcon, PlayIcon, PauseIcon, LockIcon, DatabaseIcon, ExternalLinkIcon, EyeIcon } from '@/components/common/Icon';
import { confirmAction } from '@/utils/confirmDialog';
import { ProvisionTenantModal } from './modals/ProvisionTenantModal';
import styles from './TenantList.module.css';

interface TenantListProps {
  onCreateNew: () => void;
  onViewDetails: (id: string) => void;
  onShowCredentials: (title: string, email: string, password: string) => void;
  onRefresh: () => void;
}

/** Title and confirm-button wording for each target status. */
const STATUS_CONFIRM: Record<Tenant['status'], { title: string; confirmLabel: string }> = {
  active: { title: 'Activate tenant', confirmLabel: 'Activate' },
  suspended: { title: 'Suspend tenant', confirmLabel: 'Suspend' },
  archived: { title: 'Archive tenant', confirmLabel: 'Archive' },
  pending: { title: 'Change tenant status', confirmLabel: 'Change status' },
};

export function TenantList({ onCreateNew, onViewDetails, onShowCredentials, onRefresh }: TenantListProps) {
  const tenants = useAdminStore((s) => s.tenants);
  const systemStats = useAdminStore((s) => s.systemStats);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // The tenant whose Provision dialog (defaults or demo data) is open.
  const [provisionTarget, setProvisionTarget] = useState<Tenant | null>(null);

  const handleProvision = async (tenant: Tenant, options: TenantProvisionOptions) => {
    setProvisionTarget(null);
    setError(null);
    setActionLoading(tenant.id);
    try {
      const result = await provisionTenant(tenant.id, options);
      onShowCredentials('Database Provisioned!', result.adminEmail, result.adminPassword);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleResetPassword = async (tenant: Tenant) => {
    if (!(await confirmAction({
      message: 'This will generate a new password for the tenant admin. Continue?',
      title: 'Reset admin password',
      confirmLabel: 'Reset',
    }))) return;
    
    setError(null);
    setActionLoading(tenant.id);
    try {
      const result = await resetTenantAdminPassword(tenant.id);
      onShowCredentials('Password Reset!', result.email, result.password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleStatusChange = async (tenant: Tenant, status: Tenant['status']) => {
    if (!(await confirmAction({ message: `Change tenant status to ${status}?`, ...STATUS_CONFIRM[status] }))) return;
    
    setError(null);
    setActionLoading(tenant.id);
    try {
      await updateTenantStatus(tenant.id, status);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (tenant: Tenant) => {
    // Must be suspended first
    if (tenant.status === 'active') {
      setError('You must suspend the tenant before deleting it. This ensures no users are actively using the system.');
      return;
    }
    
    const confirmMsg = tenant.database_status?.accessible
      ? `Delete tenant "${tenant.name}"?\n\n⚠️ This will permanently delete:\n• The tenant record\n• The tenant database and all its data\n\nThis action cannot be undone.`
      : `Delete tenant "${tenant.name}"?\n\nThis will remove the tenant record.\nThis action cannot be undone.`;
    
    if (!(await confirmAction({ message: confirmMsg, title: 'Delete tenant', confirmLabel: 'Delete', destructive: true }))) return;
    
    setError(null);
    setActionLoading(tenant.id);
    try {
      // Always delete database if it exists
      await deleteTenant(tenant.id, true);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
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
    return new Date(dateStr).toLocaleDateString(undefined, {
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
          <Button icon={<Icon icon={PlusIcon} />} onClick={onCreateNew}>
            Create Tenant
          </Button>
        </div>

        {error && (
          <Notice tone="error" onDismiss={() => setError(null)} className={styles.listNotice}>
            {error}
          </Notice>
        )}

        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Status</th>
                <th>Database</th>
                <th>Organization</th>
                <th>Admin Email</th>
                <th>Plan</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tenants.length === 0 ? (
                <tr>
                  <td colSpan={9} className={styles.emptyMessage}>
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
                      <a
                        className={styles.slug}
                        href={`/t/${tenant.slug}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Open ${tenant.name} (opens in a new tab)`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {tenant.slug}
                      </a>
                    </td>
                    <td>{getStatusBadge(tenant.status)}</td>
                    <td>{getDbStatusBadge(tenant.database_status)}</td>
                    <td>
                      {tenant.organization_name ? (
                        <span style={{ fontSize: 'var(--font-size-md)' }}>
                          {tenant.organization_name}
                          {tenant.required_group_ids && tenant.required_group_ids.length > 0 && (
                            <span style={{ marginLeft: '0.25rem', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                              ({tenant.required_group_ids.length} groups)
                            </span>
                          )}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-md)' }}>—</span>
                      )}
                    </td>
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
                              <Icon icon={EyeIcon} size={14} />
                            </button>

                            {tenant.database_status?.accessible && tenant.status === 'active' && (
                              <a
                                className={styles.btnSmall}
                                href={`/t/${tenant.slug}/`}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Open tenant (new tab)"
                              >
                                <Icon icon={ExternalLinkIcon} size={14} />
                              </a>
                            )}

                            {!tenant.database_status?.accessible && (
                              <button
                                className={`${styles.btnSmall} ${styles.btnSuccess}`}
                                onClick={() => setProvisionTarget(tenant)}
                                title="Provision Database"
                              >
                                <Icon icon={DatabaseIcon} size={14} />
                              </button>
                            )}
                            
                            {tenant.database_status?.accessible && (
                              <button
                                className={styles.btnSmall}
                                onClick={() => handleResetPassword(tenant)}
                                title="Reset Admin Password"
                              >
                                <Icon icon={LockIcon} size={14} />
                              </button>
                            )}
                            
                            {tenant.status === 'active' && (
                              <button
                                className={`${styles.btnSmall} ${styles.btnWarning}`}
                                onClick={() => handleStatusChange(tenant, 'suspended')}
                                title="Suspend"
                              >
                                <Icon icon={PauseIcon} size={14} />
                              </button>
                            )}
                            
                            {tenant.status === 'suspended' && (
                              <button
                                className={`${styles.btnSmall} ${styles.btnSuccess}`}
                                onClick={() => handleStatusChange(tenant, 'active')}
                                title="Activate"
                              >
                                <Icon icon={PlayIcon} size={14} />
                              </button>
                            )}
                            
                            <button
                              className={`${styles.btnSmall} ${styles.btnDanger}`}
                              onClick={() => handleDelete(tenant)}
                              title="Delete Tenant"
                            >
                              <Icon icon={TrashIcon} size={14} />
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

      {provisionTarget && (
        <ProvisionTenantModal
          tenantName={provisionTarget.name}
          onClose={() => setProvisionTarget(null)}
          onConfirm={(options) => handleProvision(provisionTarget, options)}
        />
      )}
    </div>
  );
}
