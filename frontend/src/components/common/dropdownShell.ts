/**
 * Shared pieces of the listbox dropdowns (`SearchableSelect`,
 * `MultiSelectDropdown`): the search filter and the active-row keyboard
 * navigation. The look is shared through `dropdownShell.module.css`; what
 * Enter / Space do stays with each component.
 */

import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';

/**
 * The rows whose `keys` contain the query: case-insensitive substring over
 * the trimmed query, from the first character. An empty query keeps every row.
 */
export function filterOptions<T>(items: readonly T[], query: string, keys: readonly (keyof T)[]): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((item) =>
    keys.some((key) => {
      const value = item[key];
      return typeof value === 'string' && value.toLowerCase().includes(q);
    })
  );
}

interface ListboxNavOptions {
  /** Number of rows in the list as shown (after filtering) */
  count: number;
  open: boolean;
  /** DOM id of the row at an index: the active row is scrolled into view */
  rowId: (index: number) => string | undefined;
  /** A row that can never be active (a disabled option) */
  isDisabled?: (index: number) => boolean;
  /** When it changes (the query), the active row goes back to `resetTo` */
  resetKey?: string;
  /** Where the active row lands on a reset (default the first enabled row; -1 = none) */
  resetTo?: number;
}

export interface ListboxNav {
  /** Index of the active row, -1 for none */
  active: number;
  setActive: (index: number) => void;
  /** The first enabled row at or after `from`, -1 when none */
  firstEnabled: (from?: number) => number;
  /**
   * ArrowUp / ArrowDown (clamped) and Home / End over the enabled rows.
   * Returns true (and prevents the default) when it handled the key.
   */
  onNavKey: (e: KeyboardEvent) => boolean;
}

/** Active row, arrow keys, scroll-into-view and reset on a new query. */
export function useListboxNav({
  count,
  open,
  rowId,
  isDisabled,
  resetKey,
  resetTo,
}: ListboxNavOptions): ListboxNav {
  const [active, setActive] = useState(0);
  const enabled = (i: number) => i >= 0 && i < count && !isDisabled?.(i);

  const firstEnabled = (from = 0) => {
    for (let i = Math.max(from, 0); i < count; i++) if (enabled(i)) return i;
    return -1;
  };

  // A new query puts the active row back (adjusting state while rendering,
  // so the first frame of the new list already shows the right row).
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setActive(resetTo === -1 ? -1 : firstEnabled(resetTo ?? 0));
  }

  // Keyboard moves keep the active row in view (the list scrolls).
  const activeId = open && active >= 0 && active < count ? rowId(active) : undefined;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < count; i += dir) if (enabled(i)) return i;
    return from;
  };

  const onNavKey = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        setActive((i) => step(Math.max(i, -1), 1));
        break;
      case 'ArrowUp':
        setActive((i) => (i < 0 ? firstEnabled(0) : step(i, -1)));
        break;
      case 'Home':
        setActive(firstEnabled(0));
        break;
      case 'End': {
        let last = -1;
        for (let i = count - 1; i >= 0; i--) {
          if (enabled(i)) {
            last = i;
            break;
          }
        }
        setActive(last);
        break;
      }
      default:
        return false;
    }
    e.preventDefault();
    return true;
  };

  return { active, setActive, firstEnabled, onNavKey };
}
