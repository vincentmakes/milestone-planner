/**
 * OrganizationList
 * List of organizations with actions for SSO management
 */

import { useState } from 'react';
import { useAdminStore } from '@/stores/adminStore';
import { deleteOrganization } from '@/api';
import type { Organization } from '@/api/endpoints/admin';
import styles from './TenantList.module.css';

interface OrganizationListProps {
  onCreateNew: () => void;
  onViewDetails: (id: string) => void;
  onRefresh: () => void;
}

export function OrganizationList({ onCreateNew, onViewDetails, onRefresh }: OrganizationListProps) {
  const organizations = useAdminStore((s) => s.organizations);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleDelete = async (org: Organization) => {
    if (org.tenant_count > 0) {
      alert(`Cannot delete organization "${org.name}" - it has ${org.tenant_count} tenant(s) assigned.\n\nRemove all tenants from this organization first.`);
      return;
    }
    
    if (!confirm(`Delete organization "${org.name}"?\n\nThis will also delete its SSO configuration.\nThis action cannot be undone.`)) {
      return;
    }
    
    setActionLoading(org.id);
    try {
      await deleteOrganization(org.id);
      onRefresh();
    } catch (err) {
      alert('Error: ' + (err instanceof Error ? err.message : 'Unknown error'));
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
          <button className={styles.btnPrimary} onClick={onCreateNew}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Create Organization
          </button>
        </div>

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
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                <circle cx="12" cy="12" r="3" />
                              </svg>
                            </button>
                            
                            <button
                              className={`${styles.btnSmall} ${styles.btnDanger}`}
                              onClick={() => handleDelete(org)}
                              title="Delete Organization"
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
