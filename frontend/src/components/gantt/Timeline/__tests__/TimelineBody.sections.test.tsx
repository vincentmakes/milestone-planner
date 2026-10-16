/**
 * TimelineBody with Group-by rows: one band per section header, in the same
 * order and with the same keys as the ProjectPanel, as direct children of the
 * rows container (in flow, so offsetTop maths and DOM measurement hold); the
 * projects of a collapsed section are not rendered and get no row position.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TimelineBody } from '../TimelineBody';
import { generateTimelineCells } from '../../utils';
import { buildGanttRows } from '../../utils/projectSections';
import type { GanttSection } from '../../utils/projectSections';
import type { Project } from '@/types';

const seen = vi.hoisted(() => ({ positions: null as Map<string, unknown> | null }));

vi.mock('../ProjectTimeline', () => ({
  ProjectTimeline: ({ project }: { project: Project }) => <div data-project-id={project.id} />,
}));
vi.mock('../DependencyLayer', () => ({
  DependencyLayer: ({ rowPositions }: { rowPositions: Map<string, unknown> }) => {
    seen.positions = rowPositions;
    return null;
  },
}));

function project(id: number): Project {
  return { id, name: `P${id}`, phases: [], staffAssignments: [], equipmentAssignments: [] } as unknown as Project;
}
const p1 = project(1);
const p2 = project(2);
const p3 = project(3);
const sections: GanttSection[] = [
  { key: 'tag-7', tag: null, label: 'Bio', projects: [p1, p2] },
  { key: 'none', tag: null, label: 'No Area', projects: [p3] },
];
const cells = generateTimelineCells(new Date(2026, 2, 15), 'month', new Set(), []);

function renderBody(collapsed: string[]) {
  return render(
    <TimelineBody
      cells={cells}
      projects={[p1, p2, p3]}
      rows={buildGanttRows(sections, collapsed)}
      cellWidth={30}
      totalWidth={cells.length * 30}
      viewMode="month"
    />
  );
}

describe('TimelineBody section bands', () => {
  it('renders a band per section, interleaved with the project rows in .rows', () => {
    const { container } = renderBody([]);
    const bands = [...container.querySelectorAll('[data-section-key]')];
    expect(bands.map((b) => b.getAttribute('data-section-key'))).toEqual(['tag-7', 'none']);

    const rowsContainer = bands[0].parentElement!;
    expect(rowsContainer.className).toMatch(/rows/);
    expect(
      [...rowsContainer.children].map((c) => c.getAttribute('data-section-key') ?? `p${c.getAttribute('data-project-id')}`)
    ).toEqual(['tag-7', 'p1', 'p2', 'none', 'p3']);

    for (const band of bands) {
      expect(band).toHaveAttribute('aria-hidden', 'true');
      expect(band.className).not.toMatch(/row/);
      expect(band.hasAttribute('data-project-id')).toBe(false);
    }
    expect(seen.positions?.get('section-none')).toEqual({ top: 37 + 2 * 45, height: 37 });
  });

  it('skips the projects of a collapsed section', () => {
    const { container } = renderBody(['tag-7']);
    expect([...container.querySelectorAll('[data-project-id]')].map((e) => e.getAttribute('data-project-id'))).toEqual(['3']);
    expect(container.querySelectorAll('[data-section-key]')).toHaveLength(2);
    expect(seen.positions?.has('project-1')).toBe(false);
    expect(seen.positions?.get('project-3')).toEqual({ top: 74, height: 45 });
  });
});
