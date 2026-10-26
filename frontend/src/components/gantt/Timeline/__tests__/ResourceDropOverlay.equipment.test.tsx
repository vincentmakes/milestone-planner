/**
 * Equipment dropped on a phase or subphase row is booked on the project
 * (r9 regression): equipment bookings are project-level, and the routes
 * `/api/phases/{id}/equipment` / `/api/subphases/{id}/equipment` the drop used
 * to reach do not exist. The dropped days are kept.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, createEvent, fireEvent } from '@testing-library/react';
import { ResourceDropOverlay } from '../ResourceDropOverlay';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { createEquipmentAssignment, loadAllProjects } from '@/api/endpoints/projects';
import { generateTimelineCells } from '../../utils';
import type { Project } from '@/types';
import { makePhase, makeProject, makeSubphase, makeUser } from '@/test/factories';

vi.mock('@/api/endpoints/projects', () => ({
  createStaffAssignment: vi.fn(),
  createEquipmentAssignment: vi.fn(),
  loadAllProjects: vi.fn(),
}));

const CELL_WIDTH = 30;
const project: Project = makeProject({
  id: 1,
  site_id: 1,
  start_date: '2026-01-01',
  end_date: '2026-12-31',
  phases: [
    makePhase({ id: 3, children: [makeSubphase({ id: 8 })] }),
  ],
});

const ROWS = new Map([
  ['project-1', { top: 0, height: 32 }],
  ['phase-3', { top: 32, height: 32 }],
  ['subphase-8', { top: 64, height: 32 }],
]);

function dropAt(y: number) {
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
      rowPositions={ROWS}
    />
  );
  const overlay = utils.container.firstChild as HTMLElement;
  const x = cells.findIndex((c) => c.dateStr === '2026-03-12') * CELL_WIDTH + CELL_WIDTH / 2;
  for (const type of ['dragOver', 'drop'] as const) {
    const event = createEvent[type](overlay, { dataTransfer: { dropEffect: 'none' } });
    Object.defineProperty(event, 'clientX', { value: x });
    Object.defineProperty(event, 'clientY', { value: y });
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
    equipment: [{ id: 5, name: 'HPLC', type: 'Analytical', site_id: 1 }] as never,
    currentUser: makeUser({ id: 1, role: 'admin' }),
  });
  vi.mocked(createEquipmentAssignment).mockResolvedValue({} as never);
  vi.mocked(loadAllProjects).mockResolvedValue([project]);
  act(() => useUIStore.getState().startResourceDrag('equipment', 5, 'HPLC'));
});

describe('ResourceDropOverlay equipment drop', () => {
  it.each([
    ['a phase', 40],
    ['a subphase', 70],
    ['the project', 10],
  ])('books the equipment on the project when dropped on %s row', async (_row, y) => {
    dropAt(y);
    await act(async () => {});

    expect(createEquipmentAssignment).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(createEquipmentAssignment).mock.calls[0][0];
    expect(sent).toMatchObject({ equipment_id: 5, project_id: 1 });
    expect(sent.start_date).toBeTruthy();
    expect(sent.end_date).toBeTruthy();
    expect(sent).not.toHaveProperty('phase_id');
    expect(sent).not.toHaveProperty('subphase_id');
    expect(useUIStore.getState().flashNotice).toBeNull();
  });
});
