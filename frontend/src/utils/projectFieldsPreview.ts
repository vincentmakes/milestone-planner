/**
 * The sample project of the preview in Settings → Project fields: a
 * `Project`-shaped object with a value for every built-in field and every
 * custom field (real option ids, since the dialog's Select shows only values
 * in its list), a 90-day span from today, one phase at 42 % (so the details
 * read "42% (calc)") and two staff bookings. The preview's Gantt card feeds
 * it through `projectTooltipData`, the builder the real tooltip uses.
 */

import type { Project, ProjectField, ProjectFieldValue, ProjectTagRef, Tag } from '@/types';
import { addDaysToDateString, formatDateISO } from './date';

/** Days the sample project lasts */
export const SAMPLE_DAYS = 90;

/** The sample text of a text field */
export const SAMPLE_TEXT = 'Sample text';

/** The sample number of Volume and of a number field */
export const SAMPLE_NUMBER = 12.5;

/** The sample value of one custom field, by type */
export function sampleFieldValue(field: ProjectField): ProjectFieldValue {
  switch (field.field_type) {
    case 'select':
      return field.options[0]?.id ?? null;
    case 'multiselect':
      return field.options.slice(0, 2).map((o) => o.id);
    case 'number':
      return SAMPLE_NUMBER;
    case 'toggle':
      return true;
    default:
      return SAMPLE_TEXT;
  }
}

/**
 * The sample project: every field filled, the first two of `tags` (in the
 * order given), dates from `today` (YYYY-MM-DD, default today in local time).
 */
export function sampleProject(
  fields: readonly ProjectField[],
  tags: readonly Tag[],
  today: string = formatDateISO(new Date())
): Project {
  const end = addDaysToDateString(today, SAMPLE_DAYS - 1);
  const fieldValues: Record<number, ProjectFieldValue> = {};
  for (const field of fields) fieldValues[field.id] = sampleFieldValue(field);
  const tagRefs: ProjectTagRef[] = tags.slice(0, 2).map((t) => ({ id: t.id, name: t.name, color: t.color }));
  return {
    id: 0,
    name: 'Sample project',
    site_id: 0,
    customer: 'Example Ltd',
    pm_id: null,
    pm_name: 'A. Manager',
    sales_pm: 'S. Contact',
    volume: SAMPLE_NUMBER,
    confirmed: true,
    archived: false,
    start_date: today,
    end_date: end,
    phases: [
      {
        id: 0,
        project_id: 0,
        name: 'Sample phase',
        start_date: today,
        end_date: end,
        color: '',
        order_index: 0,
        completion: 42,
        status: 'in_progress',
        dependencies: [],
        children: [],
        staffAssignments: [],
        equipmentAssignments: [],
      },
    ],
    staffAssignments: [
      { id: 1, staff_id: 1, staff_name: 'A. Researcher', allocation: 60, start_date: today, end_date: end },
      { id: 2, staff_id: 2, staff_name: 'B. Analyst', allocation: 40, start_date: today, end_date: end },
    ],
    equipmentAssignments: [],
    tags: tagRefs,
    team_ids: [],
    field_values: fieldValues,
  };
}
