/**
 * Gantt "Group by tag group" sections: tag order = group display order,
 * membership by tag id only, first tag in group order wins (no duplicate
 * rows), empty sections omitted, "No <group>" last; collapsed sections keep
 * only their header row.
 */
import { describe, it, expect } from 'vitest';
import {
  allSectionKeys,
  buildGanttRows,
  buildProjectSections,
  flatGanttRows,
} from '../projectSections';
import type { Project, Tag, TagGroup } from '@/types';

function tag(id: number, name: string, extra: Partial<Tag> = {}): Tag {
  return { id, name, color: '#10b981', group_id: 1, all_sites: true, site_ids: [], sort_order: 0, ...extra };
}

const AREA: TagGroup = { id: 1, name: 'Area', single_select: false, colors_projects: false, sort_order: 0 };

// Display order: Bio (sort 0), Chem (sort 1), Pharma (sort 1, after Chem by name)
const BIO = tag(10, 'Bio', { sort_order: 0 });
const PHARMA = tag(12, 'Pharma', { sort_order: 1 });
const CHEM = tag(11, 'Chem', { sort_order: 1 });
const OTHER_GROUP = tag(20, 'Customer', { group_id: 2 });
const UNGROUPED = tag(30, 'Pilot', { group_id: null });
const siteTags = [PHARMA, OTHER_GROUP, CHEM, UNGROUPED, BIO];

function project(id: number, tagIds: number[]): Project {
  // Inline names/colours are stale on purpose: only the ids count.
  return {
    id,
    name: `P${id}`,
    tags: tagIds.map((t) => ({ id: t, name: 'stale', color: '#000000', group_id: null })),
  } as unknown as Project;
}

describe('buildProjectSections', () => {
  it('orders sections by the group display order and keeps project order inside', () => {
    const projects = [project(1, [12]), project(2, [10]), project(3, [11]), project(4, [10])];
    const sections = buildProjectSections(projects, AREA, siteTags);
    expect(sections.map((s) => s.key)).toEqual(['tag-10', 'tag-11', 'tag-12']);
    expect(sections.map((s) => s.label)).toEqual(['Bio', 'Chem', 'Pharma']);
    expect(sections[0].projects.map((p) => p.id)).toEqual([2, 4]);
    // The section carries the store's tag, not the stale inline copy
    expect(sections[0].tag).toBe(BIO);
  });

  it('lists a multi-tagged project once, under its first tag in group order', () => {
    const sections = buildProjectSections([project(1, [12, 11])], AREA, siteTags);
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('tag-11');
  });

  it('puts projects without a tag of the group in a trailing "No <group>" section', () => {
    const projects = [project(1, []), project(2, [20, 30]), project(3, [10]), project(4, [999])];
    const sections = buildProjectSections(projects, AREA, siteTags);
    expect(sections.map((s) => s.key)).toEqual(['tag-10', 'none']);
    const none = sections[1];
    expect(none.tag).toBeNull();
    expect(none.label).toBe('No Area');
    expect(none.projects.map((p) => p.id)).toEqual([1, 2, 4]);
  });

  it('omits empty sections, including an empty "No <group>"', () => {
    const sections = buildProjectSections([project(1, [11])], AREA, siteTags);
    expect(sections.map((s) => s.key)).toEqual(['tag-11']);
    expect(buildProjectSections([], AREA, siteTags)).toEqual([]);
  });

  it('ignores tags that do not apply to the site: a group without site tags yields only "No <group>"', () => {
    const sections = buildProjectSections([project(1, [10]), project(2, [])], AREA, [OTHER_GROUP]);
    expect(sections.map((s) => s.key)).toEqual(['none']);
    expect(sections[0].projects.map((p) => p.id)).toEqual([1, 2]);
  });
});

describe('buildGanttRows', () => {
  const sections = buildProjectSections(
    [project(1, [10]), project(2, [11]), project(3, [])],
    AREA,
    siteTags
  );

  it('interleaves each section header with its projects', () => {
    const rows = buildGanttRows(sections, []);
    expect(rows.map((r) => (r.type === 'section' ? r.section.key : r.project.id))).toEqual([
      'tag-10', 1, 'tag-11', 2, 'none', 3,
    ]);
    expect(rows.every((r) => r.type !== 'section' || !r.collapsed)).toBe(true);
  });

  it('keeps only the header of a collapsed section', () => {
    const rows = buildGanttRows(sections, ['tag-11', 'none', 'tag-999']);
    expect(rows.map((r) => (r.type === 'section' ? `${r.section.key}:${r.collapsed}` : r.project.id))).toEqual([
      'tag-10:false', 1, 'tag-11:true', 'none:true',
    ]);
  });
});

describe('flatGanttRows / allSectionKeys', () => {
  it('maps projects to project rows in order', () => {
    const projects = [project(2, []), project(1, [])];
    expect(flatGanttRows(projects)).toEqual([
      { type: 'project', project: projects[0] },
      { type: 'project', project: projects[1] },
    ]);
  });

  it('lists every section the group can produce at the site, "none" last', () => {
    expect(allSectionKeys(AREA, siteTags)).toEqual(['tag-10', 'tag-11', 'tag-12', 'none']);
  });
});
