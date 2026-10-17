/**
 * Phase / subphase dialogs initialise their form once per open.
 *
 * `projects` is replaced with new objects on every WebSocket refetch; the
 * dialogs derive their parent project / phase from it, so without the
 * init-once guard a colleague's edit would reset what the user has typed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { PhaseModal } from '../PhaseModal';
import { SubphaseModal } from '../SubphaseModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { createPhase, createSubphase } from '@/api/endpoints/projects';
import type { Phase, Project, Subphase } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({
  createPhase: vi.fn().mockResolvedValue({}),
  updatePhase: vi.fn().mockResolvedValue({}),
  deletePhase: vi.fn().mockResolvedValue({}),
  createSubphase: vi.fn().mockResolvedValue({}),
  createChildSubphase: vi.fn().mockResolvedValue({}),
  updateSubphase: vi.fn().mockResolvedValue({}),
  deleteSubphase: vi.fn().mockResolvedValue({}),
  updateProject: vi.fn().mockResolvedValue({}),
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

const subphase = {
  id: 20,
  name: 'Setup',
  start_date: '2026-09-02',
  end_date: '2026-09-05',
  is_milestone: false,
  parent_phase_id: 10,
  children: [],
  staffAssignments: [],
} as unknown as Subphase;

const phase = {
  id: 10,
  name: 'Design',
  project_id: 1,
  start_date: '2026-09-01',
  end_date: '2026-09-30',
  is_milestone: false,
  children: [subphase],
  staffAssignments: [],
} as unknown as Phase;

const project = {
  id: 1,
  name: 'Bioprocess Scale-Up',
  site_id: 1,
  pm_id: null,
  confirmed: true,
  archived: false,
  start_date: '2026-09-01',
  end_date: '2026-12-31',
  phases: [phase],
  staffAssignments: [],
  equipmentAssignments: [],
} as unknown as Project;

/** A WebSocket refetch: same data, brand-new object identities */
function refetchProjects() {
  act(() => {
    useAppStore.setState({
      projects: [{ ...project, phases: [{ ...phase, children: [{ ...subphase }] }] }],
    });
  });
}

const nameInput = (placeholder: RegExp) => screen.getByPlaceholderText(placeholder) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.getState().closeModal();
  useAppStore.setState({
    projects: [project],
    currentUser: { id: 1, name: 'Ada Admin', role: 'admin' } as never,
  });
});

describe('PhaseModal initialisation', () => {
  const phaseName = () => nameInput(/Preparation, Analytics/);

  it('keeps the typed name when projects are refetched while open', () => {
    act(() => useUIStore.getState().openPhaseModal(phase, 1));
    render(<PhaseModal />);
    expect(phaseName()).toHaveValue('Design');

    fireEvent.change(phaseName(), { target: { value: 'Design v2' } });
    refetchProjects();

    expect(phaseName()).toHaveValue('Design v2');
  });

  it('keeps the typed name of a new phase when projects are refetched', () => {
    act(() => useUIStore.getState().openPhaseModal(undefined, 1));
    render(<PhaseModal />);
    fireEvent.change(phaseName(), { target: { value: 'Analytics' } });
    refetchProjects();

    expect(phaseName()).toHaveValue('Analytics');
  });

  it('initialises again when reopened', () => {
    act(() => useUIStore.getState().openPhaseModal(phase, 1));
    render(<PhaseModal />);
    fireEvent.change(phaseName(), { target: { value: 'Design v2' } });

    act(() => useUIStore.getState().closeModal());
    act(() => useUIStore.getState().openPhaseModal(phase, 1));

    expect(phaseName()).toHaveValue('Design');
  });
});

describe('SubphaseModal initialisation', () => {
  const subphaseName = () => nameInput(/Task 1, Setup/);

  it('keeps the typed name when projects are refetched while open', () => {
    act(() => useUIStore.getState().openSubphaseModal(subphase, 10, 1));
    render(<SubphaseModal />);
    expect(subphaseName()).toHaveValue('Setup');

    fireEvent.change(subphaseName(), { target: { value: 'Setup v2' } });
    refetchProjects();

    expect(subphaseName()).toHaveValue('Setup v2');
  });

  it('initialises again when reopened', () => {
    act(() => useUIStore.getState().openSubphaseModal(subphase, 10, 1));
    render(<SubphaseModal />);
    fireEvent.change(subphaseName(), { target: { value: 'Setup v2' } });

    act(() => useUIStore.getState().closeModal());
    act(() => useUIStore.getState().openSubphaseModal(subphase, 10, 1));

    expect(subphaseName()).toHaveValue('Setup');
  });
});

describe('Phase / subphase dialogs submitted twice (Enter, Enter)', () => {
  it('create one phase', async () => {
    let finish!: () => void;
    vi.mocked(createPhase).mockReturnValueOnce(new Promise((r) => (finish = () => r({} as never))));
    act(() => useUIStore.getState().openPhaseModal(undefined, 1));
    render(<PhaseModal />);
    fireEvent.change(nameInput(/Preparation, Analytics/), { target: { value: 'Analytics' } });

    const form = document.body.querySelector('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(createPhase).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(createPhase).toHaveBeenCalledTimes(1);
  });

  it('create one subphase', async () => {
    let finish!: () => void;
    vi.mocked(createSubphase).mockReturnValueOnce(new Promise((r) => (finish = () => r({} as never))));
    act(() => useUIStore.getState().openSubphaseModal(undefined, 10, 1));
    render(<SubphaseModal />);
    fireEvent.change(nameInput(/Task 1, Setup/), { target: { value: 'Calibration' } });

    const form = document.body.querySelector('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(createSubphase).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });
});
