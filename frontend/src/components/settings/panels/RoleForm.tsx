/**
 * RoleForm (Settings hub > Roles > edit / new)
 *
 * Name, description and permission matrix of one role, or of a new one
 * (`role` null; its key is derived from the name and cannot change later).
 *
 * - The admin role is read-only: the server refuses any edit (403) and the
 *   role always holds every permission, so every row shows Allow, the fields
 *   are disabled and there is no Save.
 * - System roles keep their key and cannot be deleted; a custom role can be
 *   deleted here or from the list (confirmed first; a 409 while users hold
 *   it shows in the Notice).
 * - Unsaved input is reported to the hub (through the panel) and Back /
 *   Cancel ask before discarding it.
 */

import { useMemo, useState } from 'react';
import { rolesApi } from '@/api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Notice } from '@/components/common/Notice';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { refreshRoles } from '@/hooks/useRoles';
import { ADMIN_ROLE_KEY } from '@/types/permissions';
import type { PermissionCatalogue, PermissionMatrix as Matrix, Role } from '@/types';
import { confirmAction } from '@/utils/confirmDialog';
import { confirmRoleDelete, matrixEquals, roleKeyFromName } from '@/utils/roles';
import { useReportDirty } from '../useReportDirty';
import { PermissionMatrix } from './PermissionMatrix';
import { BackIcon } from './PanelIcons';
import styles from './RolesPanel.module.css';

/** What a new role starts with: the locked key every role holds. */
const NEW_ROLE_MATRIX: Matrix = { 'projects.view': 'allow' };

interface RoleFormProps {
  /** The role to edit, or null for a new one */
  role: Role | null;
  /** GET /api/permissions; null while loading */
  catalogue: PermissionCatalogue | null;
  /** Why the catalogue could not be loaded */
  catalogueError?: string | null;
  /** Keys already taken (a new role's key must differ) */
  existingKeys: string[];
  /** Back to the role list without saving */
  onBack: () => void;
  /** Called once the role was saved */
  onSaved: () => void;
  /** Called once the role was deleted */
  onDeleted: () => void;
  /** Unsaved input in the form (reported to the Settings hub by the panel) */
  onDirtyChange?: (dirty: boolean) => void;
}

export function RoleForm({ role, catalogue, catalogueError = null, existingKeys, onBack, onSaved, onDeleted, onDirtyChange }: RoleFormProps) {
  const isNew = role === null;
  const isAdminRole = role?.key === ADMIN_ROLE_KEY;

  const initialMatrix = role?.permissions ?? NEW_ROLE_MATRIX;
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [matrix, setMatrix] = useState<Matrix>(initialMatrix);

  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);

  // The admin role holds every key, whatever the server listed.
  const shownMatrix = useMemo<Matrix>(() => {
    if (!isAdminRole || !catalogue) return matrix;
    return Object.fromEntries(
      catalogue.groups.flatMap((g) => g.permissions.map((p) => [p.key, 'allow' as const]))
    );
  }, [isAdminRole, catalogue, matrix]);

  const newKey = isNew ? roleKeyFromName(name, existingKeys) : null;

  const dirty =
    !isAdminRole &&
    (name !== (role?.name ?? '') ||
      description !== (role?.description ?? '') ||
      !matrixEquals(matrix, initialMatrix));
  useReportDirty(onDirtyChange, dirty);

  const leave = async () => {
    if (
      dirty &&
      !(await confirmAction({
        title: 'Discard changes',
        message: 'Discard your unsaved changes to this role?',
        confirmLabel: 'Discard',
        destructive: true,
      }))
    ) {
      return;
    }
    onBack();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isAdminRole) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Role name is required');
      return;
    }
    if (!beginSubmit()) return;
    setError(null);
    try {
      const body = {
        name: trimmed,
        // An explicit null clears the description.
        description: description.trim() || null,
        permissions: matrix,
      };
      if (role) {
        await rolesApi.update(role.id, body);
      } else {
        await rolesApi.create({ key: newKey!, ...body });
      }
      await refreshRoles();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save role');
    } finally {
      endSubmit();
    }
  };

  const handleDelete = async () => {
    if (!role) return;
    // Confirm before taking the guard, so an open dialog never holds it.
    if (!(await confirmRoleDelete(role)) || !beginSubmit()) return;
    setError(null);
    try {
      await rolesApi.delete(role.id);
      await refreshRoles();
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete role');
    } finally {
      endSubmit();
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <Button type="button" variant="ghost" icon={<BackIcon />} className={styles.backLink} onClick={leave}>
        Back to roles
      </Button>
      <h4 className={styles.formTitle}>{role ? `Edit role: ${role.name}` : 'New role'}</h4>

      {error && <Notice tone="error">{error}</Notice>}
      {isAdminRole && <Notice tone="info">The admin role always holds every permission.</Notice>}

      <Input
        label="Name *"
        type="text"
        fullWidth
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={100}
        disabled={isAdminRole}
        hint={role ? `Key: ${role.key} (cannot change)` : name.trim() ? `Key: ${newKey} (cannot change later)` : undefined}
      />
      <Input
        label="Description"
        type="text"
        fullWidth
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Optional description"
        disabled={isAdminRole}
      />

      <div className={styles.field}>
        <span className={styles.fieldLabel}>Permissions</span>
        {catalogue ? (
          <PermissionMatrix
            groups={catalogue.groups}
            value={shownMatrix}
            onChange={isAdminRole ? undefined : setMatrix}
            readOnly={isAdminRole}
          />
        ) : catalogueError ? (
          <Notice tone="error">{catalogueError}</Notice>
        ) : (
          <div className={styles.empty}>Loading permissions...</div>
        )}
      </div>

      <div className={styles.formActions}>
        {role && !role.is_system && (
          <Button type="button" variant="danger" className={styles.deleteAction} onClick={handleDelete} disabled={isSubmitting}>
            Delete role
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={leave} disabled={isSubmitting}>
          {isAdminRole ? 'Close' : 'Cancel'}
        </Button>
        {!isAdminRole && (
          <Button type="submit" loading={isSubmitting}>
            {isNew ? 'Create role' : 'Save Changes'}
          </Button>
        )}
      </div>
    </form>
  );
}
