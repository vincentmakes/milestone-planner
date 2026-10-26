/**
 * Dropping oneself on the timeline when one's own bookings need approval:
 * the server files a request (202), the pending row arrives with the reload,
 * and the user is told "Sent for approval". A failed drop is reported in the
 * flash notice instead of the console only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, createEvent, fireEvent } from '@testing-library/react';
import { ResourceDropOverlay } from '../ResourceDropOverlay';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { createStaffAssignment, loadAllProjects } from '@/api/endpoints/projects';
import { generateTimelineCells } from '../../utils';
import type { Project } from '@/types';
import { makeUser } from '@/test/factories';
import { USER_DEFAULTS } from '@/test/permissionFixtures';

vi.mock('@/api/endpoints/projects', () => ({
  createStaffAssignment: vi.fn(),
  createEquipmentAssignment: vi.fn(),
  loadAllProjects: vi.fn(),
}));

const CELL_WIDTH = 30;
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

function drop() {
  useViewStore.setState({ viewMode: 'month' });
  const cells = generateTimelineCells(new Date(2026, 2, 12), 'month', new Set(), []);
  const container = document.createElement('div');
  container.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
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
  const overlay = utils.container.firstChild as HTMLElement;
  const x = cells.findIndex((c) => c.dateStr === '2026-03-12') * CELL_WIDTH + CELL_WIDTH / 2;
  for (const type of ['dragOver', 'drop'] as const) {
    const event = createEvent[type](overlay, { dataTransfer: { dropEffect: 'none' } });
    Object.defineProperty(event, 'clientX', { value: x });
    Object.defineProperty(event, 'clientY', { value: 10 });
    act(() => {
      fireEvent(overlay, event);
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  useWhatIfStore.setState({ whatIfMode: false });
  useUIStore.setState({ flashNotice: null });
  useAppStore.setState({
    projects: [project],
    staff: [{ id: 4, name: 'Bob Brown', site_id: 1, active: true, max_capacity: 80 }] as never,
    currentUser: makeUser({
      id: 4,
      role: 'user',
      permissions: USER_DEFAULTS.filter((k) => k !== 'assignments.self_create'),
      approval_required: ['assignments.self_create'],
    }),
  });
  act(() => useUIStore.getState().startResourceDrag('staff', 4, 'Bob Brown'));
});

describe('ResourceDropOverlay own drop needing approval', () => {
  it('reloads and flashes "Sent for approval" on a 202', async () => {
    const reloaded = [{ ...project, name: 'Reloaded' }];
    vi.mocked(createStaffAssignment).mockResolvedValue({ success: true, pending: true, request_id: 31, id: 9 });
    vi.mocked(loadAllProjects).mockResolvedValue(reloaded);
    drop();
    await act(async () => {});
    expect(createStaffAssignment).toHaveBeenCalledWith(expect.objectContaining({ staff_id: 4, allocation: 80 }));
    expect(useAppStore.getState().projects).toBe(reloaded);
    expect(useUIStore.getState().flashNotice).toMatchObject({ message: 'Sent for approval', tone: 'info' });
  });

  it('says nothing extra on a direct booking', async () => {
    vi.mocked(createStaffAssignment).mockResolvedValue({ id: 9, staff_id: 4, allocation: 80, start_date: '', end_date: '' });
    vi.mocked(loadAllProjects).mockResolvedValue([project]);
    drop();
    await act(async () => {});
    expect(useUIStore.getState().flashNotice).toBeNull();
  });

  it('reports a failed drop in the flash notice', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(createStaffAssignment).mockRejectedValue(new Error('Already booked'));
    drop();
    await act(async () => {});
    expect(useUIStore.getState().flashNotice).toMatchObject({
      message: 'Could not create the assignment: Already booked',
      tone: 'error',
    });
    expect(useUIStore.getState().resourceDrag.active).toBe(false);
  });
});
