/**
 * FieldChoiceDropdown - shared shell of the Gantt project-panel header's
 * "pick one" controls (GroupByDropdown over the dropdown project fields,
 * ColorByDropdown over those fields and the tags).
 *
 * A compact 28 px trigger (accessible name `triggerLabel`, or
 * `activeLabel(choice)` while a choice is made) opening a non-modal dialog
 * with a radio group: the "none" option (`noneLabel`) plus one option per
 * choice in the order given, and an optional `footer`. Rendered only when
 * there is a choice; disabled without a site.
 *
 * Same shell as ProjectFilterDropdown: closes on an outside mousedown, when
 * focus moves outside the wrapper (Tab out), and on Escape (captured and
 * stopped so it never reaches the app-wide shortcuts, focus back on the
 * trigger). Picking an option keeps it open.
 *
 * The panel is an AnchoredPanel right-aligned to the trigger: portaled and
 * fixed, so the Gantt pane (overflow hidden while an overview panel is open)
 * never clips it.
 */

import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { AnchoredPanel } from '@/components/common/AnchoredPanel';
import styles from './FieldChoiceDropdown.module.css';

/** One option of the dropdown: a project field, or a pseudo-choice like "Tags". */
export interface FieldChoice<Id extends number | string = number> {
  id: Id;
  name: string;
}

export interface FieldChoiceDropdownProps<Id extends number | string = number> {
  /** Trigger name (and its tooltip's subject) while nothing is chosen. */
  triggerLabel: string;
  /** Trigger name and tooltip while `value` is chosen. */
  activeLabel: (choice: FieldChoice<Id>) => string;
  /** Trigger tooltip while nothing is chosen. */
  idleTitle: string;
  /** Small caps header of the panel. */
  headerLabel: string;
  dialogLabel: string;
  radioGroupLabel: string;
  /** Label of the first option, "nothing chosen". */
  noneLabel: string;
  /** 14 px trigger icon (`aria-hidden`). */
  icon: ReactNode;
  value: FieldChoice<Id> | null;
  /** Choices to offer, in display order. */
  choices: readonly FieldChoice<Id>[];
  onChange: (id: Id | null) => void;
  disabled?: boolean;
  /** Extra controls under the options (e.g. Collapse all / Expand all). */
  footer?: ReactNode;
}

export function FieldChoiceDropdown<Id extends number | string = number>({
  triggerLabel,
  activeLabel,
  idleTitle,
  headerLabel,
  dialogLabel,
  radioGroupLabel,
  noneLabel,
  icon,
  value,
  choices,
  onChange,
  disabled = false,
  footer,
}: FieldChoiceDropdownProps<Id>) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const radioName = useId();

  const close = () => setOpen(false);
  const { onBlur: handleBlur } = useDismissableOverlay({ open, onClose: close, wrapperRef, triggerRef, panelRef });

  if (choices.length === 0) return null;

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

      <AnchoredPanel
        ref={panelRef}
        open={open}
        triggerRef={triggerRef}
        align="end"
        id={panelId}
        role="dialog"
        aria-label={dialogLabel}
        className={styles.dropdown}
      >
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
          {choices.map((c) => (
            <label key={c.id} className={styles.option}>
              <input
                type="radio"
                name={radioName}
                checked={value?.id === c.id}
                onChange={() => onChange(c.id)}
              />
              <span className={styles.radio} aria-hidden="true" />
              <span className={styles.name}>{c.name}</span>
            </label>
          ))}
        </div>
        {footer}
      </AnchoredPanel>
    </div>
  );
}
