/**
 * Gantt "Group by" a project field: sections follow the field's item order,
 * membership by item id only, first item in item order wins (no duplicate
 * rows), empty sections omitted, "No <field>" last; collapsed sections keep
 * only their header row.
 */
import { describe, it, expect } from 'vitest';
import {
  allSectionKeys,
  buildGanttRows,
  buildProjectSections,
  flatGanttRows,
  ganttSectionKey,
} from '../projectSections';
import { makeProject, makeProjectField, makeProjectFieldOption } from '@/test/factories';
import type { Project, ProjectFieldValue } from '@/types';

// Item order: Bio, Chem, Pharma
const BIO = makeProjectFieldOption({ id: 10, name: 'Bio', color: '#22c55e' });
const CHEM = makeProjectFieldOption({ id: 11, name: 'Chem', color: '#ef4444' });
const PHARMA = makeProjectFieldOption({ id: 12, name: 'Pharma', color: '#3b82f6' });
const AREA = makeProjectField({ id: 1, name: 'Area', field_type: 'multiselect', options: [BIO, CHEM, PHARMA] });
const TYPE = makeProjectField({ id: 2, name: 'Type', field_type: 'select', options: [makeProjectFieldOption({ id: 20 })] });

function project(id: number, values: Record<number, ProjectFieldValue> = {}): Project {
  return makeProject({ id, name: `P${id}`, field_values: values });
}

describe('buildProjectSections', () => {
  it('orders sections by the item order and keeps project order inside', () => {
    const projects = [project(1, { 1: [12] }), project(2, { 1: [10] }), project(3, { 1: [11] }), project(4, { 1: [10] })];
    const sections = buildProjectSections(projects, AREA);
    expect(sections.map((s) => s.key)).toEqual(['field-10', 'field-11', 'field-12']);
    expect(sections.map((s) => s.label)).toEqual(['Bio', 'Chem', 'Pharma']);
    expect(sections[0].projects.map((p) => p.id)).toEqual([2, 4]);
    // The section carries the store's item
    expect(sections[0].option).toBe(BIO);
  });

  it('lists a multi-item project once, under its first item in item order', () => {
    const sections = buildProjectSections([project(1, { 1: [12, 11] })], AREA);
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('field-11');
  });

  it('files a select project under its item', () => {
    const sections = buildProjectSections([project(1, { 2: 20 }), project(2)], TYPE);
    expect(sections.map((s) => s.key)).toEqual(['field-20', 'none']);
  });

  it('puts projects without an item of the field in a trailing "No <field>" section', () => {
    const projects = [project(1), project(2, { 2: 20 }), project(3, { 1: [10] }), project(4, { 1: [999] }), makeProject({ id: 5, field_values: undefined })];
    const sections = buildProjectSections(projects, AREA);
    expect(sections.map((s) => s.key)).toEqual(['field-10', 'none']);
    const none = sections[1];
    expect(none.option).toBeNull();
    expect(none.label).toBe('No Area');
    expect(none.projects.map((p) => p.id)).toEqual([1, 2, 4, 5]);
  });

  it('omits empty sections, including an empty "No <field>"', () => {
    const sections = buildProjectSections([project(1, { 1: [11] })], AREA);
    expect(sections.map((s) => s.key)).toEqual(['field-11']);
    expect(buildProjectSections([], AREA)).toEqual([]);
  });

  it('only knows the items it is given: an item outside the site falls under "No <field>"', () => {
    const siteArea = { ...AREA, options: [BIO] };
    const sections = buildProjectSections([project(1, { 1: [12] }), project(2, { 1: [10] })], siteArea);
    expect(sections.map((s) => s.key)).toEqual(['field-10', 'none']);
    expect(sections[1].projects.map((p) => p.id)).toEqual([1]);
  });
});

describe('buildGanttRows', () => {
  const sections = buildProjectSections([project(1, { 1: [10] }), project(2, { 1: [11] }), project(3)], AREA);

  it('interleaves each section header with its projects', () => {
    const rows = buildGanttRows(sections, []);
    expect(rows.map((r) => (r.type === 'section' ? r.section.key : r.project.id))).toEqual([
      'field-10', 1, 'field-11', 2, 'none', 3,
    ]);
    expect(rows.every((r) => r.type !== 'section' || !r.collapsed)).toBe(true);
  });

  it('keeps only the header of a collapsed section', () => {
    const rows = buildGanttRows(sections, ['field-11', 'none', 'field-999']);
    expect(rows.map((r) => (r.type === 'section' ? `${r.section.key}:${r.collapsed}` : r.project.id))).toEqual([
      'field-10:false', 1, 'field-11:true', 'none:true',
    ]);
  });
});

describe('flatGanttRows / allSectionKeys / ganttSectionKey', () => {
  it('maps projects to project rows in order', () => {
    const projects = [project(2), project(1)];
    expect(flatGanttRows(projects)).toEqual([
      { type: 'project', project: projects[0] },
      { type: 'project', project: projects[1] },
    ]);
  });

  it('lists every section the field can produce, "none" last', () => {
    expect(allSectionKeys(AREA)).toEqual(['field-10', 'field-11', 'field-12', 'none']);
    expect(ganttSectionKey(7)).toBe('field-7');
  });
});
