/**
 * Gantt "Group by" a dropdown project field: the project list split into one
 * section per item of the field, plus a trailing "No <field>" section.
 *
 * Both panes (ProjectPanel on the left, TimelineBody on the right) and the
 * row-position maths (rowPositions.ts) walk the same flat `GanttRow[]` built
 * here, so the two panes always stack the same rows in the same order.
 *
 * Pure functions. Rules:
 * - `field` is the store's field with the items applying to the current site
 *   (utils/projectFilters.ts `fieldsForSite`); sections follow its item order;
 * - membership is decided by the project's item ids (`field_values`) only —
 *   the section takes the store's item for its name and colour;
 * - a project with several items of the field (multiselect) is listed once,
 *   under its first item in item order;
 * - empty sections are omitted; "No <field>" comes last.
 */

import { projectOptionIds } from '@/utils/projectFilters';
import type { Project, ProjectField, ProjectFieldOption } from '@/types';

/** `field-<item id>`, or `none` for projects without an item of the field. */
export type GanttSectionKey = `field-${number}` | 'none';

export interface GanttSection {
  key: GanttSectionKey;
  /** The section's item; null for the "No <field>" section. */
  option: ProjectFieldOption | null;
  label: string;
  projects: Project[];
}

/** One row of the Gantt project list, shared by both panes. */
export type GanttRow =
  | { type: 'section'; section: GanttSection; collapsed: boolean }
  | { type: 'project'; project: Project };

export function ganttSectionKey(optionId: number): GanttSectionKey {
  return `field-${optionId}`;
}

/**
 * Every section key a grouping by `field` can produce (whether or not the
 * section currently has projects) — what "Collapse all" stores.
 */
export function allSectionKeys(field: ProjectField): GanttSectionKey[] {
  return [...field.options.map((o) => ganttSectionKey(o.id)), 'none'];
}

/** Split `projects` (order kept inside each section) into the field's sections. */
export function buildProjectSections(projects: Project[], field: ProjectField): GanttSection[] {
  const rank = new Map(field.options.map((o, i) => [o.id, i]));
  const buckets: Project[][] = field.options.map(() => []);
  const without: Project[] = [];

  for (const project of projects) {
    // projectOptionIds lists the project's items in item order.
    const first = projectOptionIds(project, field)[0];
    if (first === undefined) without.push(project);
    else buckets[rank.get(first) as number].push(project);
  }

  const sections: GanttSection[] = [];
  field.options.forEach((option, i) => {
    if (buckets[i].length > 0) {
      sections.push({ key: ganttSectionKey(option.id), option, label: option.name, projects: buckets[i] });
    }
  });
  if (without.length > 0) {
    sections.push({ key: 'none', option: null, label: `No ${field.name}`, projects: without });
  }
  return sections;
}

/** Flatten sections into rows; a collapsed section contributes only its header row. */
export function buildGanttRows(sections: GanttSection[], collapsedKeys: readonly string[]): GanttRow[] {
  const collapsed = new Set(collapsedKeys);
  const rows: GanttRow[] = [];
  for (const section of sections) {
    const isCollapsed = collapsed.has(section.key);
    rows.push({ type: 'section', section, collapsed: isCollapsed });
    if (!isCollapsed) {
      for (const project of section.projects) rows.push({ type: 'project', project });
    }
  }
  return rows;
}

/** Ungrouped rows: one project row per project. */
export function flatGanttRows(projects: Project[]): GanttRow[] {
  return projects.map((project) => ({ type: 'project', project }));
}
