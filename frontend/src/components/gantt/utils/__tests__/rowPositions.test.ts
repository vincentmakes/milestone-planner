/**
 * calculateRowPositions walks the same flat row list both panes render:
 * section headers take SECTION_ROW_TOTAL_HEIGHT (36 + 1) under
 * `section-<key>`, projects of a collapsed section get no position.
 */
import { describe, it, expect } from 'vitest';
import { calculateRowPositions, SECTION_ROW_TOTAL_HEIGHT } from '../rowPositions';
import { buildGanttRows, flatGanttRows } from '../projectSections';
import type { GanttSection } from '../projectSections';
import type { Project } from '@/types';

function project(id: number, phaseIds: number[] = []): Project {
  return {
    id,
    name: `P${id}`,
    phases: phaseIds.map((pid) => ({ id: pid, children: [], staffAssignments: [], equipmentAssignments: [] })),
    staffAssignments: [],
    equipmentAssignments: [],
  } as unknown as Project;
}

const p1 = project(1, [10, 11]);
const p2 = project(2, [20]);
const p3 = project(3, [30]);
const expanded = new Set([1, 2, 3]);
const none = new Set<number>();

function section(key: GanttSection['key'], projects: Project[]): GanttSection {
  return { key, tag: null, label: key, projects };
}

describe('calculateRowPositions', () => {
  it('is unchanged for a flat project list', () => {
    const { positions, totalHeight } = calculateRowPositions(flatGanttRows([p1, p2]), expanded, none, none);
    expect(positions.get('project-1')).toEqual({ top: 0, height: 45 });
    expect(positions.get('phase-10')).toEqual({ top: 45, height: 32 });
    expect(positions.get('phase-11')).toEqual({ top: 78, height: 32 });
    expect(positions.get('project-2')).toEqual({ top: 111, height: 45 });
    expect(positions.get('phase-20')).toEqual({ top: 156, height: 32 });
    expect(totalHeight).toBe(189);
  });

  it('offsets every row below a section header by 37 px', () => {
    expect(SECTION_ROW_TOTAL_HEIGHT).toBe(37);
    const rows = buildGanttRows([section('tag-5', [p1]), section('none', [p2])], []);
    const { positions, totalHeight } = calculateRowPositions(rows, expanded, none, none);
    expect(positions.get('section-tag-5')).toEqual({ top: 0, height: 37 });
    expect(positions.get('project-1')).toEqual({ top: 37, height: 45 });
    expect(positions.get('phase-11')).toEqual({ top: 37 + 45 + 33, height: 32 });
    expect(positions.get('section-none')).toEqual({ top: 148, height: 37 });
    expect(positions.get('project-2')).toEqual({ top: 185, height: 45 });
    expect(positions.get('phase-20')).toEqual({ top: 230, height: 32 });
    expect(totalHeight).toBe(189 + 2 * 37);
  });

  it('gives the projects of a collapsed section no position', () => {
    const rows = buildGanttRows([section('tag-5', [p1, p3]), section('none', [p2])], ['tag-5']);
    const { positions, totalHeight } = calculateRowPositions(rows, expanded, none, none);
    expect(positions.has('project-1')).toBe(false);
    expect(positions.has('phase-10')).toBe(false);
    expect(positions.has('project-3')).toBe(false);
    expect(positions.get('section-tag-5')).toEqual({ top: 0, height: 37 });
    expect(positions.get('section-none')).toEqual({ top: 37, height: 37 });
    expect(positions.get('project-2')).toEqual({ top: 74, height: 45 });
    expect(totalHeight).toBe(74 + 45 + 33);
  });

  it('places the phantom row after its source, below the section offset', () => {
    const rows = buildGanttRows([section('tag-5', [p1])], []);
    const { positions, phantomRowTop, totalHeight } = calculateRowPositions(rows, expanded, none, none, {
      projectId: 1,
      sourceId: 10,
      type: 'phase',
    });
    expect(phantomRowTop).toBe(37 + 45 + 33);
    expect(positions.get('phantom')).toEqual({ top: 115, height: 32 });
    expect(positions.get('phase-11')).toEqual({ top: 148, height: 32 });
    expect(totalHeight).toBe(37 + 45 + 3 * 33);
  });
});
