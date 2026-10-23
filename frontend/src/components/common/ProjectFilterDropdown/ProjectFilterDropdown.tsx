/**
 * ProjectFilterDropdown - the "Filter" control of the Gantt / Kanban projects.
 *
 * One section per dropdown project field applying to the current site (its
 * items there, in item order, plus "(None)" = no item of the field), then a
 * "Tags" section (the site's tags in tag order). OR inside a field, AND
 * across fields; the tags are one more OR bucket AND-ed with the fields (see
 * projectPassesFilter in utils/projectFilters.ts). Items and tags limited to
 * teams the header team filter hides are not offered (useSiteProjectFilter).
 * The filter is stored per tenant + site in viewStore.projectFilters and
 * persisted.
 *
 * The panel is a non-modal dialog of checkboxes (not a menu). It closes on an
 * outside mousedown, when focus moves to an element outside the wrapper (Tab
 * out), and on Escape; Escape is captured and stopped so it never reaches the
 * app-wide keyboard shortcuts. The panel is an AnchoredPanel (portaled,
 * fixed, flipped above when the room below is short) so no clipping pane cuts
 * it off; its height is the measured room, the header (title + Clear) stays
 * fixed and the sections scroll below it.
 */

import { useId, useMemo, useRef, useState } from 'react';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { AnchoredPanel } from '@/components/common/AnchoredPanel';
import { useViewStore } from '@/stores/viewStore';
import { useSiteProjectFilter } from '@/hooks/useProjectFilter';
import { sortTags } from '@/utils/tags';
import type { ProjectFilter } from '@/utils/projectFilters';
import styles from './ProjectFilterDropdown.module.css';
import { Icon, CheckIcon, FilterIcon } from '@/components/common/Icon';

export interface ProjectFilterDropdownProps {
  /** Icon-only trigger (the label stays as the accessible name). */
  compact?: boolean;
  /** Which edge of the trigger the panel aligns to. */
  align?: 'left' | 'right';
}

/** `list` with `id` toggled. */
function toggled(list: number[], id: number): number[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

export function ProjectFilterDropdown({ compact = false, align = 'left' }: ProjectFilterDropdownProps) {
  const { siteId, siteFields, siteTags, filter, activeCount } = useSiteProjectFilter();
  const setProjectFilter = useViewStore((s) => s.setProjectFilter);
  const clearProjectFilter = useViewStore((s) => s.clearProjectFilter);

  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = () => setOpen(false);
  const { onBlur: handleBlur } = useDismissableOverlay({ open, onClose: close, wrapperRef, triggerRef, panelRef });

  const tags = useMemo(() => sortTags(siteTags), [siteTags]);

  // `filter` has stale ids (deleted / re-scoped items, fields and tags)
  // pruned, so every write below drops them too.
  const selectedOptionIds = useMemo(() => new Set(filter.optionIds), [filter]);
  const noneFieldIds = useMemo(() => new Set(filter.noneFieldIds), [filter]);
  const selectedTagIds = useMemo(() => new Set(filter.tagIds), [filter]);
  const active = activeCount > 0;

  const write = (patch: Partial<ProjectFilter>) => {
    if (siteId !== null) setProjectFilter(siteId, { ...filter, ...patch });
  };

  const label = active ? `Filter (${activeCount} selected)` : 'Filter';
  const empty = siteFields.length === 0 && tags.length === 0;

  return (
    <div ref={wrapperRef} className={styles.wrapper} onBlur={handleBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${compact ? styles.compact : ''} ${active ? styles.active : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        title="Filter projects"
        disabled={siteId === null}
      >
        <Icon icon={FilterIcon} size={14} />
        {!compact && <span>Filter</span>}
        {active && <span className={styles.badge} aria-hidden="true">{activeCount}</span>}
      </button>

      <AnchoredPanel
        ref={panelRef}
        open={open}
        triggerRef={triggerRef}
        align={align === 'right' ? 'end' : 'start'}
        id={panelId}
        role="dialog"
        aria-label="Filter projects"
        className={styles.dropdown}
      >
        <div className={styles.header}>
          <span>Filter projects</span>
          {active && (
            <button type="button" className={styles.clearBtn} onClick={() => siteId !== null && clearProjectFilter(siteId)}>
              Clear
            </button>
          )}
        </div>

        {empty ? (
          <div className={styles.empty}>No fields or tags for this site</div>
        ) : (
          <div className={styles.scrollBody}>
            {siteFields.map((field, i) => (
              <div key={field.id} role="group" aria-label={field.name}>
                {i > 0 && <div className={styles.divider} />}
                <div className={styles.sectionHeading}>{field.name}</div>
                <label className={styles.option}>
                  <input
                    type="checkbox"
                    checked={noneFieldIds.has(field.id)}
                    onChange={() => write({ noneFieldIds: toggled(filter.noneFieldIds, field.id) })}
                    aria-label={`(None) in ${field.name}`}
                  />
                  <span className={styles.checkbox}>
                    <Tick />
                  </span>
                  <span className={styles.noneLabel}>(None)</span>
                </label>
                {field.options.map((option) => (
                  <label key={option.id} className={styles.option}>
                    <input
                      type="checkbox"
                      checked={selectedOptionIds.has(option.id)}
                      onChange={() => write({ optionIds: toggled(filter.optionIds, option.id) })}
                    />
                    <span className={styles.checkbox}>
                      <Tick />
                    </span>
                    <span className={styles.dot} style={{ backgroundColor: option.color }} aria-hidden="true" />
                    <span className={styles.name}>{option.name}</span>
                  </label>
                ))}
              </div>
            ))}
            {tags.length > 0 && (
              <div role="group" aria-label="Tags">
                {siteFields.length > 0 && <div className={styles.divider} />}
                <div className={styles.sectionHeading}>Tags</div>
                {tags.map((tag) => (
                  <label key={tag.id} className={styles.option}>
                    <input
                      type="checkbox"
                      checked={selectedTagIds.has(tag.id)}
                      onChange={() => write({ tagIds: toggled(filter.tagIds, tag.id) })}
                    />
                    <span className={styles.checkbox}>
                      <Tick />
                    </span>
                    <span className={styles.dot} style={{ backgroundColor: tag.color }} aria-hidden="true" />
                    <span className={styles.name}>{tag.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </AnchoredPanel>
    </div>
  );
}

/** The tick drawn in a checked option's box (shown by CSS) */
function Tick() {
  return <Icon icon={CheckIcon} size={12} className={styles.checkIcon} />;
}
