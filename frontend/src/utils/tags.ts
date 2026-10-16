/**
 * Project tag helpers: site scoping, grouping, single-select groups, the
 * Gantt/Kanban tag filter and the tag-driven project bar colour.
 *
 * Pure functions. They mirror the server rules (app/routers/tags.py and the
 * project tag validation): a tag applies to a project when it is `all_sites`
 * or lists the project's site; a project holds at most one tag per
 * single-select group.
 *
 * Inline `project.tags[]` entries can be stale (What-If, a teammate's edit to
 * a tag), so everything except the tag *ids* is resolved through the store's
 * `tags` / `tagGroups`. A project tag id that no longer resolves is ignored.
 *
 * The one impure helper is {@link tagFilterKey}, which reads the tenant from
 * the URL.
 */

import { getTenantPrefix } from '@/api/client';
import type { Project, Tag, TagGroup } from '@/types';

// =============================================================================
// SITE SCOPING + GROUPING
// =============================================================================

/** Tags usable at `siteId`. No site (null/undefined) → only `all_sites` tags. */
export function tagsForSite(tags: Tag[], siteId: number | null | undefined): Tag[] {
  return tags.filter(
    (t) => t.all_sites || (siteId != null && (t.site_ids ?? []).includes(siteId))
  );
}

/** One section of tags: a group, or `group: null` for the ungrouped ("Other") tags. */
export interface TagSection {
  group: TagGroup | null;
  tags: Tag[];
}

function bySortThenName<T extends { sort_order: number; name: string }>(a: T, b: T): number {
  return (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name);
}

/** Tag groups in display order (`sort_order`, then name). Returns a new array. */
export function sortTagGroups(groups: TagGroup[]): TagGroup[] {
  return [...groups].sort(bySortThenName);
}

/**
 * Tags arranged in sections: groups by `sort_order` then name, tags inside a
 * section by `sort_order` then name, ungrouped tags (and tags whose group no
 * longer exists) last under `group: null`. Empty sections are omitted.
 *
 * `siteId` omitted (undefined) = no site filter; a number filters like
 * {@link tagsForSite}, and null keeps only the `all_sites` tags.
 */
export function groupedTags(
  tags: Tag[],
  groups: TagGroup[],
  siteId?: number | null
): TagSection[] {
  const scoped = siteId === undefined ? tags : tagsForSite(tags, siteId);
  const groupIds = new Set(groups.map((g) => g.id));
  const byGroup = new Map<number | null, Tag[]>();
  for (const tag of scoped) {
    const key = tag.group_id != null && groupIds.has(tag.group_id) ? tag.group_id : null;
    const list = byGroup.get(key);
    if (list) list.push(tag);
    else byGroup.set(key, [tag]);
  }

  const sections: TagSection[] = [];
  for (const group of sortTagGroups(groups)) {
    const list = byGroup.get(group.id);
    if (list?.length) sections.push({ group, tags: [...list].sort(bySortThenName) });
  }
  const other = byGroup.get(null);
  if (other?.length) sections.push({ group: null, tags: [...other].sort(bySortThenName) });
  return sections;
}

// =============================================================================
// SINGLE-SELECT GROUPS
// =============================================================================

function singleSelectGroupIds(groups: TagGroup[]): Set<number> {
  return new Set(groups.filter((g) => g.single_select).map((g) => g.id));
}

/** True when the selection holds two or more tags of one single-select group. */
export function violatesSingleSelect(
  selectedIds: Iterable<number>,
  tags: Tag[],
  groups: TagGroup[]
): boolean {
  const single = singleSelectGroupIds(groups);
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const seen = new Set<number>();
  for (const id of selectedIds) {
    const gid = tagById.get(id)?.group_id;
    if (gid == null || !single.has(gid)) continue;
    if (seen.has(gid)) return true;
    seen.add(gid);
  }
  return false;
}

/**
 * Toggle `tagId` in the selection. Selecting a tag of a single-select group
 * replaces that group's current selection (radio behaviour); toggling an
 * already-selected tag removes it. Returns a new Set.
 */
export function applyTagSelection(
  selectedIds: Set<number>,
  tagId: number,
  tags: Tag[],
  groups: TagGroup[]
): Set<number> {
  const next = new Set(selectedIds);
  if (next.has(tagId)) {
    next.delete(tagId);
    return next;
  }
  const tag = tags.find((t) => t.id === tagId);
  const gid = tag?.group_id;
  if (gid != null && singleSelectGroupIds(groups).has(gid)) {
    for (const other of tags) {
      if (other.group_id === gid) next.delete(other.id);
    }
  }
  next.add(tagId);
  return next;
}

// =============================================================================
// TAG FILTER
// =============================================================================

/**
 * Per-site project filter (persisted in viewStore.tagFilters).
 * - `tagIds`: wanted tags. OR inside a group (ungrouped tags form one
 *   "Other" bucket), AND across groups.
 * - `noneGroupIds`: groups for which "(No tag)" is ticked — the project
 *   carries no tag of that group. OR-ed with the group's ticked tags.
 */
export interface TagFilter {
  tagIds: number[];
  noneGroupIds: number[];
}

export const EMPTY_TAG_FILTER: TagFilter = Object.freeze({
  tagIds: [],
  noneGroupIds: [],
}) as TagFilter;

const OTHER_BUCKET = 'other';

interface Bucket {
  tagIds: Set<number>;
  none: boolean;
  /** Group id this bucket's "(No tag)" refers to (null for "Other"). */
  groupId: number | null;
}

/** Effective buckets of a filter: stale tag/group ids are ignored. */
function filterBuckets(filter: TagFilter, tags: Tag[], groups: TagGroup[]): Map<string, Bucket> {
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const groupIds = new Set(groups.map((g) => g.id));
  const buckets = new Map<string, Bucket>();
  const bucket = (key: string, groupId: number | null) => {
    let b = buckets.get(key);
    if (!b) {
      b = { tagIds: new Set(), none: false, groupId };
      buckets.set(key, b);
    }
    return b;
  };

  for (const id of filter.tagIds ?? []) {
    const tag = tagById.get(id);
    if (!tag) continue;
    const gid = tag.group_id != null && groupIds.has(tag.group_id) ? tag.group_id : null;
    bucket(gid === null ? OTHER_BUCKET : String(gid), gid).tagIds.add(id);
  }
  for (const gid of filter.noneGroupIds ?? []) {
    if (!groupIds.has(gid)) continue;
    bucket(String(gid), gid).none = true;
  }
  return buckets;
}

/** Does `project` pass the filter? An empty (or fully stale) filter passes everything. */
export function projectPassesTagFilter(
  project: Pick<Project, 'tags'>,
  filter: TagFilter | null | undefined,
  tags: Tag[],
  groups: TagGroup[]
): boolean {
  if (!filter || ((filter.tagIds?.length ?? 0) === 0 && (filter.noneGroupIds?.length ?? 0) === 0)) {
    return true;
  }
  const buckets = filterBuckets(filter, tags, groups);
  if (buckets.size === 0) return true;

  const tagById = new Map(tags.map((t) => [t.id, t]));
  const projectTags = (project.tags ?? [])
    .map((t) => tagById.get(t.id))
    .filter((t): t is Tag => t !== undefined);
  const projectTagIds = new Set(projectTags.map((t) => t.id));

  for (const b of buckets.values()) {
    const hasWanted = [...b.tagIds].some((id) => projectTagIds.has(id));
    const hasNone = b.none && !projectTags.some((t) => t.group_id === b.groupId);
    if (!hasWanted && !hasNone) return false;
  }
  return true;
}

/** True only if the filter still selects something that exists. */
export function isTagFilterActive(
  filter: TagFilter | null | undefined,
  tags: Tag[],
  groups: TagGroup[]
): boolean {
  if (!filter) return false;
  return filterBuckets(filter, tags, groups).size > 0;
}

/**
 * viewStore.tagFilters key for a site: `"<tenant slug>:<site id>"` (slug empty
 * in single-tenant mode). The persisted view storage is one localStorage key
 * per origin, shared by every `/t/{slug}/` tenant, and site ids are small
 * integers in each tenant DB — keying by site id alone would apply tenant A's
 * filter to tenant B's site with the same id.
 */
export function tagFilterKey(siteId: number, tenantPrefix: string = getTenantPrefix()): string {
  return `${tenantPrefix.replace(/^\/t\//, '')}:${siteId}`;
}

/** Shape of a {@link tagFilterKey} (legacy site-id-only keys do not match). */
export const TAG_FILTER_KEY_PATTERN = /^(?:[a-z0-9][a-z0-9-]*)?:\d+$/;

/** The filter with ids that no longer resolve to a tag/group pruned (and deduped). */
export function normalizeTagFilter(
  filter: TagFilter | null | undefined,
  tags: Tag[],
  groups: TagGroup[]
): TagFilter {
  if (!filter) return { tagIds: [], noneGroupIds: [] };
  const tagIds = new Set(tags.map((t) => t.id));
  const groupIds = new Set(groups.map((g) => g.id));
  return {
    tagIds: [...new Set(filter.tagIds ?? [])].filter((id) => tagIds.has(id)),
    noneGroupIds: [...new Set(filter.noneGroupIds ?? [])].filter((id) => groupIds.has(id)),
  };
}

/**
 * {@link normalizeTagFilter} for one site's filter, as the TagFilterDropdown
 * shows it: `siteTags` are the tags applying to the site, and a "(No tag)"
 * selection survives only for a group the dropdown renders (one with at least
 * one site tag, see {@link groupedTags}) — otherwise it would stay selected
 * with no checkbox left to untick it.
 */
export function normalizeSiteTagFilter(
  filter: TagFilter | null | undefined,
  siteTags: Tag[],
  groups: TagGroup[]
): TagFilter {
  const shownGroups = groupedTags(siteTags, groups).flatMap((section) =>
    section.group ? [section.group] : []
  );
  return normalizeTagFilter(filter, siteTags, shownGroups);
}

// =============================================================================
// PROJECT BAR COLOUR
// =============================================================================

const tagIndexCache = new WeakMap<Tag[], Map<number, Tag>>();

/** id → tag map, cached per `tags` array (the store replaces the array on change). */
export function indexTags(tags: Tag[]): Map<number, Tag> {
  let index = tagIndexCache.get(tags);
  if (!index) {
    index = new Map(tags.map((t) => [t.id, t]));
    tagIndexCache.set(tags, index);
  }
  return index;
}

/**
 * Colour of the project's tag in the group flagged `colors_projects`, or null
 * (no such group, or the project has no tag in it → default bar styling).
 */
export function projectBarColor(
  project: Pick<Project, 'tags'>,
  tagById: Map<number, Tag>,
  groups: TagGroup[]
): string | null {
  const colouring = groups.find((g) => g.colors_projects);
  if (!colouring) return null;
  for (const ref of project.tags ?? []) {
    const tag = tagById.get(ref.id);
    if (tag && tag.group_id === colouring.id) return tag.color;
  }
  return null;
}

const LIGHT_TEXT = '#ffffff';
const DARK_TEXT = '#111827';

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance of an `#rgb` / `#rrggbb` colour (null if unparsable). */
export function relativeLuminance(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const DARK_TEXT_LUMINANCE = relativeLuminance(DARK_TEXT) as number;

/** Text colour for a label on `hex`: white or near-black, whichever contrasts more. */
export function barTextColor(hex: string): '#ffffff' | '#111827' {
  const l = relativeLuminance(hex);
  if (l === null) return LIGHT_TEXT;
  const contrastWhite = 1.05 / (l + 0.05);
  const contrastDark = (l + 0.05) / (DARK_TEXT_LUMINANCE + 0.05);
  return contrastDark > contrastWhite ? DARK_TEXT : LIGHT_TEXT;
}
