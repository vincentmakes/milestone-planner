/**
 * RoleChecklist - tick some of the tenant's roles (who may approve a request).
 *
 * The TeamChecklist layout without colours: picking several items from a
 * list is the one place a raw checkbox is right (UI_GUIDELINES §3.4), each
 * inside its label so the label row is the touch target (§7). The admin role
 * always holds every permission, so it is listed ticked and disabled with
 * "(always)" and is never part of `selected` / `onChange`.
 */

import type { Role } from '@/types';
import { ADMIN_ROLE_KEY } from '@/types/permissions';
import styles from './RoleChecklist.module.css';

export interface RoleChecklistProps {
  roles: Role[];
  selected: number[];
  onChange: (ids: number[]) => void;
  /** Accessible name of the group */
  label: string;
  disabled?: boolean;
  /** Shown instead of the checkboxes when there is no role */
  emptyText?: string;
}

export function RoleChecklist({ roles, selected, onChange, label, disabled = false, emptyText }: RoleChecklistProps) {
  const toggle = (roleId: number, checked: boolean) => {
    onChange(checked ? [...selected, roleId] : selected.filter((id) => id !== roleId));
  };

  return (
    <div className={styles.checklist} role="group" aria-label={label}>
      {roles.length === 0 && emptyText && <span className={styles.empty}>{emptyText}</span>}
      {roles.map((role) => {
        const always = role.key === ADMIN_ROLE_KEY;
        const off = disabled || always;
        return (
          <label key={role.id} className={`${styles.check} ${off ? styles.disabled : ''}`}>
            <input
              type="checkbox"
              checked={always || selected.includes(role.id)}
              disabled={off}
              onChange={(e) => {
                if (!off) toggle(role.id, e.target.checked);
              }}
            />
            <span>{role.name}</span>
            {always && <span className={styles.always}> (always)</span>}
          </label>
        );
      })}
    </div>
  );
}
