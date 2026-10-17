/**
 * Gantt "Group by tag group": the project list split into one section per
 * tag of the chosen group, plus a trailing "No <group>" section.
 *
 * Both panes (ProjectPanel on the left, TimelineBody on the right) and the
 * row-position maths (rowPositions.ts) walk the same flat `GanttRow[]` built
 * here, so the two panes always stack the same rows in the same order.
 *
 * Pure functions. Rules:
 * - tag order is the group's display order (`groupedTags`: sort_order, name);
 * - membership is decided by `project.tags[].id` only (the inline name/colour
 *   may be stale — the section takes the store's tag);
 * - a project with several tags of the group (multi-select) is listed once,
 *   under its first tag in group order;
 * - empty sections are omitted; "No <group>" comes last.
 */

import { groupedTags } from '@/utils/tags';
import type { Project, Tag, TagGroup } from '@/types';

/** `tag-<tag id>`, or `none` for projects without a tag of the group. */
export type GanttSectionKey = `tag-${number}` | 'none';

export interface GanttSection {
  key: GanttSectionKey;
  /** The section's tag; null for the "No <group>" section. */
  tag: Tag | null;
  label: string;
  projects: Project[];
}

/** One row of the Gantt project list, shared by both panes. */
export type GanttRow =
  | { type: 'section'; section: GanttSection; collapsed: boolean }
  | { type: 'project'; project: Project };

export function ganttSectionKey(tagId: number): GanttSectionKey {
  return `tag-${tagId}`;
}

/**
 * Every section key a grouping by `group` can produce at the site (whether
 * or not the section currently has projects) — what "Collapse all" stores.
 */
export function allSectionKeys(group: TagGroup, siteTags: Tag[]): GanttSectionKey[] {
  return [...groupTags(group, siteTags).map((t) => ganttSectionKey(t.id)), 'none'];
}

/** The group's tags applying to the site, in group display order. */
function groupTags(group: TagGroup, siteTags: Tag[]): Tag[] {
  return groupedTags(siteTags, [group]).find((s) => s.group?.id === group.id)?.tags ?? [];
}

/** Split `projects` (order kept inside each section) into the group's sections. */
export function buildProjectSections(
  projects: Project[],
  group: TagGroup,
  siteTags: Tag[]
): GanttSection[] {
  const tags = groupTags(group, siteTags);
  const rank = new Map(tags.map((t, i) => [t.id, i]));
  const buckets: Project[][] = tags.map(() => []);
  const untagged: Project[] = [];

  for (const project of projects) {
    let best = -1;
    for (const ref of project.tags ?? []) {
      const r = rank.get(ref.id);
      if (r !== undefined && (best === -1 || r < best)) best = r;
    }
    if (best === -1) untagged.push(project);
    else buckets[best].push(project);
  }

  const sections: GanttSection[] = [];
  tags.forEach((tag, i) => {
    if (buckets[i].length > 0) {
      sections.push({ key: ganttSectionKey(tag.id), tag, label: tag.name, projects: buckets[i] });
    }
  });
  if (untagged.length > 0) {
    sections.push({ key: 'none', tag: null, label: `No ${group.name}`, projects: untagged });
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
