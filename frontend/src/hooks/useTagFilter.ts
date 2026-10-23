/**
 * The current site's project tag filter (viewStore.tagFilters), shared by the
 * Gantt, the Kanban board and the TagFilterDropdown so all three agree.
 *
 * Only tags applying to the current site take part: a filter id for a tag
 * that was deleted or re-scoped away from the site is ignored (never
 * "exclude everything"), and pruned on the next write. The same goes for a
 * "(No tag)" selection of a group the dropdown no longer shows (none of its
 * tags applies to the site).
 *
 * Tags limited to teams the header team filter hides are left out of the
 * options too (a stored selection of one is ignored and pruned the same way),
 * but projects are still evaluated against every tag of the site: a visible
 * project carrying a hidden tag still has a tag of that group.
 *
 * Filters are stored per tenant + site (`tagFilterKey`), since the persisted
 * view storage is shared by every tenant on the origin.
 */

import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useTeamFilter } from '@/hooks/useTeamFilter';
import { normalizeSiteTagFilter, projectPassesTagFilter, tagFilterKey, tagsForSite } from '@/utils/tags';
import type { TagFilter } from '@/utils/tags';
import type { Project, Tag } from '@/types';
import type { TagGroup } from '@/utils/tags';

export interface SiteTagFilter {
  siteId: number | null;
  /** Tags applying to the current site and passing its header team filter (the options). */
  siteTags: Tag[];
  /** Every tag applying to the current site, to resolve a project's tags. */
  allSiteTags: Tag[];
  tagGroups: TagGroup[];
  /** Stored filter with stale ids pruned. */
  filter: TagFilter;
  /** Number of effective selections (tags + "(No tag)" options). */
  activeCount: number;
}

export function useSiteTagFilter(): SiteTagFilter {
  const siteId = useAppStore((s) => s.currentSite?.id ?? null);
  const tags = useAppStore((s) => s.tags);
  const tagGroups = useAppStore((s) => s.tagGroups);
  const stored = useViewStore((s) =>
    siteId === null ? undefined : s.tagFilters[tagFilterKey(siteId)]
  );

  const { tagMatches } = useTeamFilter();

  const allSiteTags = useMemo(() => tagsForSite(tags, siteId), [tags, siteId]);
  const siteTags = useMemo(() => allSiteTags.filter(tagMatches), [allSiteTags, tagMatches]);
  const filter = useMemo(
    () => normalizeSiteTagFilter(stored, siteTags, tagGroups),
    [stored, siteTags, tagGroups]
  );

  return {
    siteId,
    siteTags,
    allSiteTags,
    tagGroups,
    filter,
    activeCount: filter.tagIds.length + filter.noneGroupIds.length,
  };
}

/** `projects` narrowed by the current site's tag filter (same array when inactive). */
export function useTagFilteredProjects(projects: Project[]): Project[] {
  const { allSiteTags, tagGroups, filter, activeCount } = useSiteTagFilter();
  // The filter holds option ids only (normalised against `siteTags`); a
  // project's tags resolve against every site tag.
  return useMemo(
    () =>
      activeCount === 0
        ? projects
        : projects.filter((p) => projectPassesTagFilter(p, filter, allSiteTags, tagGroups)),
    [projects, filter, allSiteTags, tagGroups, activeCount]
  );
}
