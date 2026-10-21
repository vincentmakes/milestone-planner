/**
 * "Delete Dependency" removes the clicked link (F2-13/F2-14).
 *
 * - A legacy entry stored as a bare `{id}` (no `type`, no `entity`) is drawn
 *   as FS from the phase-first match; deleting it used to compare against the
 *   defaulted 'FS' and silently kept it.
 * - With a phase and a subphase sharing an id, deleting the link from one
 *   kind leaves the other kind's link alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { DependencyLayer } from '../DependencyLayer';
import { generateTimelineCells } from '../../utils';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { updatePhase, updateSubphase } from '@/api/endpoints/projects';
import type { Dependency, Phase, Project, Subphase } from '@/types';
import { stubConfirm } from '@/test/confirmDialog';
import { makeUser } from '@/test/factories';

vi.mock('@/api/endpoints/projects', () => ({
  updatePhase: vi.fn().mockResolvedValue({}),
  updateSubphase: vi.fn().mockResolvedValue({}),
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

const cells = generateTimelineCells(new Date(2026, 2, 15), 'month', new Set(), []);

function subphase(id: number, start: string, end: string, dependencies: Dependency[] = []): Subphase {
  return { id, name: `Sub ${id}`, start_date: start, end_date: end, color: '#111', dependencies, children: [] } as unknown as Subphase;
}
function phase(id: number, start: string, end: string, dependencies: Dependency[] = [], children: Subphase[] = []): Phase {
  return { id, name: `Phase ${id}`, start_date: start, end_date: end, color: '#222', dependencies, children } as unknown as Phase;
}
function project(phases: Phase[]): Project {
  return { id: 1, name: 'P', site_id: 1, pm_id: null, phases } as unknown as Project;
}

const positions = new Map([
  ['phase-5', { top: 0, height: 32 }],
  ['phase-6', { top: 32, height: 32 }],
  ['subphase-5', { top: 64, height: 32 }],
  ['subphase-7', { top: 96, height: 32 }],
]);

function renderLayer(projects: Project[]) {
  useAppStore.setState({ projects, currentUser: makeUser({ id: 1, role: 'admin' }) });
  return render(<DependencyLayer projects={projects} cells={cells} cellWidth={20} rowPositions={positions} />);
}

/** Click the arrow from `from` (e.g. 'phase-5') to `to` and delete it */
async function deleteArrow(container: HTMLElement, from: string, to: string) {
  const hit = container.querySelector(`[data-dependency-id^="dep-${from}-"][data-dependency-id$="-${to}"]`);
  expect(hit).not.toBeNull();
  fireEvent.click(hit!, { clientX: 10, clientY: 10 });
  const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Delete Dependency');
  expect(button).toBeDefined();
  await act(async () => {
    fireEvent.click(button!);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubConfirm(true);
  useViewStore.setState({ viewMode: 'month', showAssignments: false });
});

describe('DependencyLayer delete', () => {
  it('removes a legacy untyped entry', async () => {
    const legacy = { id: 5 } as Dependency;
    const { container } = renderLayer([
      project([phase(5, '2026-03-01', '2026-03-05'), phase(6, '2026-03-06', '2026-03-10', [legacy])]),
    ]);

    await deleteArrow(container, 'phase-5', 'phase-6');

    expect(updatePhase).toHaveBeenCalledWith(6, expect.objectContaining({ dependencies: [] }));
    expect(useAppStore.getState().projects[0].phases[1].dependencies).toEqual([]);
  });

  it('removes only the link of the clicked kind when a phase and a subphase share an id', async () => {
    const fromPhase: Dependency = { id: 5, type: 'FS', entity: 'phase' };
    const fromSubphase: Dependency = { id: 5, type: 'FS', entity: 'subphase' };
    const { container } = renderLayer([
      project([
        phase(5, '2026-03-01', '2026-03-05'),
        phase(6, '2026-03-01', '2026-03-31', [], [
          subphase(5, '2026-03-01', '2026-03-04'),
          subphase(7, '2026-03-10', '2026-03-12', [fromPhase, fromSubphase]),
        ]),
      ]),
    ]);

    await deleteArrow(container, 'subphase-5', 'subphase-7');

    expect(updateSubphase).toHaveBeenCalledWith(7, expect.objectContaining({ dependencies: [fromPhase] }));
  });
});
