/**
 * MultiSelectDropdown - pick several items from a short coloured list, in a
 * control that looks like the shared `Select` (the project dialog's
 * multi-select project fields).
 *
 * The trigger is a button styled like the Select box: the chosen items'
 * names in item order (ellipsised, full list in its `title`), else the
 * placeholder. It opens a `role="listbox"` (`aria-multiselectable`) of
 * `role="option"` rows — a checkbox glyph, the colour dot and the name —
 * under the trigger, inside the dialog's scroll area like `OptionPicker`.
 * A click or Space / Enter toggles the active row and keeps the panel open;
 * ArrowUp / ArrowDown / Home / End move; Escape, an outside mousedown or
 * Tab out close it (`useDismissableOverlay`, focus back on the trigger
 * after Escape). "Clear" empties the choice.
 *
 * `onChange` receives the chosen ids in item order.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { Icon, CheckBoxBlankIcon, CheckBoxIcon, ChevronDownIcon } from '@/components/common/Icon';
import styles from './MultiSelectDropdown.module.css';

export interface MultiSelectDropdownItem {
  id: number;
  name: string;
  color?: string;
}

export interface MultiSelectDropdownProps {
  /** Visible label above the box; also names the trigger and the listbox */
  label: string;
  options: readonly MultiSelectDropdownItem[];
  selectedIds: ReadonlySet<number>;
  /** The new choice, ids in item order */
  onChange: (next: number[]) => void;
  disabled?: boolean;
  /** Text of the box while nothing is chosen */
  placeholder?: string;
  /** Shown in the panel when there is no item to pick */
  emptyText?: string;
  className?: string;
}

export function MultiSelectDropdown({
  label,
  options,
  selectedIds,
  onChange,
  disabled = false,
  placeholder = 'None',
  emptyText = 'No items for this site',
  className,
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const valueId = `${baseId}-value`;
  const listId = `${baseId}-list`;
  const optionId = (id: number) => `${baseId}-option-${id}`;

  const close = () => setOpen(false);
  const { onBlur } = useDismissableOverlay({ open, onClose: close, wrapperRef, triggerRef });

  // Only items on offer count: an id no longer offered is dropped on save.
  const chosen = useMemo(() => options.filter((o) => selectedIds.has(o.id)), [options, selectedIds]);
  const summary = chosen.map((o) => o.name).join(', ');

  // Opening moves focus into the list, on the first chosen item (else the first).
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  // Keyboard moves keep the active row in view (the list scrolls past 18rem).
  useEffect(() => {
    if (!open) return;
    const row = options[active];
    if (row) document.getElementById(`${baseId}-option-${row.id}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, options, baseId]);

  const openPanel = () => {
    const first = options.findIndex((o) => selectedIds.has(o.id));
    setActive(first >= 0 ? first : 0);
    setOpen(true);
  };

  const toggle = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(options.filter((o) => next.has(o.id)).map((o) => o.id));
  };

  const clear = () => {
    onChange([]);
    // The Clear button disappears: keep focus inside the panel.
    listRef.current?.focus();
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      openPanel();
    }
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const last = options.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => Math.min(i + 1, last));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(last);
        break;
      case ' ':
      case 'Enter': {
        e.preventDefault();
        const row = options[active];
        if (row) toggle(row.id);
        break;
      }
      default:
        break;
    }
  };

  const activeRow = options[active];

  return (
    <div ref={wrapperRef} className={[styles.wrapper, className].filter(Boolean).join(' ')} onBlur={onBlur}>
      <span id={labelId} className={styles.label}>
        {label}
      </span>
      <div className={styles.control}>
        <button
          ref={triggerRef}
          type="button"
          className={styles.trigger}
          onClick={() => (open ? close() : openPanel())}
          onKeyDown={onTriggerKeyDown}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-labelledby={`${labelId} ${valueId}`}
          disabled={disabled}
        >
          <span
            id={valueId}
            className={`${styles.value} ${chosen.length === 0 ? styles.placeholder : ''}`}
            title={summary || undefined}
          >
            {summary || placeholder}
          </span>
          <span className={styles.chevron} aria-hidden="true">
            <Icon icon={ChevronDownIcon} size={12} />
          </span>
        </button>

        {open && (
          <div className={styles.panel}>
            {options.length === 0 ? (
              <div className={styles.empty} role="status">
                {emptyText}
              </div>
            ) : (
              <ul
                ref={listRef}
                id={listId}
                role="listbox"
                aria-multiselectable="true"
                aria-labelledby={labelId}
                aria-activedescendant={activeRow ? optionId(activeRow.id) : undefined}
                tabIndex={0}
                className={styles.list}
                onKeyDown={onListKeyDown}
              >
                {options.map((option, index) => {
                  const selected = selectedIds.has(option.id);
                  return (
                    <li
                      key={option.id}
                      id={optionId(option.id)}
                      role="option"
                      aria-selected={selected}
                      className={`${styles.option} ${index === active ? styles.active : ''}`}
                      // Keep focus on the list, so the panel stays open
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setActive(index);
                        toggle(option.id);
                      }}
                    >
                      <span className={`${styles.box} ${selected ? styles.boxChecked : ''}`} aria-hidden="true">
                        <Icon icon={selected ? CheckBoxIcon : CheckBoxBlankIcon} size={16} />
                      </span>
                      {option.color && (
                        <span className={styles.dot} style={{ backgroundColor: option.color }} aria-hidden="true" />
                      )}
                      <span className={styles.name}>{option.name}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {chosen.length > 0 && (
              <button
                type="button"
                className={styles.clear}
                onMouseDown={(e) => e.preventDefault()}
                onClick={clear}
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
