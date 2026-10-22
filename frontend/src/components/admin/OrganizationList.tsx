/**
 * OrganizationList
 * List of organizations with actions for SSO management
 */

import { useState } from 'react';
import { useAdminStore } from '@/stores/adminStore';
import { deleteOrganization } from '@/api';
import type { Organization } from '@/api/endpoints/admin';
import { Button } from '@/components/common/Button';
import { Notice } from '@/components/common/Notice';
import { Icon, PlusIcon, TrashIcon, EyeIcon } from '@/components/common/Icon';
import { confirmAction } from '@/utils/confirmDialog';
import styles from './TenantList.module.css';

interface OrganizationListProps {
  onCreateNew: () => void;
  onViewDetails: (id: string) => void;
  onRefresh: () => void;
}

export function OrganizationList({ onCreateNew, onViewDetails, onRefresh }: OrganizationListProps) {
  const organizations = useAdminStore((s) => s.organizations);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleDelete = async (org: Organization) => {
    if (org.tenant_count > 0) {
      setError(`Cannot delete organization "${org.name}" - it has ${org.tenant_count} tenant(s) assigned.\n\nRemove all tenants from this organization first.`);
      return;
    }
    
    if (!(await confirmAction({
      message: `Delete organization "${org.name}"?\n\nThis will also delete its SSO configuration.\nThis action cannot be undone.`,
      title: 'Delete organization',
      confirmLabel: 'Delete',
      destructive: true,
    }))) {
      return;
    }
    
    setError(null);
    setActionLoading(org.id);
    try {
      await deleteOrganization(org.id);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setActionLoading(null);
    }
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
      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <h3>Total Organizations</h3>
          <div className={styles.statValue}>{organizations.length}</div>
        </div>
        <div className={`${styles.statCard} ${styles.success}`}>
          <h3>SSO Enabled</h3>
          <div className={styles.statValue}>
            {organizations.filter(o => o.sso_enabled).length}
          </div>
        </div>
        <div className={styles.statCard}>
          <h3>Total Tenants</h3>
          <div className={styles.statValue}>
            {organizations.reduce((sum, o) => sum + o.tenant_count, 0)}
          </div>
        </div>
      </div>

      {/* Organization Table */}
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <h2>Organizations</h2>
          <Button icon={<Icon icon={PlusIcon} />} onClick={onCreateNew}>
            Create Organization
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
                <th>Tenants</th>
                <th>SSO</th>
                <th>Description</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {organizations.length === 0 ? (
                <tr>
                  <td colSpan={7} className={styles.emptyMessage}>
                    No organizations found. Create an organization to enable shared SSO configuration across multiple tenants.
                  </td>
                </tr>
              ) : (
                organizations.map((org) => (
                  <tr key={org.id}>
                    <td>
                      <button 
                        className={styles.tenantName}
                        onClick={() => onViewDetails(org.id)}
                      >
                        {org.name}
                      </button>
                    </td>
                    <td>
                      <code className={styles.slug}>{org.slug}</code>
                    </td>
                    <td>{org.tenant_count}</td>
                    <td>
                      {org.sso_enabled ? (
                        <span className={`${styles.badge} ${styles.badgeSuccess}`}>Enabled</span>
                      ) : (
                        <span className={`${styles.badge} ${styles.badgeWarning}`}>Not configured</span>
                      )}
                    </td>
                    <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {org.description || '—'}
                    </td>
                    <td>{formatDate(org.created_at)}</td>
                    <td>
                      <div className={styles.actions}>
                        {actionLoading === org.id ? (
                          <span className={styles.loading}>Loading...</span>
                        ) : (
                          <>
                            <button
                              className={styles.btnSmall}
                              onClick={() => onViewDetails(org.id)}
                              title="View Details & Configure SSO"
                            >
                              <Icon icon={EyeIcon} size={14} />
                            </button>
                            
                            <button
                              className={`${styles.btnSmall} ${styles.btnDanger}`}
                              onClick={() => handleDelete(org)}
                              title="Delete Organization"
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

      {/* Info Panel */}
      <div className={styles.panel} style={{ padding: '1rem 1.25rem' }}>
        <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.875rem', color: 'var(--text-primary)' }}>
          About Organizations
        </h3>
        <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
          Organizations allow multiple tenants to share a single SSO configuration. This is useful for enterprises 
          with multiple departments or subsidiaries that use the same Microsoft Entra ID tenant. Each tenant within 
          an organization can have its own group-based access requirements to control which Entra groups can access 
          that specific tenant.
        </p>
      </div>
    </div>
  );
}
