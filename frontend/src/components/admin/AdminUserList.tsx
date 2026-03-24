/**
 * AdminUserList
 * List of admin users (superadmin only)
 */

import { useState } from 'react';
import { useAdminStore } from '@/stores/adminStore';
import { deleteAdminUser, updateAdminUser } from '@/api';
import styles from './TenantList.module.css'; // Reuse styles

interface AdminUserListProps {
  onCreateNew: () => void;
  onRefresh: () => void;
}

export function AdminUserList({ onCreateNew, onRefresh }: AdminUserListProps) {
  const adminUsers = useAdminStore((s) => s.adminUsers);
  const currentUser = useAdminStore((s) => s.adminUser);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const handleToggleActive = async (id: number, currentActive: boolean) => {
    setActionLoading(id);
    try {
      await updateAdminUser(id, { active: !currentActive });
      onRefresh();
    } catch (err) {
      alert('Error: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (id: number, email: string) => {
    if (id === currentUser?.id) {
      alert('You cannot delete yourself.');
      return;
    }
    
    if (!confirm(`Delete admin user "${email}"?`)) return;
    
    setActionLoading(id);
    try {
      await deleteAdminUser(id);
      onRefresh();
    } catch (err) {
      alert('Error: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setActionLoading(null);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <div className={styles.container}>
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <h2>Admin Users</h2>
          <button className={styles.btnPrimary} onClick={onCreateNew}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Admin
          </button>
        </div>

        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th>Last Login</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {adminUsers.length === 0 ? (
                <tr>
                  <td colSpan={7} className={styles.emptyMessage}>
                    No admin users found.
                  </td>
                </tr>
              ) : (
                adminUsers.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.email}</strong>
                      {user.id === currentUser?.id && (
                        <span style={{ marginLeft: 8, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          (you)
                        </span>
                      )}
                    </td>
                    <td>{user.name}</td>
                    <td>
                      <span className={`${styles.badge} ${user.role === 'superadmin' ? styles.badgeInfo : ''}`}>
                        {user.role}
                      </span>
                    </td>
                    <td>
                      <span className={`${styles.badge} ${user.active ? styles.badgeSuccess : styles.badgeDanger}`}>
                        {user.active ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td>{formatDate(user.created_at)}</td>
                    <td>{formatDate(user.last_login)}</td>
                    <td>
                      <div className={styles.actions}>
                        {actionLoading === user.id ? (
                          <span className={styles.loading}>Loading...</span>
                        ) : (
                          <>
                            <button
                              className={`${styles.btnSmall} ${user.active ? styles.btnWarning : styles.btnSuccess}`}
                              onClick={() => handleToggleActive(user.id, user.active)}
                              title={user.active ? 'Disable' : 'Enable'}
                              disabled={user.id === currentUser?.id}
                            >
                              {user.active ? (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <circle cx="12" cy="12" r="10" />
                                  <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                                </svg>
                              ) : (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              )}
                            </button>
                            
                            <button
                              className={`${styles.btnSmall} ${styles.btnDanger}`}
                              onClick={() => handleDelete(user.id, user.email)}
                              title="Delete"
                              disabled={user.id === currentUser?.id}
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
