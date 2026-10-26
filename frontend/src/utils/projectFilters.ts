/**
 * The Gantt / Kanban project filter, the Gantt "Group by" choices and the
 * "Colour by" bar colour — over the dropdown project fields (select /
 * multiselect) and the tags.
 *
 * Pure functions. Item and tag scoping come from ./projectFields.ts and
 * ./tags.ts. Everything except ids is resolved through the store's
 * `projectFields` / `tags`: inline project data (`project.tags[]` names and
 * colours) can be stale during What-If, and an id that no longer resolves is
 * ignored — never "exclude everything".
 */

import type { Project, ProjectField, ProjectFieldOption, Tag } from '@/types';
import { isDropdownField, optionsForSite, valueOptionIds } from './projectFields';
import { compareTags, indexTags } from './tags';

export { optionsForSite };

// =============================================================================
// FIELDS
// =============================================================================

/** Field display order: `sort_order`, then name. */
function compareFields(a: ProjectField, b: ProjectField): number {
  return (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name);
}

/** The dropdown fields (select / multiselect) in display order. Returns a new array. */
export function selectableFields(fields: readonly ProjectField[]): ProjectField[] {
  return fields.filter(isDropdownField).sort(compareFields);
}

/**
 * The dropdown fields applicable at `siteId`, each with only its items usable
 * at the site ({@link optionsForSite}, item order kept); a field with no item
 * there is left out. Field display order.
 */
export function fieldsForSite(fields: readonly ProjectField[], siteId: number | null | undefined): ProjectField[] {
  return selectableFields(fields).flatMap((field) => {
    const options = optionsForSite(field, siteId);
    return options.length > 0 ? [{ ...field, options }] : [];
  });
}

/**
 * The project's chosen items of `field` that exist among `field.options`, in
 * item order (a select gives at most one).
 */
export function projectOptionIds(project: Pick<Project, 'field_values'>, field: ProjectField): number[] {
  const chosen = new Set(valueOptionIds((project.field_values ?? {})[field.id]));
  if (chosen.size === 0) return [];
  return field.options.filter((o) => chosen.has(o.id)).map((o) => o.id);
}

/** An item resolved by id: the item, its field and its rank in the field's item order. */
export interface IndexedOption {
  option: ProjectFieldOption;
  field: ProjectField;
  rank: number;
}

const optionIndexCache = new WeakMap<readonly ProjectField[], Map<number, IndexedOption>>();

/** item id → {@link IndexedOption}, cached per `fields` array (the store replaces it on change). */
export function indexOptions(fields: readonly ProjectField[]): Map<number, IndexedOption> {
  let index = optionIndexCache.get(fields);
  if (!index) {
    index = new Map();
    for (const field of fields) {
      field.options.forEach((option, rank) => index!.set(option.id, { option, field, rank }));
    }
    optionIndexCache.set(fields, index);
  }
  return index;
}

// =============================================================================
// FILTER
// =============================================================================

/**
 * A site's project filter (persisted in viewStore.projectFilters).
 * - `optionIds`: wanted field items. OR within one field, AND across fields.
 * - `noneFieldIds`: fields whose "(None)" is ticked — the project holds no
 *   item of that field. OR-ed with the field's ticked items.
 * - `tagIds`: wanted tags, one OR bucket, AND-ed with the fields.
 */
export interface ProjectFilter {
  optionIds: number[];
  noneFieldIds: number[];
  tagIds: number[];
}

export const EMPTY_PROJECT_FILTER: ProjectFilter = Object.freeze({
  optionIds: [],
  noneFieldIds: [],
  tagIds: [],
}) as unknown as ProjectFilter;

interface FieldBucket {
  field: ProjectField;
  optionIds: Set<number>;
  none: boolean;
}

interface Buckets {
  fields: FieldBucket[];
  /** Wanted tags that resolve; null = no tag bucket. */
  tagIds: Set<number> | null;
}

/** Effective buckets of `filter` over `fields` / `tags`: stale ids are ignored. */
function filterBuckets(filter: ProjectFilter, fields: readonly ProjectField[], tags: Tag[]): Buckets {
  const byField = new Map<number, FieldBucket>();
  const bucket = (field: ProjectField) => {
    let b = byField.get(field.id);
    if (!b) {
      b = { field, optionIds: new Set(), none: false };
      byField.set(field.id, b);
    }
    return b;
  };

  const options = indexOptions(fields);
  for (const id of filter.optionIds ?? []) {
    const hit = options.get(id);
    if (hit) bucket(hit.field).optionIds.add(id);
  }
  const fieldById = new Map(fields.map((f) => [f.id, f]));
  for (const id of filter.noneFieldIds ?? []) {
    const field = fieldById.get(id);
    if (field) bucket(field).none = true;
  }

  const tagById = indexTags(tags);
  const tagIds = new Set((filter.tagIds ?? []).filter((id) => tagById.has(id)));
  return { fields: [...byField.values()], tagIds: tagIds.size > 0 ? tagIds : null };
}

/**
 * Does `project` pass the filter? `fields` are the dropdown fields the
 * project is resolved against (with the items of its site, see
 * {@link fieldsForSite}) and `tags` the tags of its site. An empty (or fully
 * stale) filter passes everything.
 */
export function projectPassesFilter(
  project: Pick<Project, 'field_values' | 'tags'>,
  filter: ProjectFilter | null | undefined,
  fields: readonly ProjectField[],
  tags: Tag[]
): boolean {
  if (!filter) return true;
  const buckets = filterBuckets(filter, fields, tags);

  for (const b of buckets.fields) {
    const held = projectOptionIds(project, b.field);
    const matches = held.some((id) => b.optionIds.has(id)) || (b.none && held.length === 0);
    if (!matches) return false;
  }
  if (buckets.tagIds) {
    const wanted = buckets.tagIds;
    if (!(project.tags ?? []).some((t) => wanted.has(t.id))) return false;
  }
  return true;
}

/** True only if the filter still selects something that exists. */
export function isFilterActive(
  filter: ProjectFilter | null | undefined,
  fields: readonly ProjectField[],
  tags: Tag[]
): boolean {
  if (!filter) return false;
  const buckets = filterBuckets(filter, fields, tags);
  return buckets.fields.length > 0 || buckets.tagIds !== null;
}

/**
 * One site's filter as the ProjectFilterDropdown shows it: ids that no longer
 * resolve among `siteFields` (the fields and items offered at the site) and
 * `siteTags` pruned, duplicates dropped. A "(None)" survives only for a field
 * the dropdown renders, otherwise it would stay selected with no checkbox
 * left to untick it.
 */
export function normalizeSiteFilter(
  filter: ProjectFilter | null | undefined,
  siteFields: readonly ProjectField[],
  siteTags: Tag[]
): ProjectFilter {
  if (!filter) return { optionIds: [], noneFieldIds: [], tagIds: [] };
  const options = indexOptions(siteFields);
  const fieldIds = new Set(siteFields.map((f) => f.id));
  const tagById = indexTags(siteTags);
  return {
    optionIds: [...new Set(filter.optionIds ?? [])].filter((id) => options.has(id)),
    noneFieldIds: [...new Set(filter.noneFieldIds ?? [])].filter((id) => fieldIds.has(id)),
    tagIds: [...new Set(filter.tagIds ?? [])].filter((id) => tagById.has(id)),
  };
}

/** Number of selections in a (normalised) filter, for the trigger badge. */
export function filterSelectionCount(filter: ProjectFilter): number {
  return filter.optionIds.length + filter.noneFieldIds.length + filter.tagIds.length;
}

// =============================================================================
// COLOUR BY
// =============================================================================

/** What the Gantt bars are coloured by: a dropdown field's id, or the tags. */
export type ColorByChoice = number | 'tags';

/**
 * Bar colour of a project when the Gantt is coloured by `colorBy`:
 * - a field id: the colour of the project's first chosen item in item order
 *   (the item Group by files the project under);
 * - `'tags'`: the colour of the project's first tag in tag order
 *   (`sort_order`, then name);
 * - otherwise (null, an unknown field, no item / tag): null → default bar.
 *
 * Fields and tags resolve by id through `fields` / `tags` (the store's).
 */
export function projectBarColor(
  project: Pick<Project, 'field_values' | 'tags'>,
  fields: readonly ProjectField[],
  tags: Tag[],
  colorBy: ColorByChoice | null | undefined
): string | null {
  if (colorBy === 'tags') {
    const tagById = indexTags(tags);
    let best: Tag | null = null;
    for (const ref of project.tags ?? []) {
      const tag = tagById.get(ref.id);
      if (tag && (best === null || compareTags(tag, best) < 0)) best = tag;
    }
    return best?.color ?? null;
  }
  if (colorBy == null) return null;
  const field = fields.find((f) => f.id === colorBy);
  if (!field) return null;
  const first = projectOptionIds(project, field)[0];
  return first === undefined ? null : (field.options.find((o) => o.id === first)?.color ?? null);
}
