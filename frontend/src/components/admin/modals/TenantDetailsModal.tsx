/**
 * TenantDetailsModal
 * Modal showing detailed tenant information including organization membership
 */

import { useState, useEffect } from 'react';
import { getTenant, getTenantAuditLog } from '@/api';
import type { Tenant, AuditLogEntry } from '@/api/endpoints/admin';
import styles from './AdminModal.module.css';

interface TenantDetailsModalProps {
  tenantId: string;
  onClose: () => void;
  onShowCredentials?: (title: string, email: string, password: string) => void;
  onRefresh?: () => void;
}

export function TenantDetailsModal({ tenantId, onClose }: TenantDetailsModalProps) {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTenantDetails();
  }, [tenantId]);

  const loadTenantDetails = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [tenantData, logData] = await Promise.all([
        getTenant(tenantId),
        getTenantAuditLog(tenantId, 10),
      ]);
      setTenant(tenantData);
      setAuditLog(logData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tenant details');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
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
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={`${styles.modal} ${styles.wide}`}>
        <div className={styles.header}>
          <h2 className={styles.title}>Tenant Details</h2>
          <button className={styles.closeBtn} onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className={styles.body}>
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
              Loading...
            </div>
          ) : error ? (
            <div className={styles.error}>{error}</div>
          ) : tenant ? (
            <>
              {/* Header Info */}
              <div style={{ marginBottom: '1.5rem' }}>
                <h3 style={{ margin: 0, color: 'var(--text-primary)' }}>{tenant.name}</h3>
                {tenant.company_name && (
                  <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)' }}>{tenant.company_name}</p>
                )}
              </div>

              {/* Details Grid */}
              <div className={styles.infoGrid}>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Slug</span>
                  <code className={styles.infoValue}>{tenant.slug}</code>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Status</span>
                  <span className={styles.infoValue}>{getStatusBadge(tenant.status)}</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Database</span>
                  <span className={styles.infoValue}>{getDbStatusBadge(tenant.database_status)}</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>DB Name</span>
                  <code className={styles.infoValue}>{tenant.database_name}</code>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>DB User</span>
                  <code className={styles.infoValue}>{tenant.database_user}</code>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Admin Email</span>
                  <span className={styles.infoValue}>{tenant.admin_email}</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Plan</span>
                  <span className={styles.infoValue}>{tenant.plan}</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Max Users</span>
                  <span className={styles.infoValue}>{tenant.max_users}</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Max Projects</span>
                  <span className={styles.infoValue}>{tenant.max_projects}</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Created</span>
                  <span className={styles.infoValue}>{formatDate(tenant.created_at)}</span>
                </div>
              </div>

              {/* Organization Section */}
              <h4 className={styles.sectionTitle}>Organization & SSO</h4>
              <div className={styles.infoGrid}>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Organization</span>
                  <span className={styles.infoValue}>
                    {tenant.organization_name ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {tenant.organization_name}
                        <span className={`${styles.badge} ${styles.badgeInfo}`}>SSO via Org</span>
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>Not assigned</span>
                    )}
                  </span>
                </div>
                {tenant.organization_id && (
                  <>
                    <div className={styles.infoRow}>
                      <span className={styles.infoLabel}>Required Groups</span>
                      <span className={styles.infoValue}>
                        {tenant.required_group_ids && tenant.required_group_ids.length > 0 ? (
                          <span>{tenant.required_group_ids.length} group(s) configured</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>None (all org users allowed)</span>
                        )}
                      </span>
                    </div>
                    <div className={styles.infoRow}>
                      <span className={styles.infoLabel}>Group Mode</span>
                      <span className={styles.infoValue}>
                        {tenant.group_membership_mode === 'all' ? 'All groups required' : 'Any group allowed'}
                      </span>
                    </div>
                  </>
                )}
              </div>

              {/* Access URL */}
              <h4 className={styles.sectionTitle}>Access URL</h4>
              <div className={styles.codeBlock}>
                {window.location.origin}/t/{tenant.slug}/
              </div>

              {/* Audit Log */}
              {auditLog.length > 0 && (
                <>
                  <h4 className={styles.sectionTitle}>Recent Activity</h4>
                  <div className={styles.auditLog}>
                    {auditLog.map((log) => (
                      <div key={log.id} className={styles.auditEntry}>
                        <span className={styles.auditAction}>{log.action}</span>
                        <span className={styles.auditMeta}>
                          {formatDate(log.created_at)}
                          {log.actor && ` by ${log.actor}`}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
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
