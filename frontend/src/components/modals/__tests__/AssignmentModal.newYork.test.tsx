/**
 * Default dates are the LOCAL today, also west of UTC.
 *
 * `new Date().toISOString().split('T')[0]` is the UTC date: on a New York
 * evening it is already tomorrow. TZ is pinned before anything date-related
 * is imported (see utils/__tests__/date.newYork.test.ts).
 */
declare const process: { env: Record<string, string | undefined> };
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/New_York';

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { render } from '@testing-library/react';
import { AssignmentModal } from '../AssignmentModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import type { Project } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({
  createStaffAssignment: vi.fn().mockResolvedValue({}),
  updateStaffAssignment: vi.fn().mockResolvedValue({}),
  deleteStaffAssignment: vi.fn().mockResolvedValue({}),
  createEquipmentAssignment: vi.fn().mockResolvedValue({}),
  updateEquipmentAssignment: vi.fn().mockResolvedValue({}),
  deleteEquipmentAssignment: vi.fn().mockResolvedValue({}),
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// A project without dates: the dialog falls back to today.
const project = {
  id: 1,
  name: 'Catalyst Optimization',
  site_id: 1,
  pm_id: null,
  confirmed: false,
  archived: false,
  start_date: null,
  end_date: null,
  phases: [],
  staffAssignments: [],
  equipmentAssignments: [],
} as unknown as Project;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 21:30 on 2 March in New York is already 3 March (02:30) in UTC.
  vi.setSystemTime(new Date(2026, 2, 2, 21, 30));
  useUIStore.getState().closeModal();
  useUIStore.setState({ editingStaffAssignment: null });
  useAppStore.setState({
    projects: [project],
    currentSite: { id: 1, name: 'Basel' } as never,
    staff: [] as never,
    currentUser: { id: 1, name: 'Ada Admin', role: 'admin' } as never,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AssignmentModal default dates in America/New_York', () => {
  it('defaults to the local today, not the UTC date', () => {
    expect(new Date().toISOString().split('T')[0]).toBe('2026-03-03'); // the old, wrong default
    useUIStore.getState().openModal('staffAssignment', { projectId: 1 });
    render(<AssignmentModal mode="staff" />);

    const [start, end] = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    expect(start).toHaveValue('2026-03-02');
    expect(end).toHaveValue('2026-03-02');
  });
});
