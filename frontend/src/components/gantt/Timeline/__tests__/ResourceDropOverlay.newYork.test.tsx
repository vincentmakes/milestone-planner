/**
 * Dropping a resource on the timeline creates a 5-day booking -- also west of
 * UTC, and across a DST switch (US clocks spring forward on 2026-03-08).
 *
 * `new Date('YYYY-MM-DD')` is UTC midnight, i.e. the previous evening in New
 * York, so the old `addDays(new Date(start), 4)` produced a 4-day booking.
 * TZ is pinned before anything date-related is imported (see
 * utils/__tests__/date.newYork.test.ts).
 */
declare const process: { env: Record<string, string | undefined> };
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/New_York';

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { render, screen, act, createEvent, fireEvent } from '@testing-library/react';
import { ResourceDropOverlay } from '../ResourceDropOverlay';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { useViewStore } from '@/stores/viewStore';
import { createStaffAssignment } from '@/api/endpoints/projects';
import type { TimelineCell } from '../../utils';
import type { Project } from '@/types';
import { makeUser } from '@/test/factories';

vi.mock('@/api/endpoints/projects', () => ({
  createStaffAssignment: vi.fn().mockResolvedValue({}),
  createEquipmentAssignment: vi.fn().mockResolvedValue({}),
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const CELL_WIDTH = 20;

/** One day cell per day of March 2026 */
const cells = Array.from({ length: 31 }, (_, i) => {
  const date = new Date(2026, 2, i + 1);
  return { date, dateStr: `2026-03-${String(i + 1).padStart(2, '0')}` } as unknown as TimelineCell;
});

const project = {
  id: 1,
  name: 'Bioprocess Scale-Up',
  site_id: 1,
  pm_id: null,
  confirmed: true,
  archived: false,
  start_date: '2026-03-01',
  end_date: '2026-03-31',
  phases: [],
  staffAssignments: [],
  equipmentAssignments: [],
} as unknown as Project;

function renderOverlay() {
  const container = document.createElement('div');
  container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
  const containerRef = { current: container };
  const utils = render(
    <ResourceDropOverlay
      projects={[project]}
      cells={cells}
      cellWidth={CELL_WIDTH}
      totalWidth={cells.length * CELL_WIDTH}
      containerRef={containerRef}
      rowPositions={new Map([['project-1', { top: 0, height: 32 }]])}
    />
  );
  return utils.container.firstChild as HTMLElement;
}

/** jsdom has no DragEvent: build the event, then pin the pointer position on it. */
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
  useViewStore.setState({ viewMode: 'month' });
  useAppStore.setState({
    projects: [project],
    staff: [{ id: 7, name: 'Alice Anderson', site_id: 1, active: true, max_capacity: 80 }] as never,
    currentUser: makeUser({ id: 1, name: 'Ada Admin', role: 'admin' }),
  });
  act(() => useUIStore.getState().startResourceDrag('staff', 7, 'Alice Anderson'));
});

describe('ResourceDropOverlay in America/New_York', () => {
  it('creates a 5-day assignment spanning the DST switch', async () => {
    const overlay = renderOverlay();
    // Bar centred on x=120 -> starts 2.5 cells earlier, in cell 3 (2026-03-04).
    fireDrag('dragOver', overlay, 120, 10);
    fireDrag('drop', overlay, 120, 10);
    await act(async () => {});

    expect(createStaffAssignment).toHaveBeenCalledTimes(1);
    expect(createStaffAssignment).toHaveBeenCalledWith(
      expect.objectContaining({
        staff_id: 7,
        project_id: 1,
        allocation: 80,
        start_date: '2026-03-04',
        end_date: '2026-03-08', // 4, 5, 6, 7, 8 March: five calendar days
      })
    );
  });

  it('does not create anything while What-If mode is active', async () => {
    useWhatIfStore.setState({ whatIfMode: true });
    const overlay = renderOverlay();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Dropping resources is unavailable while What-If mode is active. Apply or discard your What-If changes first.'
    );

    fireDrag('dragOver', overlay, 120, 10);
    fireDrag('drop', overlay, 120, 10);
    await act(async () => {});

    expect(createStaffAssignment).not.toHaveBeenCalled();
    expect(useUIStore.getState().resourceDrag.active).toBe(false);
  });
});
