/**
 * TagPicker - choose a project's tags.
 *
 * A pure picker: tags are created, renamed, recoloured and grouped in
 * Settings → Tags (admins get a "Manage tags…" shortcut here).
 *
 * - Only tags that apply to the project's site are offered (`all_sites`, or
 *   the site is in `site_ids`), and of those limited to teams there, only the
 *   ones sharing a team with the project (`teamIds`).
 * - Options are listed per tag group; in a single-select group picking a tag
 *   replaces the group's current choice (radio behaviour).
 * - Type to filter; Enter picks the tag whose name matches exactly, or the
 *   only remaining match.
 * - Escape with the dropdown open closes only the dropdown, not the dialog.
 * - `disabled` (the enclosing dialog is saving) locks the search box, the
 *   pills and "Manage tags…": opening the hub mid-save would be closed again
 *   by the save's own closeModal().
 * - "Manage tags…" is also disabled during What-If: the Settings hub cannot
 *   open then (uiStore), and closing the dialog first would lose its input.
 */

import { useState, useMemo, useRef, useEffect, useId } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { applyTagSelection, barTextColor, groupedTags, tagsForProjectScope } from '@/utils/tags';
import { teamsForSite } from '@/utils/teams';
import type { Tag } from '@/types';
import styles from './TagPicker.module.css';
import { confirmAction } from '@/utils/confirmDialog';

/** Search box placeholder (referenced by scripts/screenshots). */
export const TAG_PICKER_PLACEHOLDER = 'Find a tag...';

/** Confirmation shown before "Manage tags…" leaves the enclosing dialog. */
export const MANAGE_TAGS_CONFIRM =
  'Open Settings → Tags? This closes the dialog and discards unsaved changes.';

interface TagPickerProps {
  selectedIds: Set<number>;
  onChange: (next: Set<number>) => void;
  /** Site of the project being edited; decides which tags are offered. */
  siteId: number | null;
  /** The project's teams; a tag limited to teams is offered only if one is among them. */
  teamIds?: number[];
  /** Lock the picker (e.g. while the enclosing dialog's save is in flight). */
  disabled?: boolean;
}

const NO_TEAMS: number[] = [];

export function TagPicker({ selectedIds, onChange, siteId, teamIds = NO_TEAMS, disabled = false }: TagPickerProps) {
  const tags = useAppStore((s) => s.tags);
  const teams = useAppStore((s) => s.teams);
  const tagGroups = useAppStore((s) => s.tagGroups);
  const isAdmin = useAppStore((s) => s.currentUser?.role === 'admin');
  const whatIf = useWhatIfBlocked();
  const manageBlockedReason = whatIf.blocked ? whatIf.reason('Managing tags') : null;

  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const expanded = open && !disabled;

  // Close the dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const siteTags = useMemo(
    () => tagsForProjectScope(tags, siteId, teamIds, teamsForSite(teams, siteId)),
    [tags, siteId, teamIds, teams]
  );
  const groupById = useMemo(() => new Map(tagGroups.map((g) => [g.id, g])), [tagGroups]);

  // Pills: selected tags that exist and apply to this site, in section order.
  const selectedTags = useMemo(
    () =>
      groupedTags(siteTags, tagGroups)
        .flatMap((section) => section.tags)
        .filter((t) => selectedIds.has(t.id)),
    [siteTags, tagGroups, selectedIds]
  );

  const query = search.trim().toLowerCase();

  const sections = useMemo(
    () =>
      groupedTags(siteTags, tagGroups)
        .map((section) => ({
          ...section,
          tags: section.tags.filter((t) => !query || t.name.toLowerCase().includes(query)),
        }))
        .filter((section) => section.tags.length > 0),
    [siteTags, tagGroups, query]
  );

  const toggle = (tag: Tag) => {
    onChange(applyTagSelection(selectedIds, tag.id, tags, tagGroups));
    setSearch('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!query) return;
    const exact = siteTags.find((t) => t.name.toLowerCase() === query);
    const matches = sections.flatMap((section) => section.tags);
    const pick = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (pick && !selectedIds.has(pick.id)) toggle(pick);
  };

  // Escape while the dropdown is open closes only the dropdown: stopping
  // propagation keeps the shared Modal's document-level Escape listener from
  // closing the enclosing dialog. With the dropdown closed, Escape is left
  // alone and closes the dialog as usual.
  const handleContainerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !expanded) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
  };

  const handleManageTags = async () => {
    if (disabled || manageBlockedReason) return;
    const confirmed = await confirmAction({
      title: 'Manage tags',
      message: MANAGE_TAGS_CONFIRM,
      confirmLabel: 'Open settings',
    });
    if (!confirmed) return;
    // Close the project dialog first so its editing context is cleared,
    // then open the hub on the Tags section.
    const ui = useUIStore.getState();
    ui.closeModal();
    ui.openSettings('tags');
  };

  return (
    <div className={styles.container} ref={containerRef} onKeyDown={handleContainerKeyDown}>
      {/* Selected pills */}
      <div className={styles.selectedRow}>
        {selectedTags.length === 0 ? (
          <span className={styles.empty}>No tags</span>
        ) : (
          selectedTags.map((tag) => {
            const group = tag.group_id != null ? groupById.get(tag.group_id) : undefined;
            return (
              <span
                key={tag.id}
                className={styles.pill}
                style={{ backgroundColor: tag.color, color: barTextColor(tag.color) }}
                title={group ? `${group.name}: ${tag.name}` : tag.name}
              >
                {tag.name}
                <button
                  type="button"
                  className={styles.pillRemove}
                  onClick={() => onChange(applyTagSelection(selectedIds, tag.id, tags, tagGroups))}
                  aria-label={`Remove ${tag.name}`}
                  disabled={disabled}
                >
                  ×
                </button>
              </span>
            );
          })
        )}
      </div>

      {/* Search + dropdown */}
      <div className={styles.searchWrapper}>
        <div className={styles.searchRow}>
          <input
            type="text"
            role="combobox"
            className={styles.searchInput}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder={TAG_PICKER_PLACEHOLDER}
            aria-label="Find a tag"
            aria-expanded={expanded}
            aria-controls={expanded ? listboxId : undefined}
            aria-autocomplete="list"
            disabled={disabled}
          />
          {isAdmin && (
            <button
              type="button"
              className={styles.manageLink}
              onClick={handleManageTags}
              disabled={disabled || manageBlockedReason !== null}
              title={manageBlockedReason ?? undefined}
            >
              Manage tags…
            </button>
          )}
        </div>
        {expanded && (
          <div id={listboxId} className={styles.dropdown} role="listbox" aria-multiselectable="true">
            {sections.length === 0 && (
              <div className={styles.empty}>
                {siteTags.length === 0 ? 'No tags for this site' : 'No tags match'}
              </div>
            )}
            {sections.map((section) => (
              <div
                key={section.group?.id ?? 'other'}
                className={styles.section}
                role="group"
                aria-label={section.group?.name ?? 'Other'}
              >
                <div className={styles.sectionHeading}>
                  {section.group?.name ?? 'Other'}
                  {section.group?.single_select && (
                    <span className={styles.sectionHint}>pick one</span>
                  )}
                </div>
                {section.tags.map((tag) => {
                  const selected = selectedIds.has(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`${styles.dropdownRow} ${selected ? styles.dropdownRowSelected : ''}`}
                      onClick={() => toggle(tag)}
                    >
                      <span className={styles.dropdownPill} style={{ backgroundColor: tag.color, color: barTextColor(tag.color) }}>
                        {tag.name}
                      </span>
                      {selected && (
                        <svg
                          className={styles.check}
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          aria-hidden="true"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
