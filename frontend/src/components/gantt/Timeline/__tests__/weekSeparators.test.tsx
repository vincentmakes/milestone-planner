/**
 * With weekends hidden, every timeline marks the start of each week with a
 * 3 px band in `--border-color-hover` before its Monday (never before the
 * first cell): the header, the Gantt, Equipment, Cross-site and Archived
 * bodies in their grid layer (under the bars), the Staff body in an overlay
 * that is the last child of its rows (the workload heatmap would cover a grid
 * band; the overlay stays under the bars and the workload badges). Week / month zoom only, and none
 * while weekends are shown. Separators carry no `row` / `bar` class and no
 * `data-date` (the drag hooks and `DependencyLayer` query those).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { TimelineBody } from '../TimelineBody';
import { TimelineHeader } from '../TimelineHeader';
import { generateTimelineCells, generateTimelineHeaders } from '../../utils';
import type { TimelineCell } from '../../utils';
import { EquipmentTimelineBody } from '@/components/views/EquipmentView/EquipmentTimelineBody';
import { CrossSiteTimelineBody } from '@/components/views/CrossSiteView/CrossSiteTimelineBody';
import { StaffTimelineBody } from '@/components/views/StaffView/StaffTimelineBody';
import { TimelineRow } from '@/components/views/ArchivedView/TimelineRow';
import { useAppStore } from '@/stores/appStore';
import { makeSite, makeUser } from '@/test/factories';
import type { Project, Staff, ViewMode } from '@/types';

vi.mock('../ProjectTimeline', () => ({
  ProjectTimeline: ({ project }: { project: Project }) => <div data-project-id={project.id} />,
}));
vi.mock('../DependencyLayer', () => ({ DependencyLayer: () => null }));

const WIDTH = 30;
const project = {
  id: 1,
  name: 'P1',
  confirmed: true,
  phases: [],
  staffAssignments: [],
  equipmentAssignments: [],
} as unknown as Project;
const bob: Staff = { id: 4, name: 'Bob Brown', site_id: 1, active: true };

function cellsFor(showWeekends: boolean, mode: ViewMode = 'month'): TimelineCell[] {
  return generateTimelineCells(new Date(2026, 8, 15), mode, new Set(), [], new Set(), [], showWeekends);
}

const BODIES: Array<[string, (cells: TimelineCell[], mode: ViewMode) => ReactElement]> = [
  [
    'header',
    (cells, mode) => (
      <TimelineHeader
        headers={generateTimelineHeaders(cells, mode)}
        cells={cells}
        cellWidth={WIDTH}
        totalWidth={cells.length * WIDTH}
        viewMode={mode as 'month'}
      />
    ),
  ],
  [
    'Gantt body',
    (cells, mode) => (
      <TimelineBody cells={cells} projects={[project]} cellWidth={WIDTH} totalWidth={cells.length * WIDTH} viewMode={mode} />
    ),
  ],
  [
    'Equipment body',
    (cells, mode) => (
      <EquipmentTimelineBody
        equipment={[{ id: 3, name: 'HPLC', type: 'Analytical', site_id: 1, active: true }]}
        bookingsMap={new Map()}
        blocksMap={new Map()}
        overlapMap={new Map()}
        expandedEquipment={new Set()}
        canManage={false}
        cells={cells}
        cellWidth={WIDTH}
        totalWidth={cells.length * WIDTH}
        viewMode={mode}
      />
    ),
  ],
  [
    'Cross-site body',
    (cells, mode) => (
      <CrossSiteTimelineBody rows={[]} cells={cells} cellWidth={WIDTH} totalWidth={cells.length * WIDTH} viewMode={mode} />
    ),
  ],
  [
    'Archived row',
    (cells, mode) => (
      <TimelineRow
        project={project}
        cells={cells}
        cellWidth={WIDTH}
        totalWidth={cells.length * WIDTH}
        showHighlighting={mode === 'week' || mode === 'month'}
      />
    ),
  ],
  [
    'Staff body',
    (cells, mode) => (
      <StaffTimelineBody
        staff={[bob]}
        assignmentsMap={new Map()}
        vacationsMap={new Map()}
        rowHeights={new Map([[4, 44]])}
        expandedStaff={new Set()}
        expandedBankHolidays={false}
        expandedCompanyEvents={false}
        cells={cells}
        cellWidth={WIDTH}
        totalWidth={cells.length * WIDTH}
        viewMode={mode}
      />
    ),
  ],
];

function setShowWeekends(showWeekends: boolean) {
  useAppStore.setState({
    instanceSettings: { ...useAppStore.getState().instanceSettings, show_weekends: showWeekends ? 'true' : 'false' },
  } as never);
}

const separators = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[class*="weekSeparator"]')];

beforeEach(() => {
  useAppStore.setState({
    currentSite: makeSite({ id: 1 }),
    currentUser: makeUser({ role: 'admin' }),
    bankHolidays: [],
    companyEvents: [],
  });
});

describe.each(BODIES)('week separators — %s', (_name, renderFor) => {
  it('draws one before every Monday but the first cell when weekends are hidden', () => {
    setShowWeekends(false);
    const cells = cellsFor(false);
    const { container } = render(renderFor(cells, 'month'));
    const mondays = cells.flatMap((cell, index) => (cell.isFirstOfWeek && index > 0 ? [index] : []));
    expect(mondays.length).toBeGreaterThan(2);
    expect(cells[mondays[0]].date.getDay()).toBe(1);
    // The band straddles the cell boundary: it starts 1 px before the Monday
    expect(separators(container).map((el) => el.style.left)).toEqual(mondays.map((i) => `${i * WIDTH - 1}px`));
    for (const el of separators(container)) {
      expect(el.className).not.toMatch(/row|bar/i);
      expect(el.hasAttribute('data-date')).toBe(false);
    }
  });

  it('draws none while weekends are shown', () => {
    setShowWeekends(true);
    const { container } = render(renderFor(cellsFor(true), 'month'));
    expect(separators(container)).toHaveLength(0);
  });

  it('draws none at quarter zoom', () => {
    setShowWeekends(false);
    const { container } = render(renderFor(cellsFor(false, 'quarter'), 'quarter'));
    expect(separators(container)).toHaveLength(0);
  });
});

describe('week separators — Staff overlay', () => {
  it('sits in an overlay that is the last child of the rows, above the heatmap and below the bars', () => {
    setShowWeekends(false);
    const { container } = render(BODIES[5][1](cellsFor(false), 'month'));
    const [first] = separators(container);
    const overlay = first.parentElement!;
    expect(overlay.className).toMatch(/weekBands/);
    expect(overlay.className).not.toMatch(/row/i);
    const rows = overlay.parentElement!;
    expect(rows.className).toMatch(/rows/);
    expect(rows.lastElementChild).toBe(overlay);
    // None left in the grid layer behind the heatmap
    expect(container.querySelector('[class*="grid"] [class*="weekSeparator"]')).toBeNull();

    const css = readFileSync(
      join(__dirname, '..', '..', '..', 'views', 'StaffView', 'StaffTimelineBody.module.css'),
      'utf8'
    );
    const rule = css.match(/\.weekBands\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/position: absolute;/);
    expect(rule).toMatch(/inset: 0;/);
    expect(rule).toMatch(/z-index: 1;/);
    expect(rule).toMatch(/pointer-events: none;/);
  });

  it('paints over the heatmap fill but never over a workload badge', () => {
    const css = readFileSync(
      join(__dirname, '..', '..', '..', 'views', 'StaffView', 'StaffTimelineBody.module.css'),
      'utf8'
    );
    const zOf = (rule: string) => Number(rule.match(/z-index:\s*(\d+);/)?.[1]);
    const bands = css.match(/\.weekBands\s*\{([^}]*)\}/)?.[1] ?? '';
    const block = css.match(/\.workloadCell\s*\{([^}]*)\}/)?.[1] ?? '';
    const badge = css.match(/\.workloadIndicator\s*\{([^}]*)\}/)?.[1] ?? '';
    // The block is no stacking context (no z-index), so its badge competes
    // with the bands in the rows' stacking context and its fill stays under them
    expect(block).toMatch(/position: absolute;/);
    expect(block).not.toMatch(/z-index/);
    expect(badge).toMatch(/position: relative;/);
    expect(zOf(badge)).toBeGreaterThan(zOf(bands));
    // ...and under the bars
    const bar = css.match(/\.bar\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(zOf(badge)).toBeLessThanOrEqual(zOf(bar));
  });
});

describe('week separators — the band', () => {
  const sheets = [
    join(__dirname, '..', 'TimelineHeader.module.css'),
    join(__dirname, '..', 'TimelineBody.module.css'),
    join(__dirname, '..', '..', '..', 'views', 'EquipmentView', 'EquipmentTimelineBody.module.css'),
    join(__dirname, '..', '..', '..', 'views', 'CrossSiteView', 'CrossSiteTimelineBody.module.css'),
    join(__dirname, '..', '..', '..', 'views', 'ArchivedView', 'TimelineRow.module.css'),
    join(__dirname, '..', '..', '..', 'views', 'StaffView', 'StaffTimelineBody.module.css'),
  ];

  it.each(sheets)('is 3 px of --border-color-hover that takes no pointer (%s)', (file) => {
    const rule = readFileSync(file, 'utf8').match(/\.weekSeparator\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/width: 3px;/);
    expect(rule).toMatch(/background: var\(--border-color-hover\);/);
    expect(rule).toMatch(/pointer-events: none;/);
  });
});
