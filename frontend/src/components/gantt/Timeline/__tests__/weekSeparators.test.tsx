/**
 * With weekends hidden, every timeline marks the start of each week with a
 * 3 px band in `--border-color-hover` before its Monday (never before the
 * first cell): the header and every body (Gantt, Equipment, Cross-site,
 * Archived, Staff) draw it in their grid layer, under every bar, block and
 * label — one rule everywhere. Week / month zoom only, and none
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
        viewMode={mode}
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

/** The class of the element each timeline paints its grid layer in */
const GRID_LAYER: Record<string, RegExp> = {
  header: /bgLayer/,
  'Gantt body': /grid/,
  'Equipment body': /grid/,
  'Cross-site body': /grid/,
  'Archived row': /^_?row/,
  'Staff body': /grid/,
};

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

  it('draws them in the grid layer, under the content (never among the rows)', () => {
    setShowWeekends(false);
    const { container } = render(renderFor(cellsFor(false), 'month'));
    expect(separators(container).length).toBeGreaterThan(0);
    for (const el of separators(container)) {
      // The header's background layer, a body's grid; an Archived row is its
      // own grid (lines in ::before), its band drawn before the project bar
      expect(el.parentElement!.className).toMatch(GRID_LAYER[_name]);
      expect(el.closest('[class*="rows"]')).toBeNull();
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
