/**
 * UserManagementModal
 * 
 * Admin modal for managing users - list, create, edit, delete.
 * Displays users in a table with role badges and site assignments.
 * 
 * Permissions:
 * - Admin: Full CRUD on all users
 * - SuperUser: CRU + Disable users (no delete), can promote users to SuperUser
 */

import { useState, useEffect, useCallback } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { getUsers, createUser, updateUser, deleteUser } from '@/api/endpoints/users';
import type { User, UserRole, CreateUserRequest, UpdateUserRequest } from '@/types';
import styles from './UserManagementModal.module.css';

// Role display configuration
const ROLE_CONFIG: Record<UserRole, { label: string; color: string }> = {
  admin: { label: 'Admin', color: '#ef4444' },
  superuser: { label: 'SuperUser', color: '#f97316' },
  user: { label: 'User', color: '#3b82f6' },
};

export function UserManagementModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const sites = useAppStore((s) => s.sites);
  const currentUser = useAppStore((s) => s.currentUser);
  
  const isOpen = activeModal === 'userManagement';
  
  // State
  const [users, setUsers] = useState<User[]>([]);
  const [showDisabled, setShowDisabled] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  
  // Permission checks
  const isAdmin = currentUser?.role === 'admin';
  const isSuperUser = currentUser?.role === 'superuser';
  const canManageUsers = isAdmin || isSuperUser;
  
  // Load users when modal opens or filter changes
  const loadUsers = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getUsers(showDisabled);
      setUsers(data);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setIsLoading(false);
    }
  }, [showDisabled]);
  
  useEffect(() => {
    if (isOpen) {
      loadUsers();
    }
  }, [isOpen, loadUsers]);
  
  // Get site names for a user
  const getSiteNames = (siteIds: number[]) => {
    if (!siteIds || siteIds.length === 0) return '—';
    return siteIds
      .map(id => sites.find(s => s.id === id)?.name)
      .filter(Boolean)
      .join(', ');
  };
  
  // Handle edit click
  const handleEdit = (user: User) => {
    setEditingUser(user);
    setIsCreating(false);
  };
  
  // Handle create new
  const handleCreate = () => {
    setEditingUser(null);
    setIsCreating(true);
  };
  
  // Handle close edit/create form
  const handleCloseForm = () => {
    setEditingUser(null);
    setIsCreating(false);
  };
  
  // Handle save (create or update)
  const handleSave = async () => {
    await loadUsers();
    handleCloseForm();
  };
  
  // Handle delete
  const handleDelete = async () => {
    await loadUsers();
    handleCloseForm();
  };
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title="User Management"
      size="xl"
    >
      <div className={styles.container}>
        {/* Show form if editing or creating */}
        {(editingUser || isCreating) ? (
          <UserForm
            user={editingUser}
            sites={sites}
            currentUser={currentUser}
            onSave={handleSave}
            onDelete={handleDelete}
            onCancel={handleCloseForm}
          />
        ) : (
          <>
            {/* Toolbar */}
            <div className={styles.toolbar}>
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={showDisabled}
                  onChange={(e) => setShowDisabled(e.target.checked)}
                />
                <span>Show disabled users</span>
              </label>
              
              {canManageUsers && (
                <Button onClick={handleCreate}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  Add User
                </Button>
              )}
            </div>
            
            {/* User list */}
            <div className={styles.tableWrapper}>
              {isLoading ? (
                <div className={styles.loading}>Loading users...</div>
              ) : users.length === 0 ? (
                <div className={styles.empty}>No users found</div>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Sites</th>
                      <th style={{ width: 60 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr 
                        key={user.id} 
                        className={!user.active ? styles.disabled : ''}
                      >
                        <td>
                          <div className={styles.nameCell}>
                            <span className={styles.userName}>
                              {user.first_name} {user.last_name}
                            </span>
                            {!user.active && (
                              <span className={styles.disabledBadge}>Disabled</span>
                            )}
                          </div>
                        </td>
                        <td className={styles.emailCell}>{user.email}</td>
                        <td>
                          <span 
                            className={styles.roleBadge}
                            style={{ 
                              backgroundColor: `${ROLE_CONFIG[user.role].color}20`,
                              color: ROLE_CONFIG[user.role].color
                            }}
                          >
                            {ROLE_CONFIG[user.role].label}
                          </span>
                        </td>
                        <td className={styles.sitesCell} title={getSiteNames(user.site_ids)}>
                          {getSiteNames(user.site_ids)}
                        </td>
                        <td>
                          <button 
                            className={styles.editBtn}
                            onClick={() => handleEdit(user)}
                            title="Edit user"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// =============================================================================
// USER FORM COMPONENT
// =============================================================================

interface UserFormProps {
  user: User | null;
  sites: { id: number; name: string }[];
  currentUser: User | null;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

function UserForm({ user, sites, currentUser, onSave, onDelete, onCancel }: UserFormProps) {
  const isEditing = !!user;
  const isAdmin = currentUser?.role === 'admin';
  const isSuperUser = currentUser?.role === 'superuser';
  
  // Form state
  const [firstName, setFirstName] = useState(user?.first_name || '');
  const [lastName, setLastName] = useState(user?.last_name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>(user?.role || 'user');
  const [active, setActive] = useState(user?.active ?? true);
  const [selectedSiteIds, setSelectedSiteIds] = useState<number[]>(user?.site_ids || []);
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Permission logic:
  // - Admin can assign any role
  // - SuperUser can assign 'user' or 'superuser' (not admin)
  const canAssignAdmin = isAdmin;
  const canAssignSuperUser = isAdmin || isSuperUser;
  
  // Can delete? Only admin can delete
  const canDelete = isAdmin;
  
  // Can toggle active?
  // - Admin can toggle anyone except themselves
  // - SuperUser can toggle non-admin users
  const canToggleActive = isEditing && (
    (isAdmin && user?.id !== currentUser?.id) ||
    (isSuperUser && user?.role !== 'admin')
  );
  
  // Toggle site selection
  const toggleSite = (siteId: number) => {
    setSelectedSiteIds(prev => 
      prev.includes(siteId)
        ? prev.filter(id => id !== siteId)
        : [...prev, siteId]
    );
  };
  
  // Handle form submit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    
    // Validation
    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setError('Please fill in all required fields');
      return;
    }
    
    if (!isEditing && !password) {
      setError('Password is required for new users');
      return;
    }
    
    if (!isEditing && password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    
    setIsSubmitting(true);
    
    try {
      if (isEditing && user) {
        const data: UpdateUserRequest = {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim(),
          role,
          active,
          site_ids: selectedSiteIds,
        };
        if (password) {
          data.password = password;
        }
        await updateUser(user.id, data);
      } else {
        const data: CreateUserRequest = {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim(),
          password,
          role,
          site_ids: selectedSiteIds,
        };
        await createUser(data);
      }
      onSave();
    } catch (err) {
      console.error('Failed to save user:', err);
      // Extract error message
      let message = 'Failed to save user';
      if (err instanceof Error) {
        message = err.message;
      }
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };
  
  // Handle delete
  const handleDelete = async () => {
    if (!user) return;
    
    const confirmed = window.confirm(
      `Are you sure you want to delete "${user.first_name} ${user.last_name}"?\n\nThis action cannot be undone.`
    );
    
    if (!confirmed) return;
    
    setIsSubmitting(true);
    try {
      await deleteUser(user.id);
      onDelete();
    } catch (err) {
      console.error('Failed to delete user:', err);
      let message = 'Failed to delete user';
      if (err instanceof Error) {
        message = err.message;
      }
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };
  
  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <div className={styles.formHeader}>
        <h3>{isEditing ? 'Edit User' : 'Add User'}</h3>
        <button 
          type="button" 
          className={styles.backBtn}
          onClick={onCancel}
        >
          ← Back to list
        </button>
      </div>
      
      {error && (
        <div className={styles.error}>{error}</div>
      )}
      
      <div className={styles.formGrid}>
        {/* First Name */}
        <div className={styles.field}>
          <label htmlFor="firstName">First Name *</label>
          <input
            type="text"
            id="firstName"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            placeholder="Enter first name"
            required
          />
        </div>
        
        {/* Last Name */}
        <div className={styles.field}>
          <label htmlFor="lastName">Last Name *</label>
          <input
            type="text"
            id="lastName"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder="Enter last name"
            required
          />
        </div>
        
        {/* Email */}
        <div className={styles.field}>
          <label htmlFor="email">Email *</label>
          <input
            type="email"
            id="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Enter email address"
            required
          />
        </div>
        
        {/* Password */}
        <div className={styles.field}>
          <label htmlFor="password">
            Password {isEditing ? '(leave blank to keep)' : '*'}
          </label>
          <input
            type="password"
            id="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={isEditing ? '••••••••' : 'Min 6 characters'}
            required={!isEditing}
            minLength={6}
          />
        </div>
        
        {/* Role */}
        <div className={styles.field}>
          <label htmlFor="role">Role *</label>
          <select
            id="role"
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
          >
            <option value="user">User</option>
            <option value="superuser" disabled={!canAssignSuperUser}>
              SuperUser
            </option>
            <option value="admin" disabled={!canAssignAdmin}>
              Admin {!canAssignAdmin ? '(admin only)' : ''}
            </option>
          </select>
        </div>
        
        {/* Active Status (only for editing) */}
        {isEditing && (
          <div className={styles.field}>
            <label>Status</label>
            <label className={styles.toggleLabel}>
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                disabled={!canToggleActive}
              />
              <span>Active</span>
            </label>
            {!canToggleActive && (
              <span className={styles.hint}>
                {user?.id === currentUser?.id 
                  ? "Can't disable yourself" 
                  : "Insufficient permissions"}
              </span>
            )}
          </div>
        )}
      </div>
      
      {/* Site Assignments */}
      <div className={styles.sitesSection}>
        <label>Site Assignments</label>
        <p className={styles.hint}>
          Select which sites this user can access.
        </p>
        <div className={styles.siteCheckboxes}>
          {sites.map((site) => (
            <label key={site.id} className={styles.siteCheckbox}>
              <input
                type="checkbox"
                checked={selectedSiteIds.includes(site.id)}
                onChange={() => toggleSite(site.id)}
              />
              <span>{site.name}</span>
            </label>
          ))}
          {sites.length === 0 && (
            <span className={styles.noSites}>No sites available</span>
          )}
        </div>
      </div>
      
      {/* Form Actions */}
      <div className={styles.formActions}>
        {isEditing && canDelete && (
          <Button
            type="button"
            variant="danger"
            onClick={handleDelete}
            disabled={isSubmitting}
          >
            Delete User
          </Button>
        )}
        
        <div className={styles.rightActions}>
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Saving...' : (isEditing ? 'Save Changes' : 'Create User')}
          </Button>
        </div>
      </div>
    </form>
  );
}
