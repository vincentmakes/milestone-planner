/**
 * RolesPanel (Settings hub > Roles)
 *
 * Two tabs:
 * - **Roles**: every role (system ones marked) with its user count; Add role
 *   and Edit open RoleForm (name, description, permission matrix); custom
 *   roles can be deleted (confirmed first; a 409 while users hold the role
 *   shows in a Notice).
 * - **Approvals**: ApprovalPoliciesForm, who approves the own-booking
 *   changes of roles holding them in "Needs approval" mode.
 *
 * Listed for `roles.manage` (the admin role alone: the backend's role and
 * policy writes are admin-only). The panel is the hub's single dirty
 * reporter: the open role form's input, or the Approvals tab's.
 */

import { useEffect, useId, useState } from 'react';
import { rolesApi } from '@/api';
import { Button } from '@/components/common/Button';
import { Notice } from '@/components/common/Notice';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { refreshRoles, useRoles } from '@/hooks/useRoles';
import type { PermissionCatalogue, Role } from '@/types';
import { confirmAction } from '@/utils/confirmDialog';
import { confirmRoleDelete } from '@/utils/roles';
import { PanelToolbar } from '../PanelToolbar';
import type { SettingsPanelProps } from '../types';
import { useReportDirty } from '../useReportDirty';
import { ApprovalPoliciesForm } from './ApprovalPoliciesForm';
import { Icon, EditIcon, PlusIcon, TrashIcon } from '@/components/common/Icon';
import { RoleForm } from './RoleForm';
import styles from './RolesPanel.module.css';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

type Tab = 'roles' | 'approvals';

export function RolesPanel({ onDirtyChange }: Partial<SettingsPanelProps>) {
  const roles = useRoles();
  const tabsId = useId();

  const [tab, setTab] = useState<Tab>('roles');
  // The role being edited, 'new' for the add form, null for the list.
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const editingRole = typeof editing === 'number' ? roles.find((r) => r.id === editing) ?? null : null;
  const formOpen = editing === 'new' || editingRole !== null;

  const [catalogue, setCatalogue] = useState<PermissionCatalogue | null>(null);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    rolesApi
      .getPermissions()
      .then((loaded) => {
        if (!cancelled) setCatalogue(loaded);
      })
      .catch((err) => {
        if (!cancelled) setCatalogueError(err instanceof Error ? err.message : 'Failed to load permissions');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [error, setError] = useState<string | null>(null);
  const { begin: beginSubmit, end: endSubmit } = useSubmitGuard();

  // One combined flag: the open form, or the Approvals tab.
  const [formDirty, setFormDirty] = useState(false);
  const [policiesDirty, setPoliciesDirty] = useState(false);
  useReportDirty(onDirtyChange, formOpen ? formDirty : tab === 'approvals' && policiesDirty);

  const switchTab = async (next: Tab) => {
    if (next === tab) return;
    if (
      tab === 'approvals' &&
      policiesDirty &&
      !(await confirmAction({
        title: 'Discard changes',
        message: 'Discard your unsaved approval changes?',
        confirmLabel: 'Discard',
        destructive: true,
      }))
    ) {
      return;
    }
    setPoliciesDirty(false);
    setError(null);
    setTab(next);
  };

  const handleDelete = async (role: Role) => {
    // Confirm before taking the guard, so an open dialog never holds it.
    if (!(await confirmRoleDelete(role)) || !beginSubmit()) return;
    setError(null);
    try {
      await rolesApi.delete(role.id);
      await refreshRoles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete role');
    } finally {
      endSubmit();
    }
  };

  const closeForm = () => {
    setFormDirty(false);
    setEditing(null);
  };

  if (formOpen) {
    return (
      <RoleForm
        key={editingRole?.id ?? 'new'}
        role={editingRole}
        catalogue={catalogue}
        catalogueError={catalogueError}
        existingKeys={roles.map((r) => r.key)}
        onBack={closeForm}
        onSaved={closeForm}
        onDeleted={closeForm}
        onDirtyChange={setFormDirty}
      />
    );
  }

  const tabId = (t: Tab) => `${tabsId}-${t}`;
  const customCount = roles.filter((r) => !r.is_system).length;

  return (
    <div className={styles.container}>
      <div className={styles.tabs} role="tablist" aria-label="Roles and approvals">
        {(['roles', 'approvals'] as const).map((t) => (
          <button
            key={t}
            id={tabId(t)}
            type="button"
            role="tab"
            aria-selected={tab === t}
            aria-controls={`${tabsId}-panel`}
            className={`${styles.tab} ${tab === t ? styles.activeTab : ''}`}
            onClick={() => switchTab(t)}
          >
            {t === 'roles' ? 'Roles' : 'Approvals'}
          </button>
        ))}
      </div>

      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={tabId(tab)}>
        {tab === 'approvals' ? (
          <ApprovalPoliciesForm roles={roles} onDirtyChange={setPoliciesDirty} />
        ) : (
          <>
            <PanelToolbar
              left={<span className={styles.count}>{plural(roles.length, 'role')}</span>}
              right={
                <Button
                  icon={<Icon icon={PlusIcon} />}
                  onClick={() => {
                    setError(null);
                    setEditing('new');
                  }}
                >
                  Add role
                </Button>
              }
            />

            {error && (
              <Notice tone="error" className={styles.notice}>
                {error}
              </Notice>
            )}
            {catalogueError && (
              <Notice tone="error" className={styles.notice}>
                {catalogueError}
              </Notice>
            )}

            {roles.length === 0 ? (
              <div className={styles.empty}>Loading roles...</div>
            ) : (
              <>
                <ul className={styles.list}>
                  {roles.map((role) => (
                    <li key={role.id} className={styles.row}>
                      <div className={styles.info}>
                        <span className={styles.nameLine}>
                          <span className={styles.name}>{role.name}</span>
                          {role.is_system && <span className={styles.systemPill}>System</span>}
                        </span>
                        {role.description && <span className={styles.description}>{role.description}</span>}
                      </div>
                      <span className={styles.users}>{plural(role.user_count, 'user')}</span>
                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={styles.actionBtn}
                          onClick={() => {
                            setError(null);
                            setEditing(role.id);
                          }}
                          title="Edit role"
                          aria-label={`Edit ${role.name}`}
                        >
                          <Icon icon={EditIcon} size={15} />
                        </button>
                        {!role.is_system && (
                          <button
                            type="button"
                            className={`${styles.actionBtn} ${styles.deleteBtn}`}
                            onClick={() => handleDelete(role)}
                            title="Delete role"
                            aria-label={`Delete ${role.name}`}
                          >
                            <Icon icon={TrashIcon} size={15} />
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                {customCount === 0 && <div className={styles.empty}>No custom roles yet. Add one above.</div>}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
