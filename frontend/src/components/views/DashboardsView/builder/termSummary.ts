/**
 * The words of a calculation's terms (2.6.0): what a term's filters say
 * ("has a customer", "team Chemistry"), its label in the read-back line
 * ("Booked weeks (has a customer)") and the summary on its row ("2 filters:
 * Has a customer, Team Chemistry"). Pure: the names come in as lookups.
 */

import type { MetricFilters, MetricResult, MetricTerm, ProjectField } from '@/types';
import { MEASURES } from '@/utils/metrics';

/** Names by id, per list filter; a missing id reads as "#id". */
export interface NameLookups {
  sites: ReadonlyMap<number, string>;
  teams: ReadonlyMap<number, string>;
  people: ReadonlyMap<number, string>;
  projects: ReadonlyMap<number, string>;
  tags: ReadonlyMap<number, string>;
  equipment: ReadonlyMap<number, string>;
  fields: readonly Pick<ProjectField, 'id' | 'name' | 'options'>[];
}

type ListKey = 'site_ids' | 'team_ids' | 'project_team_ids' | 'person_ids' | 'project_ids' | 'tag_ids' | 'equipment_ids';

const LISTS: readonly { key: ListKey; one: string; many: string; names: keyof Omit<NameLookups, 'fields'> }[] = [
  { key: 'site_ids', one: 'site', many: 'sites', names: 'sites' },
  { key: 'team_ids', one: 'team', many: 'teams', names: 'teams' },
  { key: 'project_team_ids', one: 'project team', many: 'project teams', names: 'teams' },
  { key: 'person_ids', one: 'person', many: 'people', names: 'people' },
  { key: 'project_ids', one: 'project', many: 'projects', names: 'projects' },
  { key: 'tag_ids', one: 'tag', many: 'tags', names: 'tags' },
  { key: 'equipment_ids', one: 'equipment', many: 'equipment', names: 'equipment' },
];

/** At most this many names are spelled out; more read as a count ("3 teams"). */
const NAMED = 2;

function listPart(names: string[], one: string, many: string): string {
  if (names.length === 1) return `${one} ${names[0]}`;
  if (names.length <= NAMED) return `${many} ${names.join(' or ')}`;
  return `${names.length} ${many}`;
}

/** What each filter (besides the period) says, in lower case where a word leads ("has a customer"). */
export function filterParts(filters: Omit<MetricFilters, 'period'> | undefined, lookups: NameLookups): string[] {
  if (!filters) return [];
  const parts: string[] = [];
  if (typeof filters.has_customer === 'boolean') parts.push(filters.has_customer ? 'has a customer' : 'no customer');
  for (const list of LISTS) {
    const ids = filters[list.key] ?? [];
    if (ids.length === 0) continue;
    const names = ids.map((id) => lookups[list.names].get(id) ?? `#${id}`);
    parts.push(listPart(names, list.one, list.many));
  }
  for (const [fieldId, ids] of Object.entries(filters.field_options ?? {})) {
    if (ids.length === 0) continue;
    const field = lookups.fields.find((f) => String(f.id) === fieldId);
    const names = ids.map((id) => field?.options.find((o) => o.id === id)?.name ?? `#${id}`);
    parts.push(`${field?.name ?? 'Field'}: ${names.length <= NAMED ? names.join(' or ') : `${names.length} items`}`);
  }
  const types = filters.equipment_types ?? [];
  if (types.length > 0) parts.push(listPart(types, 'type', 'types'));
  if (typeof filters.confirmed === 'boolean') parts.push(filters.confirmed ? 'confirmed' : 'not confirmed');
  if (filters.milestones === 'only') parts.push('milestones only');
  if (filters.milestones === 'exclude') parts.push('without milestones');
  if (filters.archived === 'include') parts.push('archived included');
  if (filters.archived === 'only') parts.push('archived only');
  return parts;
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The label of a measure. */
export const measureLabelOf = (measure: MetricTerm['measure']): string =>
  MEASURES.find((m) => m.key === measure)?.label ?? measure;

/** A term in words: its measure, with its filters in brackets ("Booked weeks (has a customer)"). */
export function termLabel(term: Pick<MetricTerm, 'measure' | 'filters'>, lookups: NameLookups): string {
  const parts = filterParts(term.filters, lookups);
  const measure = measureLabelOf(term.measure);
  return parts.length > 0 ? `${measure} (${parts.join(', ')})` : measure;
}

/** The summary on a term's row: "No filters", "1 filter: Has a customer", "2 filters: …". */
export function filterSummary(filters: Omit<MetricFilters, 'period'> | undefined, lookups: NameLookups): string {
  const parts = filterParts(filters, lookups);
  if (parts.length === 0) return 'No filters';
  return `${parts.length} ${parts.length === 1 ? 'filter' : 'filters'}: ${parts.map(capitalise).join(', ')}`;
}

/**
 * Why a calculation's result has no value: a term that is 0 (a division by
 * it), one without a value, or a number too large to show.
 */
export function noResultReason(terms: NonNullable<MetricResult['terms']>, labels: Readonly<Record<string, string>>): string {
  const zero = terms.find((t) => t.value === 0);
  if (zero) return `${labels[zero.name] ?? zero.name} is 0 in this period`;
  const empty = terms.find((t) => t.value === null);
  if (empty) return `${labels[empty.name] ?? empty.name} has no value in this period`;
  return 'The result is too large to show';
}
