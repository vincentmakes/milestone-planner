/**
 * UsersPanel (Settings hub > Users)
 * 
 * Manage users - list, create, edit, delete.
 * Displays users in a table with role badges, job title, skills, and site assignments.
 * Includes comprehensive filtering by role, job title, status, site, and skills.
 * 
 * Permissions:
 * - Admin: Full CRUD on all users, roles and active status
 * - SuperUser: view and edit users (details, sites, skills) only. Creating,
 *   deleting, enabling/disabling and changing roles are admin-only on the
 *   backend, so those controls are hidden or disabled. A superuser cannot edit
 *   an admin account at all, and cannot change anyone's email or password
 *   but their own (the backend answers 403), so the Edit button is hidden on
 *   admin rows and the Email/Password fields are hidden for other people.
 *   Sites the superuser does not belong to are not in `appStore.sites`; the
 *   form keeps such links untouched and only sends `site_ids` once the site
 *   picker was actually used.
 */

import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { Notice } from '@/components/common/Notice';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { PanelToolbar } from '../PanelToolbar';
import { Icon, BackIcon, CheckIcon, CloseIcon, EditIcon, GearIcon, PlusIcon, ChevronDownIcon, FilterIcon } from '@/components/common/Icon';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useDataLoader } from '@/hooks/useDataLoader';
import { getUsers, createUser, updateUser, deleteUser } from '@/api/endpoints/users';
import type { User, UserRole, CreateUserRequest, UpdateUserRequest, Skill, Role } from '@/types';
import type { SettingsPanelProps } from '../types';
import { useReportDirty } from '../useReportDirty';
import { confirmAction } from '@/utils/confirmDialog';
import styles from './UsersPanel.module.css';
import { can } from '@/utils/permissions';
import { roleWithin } from '@/utils/roles';
import { useRoles } from '@/hooks/useRoles';
import { ADMIN_ROLE_KEY, DISABLEABLE_KEYS } from '@/types/permissions';
import { isSettingOn } from '@/utils/instanceSettings';

// Badge colours of the system roles; a custom role gets a neutral badge.
// The label is the role's current name (Settings → Roles can rename it).
const ROLE_CONFIG: Record<string, { label: string; color: string }> = {
  admin: { label: 'Admin', color: '#ef4444' },
  superuser: { label: 'SuperUser', color: '#f97316' },
  user: { label: 'User', color: '#3b82f6' },
};

export function UsersPanel({ onDirtyChange }: Partial<SettingsPanelProps>) {
  const openSettings = useUIStore((s) => s.openSettings);
  const sites = useAppStore((s) => s.sites);
  const skills = useAppStore((s) => s.skills);
  const teams = useAppStore((s) => s.teams);
  const currentUser = useAppStore((s) => s.currentUser);
  const roles = useRoles();
  const roleNames = useMemo(() => new Map(roles.map((r) => [r.key, r.name])), [roles]);
  const { refreshStaff } = useDataLoader();
  
  // State
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  
  // Filter state
  const [filterRole, setFilterRole] = useState<string>('all');
  const [filterJobTitle, setFilterJobTitle] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('active');
  const [filterSite, setFilterSite] = useState<string>('all');
  const [filterSkill, setFilterSkill] = useState<string>('all');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  
  // Permission checks
  const canManageSkills = can(currentUser, 'skills.manage');
  const canCreateUsers = can(currentUser, 'users.create');
  
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
    loadUsers();
  }, [loadUsers]);
  
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
  const jobTitleFilterOptions = useMemo(
    () => [{ value: 'all', label: 'All Job Titles' }, ...jobTitles.map((t) => ({ value: t, label: t }))],
    [jobTitles]
  );
  const siteFilterOptions = useMemo(
    () => [{ value: 'all', label: 'All Sites' }, ...sites.map((s) => ({ value: s.id, label: s.name }))],
    [sites]
  );
  const skillFilterOptions = useMemo(
    () => [{ value: 'all', label: 'All Skills' }, ...skills.map((s) => ({ value: s.id, label: s.name }))],
    [skills]
  );
  
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
  
  // Read-only here: membership is edited in Settings → Teams
  const getTeamNames = (teamIds: number[] | undefined) => {
    const names = (teamIds ?? []).map((id) => teams.find((t) => t.id === id)?.name).filter(Boolean);
    return names.length > 0 ? names.join(', ') : '—';
  };
  
  // users.edit, and users.edit_admins for an administrator account (else 403)
  const canEditUser = (user: User) =>
    can(currentUser, 'users.edit') &&
    (user.role !== ADMIN_ROLE_KEY || can(currentUser, 'users.edit_admins'));
  const handleEdit = (user: User) => { setEditingUser(user); setIsCreating(false); };
  const handleCreate = () => { setEditingUser(null); setIsCreating(true); };
  const handleCloseForm = () => { setEditingUser(null); setIsCreating(false); };
  // Users are also staff: keep the staff views in sync after each change
  const handleSave = async () => { await loadUsers(); handleCloseForm(); void refreshStaff(); };
  const handleDelete = async () => { await loadUsers(); handleCloseForm(); void refreshStaff(); };
  
  return (
    <div className={styles.container}>
      {(editingUser || isCreating) ? (
        <UserForm
          user={editingUser}
          sites={sites}
          skills={skills}
          currentUser={currentUser}
          roles={roles}
          jobTitleSuggestions={jobTitles}
          onSave={handleSave}
          onDelete={handleDelete}
          onCancel={handleCloseForm}
          onDirtyChange={onDirtyChange}
        />
      ) : (
        <>
          {/* Toolbar */}
          <PanelToolbar
            left={
              <>
                <div ref={filterRef} className={styles.filterWrapper}>
                  <button 
                    className={`${styles.filterTrigger} ${activeFilterCount > 0 ? styles.hasFilters : ''}`}
                    onClick={() => setIsFilterOpen(!isFilterOpen)}
                  >
                    <Icon icon={FilterIcon} size={14} />
                    <span>{activeFilterCount > 0 ? `${activeFilterCount} filter${activeFilterCount > 1 ? 's' : ''}` : 'Filter'}</span>
                    <Icon icon={ChevronDownIcon} size={12} className={`${styles.chevron} ${isFilterOpen ? styles.open : ''}`} />
                  </button>
                
                  {isFilterOpen && (
                    <div className={styles.filterDropdown}>
                      {activeFilterCount > 0 && (
                        <div className={styles.filterActions}>
                          <button className={styles.clearFilters} onClick={clearFilters}>Clear all filters</button>
                        </div>
                      )}
                      <div className={styles.filterGrid}>
                        <Select
                          label="Status"
                          className={styles.filterField}
                          options={[
                            { value: 'all', label: 'All' },
                            { value: 'active', label: 'Active' },
                            { value: 'disabled', label: 'Disabled' },
                          ]}
                          value={filterStatus}
                          onChange={(e) => setFilterStatus(e.target.value)}
                        />
                        <Select
                          label="Role"
                          className={styles.filterField}
                          options={[
                            { value: 'all', label: 'All Roles' },
                            ...roles.map((r) => ({ value: r.key, label: r.name })),
                          ]}
                          value={filterRole}
                          onChange={(e) => setFilterRole(e.target.value)}
                        />
                        <Select
                          label="Job Title"
                          className={styles.filterField}
                          options={jobTitleFilterOptions}
                          value={filterJobTitle}
                          onChange={(e) => setFilterJobTitle(e.target.value)}
                        />
                        <Select
                          label="Site"
                          className={styles.filterField}
                          options={siteFilterOptions}
                          value={filterSite}
                          onChange={(e) => setFilterSite(e.target.value)}
                        />
                        <Select
                          label="Skill"
                          className={styles.filterField}
                          options={skillFilterOptions}
                          value={filterSkill}
                          onChange={(e) => setFilterSkill(e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </div>
                <span className={styles.resultCount}>
                  {filteredUsers.length} user{filteredUsers.length !== 1 ? 's' : ''}
                  {activeFilterCount > 0 && ` (filtered from ${users.length})`}
                </span>
              </>
            }
            right={
              (canManageSkills || canCreateUsers) && (
                <>
                  {canManageSkills && (
                    <Button variant="secondary" icon={<Icon icon={GearIcon} />} onClick={() => openSettings('skills')}>
                      Manage Skills
                    </Button>
                  )}
                  {canCreateUsers && (
                    <Button icon={<Icon icon={PlusIcon} />} onClick={handleCreate}>
                      Add User
                    </Button>
                  )}
                </>
              )
            }
          />
          
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
                    <th>Teams</th>
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
                          {user.is_resource === false && (
                            <span className={styles.notBookableBadge}>Not bookable</span>
                          )}
                        </div>
                      </td>
                      <td className={styles.jobTitleCell}>
                        {user.job_title || <span className={styles.noValue}>—</span>}
                      </td>
                      <td>
                        <span
                          className={styles.roleBadge}
                          style={
                            ROLE_CONFIG[user.role]
                              ? { backgroundColor: `${ROLE_CONFIG[user.role].color}20`, color: ROLE_CONFIG[user.role].color }
                              : undefined
                          }
                        >
                          {roleNames.get(user.role) ?? user.role_name ?? ROLE_CONFIG[user.role]?.label ?? user.role}
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
                      <td className={styles.sitesCell} title={getTeamNames(user.team_ids)}>{getTeamNames(user.team_ids)}</td>
                      <td>
                        {canEditUser(user) && (
                          <button
                            type="button"
                            className={styles.editBtn}
                            onClick={() => handleEdit(user)}
                            title="Edit user"
                            aria-label={`Edit ${user.first_name} ${user.last_name}`}
                          >
                            <Icon icon={EditIcon} size={15} />
                          </button>
                        )}
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
  );
}

// =============================================================================
// JOB TITLE AUTOCOMPLETE
// =============================================================================

interface JobTitleAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
}

function JobTitleAutocomplete({ value, onChange, suggestions }: JobTitleAutocompleteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    const list = q
      ? suggestions.filter((s) => s.toLowerCase().includes(q))
      : suggestions;
    return list.slice(0, 50);
  }, [value, suggestions]);

  // Position the dropdown anchored under the input.
  useLayoutEffect(() => {
    if (!isOpen || !inputRef.current) return;
    const update = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      const top = rect.bottom + 4;
      const available = Math.max(120, window.innerHeight - top - 16);
      setDropdownStyle({
        top,
        left: rect.left,
        width: rect.width,
        maxHeight: Math.min(260, available),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [isOpen]);

  // Close on outside click.
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapperRef.current?.contains(target)) return;
      // The dropdown is portaled-feeling (position:fixed); check by class via element.closest
      if ((e.target as HTMLElement).closest?.(`[data-job-title-dropdown="true"]`)) return;
      setIsOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [isOpen]);

  const select = (val: string) => {
    onChange(val);
    setIsOpen(false);
    setHighlightIndex(-1);
    inputRef.current?.focus();
  };

  return (
    <div ref={wrapperRef} className={styles.autocompleteWrapper}>
      <input
        ref={inputRef}
        type="text"
        id="jobTitle"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setIsOpen(true);
          setHighlightIndex(-1);
        }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!isOpen) {
              setIsOpen(true);
              return;
            }
            setHighlightIndex((i) => Math.min((filtered.length - 1), i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlightIndex((i) => Math.max(-1, i - 1));
          } else if (e.key === 'Enter') {
            if (isOpen && highlightIndex >= 0 && filtered[highlightIndex]) {
              e.preventDefault();
              select(filtered[highlightIndex]);
            }
          } else if (e.key === 'Escape') {
            // Close only the suggestion list, not the enclosing dialog (the
            // shared Modal listens for Escape on document).
            if (isOpen && filtered.length > 0) {
              e.preventDefault();
              e.stopPropagation();
            }
            setIsOpen(false);
            setHighlightIndex(-1);
          }
        }}
        placeholder="e.g., Project Manager"
        autoComplete="off"
      />
      {isOpen && filtered.length > 0 && (
        <ul
          className={styles.autocompleteDropdown}
          style={dropdownStyle}
          data-job-title-dropdown="true"
          role="listbox"
        >
          {filtered.map((s, i) => (
            <li
              key={s}
              role="option"
              aria-selected={i === highlightIndex}
              className={`${styles.autocompleteOption} ${i === highlightIndex ? styles.autocompleteOptionActive : ''}`}
              onMouseDown={(e) => { e.preventDefault(); select(s); }}
              onMouseEnter={() => setHighlightIndex(i)}
            >
              <span className={styles.autocompleteText}>{s}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
  /** Every role (useRoles); empty while loading */
  roles: Role[];
  jobTitleSuggestions: string[];
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Minimum length of a new or changed password (the backend enforces it too) */
const MIN_PASSWORD_LENGTH = 8;

/** Order-insensitive equality of two id lists */
function sameIds(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** No permission key switched off (a stable reference for the memo below) */
const NO_DISABLED_KEYS: readonly string[] = [];

function UserForm({ user, sites, skills, currentUser, roles, jobTitleSuggestions, onSave, onDelete, onCancel, onDirtyChange }: UserFormProps) {
  // views.kanban is missing from /auth/me while the Kanban board is off; the
  // escalation guard then skips it, like the backend.
  const kanbanOn = useAppStore((s) => isSettingOn(s.instanceSettings, 'kanban_enabled'));
  const disabledKeys = kanbanOn ? NO_DISABLED_KEYS : DISABLEABLE_KEYS;

  const isEditing = !!user;
  
  const [firstName, setFirstName] = useState(user?.first_name || '');
  const [lastName, setLastName] = useState(user?.last_name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [password, setPassword] = useState('');
  const [jobTitle, setJobTitle] = useState(user?.job_title || '');
  const [role, setRole] = useState<UserRole>(user?.role || 'user');
  const [maxCapacity, setMaxCapacity] = useState(user?.max_capacity ?? 100);
  const [active, setActive] = useState(user?.active ?? true);
  // Bookable as a resource. A new account follows its role (the administrator
  // role is not bookable, the others are, like the backend default) until the
  // switch is used; then it keeps the choice.
  const initialIsResource = user?.is_resource ?? (user?.role || 'user') !== ADMIN_ROLE_KEY;
  const [isResourceChoice, setIsResourceChoice] = useState<boolean | null>(isEditing ? initialIsResource : null);
  const isResource = isResourceChoice ?? role !== ADMIN_ROLE_KEY;
  const [selectedSiteIds, setSelectedSiteIds] = useState<number[]>(user?.site_ids || []);
  // Whether the site picker was used: superusers only send site_ids then
  const [sitesTouched, setSitesTouched] = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState<number[]>(user?.skills?.map(s => s.id) || []);
  
  // Quick skill add state
  const [isAddingNewSkill, setIsAddingNewSkill] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [isCreatingSkill, setIsCreatingSkill] = useState(false);
  
  // Access to update global skills
  const setGlobalSkills = useAppStore((s) => s.setSkills);
  
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  // Deleting a user cascades on the server (it bypasses the What-If queue as
  // configuration) while the sandbox keeps showing the orphaned plan data, so
  // it is unavailable during What-If.
  const whatIf = useWhatIfBlocked();
  const deleteBlockedReason = whatIf.blocked ? whatIf.reason('Deleting users') : null;
  const [error, setError] = useState<string | null>(null);
  
  useReportDirty(
    onDirtyChange,
    firstName !== (user?.first_name || '') ||
      lastName !== (user?.last_name || '') ||
      email !== (user?.email || '') ||
      password !== '' ||
      jobTitle !== (user?.job_title || '') ||
      role !== (user?.role || 'user') ||
      maxCapacity !== (user?.max_capacity ?? 100) ||
      active !== (user?.active ?? true) ||
      isResource !== initialIsResource ||
      !sameIds(selectedSiteIds, user?.site_ids || []) ||
      !sameIds(selectedSkillIds, user?.skills?.map((s) => s.id) || [])
  );
  
  // Role, active status and deletion each need their key on the backend
  // (users.change_role, users.toggle_active, users.delete; a request without
  // it gets a 403). The escalation guard (app/services/user_access.py,
  // mirrored by roleWithin) lets an editor give only roles whose permissions
  // they hold, and change the role only of someone whose current role they
  // could have given; the administrator role is the administrators' alone
  // (roles.manage is locked to that role).
  const canAssignAdmin = can(currentUser, 'roles.manage');
  const mayChangeRoles = can(currentUser, 'users.change_role');
  // Nobody changes their own role or deletes/deactivates their own account
  // (the backend answers 400), so those controls are disabled on their own row.
  const isOwnAccount = isEditing && !!user && !!currentUser && user.id === currentUser.id;
  const initialRole = user?.role || 'user';
  const initialRoleDef = roles.find((r) => r.key === initialRole);
  const targetWithinMine =
    !isEditing ||
    (initialRoleDef ? roleWithin(initialRoleDef, currentUser, disabledKeys) : initialRole !== ADMIN_ROLE_KEY || canAssignAdmin);
  const canChangeRole = mayChangeRoles && !isOwnAccount && targetWithinMine;
  const roleOptions = useMemo(() => {
    const options = roles.map((r) => {
      const assignable = roleWithin(r, currentUser, disabledKeys);
      const suffix = assignable ? '' : r.key === ADMIN_ROLE_KEY ? ' (admin only)' : ' (more than your role)';
      return { value: r.key, label: `${r.name}${suffix}`, disabled: !assignable };
    });
    // Roles not loaded (yet): still show the account's own role.
    if (!options.some((o) => o.value === initialRole)) {
      options.unshift({ value: initialRole, label: user?.role_name ?? initialRole, disabled: false });
    }
    return options;
  }, [roles, currentUser, disabledKeys, initialRole, user?.role_name]);
  const roleHint = canChangeRole
    ? roleOptions.some((o) => o.disabled)
      ? "Roles granting permissions you don't hold can't be assigned"
      : undefined
    : !mayChangeRoles
      ? 'Your role cannot change roles'
      : isOwnAccount
        ? "You can't change your own role"
        : 'You can only change the role of users whose role grants no more than yours';
  const canDelete = can(currentUser, 'users.delete');
  const canToggleActive = isEditing && can(currentUser, 'users.toggle_active') && !isOwnAccount;
  // Other people's email and password need users.edit_credentials; everyone
  // keeps them for their own account.
  const isSelfEdit = isOwnAccount;
  const canEditCredentials = !isEditing || can(currentUser, 'users.edit_credentials') || isSelfEdit;
  // With sites.view_all the picker shows every site, so sending its state
  // never drops a link the editor cannot see.
  const canSeeAllSites = currentUser?.can_see_all_sites ?? false;
  
  const toggleSite = (siteId: number) => {
    setSitesTouched(true);
    setSelectedSiteIds(prev => prev.includes(siteId) ? prev.filter(id => id !== siteId) : [...prev, siteId]);
  };

  /**
   * The site ids to send on update. The picker only offers the editor's own
   * sites (`appStore.sites`), so links to any other site are carried over
   * from the user unchanged rather than dropped.
   */
  const buildSiteIdsPayload = (): number[] => {
    const visible = new Set(sites.map((s) => s.id));
    const picked = selectedSiteIds.filter((id) => visible.has(id));
    const unseen = (user?.site_ids ?? []).filter((id) => !visible.has(id));
    return [...picked, ...unseen.filter((id) => !picked.includes(id))];
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
    
    if (!firstName.trim() || !lastName.trim() || (canEditCredentials && !email.trim())) {
      setError('Please fill in all required fields');
      return;
    }
    if (!isEditing && !password) {
      setError('Password is required for new users');
      return;
    }
    if (password && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    
    if (!beginSubmit()) return;
    try {
      if (isEditing && user) {
        const data: UpdateUserRequest = {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          job_title: jobTitle.trim() || undefined,
          max_capacity: maxCapacity,
          is_resource: isResource,
          skill_ids: selectedSkillIds,
        };
        if (canEditCredentials) {
          data.email = email.trim();
          if (password) data.password = password;
        }
        // Without sites.view_all, site_ids go only when the picker was used,
        // so an unrelated edit never touches site links the editor cannot see.
        if (canSeeAllSites || sitesTouched) {
          data.site_ids = buildSiteIdsPayload();
        }
        if (canChangeRole) data.role = role;
        if (canToggleActive) data.active = active;
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
          is_resource: isResource,
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
      endSubmit();
    }
  };
  
  const handleDelete = async () => {
    if (!user || deleteBlockedReason) return;
    const confirmed = await confirmAction({
      title: 'Delete user',
      message: `Are you sure you want to delete "${user.first_name} ${user.last_name}"?\n\nThis action cannot be undone.`,
      destructive: true,
    });
    if (!confirmed) return;
    
    if (!beginSubmit()) return;
    try {
      await deleteUser(user.id);
      onDelete();
    } catch (err) {
      console.error('Failed to delete user:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    } finally {
      endSubmit();
    }
  };
  
  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <div className={styles.formHeader}>
        <h3>{isEditing ? 'Edit User' : 'Add User'}</h3>
        <Button type="button" variant="ghost" icon={<Icon icon={BackIcon} />} onClick={onCancel}>
          Back to list
        </Button>
      </div>
      
      {error && <Notice tone="error">{error}</Notice>}
      
      <div className={styles.formGrid}>
        <Input label="First Name *" fullWidth type="text" id="firstName" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Enter first name" required />
        <Input label="Last Name *" fullWidth type="text" id="lastName" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Enter last name" required />
        {canEditCredentials && (
          <>
            <Input label="Email *" fullWidth type="email" id="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Enter email address" required />
            <Input
              label={`Password ${isEditing ? '(leave blank to keep)' : '*'}`}
              fullWidth
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isEditing ? '••••••••' : `Min ${MIN_PASSWORD_LENGTH} characters`}
              required={!isEditing}
              minLength={MIN_PASSWORD_LENGTH}
            />
          </>
        )}
        <div className={styles.field}>
          <label htmlFor="jobTitle">Job Title</label>
          <JobTitleAutocomplete
            value={jobTitle}
            onChange={setJobTitle}
            suggestions={jobTitleSuggestions}
          />
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
        <Select
          label="Role *"
          fullWidth
          id="role"
          options={roleOptions}
          value={role}
          onChange={(e) => setRole(e.target.value as UserRole)}
          disabled={!canChangeRole}
          hint={roleHint}
        />
        {isEditing && (
          <div className={styles.field}>
            <label>Status</label>
            <ToggleSwitch
              className={styles.toggleLabel}
              checked={active}
              onChange={setActive}
              disabled={!canToggleActive}
              label="Active"
            />
            {!canToggleActive && <span className={styles.hint}>{!can(currentUser, 'users.toggle_active') ? 'Your role cannot enable or disable users' : user?.id === currentUser?.id ? "Can't disable yourself" : 'Insufficient permissions'}</span>}
          </div>
        )}
        <div className={styles.field}>
          <label>Resource</label>
          <ToggleSwitch
            className={styles.toggleLabel}
            checked={isResource}
            onChange={setIsResourceChoice}
            label="Bookable as a resource"
            aria-describedby="isResourceHint"
          />
          <span id="isResourceHint" className={styles.hint}>
            Appears in the Staff panel and can be booked on projects. Add the person to a site to list them there.
          </span>
        </div>
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
              <Input
                className={styles.newSkillField}
                aria-label="New skill name"
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
                    // Cancel the inline input only; keep the dialog open
                    e.preventDefault();
                    e.stopPropagation();
                    cancelNewSkill();
                  }
                }}
              />
              <button type="button" className={styles.confirmBtn} onClick={confirmNewSkill} disabled={isCreatingSkill} aria-label="Add skill" title="Add skill">
                <Icon icon={CheckIcon} size={14} />
              </button>
              <button type="button" className={styles.cancelBtn} onClick={cancelNewSkill} disabled={isCreatingSkill} aria-label="Cancel adding a skill" title="Cancel">
                <Icon icon={CloseIcon} size={14} />
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
          <Button
            type="button"
            variant="danger"
            onClick={handleDelete}
            disabled={isSubmitting || isOwnAccount || deleteBlockedReason !== null}
            title={isOwnAccount ? "You can't delete your own account" : deleteBlockedReason ?? undefined}
          >
            Delete User
          </Button>
        )}
        <div className={styles.rightActions}>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={isSubmitting}>Cancel</Button>
          <Button type="submit" loading={isSubmitting}>{isEditing ? 'Save Changes' : 'Create User'}</Button>
        </div>
      </div>
    </form>
  );
}
