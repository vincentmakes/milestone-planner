/**
 * OptionPicker - choose several coloured items from a list as pills (the
 * project tags, through TagPicker; multi-select project fields use the
 * dropdown-looking MultiSelectDropdown instead).
 *
 * - Chosen items show as removable pills filled with their colour (text
 *   colour from `barTextColor`), in the order of `options`.
 * - A search combobox opens a listbox of `options` on a click, on typing or
 *   on ArrowDown (not on plain focus, so Tab passes through a form); typing
 *   filters by name, Enter picks the item whose name matches exactly, or the
 *   only remaining match. Clicking an item toggles it.
 * - The listbox closes on an outside mousedown, on Tab out and on Escape
 *   (`useDismissableOverlay`, focus back on the search box); that Escape
 *   never reaches the enclosing dialog, a second one closes the dialog as usual.
 * - Only `options` are shown: a selected id missing from them (an item that
 *   no longer applies to the project) gets no pill; the caller drops it on save.
 * - `disabled` (the enclosing dialog is saving) locks the search box and the pills.
 */

import { useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { barTextColor } from '@/utils/tags';
import { Icon, CheckIcon, CloseIcon } from '@/components/common/Icon';
import styles from './OptionPicker.module.css';

export interface OptionPickerItem {
  id: number;
  name: string;
  color: string;
}

export interface OptionPickerProps {
  /** The items on offer, in display order */
  options: readonly OptionPickerItem[];
  selectedIds: ReadonlySet<number>;
  onChange: (next: Set<number>) => void;
  /** Accessible name of the search combobox, e.g. "Find a tag" */
  searchLabel: string;
  placeholder: string;
  /** Shown instead of pills when nothing is chosen */
  emptyText: string;
  /** Shown in the listbox when nothing is on offer */
  noOptionsText: string;
  /** Shown in the listbox when the search matches nothing */
  noMatchText: string;
  /** Lock the picker (e.g. while the enclosing dialog's save is in flight) */
  disabled?: boolean;
  /** Rendered after the search box, e.g. a "Manage …" link */
  action?: ReactNode;
}

export function OptionPicker({
  options,
  selectedIds,
  onChange,
  searchLabel,
  placeholder,
  emptyText,
  noOptionsText,
  noMatchText,
  disabled = false,
  action,
}: OptionPickerProps) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const expanded = open && !disabled;

  const { onBlur } = useDismissableOverlay({
    open: expanded,
    onClose: () => setOpen(false),
    wrapperRef: containerRef,
    triggerRef: inputRef,
  });

  const selected = useMemo(() => options.filter((o) => selectedIds.has(o.id)), [options, selectedIds]);

  const query = search.trim().toLowerCase();
  const matches = useMemo(
    () => (query ? options.filter((o) => o.name.toLowerCase().includes(query)) : options),
    [options, query]
  );

  const toggle = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
    setSearch('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!query) return;
    const exact = options.find((o) => o.name.toLowerCase() === query);
    const pick = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (pick && !selectedIds.has(pick.id)) toggle(pick.id);
  };

  return (
    <div className={styles.container} ref={containerRef} onBlur={onBlur}>
      <div className={styles.selectedRow}>
        {selected.length === 0 ? (
          <span className={styles.empty}>{emptyText}</span>
        ) : (
          selected.map((item) => (
            <span
              key={item.id}
              className={styles.pill}
              style={{ backgroundColor: item.color, color: barTextColor(item.color) }}
              title={item.name}
            >
              {item.name}
              <button
                type="button"
                className={styles.pillRemove}
                onClick={() => toggle(item.id)}
                aria-label={`Remove ${item.name}`}
                disabled={disabled}
              >
                <Icon icon={CloseIcon} size={12} />
              </button>
            </span>
          ))
        )}
      </div>

      <div className={styles.searchWrapper}>
        <div className={styles.searchRow}>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            className={styles.searchInput}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOpen(true);
            }}
            onClick={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            aria-label={searchLabel}
            aria-expanded={expanded}
            aria-controls={expanded ? listboxId : undefined}
            aria-autocomplete="list"
            disabled={disabled}
          />
          {action}
        </div>
        {expanded && (
          <div
            id={listboxId}
            className={styles.dropdown}
            role="listbox"
            aria-label={searchLabel}
            aria-multiselectable="true"
          >
            {matches.length === 0 && (
              <div className={styles.empty}>{options.length === 0 ? noOptionsText : noMatchText}</div>
            )}
            {matches.map((item) => {
              const isSelected = selectedIds.has(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`${styles.dropdownRow} ${isSelected ? styles.dropdownRowSelected : ''}`}
                  onClick={() => toggle(item.id)}
                >
                  <span
                    className={styles.dropdownPill}
                    style={{ backgroundColor: item.color, color: barTextColor(item.color) }}
                  >
                    {item.name}
                  </span>
                  {isSelected && <Icon icon={CheckIcon} size={14} className={styles.check} />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
