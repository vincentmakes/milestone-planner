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
import type { Phase } from '@/types';

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
  useUIStore.setState({ scrollToDateTrigger: null });
  useViewStore.setState({ expandedPhases: new Set() });
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
