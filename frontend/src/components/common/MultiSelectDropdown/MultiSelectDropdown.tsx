/**
 * MultiSelectDropdown - pick several items of a list, in a control that
 * looks like the shared `Select` (the project dialog's multi-select project
 * fields; with `searchable`, the members of a team).
 *
 * The trigger is a button styled like the Select box: `summary(chosen)` when
 * given, else the chosen items' names in item order (ellipsised, full list in
 * its `title`), else the placeholder. It opens a `role="listbox"`
 * (`aria-multiselectable`) of `role="option"` rows — a checkbox glyph, the
 * colour dot, the name and a muted `hint` — under the trigger, inside the
 * dialog's scroll area like `OptionPicker`. A click toggles a row and keeps
 * the panel open; Escape, an outside mousedown or Tab out close it
 * (`useDismissableOverlay`, focus back on the trigger after Escape). "Clear"
 * empties the choice (unless `allowClear={false}`).
 *
 * Plain: focus moves into the list on open; Space / Enter toggle the active
 * row, ArrowUp / ArrowDown / Home / End move.
 *
 * `searchable`: the panel starts with the shared `Input` as an ARIA combobox
 * (focused on open and after Clear, `aria-activedescendant` on it; the list
 * takes no focus, so Tab leaves the panel). Typing filters the rows by name
 * and hint (case-insensitive substring, from the first character); the
 * arrows / Home / End move over the shown rows, Enter toggles the active row
 * and keeps the panel open (always `preventDefault`ed, so a host form never
 * submits), Space types a space. Toggling works over all `options`: an item
 * hidden by the query keeps its place in the choice.
 *
 * `onChange` receives the chosen ids in item order.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { Input } from '@/components/common/Input';
import { Icon, CheckBoxBlankIcon, CheckBoxIcon, ChevronDownIcon, SearchIcon } from '@/components/common/Icon';
import { filterOptions, revealPanel, useListboxNav } from '../dropdownShell';
import shell from '../dropdownShell.module.css';
import styles from './MultiSelectDropdown.module.css';

export interface MultiSelectDropdownItem {
  id: number;
  name: string;
  color?: string;
  /** Shown muted after the name; searched in a searchable dropdown (job title) */
  hint?: string;
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
  /** A search box at the top of the panel, filtering by name and hint */
  searchable?: boolean;
  /** Accessible name of the search box */
  searchLabel?: string;
  searchPlaceholder?: string;
  /** Shown when the query matches nothing */
  noMatchText?: string;
  /** Offer the "Clear" row while something is chosen (default true) */
  allowClear?: boolean;
  /** Trigger text for the chosen items (default: their names, comma-separated) */
  summary?: (chosen: readonly MultiSelectDropdownItem[]) => string;
}

const SEARCH_KEYS = ['name', 'hint'] as const;

export function MultiSelectDropdown({
  label,
  options,
  selectedIds,
  onChange,
  disabled = false,
  placeholder = 'None',
  emptyText = 'No items for this site',
  className,
  searchable = false,
  searchLabel = 'Find a person',
  searchPlaceholder = 'Type to find…',
  noMatchText = 'No one matches',
  allowClear = true,
  summary,
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const valueId = `${baseId}-value`;
  const listId = `${baseId}-list`;
  const optionId = (id: number) => `${baseId}-option-${id}`;

  // The rows as shown: every item, or the matches of the query.
  const rows = useMemo(
    () => (searchable ? filterOptions(options, query, SEARCH_KEYS) : [...options]),
    [searchable, options, query]
  );

  const nav = useListboxNav({
    count: rows.length,
    open,
    rowId: (i) => (rows[i] ? optionId(rows[i].id) : undefined),
    resetKey: query,
  });

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const { onBlur } = useDismissableOverlay({ open, onClose: close, wrapperRef, triggerRef });

  // Only items on offer count: an id no longer offered is dropped on save.
  const chosen = useMemo(() => options.filter((o) => selectedIds.has(o.id)), [options, selectedIds]);
  const names = chosen.map((o) => o.name).join(', ');
  const triggerText = chosen.length === 0 ? '' : summary ? summary(chosen) : names;

  // Opening moves focus into the search box (searchable) or the list, and
  // reveals the panel (the dialog body is the scroll container and clips it).
  useEffect(() => {
    if (!open) return;
    if (searchable) searchRef.current?.focus();
    else listRef.current?.focus();
    revealPanel(panelRef.current);
  }, [open, searchable]);

  const openPanel = () => {
    const first = options.findIndex((o) => selectedIds.has(o.id));
    nav.setActive(first >= 0 ? first : 0);
    setOpen(true);
  };

  // Over all options, never the filtered rows: a chosen item hidden by the
  // query stays chosen.
  const toggle = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(options.filter((o) => next.has(o.id)).map((o) => o.id));
  };

  const clear = () => {
    onChange([]);
    // The Clear button disappears: keep focus inside the panel.
    (searchable ? searchRef.current : listRef.current)?.focus();
  };

  const toggleActive = () => {
    const row = rows[nav.active];
    if (row) toggle(row.id);
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      openPanel();
    }
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (nav.onNavKey(e)) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggleActive();
    }
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (nav.onNavKey(e)) return;
    if (e.key === 'Enter') {
      // Never submit a host form.
      e.preventDefault();
      toggleActive();
    }
  };

  const activeRow = nav.active >= 0 ? rows[nav.active] : undefined;
  const activeId = activeRow ? optionId(activeRow.id) : undefined;

  return (
    <div ref={wrapperRef} className={[shell.wrapper, className].filter(Boolean).join(' ')} onBlur={onBlur}>
      <span id={labelId} className={shell.label}>
        {label}
      </span>
      <div className={shell.control}>
        <button
          ref={triggerRef}
          type="button"
          className={shell.trigger}
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
            className={`${shell.value} ${chosen.length === 0 ? shell.placeholder : ''}`}
            title={names || undefined}
          >
            {triggerText || placeholder}
          </span>
          <span className={shell.chevron} aria-hidden="true">
            <Icon icon={ChevronDownIcon} size={12} />
          </span>
        </button>

        {open && (
          <div ref={panelRef} className={shell.panel}>
            {searchable && options.length > 0 && (
              <Input
                ref={searchRef}
                type="text"
                role="combobox"
                aria-label={searchLabel}
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={activeId}
                autoComplete="off"
                placeholder={searchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKeyDown}
                leftIcon={<Icon icon={SearchIcon} />}
                fullWidth
                className={shell.search}
              />
            )}
            {options.length === 0 ? (
              <div className={shell.empty} role="status">
                {emptyText}
              </div>
            ) : (
              <ul
                ref={listRef}
                id={listId}
                role="listbox"
                aria-multiselectable="true"
                aria-labelledby={labelId}
                aria-activedescendant={searchable ? undefined : activeId}
                tabIndex={searchable ? undefined : 0}
                className={shell.list}
                onKeyDown={searchable ? undefined : onListKeyDown}
              >
                {rows.map((option, index) => {
                  const selected = selectedIds.has(option.id);
                  return (
                    <li
                      key={option.id}
                      id={optionId(option.id)}
                      role="option"
                      aria-selected={selected}
                      className={`${shell.option} ${index === nav.active ? shell.active : ''}`}
                      // Keep focus in the list / search box, so the panel stays open
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        nav.setActive(index);
                        toggle(option.id);
                      }}
                    >
                      <span className={`${styles.box} ${selected ? styles.boxChecked : ''}`} aria-hidden="true">
                        <Icon icon={selected ? CheckBoxIcon : CheckBoxBlankIcon} size={16} />
                      </span>
                      {option.color && (
                        <span className={styles.dot} style={{ backgroundColor: option.color }} aria-hidden="true" />
                      )}
                      <span className={shell.name}>{option.name}</span>
                      {option.hint && (
                        <>
                          {' '}
                          <span className={shell.hint}>{option.hint}</span>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {searchable && options.length > 0 && rows.length === 0 && (
              <div className={shell.empty} role="status">
                {noMatchText}
              </div>
            )}
            {allowClear && chosen.length > 0 && (
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
