/**
 * The current site's Gantt "Colour by" preference (viewStore.ganttColorBy):
 * a dropdown project field or the tags. Shared by the project bars
 * (ProjectTimeline) and the ColorByDropdown (changes it). Independent of
 * "Group by".
 *
 * The field choices are the dropdown fields with at least one item applying
 * to the current site (`fieldsForSite`, not narrowed by the header team
 * filter); `'tags'` is always a valid choice (the dropdown offers it only
 * while the site has tags).
 *
 * Stored per tenant + site (`siteKey`), like the project filter. A stored
 * field id that no longer resolves among the choices reads as "default
 * colours" without writing; the next setColorBy() overwrites it.
 *
 * Selectors return primitives or stored references only, so unrelated store
 * changes (projects, scroll offset, other sites' preferences) do not
 * re-render the hosts — one instance runs per Gantt project row. Import this
 * file directly, not through `@/hooks`.
 */

import { useCallback, useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { siteKey } from '@/utils/tags';
import { fieldsForSite } from '@/utils/projectFilters';
import type { ColorByChoice } from '@/utils/projectFilters';
import type { ProjectField } from '@/types';

export interface GanttColorBy {
  siteId: number | null;
  /** The field (its items at the site) or `'tags'` the bars are coloured by; null = default colours. */
  colorBy: ProjectField | 'tags' | null;
  /** Fields the bars can be coloured by at the site, in display order. */
  fields: ProjectField[];
  setColorBy: (choice: ColorByChoice | null) => void;
}

export function useGanttColorBy(): GanttColorBy {
  const siteId = useAppStore((s) => s.currentSite?.id ?? null);
  const projectFields = useAppStore((s) => s.projectFields);
  const stored = useViewStore((s) =>
    siteId === null ? undefined : s.ganttColorBy[siteKey(siteId)]
  );
  const setGanttColorBy = useViewStore((s) => s.setGanttColorBy);

  const fields = useMemo(() => fieldsForSite(projectFields, siteId), [projectFields, siteId]);
  const colorBy = useMemo(() => {
    if (stored === undefined) return null;
    if (stored === 'tags') return 'tags' as const;
    return fields.find((f) => f.id === stored) ?? null;
  }, [stored, fields]);

  const setColorBy = useCallback(
    (choice: ColorByChoice | null) => {
      if (siteId !== null) setGanttColorBy(siteId, choice);
    },
    [siteId, setGanttColorBy]
  );

  return { siteId, colorBy, fields, setColorBy };
}
