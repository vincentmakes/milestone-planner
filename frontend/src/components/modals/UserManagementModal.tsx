/**
 * UserManagementModal
 * 
 * Admin modal for managing users - list, create, edit, delete.
 * Displays users in a table with role badges, job title, skills, and site assignments.
 * Includes comprehensive filtering by role, job title, status, site, and skills.
 * 
 * Permissions:
 * - Admin: Full CRUD on all users
 * - SuperUser: CRU + Disable users (no delete), can promote users to SuperUser
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useDataLoader } from '@/hooks/useDataLoader';
import { getUsers, createUser, updateUser, deleteUser } from '@/api/endpoints/users';
import { SkillsManagementModal } from './SkillsManagementModal';
import type { User, UserRole, CreateUserRequest, UpdateUserRequest, Skill } from '@/types';
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
  const skills = useAppStore((s) => s.skills);
  const currentUser = useAppStore((s) => s.currentUser);
  const { refreshStaff } = useDataLoader();
  
  const isOpen = activeModal === 'userManagement';
  
  // Track if any changes were made
  const [hasChanges, setHasChanges] = useState(false);
  
  // State
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showSkillsModal, setShowSkillsModal] = useState(false);
  
  // Filter state
  const [filterRole, setFilterRole] = useState<string>('all');
  const [filterJobTitle, setFilterJobTitle] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('active');
  const [filterSite, setFilterSite] = useState<string>('all');
  const [filterSkill, setFilterSkill] = useState<string>('all');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  
  // Permission checks
  const isAdmin = currentUser?.role === 'admin';
  const isSuperUser = currentUser?.role === 'superuser';
  const canManageUsers = isAdmin || isSuperUser;
  
  // Load users when modal opens
  const loadUsers = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getUsers(true); // Always load all including disabled
      setUsers(data);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);
  
  useEffect(() => {
    if (isOpen) {
      loadUsers();
    }
  }, [isOpen, loadUsers]);
  
  // Close filter dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setIsFilterOpen(false);
      }
    };
    if (isFilterOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isFilterOpen]);
  
  // Extract unique job titles
  const jobTitles = useMemo(() => {
    const titles = new Set<string>();
    users.forEach((u) => { if (u.job_title) titles.add(u.job_title); });
    return Array.from(titles).sort();
  }, [users]);
  
  // Filter users
  const filteredUsers = useMemo(() => {
    return users.filter((user) => {
      if (filterRole !== 'all' && user.role !== filterRole) return false;
      if (filterJobTitle !== 'all' && user.job_title !== filterJobTitle) return false;
      if (filterStatus === 'active' && !user.active) return false;
      if (filterStatus === 'disabled' && user.active) return false;
      if (filterSite !== 'all' && !user.site_ids.includes(parseInt(filterSite))) return false;
      if (filterSkill !== 'all') {
        const skillId = parseInt(filterSkill);
        if (!user.skills?.some((s) => s.id === skillId)) return false;
      }
      return true;
    });
  }, [users, filterRole, filterJobTitle, filterStatus, filterSite, filterSkill]);
  
  // Count active filters
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filterRole !== 'all') count++;
    if (filterJobTitle !== 'all') count++;
    if (filterStatus !== 'active') count++;
    if (filterSite !== 'all') count++;
    if (filterSkill !== 'all') count++;
    return count;
  }, [filterRole, filterJobTitle, filterStatus, filterSite, filterSkill]);
  
  const clearFilters = () => {
    setFilterRole('all');
    setFilterJobTitle('all');
    setFilterStatus('active');
    setFilterSite('all');
    setFilterSkill('all');
  };
  
  const getSiteNames = (siteIds: number[]) => {
    if (!siteIds || siteIds.length === 0) return '—';
    return siteIds.map(id => sites.find(s => s.id === id)?.name).filter(Boolean).join(', ');
  };
  
  const handleEdit = (user: User) => { setEditingUser(user); setIsCreating(false); };
  const handleCreate = () => { setEditingUser(null); setIsCreating(true); };
  const handleCloseForm = () => { setEditingUser(null); setIsCreating(false); };
  const handleSave = async () => { await loadUsers(); setHasChanges(true); handleCloseForm(); };
  const handleDelete = async () => { await loadUsers(); setHasChanges(true); handleCloseForm(); };
  
  // Handle modal close - refresh staff data if changes were made
  const handleClose = async () => {
    if (hasChanges) {
      await refreshStaff();
      setHasChanges(false);
    }
    closeModal();
  };
  
  return (
    <>
      <Modal isOpen={isOpen} onClose={handleClose} title="User Management" size="xxl">
        <div className={styles.container}>
          {(editingUser || isCreating) ? (
            <UserForm
              user={editingUser}
              sites={sites}
              skills={skills}
              currentUser={currentUser}
              onSave={handleSave}
              onDelete={handleDelete}
              onCancel={handleCloseForm}
            />
          ) : (
            <>
              {/* Toolbar */}
              <div className={styles.toolbar}>
                <div className={styles.toolbarLeft}>
                  <div ref={filterRef} className={styles.filterWrapper}>
                    <button 
                      className={`${styles.filterTrigger} ${activeFilterCount > 0 ? styles.hasFilters : ''}`}
                      onClick={() => setIsFilterOpen(!isFilterOpen)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                      </svg>
                      <span>{activeFilterCount > 0 ? `${activeFilterCount} filter${activeFilterCount > 1 ? 's' : ''}` : 'Filter'}</span>
                      <svg className={`${styles.chevron} ${isFilterOpen ? styles.open : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                    
                    {isFilterOpen && (
                      <div className={styles.filterDropdown}>
                        {activeFilterCount > 0 && (
                          <div className={styles.filterActions}>
                            <button className={styles.clearFilters} onClick={clearFilters}>Clear all filters</button>
                          </div>
                        )}
                        <div className={styles.filterGrid}>
                          <div className={styles.filterField}>
                            <label>Status</label>
                            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                              <option value="all">All</option>
                              <option value="active">Active</option>
                              <option value="disabled">Disabled</option>
                            </select>
                          </div>
                          <div className={styles.filterField}>
                            <label>Role</label>
                            <select value={filterRole} onChange={(e) => setFilterRole(e.target.value)}>
                              <option value="all">All Roles</option>
                              <option value="admin">Admin</option>
                              <option value="superuser">SuperUser</option>
                              <option value="user">User</option>
                            </select>
                          </div>
                          <div className={styles.filterField}>
                            <label>Job Title</label>
                            <select value={filterJobTitle} onChange={(e) => setFilterJobTitle(e.target.value)}>
                              <option value="all">All Job Titles</option>
                              {jobTitles.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </div>
                          <div className={styles.filterField}>
                            <label>Site</label>
                            <select value={filterSite} onChange={(e) => setFilterSite(e.target.value)}>
                              <option value="all">All Sites</option>
                              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                          </div>
                          <div className={styles.filterField}>
                            <label>Skill</label>
                            <select value={filterSkill} onChange={(e) => setFilterSkill(e.target.value)}>
                              <option value="all">All Skills</option>
                              {skills.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  <span className={styles.resultCount}>
                    {filteredUsers.length} user{filteredUsers.length !== 1 ? 's' : ''}
                    {activeFilterCount > 0 && ` (filtered from ${users.length})`}
                  </span>
                </div>
                
                <div className={styles.toolbarRight}>
                  {canManageUsers && (
                    <>
                      <Button variant="secondary" onClick={() => setShowSkillsModal(true)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '6px' }}>
                          <circle cx="12" cy="12" r="3" />
                          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                        </svg>
                        Manage Skills
                      </Button>
                      <Button onClick={handleCreate}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '6px' }}>
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        Add User
                      </Button>
                    </>
                  )}
                </div>
              </div>
              
              {/* User Table */}
              <div className={styles.tableWrapper}>
                {isLoading ? (
                  <div className={styles.loading}>Loading users...</div>
                ) : filteredUsers.length === 0 ? (
                  <div className={styles.empty}>
                    {activeFilterCount > 0 ? 'No users match the selected filters' : 'No users found'}
                  </div>
                ) : (
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Job Title</th>
                        <th>Role</th>
                        <th>Skills</th>
                        <th>Sites</th>
                        <th style={{ width: 60 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredUsers.map((user) => (
                        <tr key={user.id} className={!user.active ? styles.disabled : ''}>
                          <td>
                            <div className={styles.nameCell}>
                              <div className={styles.nameInfo}>
                                <span className={styles.userName}>{user.first_name} {user.last_name}</span>
                                <span className={styles.userEmail}>{user.email}</span>
                              </div>
                              {!user.active && <span className={styles.disabledBadge}>Disabled</span>}
                            </div>
                          </td>
                          <td className={styles.jobTitleCell}>
                            {user.job_title || <span className={styles.noValue}>—</span>}
                          </td>
                          <td>
                            <span className={styles.roleBadge} style={{ backgroundColor: `${ROLE_CONFIG[user.role].color}20`, color: ROLE_CONFIG[user.role].color }}>
                              {ROLE_CONFIG[user.role].label}
                            </span>
                          </td>
                          <td>
                            <div className={styles.skillsCell}>
                              {user.skills && user.skills.length > 0 ? (
                                <>
                                  {user.skills.slice(0, 3).map((skill) => (
                                    <span key={skill.id} className={styles.skillBadge} style={{ backgroundColor: `${skill.color}20`, color: skill.color }} title={skill.name}>
                                      {skill.name}
                                    </span>
                                  ))}
                                  {user.skills.length > 3 && <span className={styles.moreSkills}>+{user.skills.length - 3}</span>}
                                </>
                              ) : (
                                <span className={styles.noValue}>—</span>
                              )}
                            </div>
                          </td>
                          <td className={styles.sitesCell} title={getSiteNames(user.site_ids)}>{getSiteNames(user.site_ids)}</td>
                          <td>
                            <button className={styles.editBtn} onClick={() => handleEdit(user)} title="Edit user">
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
      <SkillsManagementModal isOpen={showSkillsModal} onClose={() => setShowSkillsModal(false)} />
    </>
  );
}

// =============================================================================
// USER FORM COMPONENT
// =============================================================================

interface UserFormProps {
  user: User | null;
  sites: { id: number; name: string }[];
  skills: Skill[];
  currentUser: User | null;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

function UserForm({ user, sites, skills, currentUser, onSave, onDelete, onCancel }: UserFormProps) {
  const isEditing = !!user;
  const isAdmin = currentUser?.role === 'admin';
  const isSuperUser = currentUser?.role === 'superuser';
  
  const [firstName, setFirstName] = useState(user?.first_name || '');
  const [lastName, setLastName] = useState(user?.last_name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [password, setPassword] = useState('');
  const [jobTitle, setJobTitle] = useState(user?.job_title || '');
  const [role, setRole] = useState<UserRole>(user?.role || 'user');
  const [maxCapacity, setMaxCapacity] = useState(user?.max_capacity ?? 100);
  const [active, setActive] = useState(user?.active ?? true);
  const [selectedSiteIds, setSelectedSiteIds] = useState<number[]>(user?.site_ids || []);
  const [selectedSkillIds, setSelectedSkillIds] = useState<number[]>(user?.skills?.map(s => s.id) || []);
  
  // Quick skill add state
  const [isAddingNewSkill, setIsAddingNewSkill] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [isCreatingSkill, setIsCreatingSkill] = useState(false);
  
  // Access to update global skills
  const setGlobalSkills = useAppStore((s) => s.setSkills);
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const canAssignAdmin = isAdmin;
  const canAssignSuperUser = isAdmin || isSuperUser;
  const canDelete = isAdmin;
  const canToggleActive = isEditing && ((isAdmin && user?.id !== currentUser?.id) || (isSuperUser && user?.role !== 'admin'));
  
  const toggleSite = (siteId: number) => {
    setSelectedSiteIds(prev => prev.includes(siteId) ? prev.filter(id => id !== siteId) : [...prev, siteId]);
  };
  
  const toggleSkill = (skillId: number) => {
    setSelectedSkillIds(prev => prev.includes(skillId) ? prev.filter(id => id !== skillId) : [...prev, skillId]);
  };
  
  // Quick skill creation
  const confirmNewSkill = async () => {
    if (!newSkillName.trim()) return;
    
    setIsCreatingSkill(true);
    try {
      const { skillsApi } = await import('@/api/endpoints/skills');
      const newSkill = await skillsApi.create({
        name: newSkillName.trim(),
        color: '#6366f1', // Default color
      });
      
      // Update global skills
      const allSkills = await skillsApi.getAll();
      setGlobalSkills(allSkills);
      
      // Select the new skill
      setSelectedSkillIds(prev => [...prev, newSkill.id]);
      
      setIsAddingNewSkill(false);
      setNewSkillName('');
    } catch (err) {
      console.error('Failed to create skill:', err);
      setError(err instanceof Error ? err.message : 'Failed to create skill');
    } finally {
      setIsCreatingSkill(false);
    }
  };
  
  const cancelNewSkill = () => {
    setIsAddingNewSkill(false);
    setNewSkillName('');
  };
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    
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
          job_title: jobTitle.trim() || undefined,
          role,
          max_capacity: maxCapacity,
          active,
          site_ids: selectedSiteIds,
          skill_ids: selectedSkillIds,
        };
        if (password) data.password = password;
        await updateUser(user.id, data);
      } else {
        const data: CreateUserRequest = {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim(),
          password,
          job_title: jobTitle.trim() || undefined,
          role,
          max_capacity: maxCapacity,
          site_ids: selectedSiteIds,
          skill_ids: selectedSkillIds,
        };
        await createUser(data);
      }
      onSave();
    } catch (err) {
      console.error('Failed to save user:', err);
      setError(err instanceof Error ? err.message : 'Failed to save user');
    } finally {
      setIsSubmitting(false);
    }
  };
  
  const handleDelete = async () => {
    if (!user) return;
    const confirmed = window.confirm(`Are you sure you want to delete "${user.first_name} ${user.last_name}"?\n\nThis action cannot be undone.`);
    if (!confirmed) return;
    
    setIsSubmitting(true);
    try {
      await deleteUser(user.id);
      onDelete();
    } catch (err) {
      console.error('Failed to delete user:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    } finally {
      setIsSubmitting(false);
    }
  };
  
  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <div className={styles.formHeader}>
        <h3>{isEditing ? 'Edit User' : 'Add User'}</h3>
        <button type="button" className={styles.backBtn} onClick={onCancel}>← Back to list</button>
      </div>
      
      {error && <div className={styles.error}>{error}</div>}
      
      <div className={styles.formGrid}>
        <div className={styles.field}>
          <label htmlFor="firstName">First Name *</label>
          <input type="text" id="firstName" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Enter first name" required />
        </div>
        <div className={styles.field}>
          <label htmlFor="lastName">Last Name *</label>
          <input type="text" id="lastName" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Enter last name" required />
        </div>
        <div className={styles.field}>
          <label htmlFor="email">Email *</label>
          <input type="email" id="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Enter email address" required />
        </div>
        <div className={styles.field}>
          <label htmlFor="password">Password {isEditing ? '(leave blank to keep)' : '*'}</label>
          <input type="password" id="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={isEditing ? '••••••••' : 'Min 6 characters'} required={!isEditing} minLength={6} />
        </div>
        <div className={styles.field}>
          <label htmlFor="jobTitle">Job Title</label>
          <input type="text" id="jobTitle" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="e.g., Project Manager" />
        </div>
        <div className={styles.field}>
          <label htmlFor="maxCapacity">Max Capacity: {maxCapacity}%</label>
          <div className={styles.sliderContainer}>
            <input
              type="range"
              className={styles.slider}
              id="maxCapacity"
              min="5"
              max="100"
              step="5"
              value={maxCapacity}
              onChange={(e) => setMaxCapacity(parseInt(e.target.value))}
            />
            <div className={styles.sliderLabels}>
              <span>5%</span>
              <span>50%</span>
              <span>100%</span>
            </div>
          </div>
          <span className={styles.hint}>
            {maxCapacity < 100 ? `Part-time worker (${maxCapacity}% capacity)` : 'Full-time worker'}
          </span>
        </div>
        <div className={styles.field}>
          <label htmlFor="role">Role *</label>
          <select id="role" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            <option value="user">User</option>
            <option value="superuser" disabled={!canAssignSuperUser}>SuperUser</option>
            <option value="admin" disabled={!canAssignAdmin}>Admin {!canAssignAdmin ? '(admin only)' : ''}</option>
          </select>
        </div>
        {isEditing && (
          <div className={styles.field}>
            <label>Status</label>
            <label className={styles.toggleLabel}>
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} disabled={!canToggleActive} />
              <span>Active</span>
            </label>
            {!canToggleActive && <span className={styles.hint}>{user?.id === currentUser?.id ? "Can't disable yourself" : "Insufficient permissions"}</span>}
          </div>
        )}
      </div>
      
      {/* Site Assignments - Button Style */}
      <div className={styles.field}>
        <label>Site Assignments</label>
        <div className={styles.optionButtons}>
          {sites.map((site) => (
            <button
              key={site.id}
              type="button"
              className={`${styles.optionButton} ${selectedSiteIds.includes(site.id) ? styles.selected : ''}`}
              onClick={() => toggleSite(site.id)}
            >
              {site.name}
            </button>
          ))}
          {sites.length === 0 && <span className={styles.noOptions}>No sites available</span>}
        </div>
        <span className={styles.hint}>Select which sites this user can access</span>
      </div>
      
      {/* Skills - Button Style with Quick Add */}
      <div className={styles.field}>
        <label>Skills</label>
        <div className={styles.optionButtons}>
          {skills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              className={`${styles.optionButton} ${styles.skillOption} ${selectedSkillIds.includes(skill.id) ? styles.selected : ''}`}
              onClick={() => toggleSkill(skill.id)}
              style={{
                '--skill-color': skill.color,
              } as React.CSSProperties}
            >
              <span className={styles.skillColorDot} style={{ backgroundColor: skill.color }} />
              {skill.name}
            </button>
          ))}
          {isAddingNewSkill ? (
            <div className={styles.newItemInput}>
              <input
                type="text"
                value={newSkillName}
                onChange={(e) => setNewSkillName(e.target.value)}
                placeholder="New skill name"
                autoFocus
                disabled={isCreatingSkill}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    confirmNewSkill();
                  } else if (e.key === 'Escape') {
                    cancelNewSkill();
                  }
                }}
              />
              <button type="button" className={styles.confirmBtn} onClick={confirmNewSkill} disabled={isCreatingSkill}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </button>
              <button type="button" className={styles.cancelBtn} onClick={cancelNewSkill} disabled={isCreatingSkill}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={`${styles.optionButton} ${styles.addNew}`}
              onClick={() => setIsAddingNewSkill(true)}
            >
              + New skill
            </button>
          )}
        </div>
        <span className={styles.hint}>Click to toggle skills. Skills are shared across all users.</span>
      </div>
      
      <div className={styles.formActions}>
        {isEditing && canDelete && (
          <Button type="button" variant="danger" onClick={handleDelete} disabled={isSubmitting}>Delete User</Button>
        )}
        <div className={styles.rightActions}>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={isSubmitting}>Cancel</Button>
          <Button type="submit" disabled={isSubmitting}>{isSubmitting ? 'Saving...' : (isEditing ? 'Save Changes' : 'Create User')}</Button>
        </div>
      </div>
    </form>
  );
}
