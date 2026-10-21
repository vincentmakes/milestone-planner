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
 * Tags limited to teams the header team filter hides are left out too (a
 * stored selection of one is ignored and pruned the same way).
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
import type { Project, Tag, TagGroup } from '@/types';

export interface SiteTagFilter {
  siteId: number | null;
  /** Tags applying to the current site and passing its header team filter. */
  siteTags: Tag[];
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

  const siteTags = useMemo(
    () => tagsForSite(tags, siteId).filter(tagMatches),
    [tags, siteId, tagMatches]
  );
  const filter = useMemo(
    () => normalizeSiteTagFilter(stored, siteTags, tagGroups),
    [stored, siteTags, tagGroups]
  );

  return {
    siteId,
    siteTags,
    tagGroups,
    filter,
    activeCount: filter.tagIds.length + filter.noneGroupIds.length,
  };
}

/** `projects` narrowed by the current site's tag filter (same array when inactive). */
export function useTagFilteredProjects(projects: Project[]): Project[] {
  const { siteTags, tagGroups, filter, activeCount } = useSiteTagFilter();
  return useMemo(
    () =>
      activeCount === 0
        ? projects
        : projects.filter((p) => projectPassesTagFilter(p, filter, siteTags, tagGroups)),
    [projects, filter, siteTags, tagGroups, activeCount]
  );
}
