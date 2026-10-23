/**
 * The current site's Gantt "Group by tag group" preference
 * (viewStore.ganttGrouping / collapsedGanttSections), shared by the
 * GanttContainer (builds the sections) and the GroupByDropdown (changes them).
 *
 * Stored per tenant + site (`tagFilterKey`), like the tag filter. A stored
 * group id that no longer resolves (group deleted) reads as "no grouping"
 * without writing; the next setGroup() overwrites it.
 *
 * Selectors return primitives or stored references only, so unrelated store
 * changes (projects, scroll offset, other sites' preferences) do not
 * re-render the hosts. Import this file directly, not through `@/hooks`.
 */

import { useCallback, useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { tagFilterKey, tagsForSite } from '@/utils/tags';
import { allSectionKeys } from '@/components/gantt/utils/projectSections';
import type { Tag } from '@/types';
import type { TagGroup } from '@/utils/tags';

const NO_KEYS: readonly string[] = Object.freeze([]);

export interface GanttGrouping {
  siteId: number | null;
  /** Tag group the Gantt is grouped by; null = not grouped. */
  group: TagGroup | null;
  /** Tags applying to the current site. */
  siteTags: Tag[];
  /** Collapsed section keys (`tag-<id>` / `none`); empty when not grouped. */
  collapsedKeys: readonly string[];
  setGroup: (groupId: number | null) => void;
  toggleSection: (key: string) => void;
  /** Collapse every section the current group can produce. */
  collapseAll: () => void;
  expandAll: () => void;
}

export function useGanttGrouping(): GanttGrouping {
  const siteId = useAppStore((s) => s.currentSite?.id ?? null);
  const tags = useAppStore((s) => s.tags);
  const tagGroups = useAppStore((s) => s.tagGroups);
  const groupId = useViewStore((s) =>
    siteId === null ? undefined : s.ganttGrouping[tagFilterKey(siteId)]
  );
  const storedCollapsed = useViewStore((s) =>
    siteId === null ? undefined : s.collapsedGanttSections[tagFilterKey(siteId)]
  );
  const setGanttGrouping = useViewStore((s) => s.setGanttGrouping);
  const toggleGanttSection = useViewStore((s) => s.toggleGanttSection);
  const setGanttSectionsCollapsed = useViewStore((s) => s.setGanttSectionsCollapsed);

  const siteTags = useMemo(() => tagsForSite(tags, siteId), [tags, siteId]);
  const group = useMemo(
    () => (groupId === undefined ? null : tagGroups.find((g) => g.id === groupId) ?? null),
    [groupId, tagGroups]
  );
  const collapsedKeys = group && storedCollapsed ? storedCollapsed : NO_KEYS;

  const setGroup = useCallback(
    (id: number | null) => {
      if (siteId !== null) setGanttGrouping(siteId, id);
    },
    [siteId, setGanttGrouping]
  );
  const toggleSection = useCallback(
    (key: string) => {
      if (siteId !== null) toggleGanttSection(siteId, key);
    },
    [siteId, toggleGanttSection]
  );
  const collapseAll = useCallback(() => {
    if (siteId !== null && group) setGanttSectionsCollapsed(siteId, allSectionKeys(group, siteTags));
  }, [siteId, group, siteTags, setGanttSectionsCollapsed]);
  const expandAll = useCallback(() => {
    if (siteId !== null) setGanttSectionsCollapsed(siteId, []);
  }, [siteId, setGanttSectionsCollapsed]);

  return { siteId, group, siteTags, collapsedKeys, setGroup, toggleSection, collapseAll, expandAll };
}
