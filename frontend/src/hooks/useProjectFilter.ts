/**
 * The current site's project filter (viewStore.projectFilters), shared by the
 * Gantt, the Kanban board and the ProjectFilterDropdown so all three agree.
 *
 * It works over the dropdown project fields (select / multiselect) and the
 * tags (utils/projectFilters.ts). Only items and tags applying to the current
 * site take part: a filter id of an item, field or tag that was deleted or
 * re-scoped away from the site is ignored (never "exclude everything"), and
 * pruned on the next write. The same goes for a "(None)" of a field the
 * dropdown no longer shows (none of its items applies to the site).
 *
 * Items and tags limited to teams the header team filter hides are left out
 * of the options too (a stored selection of one is ignored and pruned the
 * same way), but projects are still evaluated against every item and tag of
 * the site: a visible project holding a hidden item still has an item of that
 * field, so it never matches that field's "(None)".
 *
 * Filters are stored per tenant + site (`siteKey`), since the persisted view
 * storage is shared by every tenant on the origin.
 */

import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useTeamFilter } from '@/hooks/useTeamFilter';
import { siteKey, tagsForSite } from '@/utils/tags';
import {
  fieldsForSite,
  filterSelectionCount,
  normalizeSiteFilter,
  projectPassesFilter,
} from '@/utils/projectFilters';
import type { ProjectFilter } from '@/utils/projectFilters';
import type { Project, ProjectField, Tag } from '@/types';

export interface SiteProjectFilter {
  siteId: number | null;
  /**
   * Dropdown fields offered at the current site (the options): each with its
   * items applying to the site and passing the header team filter; a field
   * left with no item is omitted.
   */
  siteFields: ProjectField[];
  /** Dropdown fields with every item applying to the site, to resolve a project's items. */
  allSiteFields: ProjectField[];
  /** Tags applying to the current site and passing its header team filter (the options). */
  siteTags: Tag[];
  /** Every tag applying to the current site, to resolve a project's tags. */
  allSiteTags: Tag[];
  /** Stored filter with stale ids pruned. */
  filter: ProjectFilter;
  /** Number of effective selections (items, "(None)" options and tags). */
  activeCount: number;
}

export function useSiteProjectFilter(): SiteProjectFilter {
  const siteId = useAppStore((s) => s.currentSite?.id ?? null);
  const projectFields = useAppStore((s) => s.projectFields);
  const tags = useAppStore((s) => s.tags);
  const stored = useViewStore((s) =>
    siteId === null ? undefined : s.projectFilters[siteKey(siteId)]
  );

  const { tagMatches, optionMatches } = useTeamFilter();

  const allSiteFields = useMemo(() => fieldsForSite(projectFields, siteId), [projectFields, siteId]);
  const siteFields = useMemo(
    () =>
      allSiteFields.flatMap((field) => {
        const options = field.options.filter(optionMatches);
        if (options.length === field.options.length) return [field];
        return options.length > 0 ? [{ ...field, options }] : [];
      }),
    [allSiteFields, optionMatches]
  );
  const allSiteTags = useMemo(() => tagsForSite(tags, siteId), [tags, siteId]);
  const siteTags = useMemo(() => allSiteTags.filter(tagMatches), [allSiteTags, tagMatches]);
  const filter = useMemo(
    () => normalizeSiteFilter(stored, siteFields, siteTags),
    [stored, siteFields, siteTags]
  );

  return {
    siteId,
    siteFields,
    allSiteFields,
    siteTags,
    allSiteTags,
    filter,
    activeCount: filterSelectionCount(filter),
  };
}

/** `projects` narrowed by the current site's project filter (same array when inactive). */
export function useFilteredProjects(projects: Project[]): Project[] {
  const { allSiteFields, allSiteTags, filter, activeCount } = useSiteProjectFilter();
  // The filter holds ids offered at the site (normalised against the
  // team-narrowed options); a project's items and tags resolve against every
  // item and tag of the site.
  return useMemo(
    () =>
      activeCount === 0
        ? projects
        : projects.filter((p) => projectPassesFilter(p, filter, allSiteFields, allSiteTags)),
    [projects, filter, allSiteFields, allSiteTags, activeCount]
  );
}
