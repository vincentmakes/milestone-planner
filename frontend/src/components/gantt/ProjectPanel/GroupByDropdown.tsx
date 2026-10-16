/**
 * GroupByDropdown - "Group by tag group" control of the Gantt project panel.
 *
 * A compact 28 px trigger (accessible name "Group by", or "Grouped by <group>"
 * when active) opening a non-modal dialog with a radio group: "No grouping"
 * plus one option per tag group (group display order), and Collapse all /
 * Expand all while grouped. Rendered only when tag groups exist.
 *
 * Same shell as TagFilterDropdown: closes on an outside mousedown, when focus
 * moves outside the wrapper (Tab out), and on Escape (captured and stopped so
 * it never reaches the app-wide shortcuts). Picking an option keeps it open.
 *
 * The panel hangs from the nearest positioned ancestor (ProjectPanel's
 * header), right-aligned and capped to its width, like the other header
 * dropdowns.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useGanttGrouping } from '@/hooks/useGanttGrouping';
import { sortTagGroups } from '@/utils/tags';
import styles from './GroupByDropdown.module.css';

export function GroupByDropdown() {
  const tagGroups = useAppStore((s) => s.tagGroups);
  const { siteId, group, collapsedKeys, setGroup, collapseAll, expandAll } = useGanttGrouping();

  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const radioName = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const groups = useMemo(() => sortTagGroups(tagGroups), [tagGroups]);

  if (groups.length === 0) return null;

  const active = group !== null;
  const label = active ? `Grouped by ${group.name}` : 'Group by';

  // Tab out closes the panel; a null relatedTarget (focus dropped to the
  // body by a mousedown inside the panel) is left to the mousedown handler.
  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (open && next && !wrapperRef.current?.contains(next)) setOpen(false);
  };

  return (
    <div ref={wrapperRef} className={styles.wrapper} onBlur={handleBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${active ? styles.active : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        title={active ? `Grouped by ${group.name}` : 'Group projects by tag group'}
        disabled={siteId === null}
      >
        {/* Stacked sections icon */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="3" y="3" width="18" height="5" rx="1" />
          <line x1="7" y1="12" x2="21" y2="12" />
          <line x1="7" y1="16" x2="21" y2="16" />
          <line x1="7" y1="20" x2="21" y2="20" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="16" x2="3.01" y2="16" />
          <line x1="3" y1="20" x2="3.01" y2="20" />
        </svg>
      </button>

      {open && (
        <div id={panelId} role="dialog" aria-label="Group projects" className={styles.dropdown}>
          <div className={styles.header}>
            <span>Group by</span>
          </div>
          <div role="radiogroup" aria-label="Group projects by tag group" className={styles.list}>
            <label className={styles.option}>
              <input
                type="radio"
                name={radioName}
                checked={!active}
                onChange={() => setGroup(null)}
              />
              <span className={styles.radio} aria-hidden="true" />
              <span className={styles.noneLabel}>No grouping</span>
            </label>
            {groups.map((g) => (
              <label key={g.id} className={styles.option}>
                <input
                  type="radio"
                  name={radioName}
                  checked={group?.id === g.id}
                  onChange={() => setGroup(g.id)}
                />
                <span className={styles.radio} aria-hidden="true" />
                <span className={styles.name}>{g.name}</span>
              </label>
            ))}
          </div>
          {active && (
            <div className={styles.footer}>
              <button type="button" className={styles.footerBtn} onClick={collapseAll}>
                Collapse all
              </button>
              <button
                type="button"
                className={styles.footerBtn}
                onClick={expandAll}
                disabled={collapsedKeys.length === 0}
              >
                Expand all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
