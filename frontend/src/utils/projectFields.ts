/**
 * Project field helpers: which dropdown items apply to a project, and the
 * shape of a field's value.
 *
 * Pure functions. Item scoping mirrors the server
 * (app/services/project_field_rules.py), which applies the tag rules: an item
 * applies at a site when it is `all_sites` or lists the site; one limited to
 * teams at that site applies only to a project sharing one of them (its teams
 * at other sites are ignored). Twins of `tagsForSite` / `tagsForProjectScope`
 * in ./tags.ts.
 */

import type { ProjectField, ProjectFieldOption, ProjectFieldType, ProjectFieldValue, Team } from '@/types';
import { teamIdsOnSite } from './teams';

/** The dropdown types: their values are item ids. */
export function isDropdownField(field: Pick<ProjectField, 'field_type'>): boolean {
  return field.field_type === 'select' || field.field_type === 'multiselect';
}

/** Items of `field` usable at `siteId`. No site (null/undefined) → only `all_sites` items. */
export function optionsForSite(
  field: Pick<ProjectField, 'options'>,
  siteId: number | null | undefined
): ProjectFieldOption[] {
  return field.options.filter(
    (o) => o.all_sites || (siteId != null && (o.site_ids ?? []).includes(siteId))
  );
}

/**
 * Items of `field` usable on a project at `siteId` with `projectTeamIds`: the
 * site's items ({@link optionsForSite}) minus those limited to teams at this
 * site (`siteTeams`) that the project does not belong to. Item order kept.
 */
export function optionsForProjectScope(
  field: Pick<ProjectField, 'options'>,
  siteId: number | null | undefined,
  projectTeamIds: readonly number[],
  siteTeams: readonly Team[]
): ProjectFieldOption[] {
  return optionsForSite(field, siteId).filter((o) => {
    const restricted = teamIdsOnSite(o.team_ids, siteTeams);
    return restricted.length === 0 || restricted.some((id) => projectTeamIds.includes(id));
  });
}

/** Item ids held in a dropdown value (a select's id, a multiselect's list); anything else → []. */
export function valueOptionIds(value: ProjectFieldValue | undefined): number[] {
  if (Array.isArray(value)) return value.filter((id) => Number.isInteger(id));
  if (typeof value === 'number' && Number.isInteger(value)) return [value];
  return [];
}

/** Whether a value counts as no value (what the API clears: null, '', [], blank text). */
export function isEmptyFieldValue(value: ProjectFieldValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Human name of a field type, for badges and the type picker. */
export const FIELD_TYPE_LABELS: Record<ProjectFieldType, string> = {
  text: 'Text',
  number: 'Number',
  toggle: 'Switch',
  select: 'Dropdown',
  multiselect: 'Multi-select dropdown',
};

// =============================================================================
// DIALOG DRAFTS
// =============================================================================

/**
 * A field's value while the project dialog edits it: text, number and select
 * as the control's string (`''` = none, a select holds the item id), a toggle
 * as a boolean, a multiselect as item ids.
 */
export type FieldDraft = string | boolean | number[];

/** The dialog draft of a stored value (absent = empty). */
export function draftFromValue(
  field: Pick<ProjectField, 'field_type'>,
  value: ProjectFieldValue | undefined
): FieldDraft {
  switch (field.field_type) {
    case 'toggle':
      return value === true;
    case 'multiselect':
      return valueOptionIds(value);
    case 'select':
      return valueOptionIds(value).length ? String(valueOptionIds(value)[0]) : '';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    default:
      return typeof value === 'string' ? value : '';
  }
}

/**
 * The value to send for a draft, in the API's shape; null = no value (a
 * toggle that is off counts as none). Dropdown items outside `allowedIds`
 * (the items that apply to the project's site and teams) are dropped, and a
 * multiselect lists its items in item order. `undefined` = the draft is not
 * a valid value (a number that does not parse).
 */
export function valueFromDraft(
  field: Pick<ProjectField, 'field_type' | 'options'>,
  draft: FieldDraft | undefined,
  allowedIds?: ReadonlySet<number>
): ProjectFieldValue | undefined {
  const allowed = (id: number) => !allowedIds || allowedIds.has(id);
  switch (field.field_type) {
    case 'toggle':
      return draft === true ? true : null;
    case 'multiselect': {
      const ids = new Set(Array.isArray(draft) ? draft : []);
      const picked = field.options.filter((o) => ids.has(o.id) && allowed(o.id)).map((o) => o.id);
      return picked.length ? picked : null;
    }
    case 'select': {
      const id = typeof draft === 'string' && draft !== '' ? Number(draft) : NaN;
      return Number.isInteger(id) && allowed(id) ? id : null;
    }
    case 'number': {
      const text = typeof draft === 'string' ? draft.trim() : '';
      if (text === '') return null;
      const n = Number(text);
      return Number.isFinite(n) ? n : undefined;
    }
    default: {
      const text = typeof draft === 'string' ? draft.trim() : '';
      return text === '' ? null : text;
    }
  }
}

/** The stored value in the shape `valueFromDraft` returns (for a "did it change" check). */
export function normalizeStoredValue(
  field: Pick<ProjectField, 'field_type' | 'options'>,
  value: ProjectFieldValue | undefined
): ProjectFieldValue {
  return valueFromDraft(field, draftFromValue(field, value)) ?? null;
}

/** Equality of two values as `valueFromDraft` / `normalizeStoredValue` return them. */
export function sameFieldValue(a: ProjectFieldValue, b: ProjectFieldValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((id, i) => id === b[i]);
  }
  return a === b;
}
