/**
 * AdminUserList
 * List of admin users (superadmin only)
 */

import { useState } from 'react';
import { useAdminStore } from '@/stores/adminStore';
import { deleteAdminUser, updateAdminUser } from '@/api';
import { Button } from '@/components/common/Button';
import { Notice } from '@/components/common/Notice';
import { Icon, PlusIcon, TrashIcon, CheckIcon, BanIcon } from '@/components/common/Icon';
import { confirmAction } from '@/utils/confirmDialog';
import styles from './TenantList.module.css'; // Reuse styles

interface AdminUserListProps {
  onCreateNew: () => void;
  onRefresh: () => void;
}

export function AdminUserList({ onCreateNew, onRefresh }: AdminUserListProps) {
  const adminUsers = useAdminStore((s) => s.adminUsers);
  const currentUser = useAdminStore((s) => s.adminUser);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const handleToggleActive = async (id: number, currentActive: boolean) => {
    setError(null);
    setActionLoading(id);
    try {
      await updateAdminUser(id, { active: !currentActive });
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (id: number, email: string) => {
    if (id === currentUser?.id) {
      setError('You cannot delete yourself.');
      return;
    }
    
    if (!(await confirmAction({
      message: `Delete admin user "${email}"?`,
      title: 'Delete admin',
      confirmLabel: 'Delete',
      destructive: true,
    }))) return;
    
    setError(null);
    setActionLoading(id);
    try {
      await deleteAdminUser(id);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
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
          <Button icon={<Icon icon={PlusIcon} />} onClick={onCreateNew}>
            Add Admin
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
                        <span style={{ marginLeft: 8, fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
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
                                <Icon icon={BanIcon} size={14} />
                              ) : (
                                <Icon icon={CheckIcon} size={14} />
                              )}
                            </button>
                            
                            <button
                              className={`${styles.btnSmall} ${styles.btnDanger}`}
                              onClick={() => handleDelete(user.id, user.email)}
                              title="Delete"
                              disabled={user.id === currentUser?.id}
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
    </div>
  );
}
