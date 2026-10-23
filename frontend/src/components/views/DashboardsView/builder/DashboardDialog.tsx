/**
 * DashboardDialog — a dashboard's name, description and who sees it (2.1.0).
 *
 * *Private* (the owner, and admins), *Shared with roles* (the roles ticked —
 * at least one; administrators always see every dashboard) or *Everyone*
 * (everyone who can open the Dashboards view). Two uses:
 * - **New**: the values go back to the view, which starts an empty draft in
 *   edit mode; nothing is sent until the builder saves.
 * - **Share…**: Save sends the name, description, visibility and roles of
 *   the open dashboard — without a `widgets` key, so the server keeps its
 *   widgets — and the saved dashboard is shown.
 * Errors (a missing role, the server's refusal) show in a `Notice`.
 */

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
import { Notice } from '@/components/common/Notice';
import { RoleChecklist } from '@/components/common/RoleChecklist';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useRoles } from '@/hooks/useRoles';
import { useDashboardStore } from '@/stores/dashboardStore';
import type { DashboardVisibility } from '@/types';
import { plainError } from './useDashboardEditor';
import type { DashboardMeta } from './widgetDraft';
import styles from './DashboardDialog.module.css';

export const NAME_REQUIRED = 'Enter a name';
export const ROLES_REQUIRED = 'Choose at least one role';
const NAME_MAX = 100;
const DESCRIPTION_MAX = 2000;

const VISIBILITY_OPTIONS: { value: DashboardVisibility; label: string }[] = [
  { value: 'private', label: 'Private' },
  { value: 'roles', label: 'Shared with roles' },
  { value: 'everyone', label: 'Everyone' },
];

const VISIBILITY_HINTS: Record<DashboardVisibility, string> = {
  private: 'Only you (and administrators) see it.',
  roles: 'People holding one of these roles see it, with their own numbers.',
  everyone: 'Everyone who can open Dashboards sees it, with their own numbers.',
};

export interface DashboardDialogProps {
  /** `new` hands the values back; `share` saves them on `dashboardId` */
  mode: 'new' | 'share';
  initial: DashboardMeta;
  /** The dashboard Share… saves (share mode) */
  dashboardId?: number;
  onClose: () => void;
  /** New: the values chosen. Share: called after the save */
  onDone: (meta: DashboardMeta) => void;
}

export function DashboardDialog({ mode, initial, dashboardId, onClose, onDone }: DashboardDialogProps) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [visibility, setVisibility] = useState<DashboardVisibility>(initial.visibility);
  const [roleIds, setRoleIds] = useState<number[]>(initial.role_ids);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { isSubmitting, begin, end } = useSubmitGuard();
  const roles = useRoles();

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = name.trim();
    setNameError(trimmed ? null : NAME_REQUIRED);
    const noRole = visibility === 'roles' && roleIds.length === 0;
    setError(noRole ? ROLES_REQUIRED : null);
    if (!trimmed || noRole) return;
    const meta: DashboardMeta = {
      name: trimmed,
      description: description.trim() || null,
      visibility,
      role_ids: visibility === 'roles' ? roleIds : [],
    };
    if (mode === 'new') {
      onDone(meta);
      return;
    }
    if (dashboardId === undefined || !begin()) return;
    try {
      // No `widgets` key: the server keeps the dashboard's widgets.
      await useDashboardStore.getState().save({ id: dashboardId, ...meta });
      onDone(meta);
    } catch (err) {
      console.error('[Dashboards] Failed to share a dashboard', err);
      setError(plainError(err, 'The dashboard could not be saved.'));
    } finally {
      end();
    }
  };

  const footer = (
    <div className={styles.footer}>
      <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
        Cancel
      </Button>
      <Button type="button" onClick={() => void handleSubmit()} loading={isSubmitting}>
        {mode === 'new' ? 'Create dashboard' : 'Save Changes'}
      </Button>
    </div>
  );

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={mode === 'new' ? 'New dashboard' : 'Share dashboard'}
      size="md"
      footer={footer}
    >
      <form className={styles.form} onSubmit={(e) => void handleSubmit(e)} noValidate>
        {error && <Notice tone="error">{error}</Notice>}
        <Input
          label="Name *"
          fullWidth
          value={name}
          maxLength={NAME_MAX}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError) setNameError(null);
          }}
          error={nameError ?? undefined}
          autoFocus
        />
        <Input
          label="Description"
          fullWidth
          value={description}
          maxLength={DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description"
        />
        <Select
          label="Visibility"
          fullWidth
          value={visibility}
          onChange={(e) => {
            setVisibility(e.target.value as DashboardVisibility);
            setError(null);
          }}
          options={VISIBILITY_OPTIONS}
          hint={VISIBILITY_HINTS[visibility]}
        />
        {visibility === 'roles' && (
          <div className={styles.roles}>
            <span className={styles.label}>Roles</span>
            <RoleChecklist
              roles={roles}
              selected={roleIds}
              onChange={(ids) => {
                setRoleIds(ids);
                setError(null);
              }}
              label="Roles that see this dashboard"
              emptyText="Loading roles…"
            />
          </div>
        )}
      </form>
    </Modal>
  );
}
