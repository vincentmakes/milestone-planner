/**
 * Clicking a phase name jumps the timeline to that phase, the same way a
 * subphase's L1/L2 badge does.
 *
 * The scroll itself cannot be observed in jsdom — Timeline resolves the date
 * to a pixel offset and there is no layout here. What is observable, and what
 * actually matters, is that the row asks for the right date.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PhaseRow } from '../PhaseRow';
import { ReorderProvider } from '@/contexts/ReorderContext';
import { useUIStore } from '@/stores/uiStore';
import { useViewStore } from '@/stores/viewStore';
import { useAppStore } from '@/stores/appStore';
import type { Phase, Project } from '@/types';
import { makeUser } from '@/test/factories';

// The completion slider imports these; nothing here exercises them.
vi.mock('@/api', () => ({
  updatePhase: vi.fn(),
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

function makePhase(overrides: Partial<Phase> = {}): Phase {
  return {
    id: 1,
    project_id: 1,
    name: 'Design',
    start_date: '2026-09-01',
    end_date: '2026-09-30',
    color: '#3b82f6',
    order_index: 0,
    completion: null,
    status: 'todo',
    is_milestone: false,
    dependencies: [],
    children: [],
    staffAssignments: [],
    equipmentAssignments: [],
    ...overrides,
  } as unknown as Phase;
}

function renderRow(phase: Phase) {
  return render(
    <ReorderProvider>
      <PhaseRow phase={phase} projectId={1} depth={0} phases={[phase]} nameColumnWidth={320} />
    </ReorderProvider>
  );
}

const nameButton = (phase: Phase) =>
  screen.getByRole('button', { name: new RegExp(phase.name, 'i') });

beforeEach(() => {
  useUIStore.setState({ scrollToDateTrigger: null, activeModal: null });
  useViewStore.setState({ expandedPhases: new Set() });
  useAppStore.setState({ projects: [], currentUser: null });
});

describe('PhaseRow name click', () => {
  it('asks the timeline to scroll to the phase start date', () => {
    const phase = makePhase();
    renderRow(phase);

    fireEvent.click(nameButton(phase));

    expect(useUIStore.getState().scrollToDateTrigger?.date).toBe('2026-09-01');
  });

  it('does the same for a milestone, whose start and end are one day', () => {
    const phase = makePhase({
      id: 2,
      name: 'Gate review',
      is_milestone: true,
      start_date: '2026-11-12',
      end_date: '2026-11-12',
    });
    renderRow(phase);

    fireEvent.click(nameButton(phase));

    expect(useUIStore.getState().scrollToDateTrigger?.date).toBe('2026-11-12');
  });

  it('does not scroll when the expand chevron is clicked', () => {
    // The chevron sits next to the name; confusing the two would move the
    // timeline every time someone opened a phase.
    const child = makePhase({ id: 9, name: 'DoE setup' });
    const phase = makePhase({ children: [child] as never });
    const { container } = renderRow(phase);

    const chevron = container.querySelector('button[class*="expandBtn"]');
    expect(chevron).not.toBeNull();
    fireEvent.click(chevron!);

    expect(useUIStore.getState().scrollToDateTrigger).toBeNull();
    expect(useViewStore.getState().expandedPhases.has(phase.id)).toBe(true);
  });
});

/**
 * Per-project rights (utils/permissions.ts): the project's manager edits its
 * phases like a superuser, a plain user does not. The row exposes editing
 * through the reorder handle and the double-click, so those are what we check.
 */
describe('PhaseRow permissions', () => {
  const project = {
    id: 1,
    name: 'Bioprocess Scale-Up',
    site_id: 1,
    pm_id: 42,
    confirmed: true,
    archived: false,
    phases: [],
    staffAssignments: [],
    equipmentAssignments: [],
  } as unknown as Project;

  function seed(user: { id: number; role: 'admin' | 'superuser' | 'user' }) {
    useAppStore.setState({ projects: [project], currentUser: makeUser(user) });
  }

  it('lets the project manager reorder and open the phase', () => {
    seed({ id: 42, role: 'user' });
    const phase = makePhase();
    renderRow(phase);

    expect(screen.getByTitle('Drag to reorder')).toBeInTheDocument();

    fireEvent.doubleClick(screen.getByTitle('Drag to reorder').parentElement!.parentElement!);
    expect(useUIStore.getState().activeModal).toBe('phase');
  });

  it('gives a plain user neither the reorder handle nor the editor', () => {
    seed({ id: 43, role: 'user' });
    const phase = makePhase();
    const { container } = renderRow(phase);

    expect(screen.queryByTitle('Drag to reorder')).not.toBeInTheDocument();

    fireEvent.doubleClick(container.querySelector('[data-phase-id="1"]')!);
    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it('does not open the completion slider for a plain user', () => {
    seed({ id: 43, role: 'user' });
    renderRow(makePhase({ completion: 40 }));

    fireEvent.click(screen.getByText('40%'));
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('keeps superusers unchanged, whoever manages the project', () => {
    seed({ id: 99, role: 'superuser' });
    renderRow(makePhase());
    expect(screen.getByTitle('Drag to reorder')).toBeInTheDocument();
  });
});
