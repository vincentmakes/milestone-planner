/**
 * TagGroupChoiceDropdown - shared shell of the Gantt project-panel header's
 * "pick one tag group" controls (GroupByDropdown, ColorByDropdown).
 *
 * A compact 28 px trigger (accessible name `triggerLabel`, or
 * `activeLabel(group)` while a group is chosen) opening a non-modal dialog
 * with a radio group: the "none" option (`noneLabel`) plus one option per tag
 * group in display order (`sortTagGroups`), and an optional `footer`.
 * Rendered only when tag groups exist; disabled without a site.
 *
 * Same shell as TagFilterDropdown: closes on an outside mousedown, when focus
 * moves outside the wrapper (Tab out), and on Escape (captured and stopped so
 * it never reaches the app-wide shortcuts, focus back on the trigger).
 * Picking an option keeps it open.
 *
 * The panel hangs from the nearest positioned ancestor (ProjectPanel's
 * header), right-aligned and capped to its width, like the other header
 * dropdowns.
 */

import { useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { sortTagGroups } from '@/utils/tags';
import type { TagGroup } from '@/utils/tags';
import styles from './TagGroupChoiceDropdown.module.css';

export interface TagGroupChoiceDropdownProps {
  /** Trigger name (and its tooltip's subject) while no group is chosen. */
  triggerLabel: string;
  /** Trigger name and tooltip while `group` is chosen. */
  activeLabel: (group: TagGroup) => string;
  /** Trigger tooltip while no group is chosen. */
  idleTitle: string;
  /** Small caps header of the panel. */
  headerLabel: string;
  dialogLabel: string;
  radioGroupLabel: string;
  /** Label of the first option, "no group". */
  noneLabel: string;
  /** 14 px trigger icon (`aria-hidden`). */
  icon: ReactNode;
  value: TagGroup | null;
  /** Tag groups to offer (any order — listed in display order). */
  groups: TagGroup[];
  onChange: (groupId: number | null) => void;
  disabled?: boolean;
  /** Extra controls under the options (e.g. Collapse all / Expand all). */
  footer?: ReactNode;
}

export function TagGroupChoiceDropdown({
  triggerLabel,
  activeLabel,
  idleTitle,
  headerLabel,
  dialogLabel,
  radioGroupLabel,
  noneLabel,
  icon,
  value,
  groups,
  onChange,
  disabled = false,
  footer,
}: TagGroupChoiceDropdownProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const radioName = useId();

  const close = () => setOpen(false);
  const { onBlur: handleBlur } = useDismissableOverlay({ open, onClose: close, wrapperRef, triggerRef });

  const sorted = useMemo(() => sortTagGroups(groups), [groups]);

  if (sorted.length === 0) return null;

  const label = value ? activeLabel(value) : triggerLabel;

  return (
    <div ref={wrapperRef} className={styles.wrapper} onBlur={handleBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${value ? styles.active : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        title={value ? label : idleTitle}
        disabled={disabled}
      >
        {icon}
      </button>

      {open && (
        <div id={panelId} role="dialog" aria-label={dialogLabel} className={styles.dropdown}>
          <div className={styles.header}>
            <span>{headerLabel}</span>
          </div>
          <div role="radiogroup" aria-label={radioGroupLabel} className={styles.list}>
            <label className={styles.option}>
              <input
                type="radio"
                name={radioName}
                checked={value === null}
                onChange={() => onChange(null)}
              />
              <span className={styles.radio} aria-hidden="true" />
              <span className={styles.noneLabel}>{noneLabel}</span>
            </label>
            {sorted.map((g) => (
              <label key={g.id} className={styles.option}>
                <input
                  type="radio"
                  name={radioName}
                  checked={value?.id === g.id}
                  onChange={() => onChange(g.id)}
                />
                <span className={styles.radio} aria-hidden="true" />
                <span className={styles.name}>{g.name}</span>
              </label>
            ))}
          </div>
          {footer}
        </div>
      )}
    </div>
  );
}
