/**
 * SearchableSelect - pick one item of a long list (people, equipment) in a
 * control that looks like the shared `Select`, with a search box that opens
 * focused and filters from the first character.
 *
 * The trigger is a `<button>` styled like the Select box (`aria-haspopup=
 * "listbox"`, named by the label and the chosen item): the chosen option's
 * label, else the placeholder. Opening it — a click, Enter / Space (the
 * native click), ArrowDown / ArrowUp, or a printable key, which also seeds
 * the query — shows a panel under it, inside the wrapper (never portaled:
 * every picker sits in a `Modal`, whose Tab trap and Escape stack need the
 * panel in its DOM subtree): the shared `Input` as an ARIA combobox
 * (`aria-activedescendant` on the input; focus stays there) over a
 * `role="listbox"` of `role="option"` rows (label, a muted `hint`, a muted
 * `note`), the optional `emptyLabel` row first (it picks `null`).
 *
 * Filtering is a case-insensitive substring of the trimmed query over the
 * label and the hint (never the note); the `emptyLabel` row always stays and
 * the active row goes to the first match on every keystroke. In the search
 * box ArrowUp / ArrowDown / Home / End move over the enabled rows, Enter
 * (always `preventDefault`ed, so a host form never submits) picks the active
 * row (or the single match) and closes with focus back on the trigger.
 * Escape, an outside mousedown and Tab out close it (`useDismissableOverlay`);
 * Shift+Tab lands on the trigger, inside the wrapper, so the panel stays open.
 *
 * `onChange` fires only when the picked id differs from `value`, like a
 * native select (a caller may reset dependent state on change).
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { Input } from '@/components/common/Input';
import { Icon, CheckIcon, ChevronDownIcon, SearchIcon } from '@/components/common/Icon';
import { filterOptions, revealPanel, useListboxNav } from '../dropdownShell';
import shell from '../dropdownShell.module.css';
import styles from './SearchableSelect.module.css';

export interface SearchableOption {
  id: number;
  label: string;
  /** Shown muted and searched (job title, equipment type) */
  hint?: string;
  /** Shown muted, never searched ("80% capacity", "already on this card") */
  note?: string;
  disabled?: boolean;
}

export interface SearchableSelectProps {
  /** Visible label above the box; names the trigger (with the chosen item) and the list */
  label?: string;
  /** A visually hidden label when there is no visible one */
  'aria-label'?: string;
  options: readonly SearchableOption[];
  value: number | null;
  /** Called with the picked id only when it differs from `value` */
  onChange: (id: number | null) => void;
  /** A first row picking `null` (e.g. "Select PM") */
  emptyLabel?: string;
  /** Trigger text while `value` is null (defaults to `emptyLabel`) */
  placeholder?: string;
  disabled?: boolean;
  /** Tooltip of the trigger (e.g. why it is disabled); defaults to the chosen label */
  title?: string;
  /** Accessible name of the search box */
  searchLabel?: string;
  searchPlaceholder?: string;
  /** Shown when the query matches nothing */
  noMatchText?: string;
  /** Shown when there is no option at all */
  emptyText?: string;
  fullWidth?: boolean;
  /** On the outer wrapper, so a caller's flex rules apply to the whole control */
  className?: string;
}

/** A printable key typed on the closed trigger opens it with that character. */
function isPrintableKey(e: KeyboardEvent): boolean {
  return (
    e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing
  );
}

const SEARCH_KEYS = ['label', 'hint'] as const;

export function SearchableSelect({
  label,
  'aria-label': ariaLabel,
  options,
  value,
  onChange,
  emptyLabel,
  placeholder,
  disabled = false,
  title,
  searchLabel = 'Find a person',
  searchPlaceholder = 'Type to find…',
  noMatchText = 'No one matches',
  emptyText = 'Nothing to choose from',
  fullWidth = false,
  className,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const valueId = `${baseId}-value`;
  const listId = `${baseId}-list`;
  const rowDomId = (id: number | null) => `${baseId}-option-${id ?? 'none'}`;

  const hasNoneRow = emptyLabel !== undefined;
  const matches = useMemo(() => filterOptions(options, query, SEARCH_KEYS), [options, query]);
  // The rows as shown: the "none" row (id null) first, then the matches.
  const rows = useMemo(
    () => [
      ...(hasNoneRow ? [{ id: null as number | null, option: undefined as SearchableOption | undefined }] : []),
      ...matches.map((option) => ({ id: option.id as number | null, option })),
    ],
    [hasNoneRow, matches]
  );
  const hasQuery = query.trim() !== '';
  const firstMatch = hasNoneRow ? 1 : 0;
  // With a query, the first match (none: no active row); without, the current value.
  const resetTo = hasQuery ? (matches.length > 0 ? firstMatch : -1) : Math.max(rows.findIndex((r) => r.id === value), 0);

  const nav = useListboxNav({
    count: rows.length,
    open,
    rowId: (i) => (rows[i] ? rowDomId(rows[i].id) : undefined),
    isDisabled: (i) => Boolean(rows[i]?.option?.disabled),
    resetKey: query,
    resetTo,
  });

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const { onBlur } = useDismissableOverlay({ open, onClose: close, wrapperRef, triggerRef });

  const chosen = value === null ? undefined : options.find((o) => o.id === value);
  const triggerText = chosen?.label ?? placeholder ?? emptyLabel ?? '';

  // Opening moves focus into the search box and reveals the panel (the
  // dialog body is the scroll container and clips it at its edge).
  useEffect(() => {
    if (!open) return;
    const input = searchRef.current;
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    revealPanel(panelRef.current);
  }, [open]);

  const openPanel = (seed = '') => {
    if (disabled) return;
    setQuery(seed);
    // An empty query starts on the current value; a seeded one resets to the
    // first match through the hook.
    if (!seed) nav.setActive(nav.firstEnabled(Math.max(rows.findIndex((r) => r.id === value), 0)));
    setOpen(true);
  };

  const choose = (index: number) => {
    const row = rows[index];
    if (!row || row.option?.disabled) return;
    if (row.id !== value) onChange(row.id);
    close();
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) {
        e.preventDefault();
        openPanel();
      }
      return;
    }
    if (!isPrintableKey(e)) return;
    e.preventDefault();
    if (open) {
      setQuery((q) => q + e.key);
      searchRef.current?.focus();
    } else {
      openPanel(e.key);
    }
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (nav.onNavKey(e)) return;
    if (e.key !== 'Enter') return;
    // Never submit a host form.
    e.preventDefault();
    // The active row: after a keystroke, the first match (so the single one).
    if (nav.active >= 0) choose(nav.active);
  };

  const activeRow = nav.active >= 0 ? rows[nav.active] : undefined;
  const labelledBy = label || ariaLabel ? `${labelId} ${valueId}` : valueId;

  return (
    <div
      ref={wrapperRef}
      className={[shell.wrapper, fullWidth && shell.fullWidth, className].filter(Boolean).join(' ')}
      onBlur={onBlur}
    >
      {label ? (
        <span id={labelId} className={shell.label}>
          {label}
        </span>
      ) : (
        ariaLabel && (
          <span id={labelId} className="sr-only">
            {ariaLabel}
          </span>
        )
      )}
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
          aria-labelledby={labelledBy}
          disabled={disabled}
          title={title ?? chosen?.label}
        >
          <span id={valueId} className={`${shell.value} ${chosen ? '' : shell.placeholder}`}>
            {triggerText}
          </span>
          <span className={shell.chevron} aria-hidden="true">
            <Icon icon={ChevronDownIcon} size={12} />
          </span>
        </button>

        {open && (
          <div ref={panelRef} className={shell.panel}>
            <Input
              ref={searchRef}
              type="text"
              role="combobox"
              aria-label={searchLabel}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeRow ? rowDomId(activeRow.id) : undefined}
              autoComplete="off"
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              leftIcon={<Icon icon={SearchIcon} />}
              fullWidth
              className={shell.search}
            />
            <ul
              id={listId}
              role="listbox"
              aria-labelledby={label || ariaLabel ? labelId : undefined}
              aria-label={label || ariaLabel ? undefined : searchLabel}
              className={`${shell.list} ${shell.listShort}`}
            >
              {rows.map((row, index) => {
                const selected = row.id === value;
                const rowDisabled = Boolean(row.option?.disabled);
                return (
                  <li
                    key={row.id ?? 'none'}
                    id={rowDomId(row.id)}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={rowDisabled || undefined}
                    className={[
                      shell.option,
                      index === nav.active && shell.active,
                      selected && styles.chosen,
                      row.option ? '' : styles.noneRow,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    // Keep focus in the search box
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(index)}
                  >
                    <span className={styles.check} aria-hidden="true">
                      {selected && <Icon icon={CheckIcon} size={14} />}
                    </span>
                    <span className={shell.name}>{row.option ? row.option.label : emptyLabel}</span>
                    {row.option?.hint && (
                      <>
                        {' '}
                        <span className={shell.hint}>{row.option.hint}</span>
                      </>
                    )}
                    {row.option?.note && (
                      <>
                        {' '}
                        <span className={shell.note}>{row.option.note}</span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
            {options.length === 0 ? (
              <div className={shell.empty} role="status">
                {emptyText}
              </div>
            ) : (
              hasQuery &&
              matches.length === 0 && (
                <div className={shell.empty} role="status">
                  {noMatchText}
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
