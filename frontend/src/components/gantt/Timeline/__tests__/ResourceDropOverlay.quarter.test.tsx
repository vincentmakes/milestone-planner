/**
 * A resource drop always books 5 calendar days (F2-15). In quarter view a
 * cell is a week, and the preview used to be `5 x cellWidth` wide (5 weeks)
 * with the start date taken 2.5 *cells* left of the pointer — so it showed
 * 5 weeks and booked 5 days about two weeks earlier than shown. The preview
 * and the drop now share one 5-day range centred on the pointer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, createEvent, fireEvent } from '@testing-library/react';
import { ResourceDropOverlay } from '../ResourceDropOverlay';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { createStaffAssignment } from '@/api/endpoints/projects';
import { generateTimelineCells, calculateBarPosition } from '../../utils';
import type { Project, ViewMode } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({
  createStaffAssignment: vi.fn().mockResolvedValue({}),
  createEquipmentAssignment: vi.fn().mockResolvedValue({}),
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

const CELL_WIDTH = 70; // 10 px per day in quarter view

const project = {
  id: 1,
  name: 'Bioprocess Scale-Up',
  site_id: 1,
  pm_id: null,
  confirmed: true,
  archived: false,
  start_date: '2026-01-01',
  end_date: '2026-12-31',
  phases: [],
  staffAssignments: [],
  equipmentAssignments: [],
} as unknown as Project;

function renderOverlay(viewMode: ViewMode) {
  useViewStore.setState({ viewMode });
  const cells = generateTimelineCells(new Date(2026, 2, 12), viewMode, new Set(), []);
  const container = document.createElement('div');
  container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
  const utils = render(
    <ResourceDropOverlay
      projects={[project]}
      cells={cells}
      cellWidth={CELL_WIDTH}
      totalWidth={cells.length * CELL_WIDTH}
      containerRef={{ current: container }}
      rowPositions={new Map([['project-1', { top: 0, height: 32 }]])}
    />
  );
  return { overlay: utils.container.firstChild as HTMLElement, cells, container: utils.container };
}

function fireDrag(type: 'dragOver' | 'drop', el: HTMLElement, clientX: number, clientY: number) {
  const event = createEvent[type](el, { dataTransfer: { dropEffect: 'none' } });
  Object.defineProperty(event, 'clientX', { value: clientX });
  Object.defineProperty(event, 'clientY', { value: clientY });
  act(() => {
    fireEvent(el, event);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useWhatIfStore.setState({ whatIfMode: false });
  useAppStore.setState({
    projects: [project],
    staff: [{ id: 7, name: 'Alice Anderson', site_id: 1, active: true, max_capacity: 80 }] as never,
    currentUser: { id: 1, name: 'Ada Admin', role: 'admin' } as never,
  });
  act(() => useUIStore.getState().startResourceDrag('staff', 7, 'Alice Anderson'));
});

describe('ResourceDropOverlay in quarter view', () => {
  it('previews 5 days, centred on the pointer, and books the same 5 days', async () => {
    const { overlay, cells, container } = renderOverlay('quarter');
    // Middle of the week cell starting Monday 2026-03-09 -> Thursday Mar 12, noon
    const weekIdx = cells.findIndex((c) => c.dateStr === '2026-03-09');
    expect(weekIdx).toBeGreaterThan(2);
    const x = weekIdx * CELL_WIDTH + CELL_WIDTH / 2;

    fireDrag('dragOver', overlay, x, 10);

    const preview = container.querySelector('[class*="previewBar"]') as HTMLElement;
    expect(preview).not.toBeNull();
    const width = parseFloat(preview.style.width);
    const left = parseFloat(preview.style.left);
    // 5 days at 10 px/day (not 5 cells = 350 px)
    expect(width).toBeGreaterThan(45);
    expect(width).toBeLessThan(55);
    // ...and drawn where the booking lands
    const expected = calculateBarPosition('2026-03-10', '2026-03-14', cells, CELL_WIDTH, 'quarter')!;
    expect(left).toBeCloseTo(expected.left, 0);
    // The pointer sits inside the preview
    expect(left).toBeLessThan(x);
    expect(left + width).toBeGreaterThan(x);

    fireDrag('drop', overlay, x, 10);
    await act(async () => {});

    expect(createStaffAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ start_date: '2026-03-10', end_date: '2026-03-14' })
    );
  });

  it('also books 5 days in year view', async () => {
    const { overlay, cells } = renderOverlay('year');
    const monthIdx = cells.findIndex((c) => c.dateStr === '2026-03-01');
    // Roughly the middle of March
    fireDrag('dragOver', overlay, monthIdx * CELL_WIDTH + CELL_WIDTH / 2, 10);
    fireDrag('drop', overlay, monthIdx * CELL_WIDTH + CELL_WIDTH / 2, 10);
    await act(async () => {});

    const body = vi.mocked(createStaffAssignment).mock.calls[0][0];
    expect(body.start_date.startsWith('2026-03-1')).toBe(true);
    const days =
      (Date.UTC(...(body.end_date.split('-').map(Number) as [number, number, number])) -
        Date.UTC(...(body.start_date.split('-').map(Number) as [number, number, number]))) /
      86400000;
    expect(days).toBe(4);
  });
});
