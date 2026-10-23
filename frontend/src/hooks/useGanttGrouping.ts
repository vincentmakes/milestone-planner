/**
 * The current site's Gantt "Group by" preference (viewStore.ganttGrouping /
 * collapsedGanttSections): a dropdown project field. Shared by the
 * GanttContainer (builds the sections) and the GroupByDropdown (changes them).
 *
 * The choices are the dropdown fields with at least one item applying to the
 * current site, each with only those items (`fieldsForSite`). They are not
 * narrowed by the header team filter: a section exists only when a visible
 * project holds the item, and hiding it would misfile that project.
 *
 * Stored per tenant + site (`siteKey`), like the project filter. A stored
 * field id that no longer resolves among the choices (field deleted, turned
 * into no item at this site) reads as "no grouping" without writing; the next
 * setField() overwrites it.
 *
 * Selectors return primitives or stored references only, so unrelated store
 * changes (projects, scroll offset, other sites' preferences) do not
 * re-render the hosts. Import this file directly, not through `@/hooks`.
 */

import { useCallback, useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { siteKey } from '@/utils/tags';
import { fieldsForSite } from '@/utils/projectFilters';
import { allSectionKeys } from '@/components/gantt/utils/projectSections';
import type { ProjectField } from '@/types';

const NO_KEYS: readonly string[] = Object.freeze([]);

export interface GanttGrouping {
  siteId: number | null;
  /** Field the Gantt is grouped by (its items at the site); null = not grouped. */
  field: ProjectField | null;
  /** Fields the Gantt can be grouped by at the site, in display order. */
  fields: ProjectField[];
  /** Collapsed section keys (`field-<item id>` / `none`); empty when not grouped. */
  collapsedKeys: readonly string[];
  setField: (fieldId: number | null) => void;
  toggleSection: (key: string) => void;
  /** Collapse every section the current field can produce. */
  collapseAll: () => void;
  expandAll: () => void;
}

export function useGanttGrouping(): GanttGrouping {
  const siteId = useAppStore((s) => s.currentSite?.id ?? null);
  const projectFields = useAppStore((s) => s.projectFields);
  const fieldId = useViewStore((s) =>
    siteId === null ? undefined : s.ganttGrouping[siteKey(siteId)]
  );
  const storedCollapsed = useViewStore((s) =>
    siteId === null ? undefined : s.collapsedGanttSections[siteKey(siteId)]
  );
  const setGanttGrouping = useViewStore((s) => s.setGanttGrouping);
  const toggleGanttSection = useViewStore((s) => s.toggleGanttSection);
  const setGanttSectionsCollapsed = useViewStore((s) => s.setGanttSectionsCollapsed);

  const fields = useMemo(() => fieldsForSite(projectFields, siteId), [projectFields, siteId]);
  const field = useMemo(
    () => (fieldId === undefined ? null : fields.find((f) => f.id === fieldId) ?? null),
    [fieldId, fields]
  );
  const collapsedKeys = field && storedCollapsed ? storedCollapsed : NO_KEYS;

  const setField = useCallback(
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
    if (siteId !== null && field) setGanttSectionsCollapsed(siteId, allSectionKeys(field));
  }, [siteId, field, setGanttSectionsCollapsed]);
  const expandAll = useCallback(() => {
    if (siteId !== null) setGanttSectionsCollapsed(siteId, []);
  }, [siteId, setGanttSectionsCollapsed]);

  return { siteId, field, fields, collapsedKeys, setField, toggleSection, collapseAll, expandAll };
}
