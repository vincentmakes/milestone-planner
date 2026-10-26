/**
 * PermissionMatrix (Settings hub > Roles > role form)
 *
 * The permission catalogue grouped by domain (GET /api/permissions order),
 * one row per key: label, description and PermissionModeChips — Allow,
 * Needs approval (only the approvable own-booking keys) or Deny. Chips
 * rather than a switch or a select keep every row identical and
 * keyboard-reachable: each row is a `role="radiogroup"` named after the
 * permission with one tab stop, and the arrow keys move the choice.
 *
 * Locked keys (`projects.view` for every role, `roles.manage` for the admin
 * alone) are greyed out and keep their mode; `readOnly` (the admin role)
 * disables every row. A key missing from `value` is denied.
 */

import { useId, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { PermissionGroup, PermissionMatrix as Matrix, PermissionMode } from '@/types';
import styles from './PermissionMatrix.module.css';

/** A chip's mode; `deny` = the key is left out of the matrix. */
export type ChipMode = PermissionMode | 'deny';

const CHIP_LABELS: Record<ChipMode, string> = {
  allow: 'Allow',
  approval: 'Needs approval',
  deny: 'Deny',
};

interface PermissionModeChipsProps {
  /** Accessible name of the radiogroup (the permission's label) */
  label: string;
  /** Id of the element describing the permission */
  describedBy?: string;
  value: ChipMode;
  /** Offer "Needs approval" */
  approvable: boolean;
  disabled?: boolean;
  onChange: (mode: ChipMode) => void;
}

export function PermissionModeChips({
  label,
  describedBy,
  value,
  approvable,
  disabled = false,
  onChange,
}: PermissionModeChipsProps) {
  const modes: ChipMode[] = approvable ? ['allow', 'approval', 'deny'] : ['allow', 'deny'];
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(0, modes.indexOf(value));

  const choose = (mode: ChipMode) => {
    if (!disabled && mode !== value) onChange(mode);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = (index + step + modes.length) % modes.length;
    choose(modes[next]);
    refs.current[next]?.focus();
  };

  return (
    <div className={styles.chips} role="radiogroup" aria-label={label} aria-describedby={describedBy}>
      {modes.map((mode, index) => {
        const selected = index === current;
        return (
          <button
            key={mode}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            className={`${styles.chip} ${selected ? styles.selected : ''} ${styles[mode]}`}
            onClick={() => choose(mode)}
            onKeyDown={(e) => handleKeyDown(e, index)}
          >
            {CHIP_LABELS[mode]}
          </button>
        );
      })}
    </div>
  );
}

interface PermissionMatrixProps {
  groups: PermissionGroup[];
  value: Matrix;
  /** Receives the whole new matrix; omitted with `readOnly` */
  onChange?: (next: Matrix) => void;
  /** Every row read-only (the admin role) */
  readOnly?: boolean;
}

/** The matrix with `key` set to `mode` (`deny` removes it). */
function withMode(value: Matrix, key: string, mode: ChipMode): Matrix {
  const next = { ...value };
  if (mode === 'deny') delete next[key];
  else next[key] = mode;
  return next;
}

function PermissionRow({
  permission,
  value,
  disabled,
  onChange,
}: {
  permission: PermissionGroup['permissions'][number];
  value: Matrix;
  disabled: boolean;
  onChange: (mode: ChipMode) => void;
}) {
  const descriptionId = useId();
  return (
    <li className={`${styles.row} ${permission.locked ? styles.locked : ''}`} data-locked={permission.locked}>
      <div className={styles.text}>
        <span className={styles.label}>
          {permission.label}
          {permission.locked && (
            <span className={styles.lockedPill} title="This permission is the same for every role and cannot be changed">
              Locked
            </span>
          )}
        </span>
        <span id={descriptionId} className={styles.description}>
          {permission.description}
        </span>
      </div>
      <PermissionModeChips
        label={permission.label}
        describedBy={descriptionId}
        value={value[permission.key] ?? 'deny'}
        approvable={permission.approvable}
        disabled={disabled || permission.locked}
        onChange={onChange}
      />
    </li>
  );
}

export function PermissionMatrix({ groups, value, onChange, readOnly = false }: PermissionMatrixProps) {
  return (
    <div className={styles.matrix}>
      {groups.map((group) => (
        <section key={group.name} className={styles.group}>
          <h4 className={styles.groupTitle}>{group.name}</h4>
          <ul className={styles.rows}>
            {group.permissions.map((permission) => (
              <PermissionRow
                key={permission.key}
                permission={permission}
                value={value}
                disabled={readOnly || !onChange}
                onChange={(mode) => onChange?.(withMode(value, permission.key, mode))}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
