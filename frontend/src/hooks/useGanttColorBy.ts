/**
 * The current site's Gantt "Colour by tag group" preference
 * (viewStore.ganttColorBy), shared by the project bars (ProjectTimeline) and
 * the ColorByDropdown (changes it). Independent of "Group by".
 *
 * Stored per tenant + site (`tagFilterKey`), like the tag filter. A stored
 * group id that no longer resolves (group deleted) reads as "default
 * colours" without writing; the next setGroup() overwrites it.
 *
 * Selectors return primitives or stored references only, so unrelated store
 * changes (projects, scroll offset, other sites' preferences) do not
 * re-render the hosts — one instance runs per Gantt project row. Import this
 * file directly, not through `@/hooks`.
 */

import { useCallback, useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { tagFilterKey } from '@/utils/tags';
import type { TagGroup } from '@/types';

export interface GanttColorBy {
  siteId: number | null;
  /** Tag group the project bars are coloured by; null = default colours. */
  group: TagGroup | null;
  setGroup: (groupId: number | null) => void;
}

export function useGanttColorBy(): GanttColorBy {
  const siteId = useAppStore((s) => s.currentSite?.id ?? null);
  const tagGroups = useAppStore((s) => s.tagGroups);
  const groupId = useViewStore((s) =>
    siteId === null ? undefined : s.ganttColorBy[tagFilterKey(siteId)]
  );
  const setGanttColorBy = useViewStore((s) => s.setGanttColorBy);

  const group = useMemo(
    () => (groupId === undefined ? null : tagGroups.find((g) => g.id === groupId) ?? null),
    [groupId, tagGroups]
  );

  const setGroup = useCallback(
    (id: number | null) => {
      if (siteId !== null) setGanttColorBy(siteId, id);
    },
    [siteId, setGanttColorBy]
  );

  return { siteId, group, setGroup };
}
