/**
 * TagFilterDropdown - filter the Gantt / Kanban projects by tag.
 *
 * One section per tag group (tags applying to the current site only), with a
 * "(No tag)" option per group and "Other" for ungrouped tags. OR inside a
 * group, AND across groups (see projectPassesTagFilter in utils/tags.ts).
 * The filter is stored per tenant + site in viewStore.tagFilters and persisted.
 *
 * The panel is a non-modal dialog of checkboxes (not a menu). It closes on an
 * outside mousedown, when focus moves to an element outside the wrapper (Tab
 * out), and on Escape; Escape is captured and stopped so it never reaches the
 * app-wide keyboard shortcuts.
 */

import { useId, useMemo, useRef, useState } from 'react';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { useViewStore } from '@/stores/viewStore';
import { useSiteTagFilter } from '@/hooks/useTagFilter';
import { groupedTags } from '@/utils/tags';
import type { TagFilter } from '@/utils/tags';
import styles from './TagFilterDropdown.module.css';
import { Icon, CheckIcon, FilterIcon } from '@/components/common/Icon';

export interface TagFilterDropdownProps {
  /** Icon-only trigger (the label stays as the accessible name). */
  compact?: boolean;
  /** Which edge of the trigger (or of the anchoring container) the panel aligns to. */
  align?: 'left' | 'right';
  /**
   * `container`: position the panel against the nearest positioned ancestor
   * instead of the trigger, inset by its `--dropdown-inset` (default 0) and
   * never wider than it — for a toolbar near a clipping edge (Gantt header).
   */
  anchor?: 'trigger' | 'container';
}

export function TagFilterDropdown({ compact = false, align = 'left', anchor = 'trigger' }: TagFilterDropdownProps) {
  const { siteId, siteTags, tagGroups, filter, activeCount } = useSiteTagFilter();
  const setTagFilter = useViewStore((s) => s.setTagFilter);
  const clearTagFilter = useViewStore((s) => s.clearTagFilter);

  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = () => setOpen(false);
  const { onBlur: handleBlur } = useDismissableOverlay({ open, onClose: close, wrapperRef, triggerRef });

  const sections = useMemo(() => groupedTags(siteTags, tagGroups), [siteTags, tagGroups]);

  // `filter` has stale ids (deleted / re-scoped tags, deleted groups) pruned,
  // so every write below drops them too.
  const selectedTagIds = useMemo(() => new Set(filter.tagIds), [filter]);
  const noneGroupIds = useMemo(() => new Set(filter.noneGroupIds), [filter]);
  const active = activeCount > 0;

  const write = (next: TagFilter) => {
    if (siteId !== null) setTagFilter(siteId, next);
  };

  const toggleTag = (tagId: number) => {
    write({
      tagIds: selectedTagIds.has(tagId)
        ? filter.tagIds.filter((id) => id !== tagId)
        : [...filter.tagIds, tagId],
      noneGroupIds: filter.noneGroupIds,
    });
  };

  const toggleNone = (groupId: number) => {
    write({
      tagIds: filter.tagIds,
      noneGroupIds: noneGroupIds.has(groupId)
        ? filter.noneGroupIds.filter((id) => id !== groupId)
        : [...filter.noneGroupIds, groupId],
    });
  };

  const label = active ? `Tags (${activeCount} selected)` : 'Tags';

  return (
    <div
      ref={wrapperRef}
      className={`${styles.wrapper} ${anchor === 'container' ? styles.containerAnchored : ''}`}
      onBlur={handleBlur}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${compact ? styles.compact : ''} ${active ? styles.active : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        title="Filter projects by tag"
        disabled={siteId === null}
      >
        <Icon icon={FilterIcon} size={14} />
        {!compact && <span>Tags</span>}
        {active && <span className={styles.badge} aria-hidden="true">{activeCount}</span>}
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Filter by tag"
          className={`${styles.dropdown} ${align === 'right' ? styles.alignRight : ''} ${anchor === 'container' ? styles.anchored : ''}`}
        >
          <div className={styles.header}>
            <span>Filter by tag</span>
            {active && (
              <button type="button" className={styles.clearBtn} onClick={() => siteId !== null && clearTagFilter(siteId)}>
                Clear
              </button>
            )}
          </div>

          {sections.length === 0 ? (
            <div className={styles.empty}>No tags for this site</div>
          ) : (
            <div className={styles.list}>
              {sections.map((section, i) => {
                const group = section.group;
                const heading = group?.name ?? 'Other';
                return (
                  <div key={group?.id ?? 'other'} role="group" aria-label={heading}>
                    {i > 0 && <div className={styles.divider} />}
                    <div className={styles.sectionHeading}>{heading}</div>
                    {group && (
                      <label className={styles.option}>
                        <input
                          type="checkbox"
                          checked={noneGroupIds.has(group.id)}
                          onChange={() => toggleNone(group.id)}
                          aria-label={`(No tag) in ${group.name}`}
                        />
                        <span className={styles.checkbox}>
                          <Tick />
                        </span>
                        <span className={styles.noneLabel}>(No tag)</span>
                      </label>
                    )}
                    {section.tags.map((tag) => (
                      <label key={tag.id} className={styles.option}>
                        <input
                          type="checkbox"
                          checked={selectedTagIds.has(tag.id)}
                          onChange={() => toggleTag(tag.id)}
                        />
                        <span className={styles.checkbox}>
                          <Tick />
                        </span>
                        <span className={styles.dot} style={{ backgroundColor: tag.color }} aria-hidden="true" />
                        <span className={styles.name}>{tag.name}</span>
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The tick drawn in a checked option's box (shown by CSS) */
function Tick() {
  return <Icon icon={CheckIcon} size={12} className={styles.checkIcon} />;
}
