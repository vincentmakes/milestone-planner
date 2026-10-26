/**
 * Project tag helpers: site scoping, tag order, the per-site storage key
 * shared by the per-site view preferences, and the bar text colour.
 *
 * Pure functions. They mirror the server rules (app/routers/tags.py and the
 * project tag validation): a tag applies to a project when it is `all_sites`
 * or lists the project's site; a team-restricted tag applies to a project that
 * shares a team with it (its teams at the project's site — teams of other
 * sites are ignored).
 *
 * Inline `project.tags[]` entries can be stale (What-If, a teammate's edit to
 * a tag), so everything except the tag *ids* is resolved through the store's
 * `tags`. The Gantt / Kanban filter and the bar colour over project fields and
 * tags live in ./projectFilters.ts.
 *
 * The one impure helper is {@link siteKey}, which reads the tenant from the
 * URL.
 */

import { getTenantPrefix } from '@/api/client';
import type { Tag, Team } from '@/types';
import { teamIdsOnSite } from './teams';

// =============================================================================
// SITE SCOPING
// =============================================================================

/** Tags usable at `siteId`. No site (null/undefined) → only `all_sites` tags. */
export function tagsForSite(tags: Tag[], siteId: number | null | undefined): Tag[] {
  return tags.filter(
    (t) => t.all_sites || (siteId != null && (t.site_ids ?? []).includes(siteId))
  );
}

/**
 * Tags usable on a project at `siteId` with `projectTeamIds`: the site's tags
 * ({@link tagsForSite}) minus those restricted to teams at this site
 * (`siteTeams`) that the project does not belong to.
 */
export function tagsForProjectScope(
  tags: Tag[],
  siteId: number | null | undefined,
  projectTeamIds: readonly number[],
  siteTeams: readonly Team[]
): Tag[] {
  return tagsForSite(tags, siteId).filter((t) => {
    const restricted = teamIdsOnSite(t.team_ids, siteTeams);
    return restricted.length === 0 || restricted.some((id) => projectTeamIds.includes(id));
  });
}

/** Tag display order: `sort_order`, then name. */
export function compareTags(a: Tag, b: Tag): number {
  return (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name);
}

/** Tags in display order ({@link compareTags}). Returns a new array. */
export function sortTags(tags: readonly Tag[]): Tag[] {
  return [...tags].sort(compareTags);
}

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

// =============================================================================
// PER-SITE STORAGE KEY
// =============================================================================

/**
 * Key of a site's per-browser view preferences (project filter, team filter,
 * Gantt Group by / Colour by): `"<tenant slug>:<site id>"` (slug empty in
 * single-tenant mode). The persisted view storage is one localStorage key per
 * origin, shared by every `/t/{slug}/` tenant, and site ids are small integers
 * in each tenant DB — keying by site id alone would apply tenant A's
 * preference to tenant B's site with the same id.
 */
export function siteKey(siteId: number, tenantPrefix: string = getTenantPrefix()): string {
  return `${tenantPrefix.replace(/^\/t\//, '')}:${siteId}`;
}

/** Shape of a {@link siteKey} (legacy site-id-only keys do not match). */
export const SITE_KEY_PATTERN = /^(?:[a-z0-9][a-z0-9-]*)?:\d+$/;

/** Former name of {@link siteKey} (the key was introduced for the tag filter). */
export const tagFilterKey = siteKey;

/** Former name of {@link SITE_KEY_PATTERN}. */
export const TAG_FILTER_KEY_PATTERN = SITE_KEY_PATTERN;

// =============================================================================
// BAR TEXT COLOUR
// =============================================================================

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
