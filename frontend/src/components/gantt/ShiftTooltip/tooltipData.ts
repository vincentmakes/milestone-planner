/**
 * What the Gantt's Shift-hover details show, as plain data: built from a
 * project, phase or subphase by pure functions, rendered by `DetailsRows`.
 * The tooltip builds it on hover; Settings → Project fields builds the
 * project one from a sample project for its preview.
 */

import { differenceInDays, eachDayOfInterval, isWeekend, format } from 'date-fns';
import type { Phase, Subphase, Project, ProjectField, Tag } from '@/types';
import { parseLocalDate } from '@/utils/date';
import { fieldValueItems, formatFieldValue, isDropdownField } from '@/utils/projectFields';

export interface StaffInfo {
  name: string;
  allocation: number;
}

export interface TooltipTag {
  id: number;
  label: string;
  color: string;
}

export interface TooltipFieldRow {
  id: number;
  label: string;
  /** The value as text (text, number, toggle) */
  text?: string;
  /** A dropdown value's items, drawn as pills */
  items?: TooltipTag[];
}

/** The details of one bar (the tooltip adds the pointer position). */
export interface TooltipData {
  type: 'phase' | 'subphase' | 'project';
  title: string;
  projectName?: string; // Only for phase/subphase
  parentName?: string;
  startDate: string;
  endDate: string;
  completion: number | null;
  isCalculatedCompletion: boolean;
  workDays: number;
  totalDays: number;
  holidays: number;
  staff: StaffInfo[];
  // Project-specific
  customer?: string | null;
  pmName?: string | null;
  salesPm?: string | null;
  volume?: number | null;
  confirmed?: boolean;
  tags?: TooltipTag[];
  /** The project's custom field values, in field order (fields without a value left out) */
  fieldRows?: TooltipFieldRow[];
}

/**
 * The project's tags resolved through the store (inline project.tags can be
 * stale, e.g. in What-If), in tag order; deleted tags are dropped.
 */
function resolveTooltipTags(project: Project, tags: readonly Tag[]): TooltipTag[] {
  const ids = new Set((project.tags ?? []).map((t) => t.id));
  if (ids.size === 0) return [];
  return tags
    .filter((t) => ids.has(t.id))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name))
    .map((t) => ({ id: t.id, label: t.name, color: t.color }));
}

/**
 * The project's custom field values as tooltip rows, in the store's field
 * order (the server's sort order); fields without a value are left out.
 * Which of them show is decided at render (`project_tooltip_rows`).
 */
function resolveFieldRows(project: Project, fields: readonly ProjectField[]): TooltipFieldRow[] {
  const values = project.field_values ?? {};
  const rows: TooltipFieldRow[] = [];
  for (const field of fields) {
    const value = values[field.id];
    if (isDropdownField(field)) {
      const items = fieldValueItems(field, value);
      if (items.length) rows.push({ id: field.id, label: field.name, items });
      continue;
    }
    const text = formatFieldValue(field, value);
    if (text !== null) rows.push({ id: field.id, label: field.name, text });
  }
  return rows;
}

// Calculate work days excluding weekends and holidays
function calculateDurationStats(startDate: string, endDate: string, bankHolidayDates: ReadonlySet<string>) {
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);

  const totalDays = differenceInDays(end, start) + 1;

  let workDays = 0;
  let holidays = 0;

  try {
    const days = eachDayOfInterval({ start, end });
    for (const day of days) {
      const dateStr = format(day, 'yyyy-MM-dd');
      const isBankHoliday = bankHolidayDates.has(dateStr);
      const isWeekendDay = isWeekend(day);

      if (isBankHoliday) {
        holidays++;
      } else if (!isWeekendDay) {
        workDays++;
      }
    }
  } catch {
    // If dates are invalid, just use total days
    workDays = totalDays;
  }

  return { totalDays, workDays, holidays };
}

// Recursively calculate effective completion for an item
// This mirrors the logic in PhaseRow.tsx
function getEffectiveCompletion(item: Phase | Subphase): { completion: number | null; isCalculated: boolean } {
  if (!item) return { completion: null, isCalculated: false };

  const children = item.children ?? [];

  // Check if any children have completion (direct or calculated)
  let hasChildrenWithCompletion = false;
  for (const child of children) {
    const childResult = getEffectiveCompletion(child);
    if (childResult && childResult.completion !== null) {
      hasChildrenWithCompletion = true;
      break;
    }
  }

  if (hasChildrenWithCompletion) {
    // Calculate weighted average from children's effective completion
    // Children without completion count as 0%
    let weightedSum = 0;
    let totalWeight = 0;

    for (const child of children) {
      const childResult = getEffectiveCompletion(child);
      const start = parseLocalDate(child.start_date);
      const end = parseLocalDate(child.end_date);
      const days = Math.max(1, differenceInDays(end, start) + 1);
      // Unset completion counts as 0% when at least one sibling has a value
      const completion = childResult.completion ?? 0;
      weightedSum += completion * days;
      totalWeight += days;
    }

    if (totalWeight > 0) {
      return { completion: Math.round(weightedSum / totalWeight), isCalculated: true };
    }
  }

  // No children with completion, return item's own completion
  return { completion: item.completion ?? null, isCalculated: false };
}

function staffOf(assignments: Phase['staffAssignments']): StaffInfo[] {
  return (assignments ?? []).map((a) => ({
    name: a.staff_name || `Staff #${a.staff_id}`,
    allocation: a.allocation,
  }));
}

/** The details of a phase bar. */
export function phaseTooltipData(
  phase: Phase,
  project: Project,
  bankHolidayDates: ReadonlySet<string>
): TooltipData {
  const { totalDays, workDays, holidays } = calculateDurationStats(phase.start_date, phase.end_date, bankHolidayDates);
  const completionResult = getEffectiveCompletion(phase);
  return {
    type: 'phase',
    title: phase.name,
    projectName: project.name,
    startDate: phase.start_date,
    endDate: phase.end_date,
    completion: completionResult.completion,
    isCalculatedCompletion: completionResult.isCalculated,
    workDays,
    totalDays,
    holidays,
    staff: staffOf(phase.staffAssignments),
  };
}

/** The details of a subphase bar, at any depth under `parentPhase`. */
export function subphaseTooltipData(
  subphase: Subphase,
  project: Project,
  parentPhase: Phase,
  bankHolidayDates: ReadonlySet<string>
): TooltipData {
  const { totalDays, workDays, holidays } = calculateDurationStats(
    subphase.start_date,
    subphase.end_date,
    bankHolidayDates
  );
  const completionResult = getEffectiveCompletion(subphase);
  return {
    type: 'subphase',
    title: subphase.name,
    projectName: project.name,
    parentName: parentPhase.name,
    startDate: subphase.start_date,
    endDate: subphase.end_date,
    completion: completionResult.completion,
    isCalculatedCompletion: completionResult.isCalculated,
    workDays,
    totalDays,
    holidays,
    staff: staffOf(subphase.staffAssignments),
  };
}

interface ProjectTooltipContext {
  /** The store's tags (`appStore.tags`) */
  tags: readonly Tag[];
  /** The store's project fields, in order (`appStore.projectFields`) */
  fields: readonly ProjectField[];
  bankHolidayDates: ReadonlySet<string>;
}

/**
 * The details of a project bar: every value it has, whatever
 * `project_tooltip_rows` lists (the rows are gated at render). Null for a
 * project without dates (none of its own, no phase).
 */
export function projectTooltipData(
  project: Project,
  { tags, fields, bankHolidayDates }: ProjectTooltipContext
): TooltipData | null {
  // Calculate project dates from phases if not set
  const startDate = project.start_date || (project.phases?.[0]?.start_date ?? '');
  const endDate =
    project.end_date || (project.phases?.reduce((latest, p) => (p.end_date > latest ? p.end_date : latest), '') ?? '');

  if (!startDate || !endDate) return null;

  const { totalDays, workDays, holidays } = calculateDurationStats(startDate, endDate, bankHolidayDates);

  // Calculate overall project completion from phases
  let completion: number | null = null;
  let isCalculatedCompletion = false;
  const phasesWithCompletion = (project.phases ?? []).filter((p) => getEffectiveCompletion(p).completion !== null);

  if (phasesWithCompletion.length > 0) {
    let weightedSum = 0;
    let totalWeight = 0;

    for (const phase of project.phases ?? []) {
      const result = getEffectiveCompletion(phase);
      const start = parseLocalDate(phase.start_date);
      const end = parseLocalDate(phase.end_date);
      const days = Math.max(1, differenceInDays(end, start) + 1);
      const comp = result.completion ?? 0;
      weightedSum += comp * days;
      totalWeight += days;
    }

    if (totalWeight > 0) {
      completion = Math.round(weightedSum / totalWeight);
      isCalculatedCompletion = true;
    }
  }

  return {
    type: 'project',
    title: project.name,
    startDate,
    endDate,
    completion,
    isCalculatedCompletion,
    workDays,
    totalDays,
    holidays,
    // All staff assignments for the project (project-level)
    staff: staffOf(project.staffAssignments),
    customer: project.customer,
    pmName: project.pm_name,
    salesPm: project.sales_pm,
    volume: project.volume ?? null,
    confirmed: project.confirmed,
    tags: resolveTooltipTags(project, tags),
    fieldRows: resolveFieldRows(project, fields),
  };
}
