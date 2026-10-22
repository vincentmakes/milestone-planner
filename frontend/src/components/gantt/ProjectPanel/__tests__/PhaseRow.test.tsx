/**
 * Clicking a phase name jumps the timeline to that phase, the same way a
 * subphase's L1/L2 badge does.
 *
 * The scroll itself cannot be observed in jsdom — Timeline resolves the date
 * to a pixel offset and there is no layout here. What is observable, and what
 * actually matters, is that the row asks for the right date.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { PhaseRow } from '../PhaseRow';
import { ReorderProvider } from '@/contexts/ReorderContext';
import { useUIStore } from '@/stores/uiStore';
import { useViewStore } from '@/stores/viewStore';
import { useAppStore } from '@/stores/appStore';
import type { Phase, Project } from '@/types';
import { makeUser } from '@/test/factories';
import { staffRowCount } from '@/components/gantt/utils/staffGroups';

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

/**
 * A person with two or more bookings on the phase gets a collapsible overview
 * row (StaffGroupRow), their bookings one level deeper; a person with one
 * booking keeps the plain row.
 */
describe('PhaseRow per-person booking groups', () => {
  const bookings = [
    { id: 71, staff_id: 4, staff_name: 'Bob Brown', allocation: 20, start_date: '2026-09-01', end_date: '2026-09-05', linked: false },
    { id: 72, staff_id: 5, staff_name: 'Cleo Chen', allocation: 40, start_date: '', end_date: '' },
    { id: 73, staff_id: 4, staff_name: 'Bob Brown', allocation: 60, start_date: '2026-09-10', end_date: '2026-09-12', linked: false },
  ];
  const groupedPhase = () => makePhase({ staffAssignments: bookings as never });
  /** The booking rows, by their pin badge (plain badge: nobody signed in). */
  const bookingRows = () => screen.queryAllByText(/Design$/).filter((el) => el.textContent?.startsWith('📍') || el.textContent?.startsWith('📌'));

  beforeEach(() => {
    useViewStore.setState({ expandedPhases: new Set([1]), showAssignments: true, collapsedStaffGroups: new Set() });
  });

  it('groups a person with 2+ bookings, expanded, with their rows one level deeper', () => {
    const { container } = renderRow(groupedPhase());
    // the phase row + the staff block the timeline and the row geometry count
    expect(container.children).toHaveLength(1 + staffRowCount(bookings as never, 'phase', 1, new Set()));

    const toggle = screen.getByRole('button', { name: "Collapse Bob Brown's bookings" });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const group = toggle.parentElement!;
    expect(group).toHaveTextContent('DesignBob Brown2 bookings20–60%');
    // indented like the card's booking rows (depth 1), not like a phase row
    expect(group).toHaveStyle({ paddingLeft: '44px' });
    // the card badge, tinted like the booking rows' badges, without the pin
    const badge = within(group).getByText('Design');
    expect(badge).toHaveStyle({ backgroundColor: 'rgba(59, 130, 246, 0.2)', color: 'rgb(59, 130, 246)' });
    expect(badge.getAttribute('style')).toBe(bookingRows()[0].getAttribute('style'));
    expect(badge.previousElementSibling).toBe(toggle);
    expect(group.className).not.toMatch(/row/);
    expect([...group.attributes].some((a) => /^data-.*id$/.test(a.name))).toBe(false);

    // Bob's two rows at depth 2 (60 px), then Cleo's single row at depth 1 (44 px)
    const rows = bookingRows().map((badge) => badge.parentElement as HTMLElement);
    expect(rows.map((r) => r.style.paddingLeft)).toEqual(['60px', '60px', '44px']);
    expect(screen.getAllByTitle('Bob Brown')).toHaveLength(3); // group name + 2 rows
    // Cleo has no group
    expect(screen.queryByRole('button', { name: /Cleo Chen's bookings/ })).not.toBeInTheDocument();
  });

  it('collapses and expands the group from its chevron', () => {
    const { container } = renderRow(groupedPhase());
    fireEvent.click(screen.getByRole('button', { name: "Collapse Bob Brown's bookings" }));
    expect(container.children).toHaveLength(1 + staffRowCount(bookings as never, 'phase', 1, new Set(['phase:1:4'])));

    expect(useViewStore.getState().collapsedStaffGroups.has('phase:1:4')).toBe(true);
    const toggle = screen.getByRole('button', { name: "Expand Bob Brown's bookings" });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByTitle('Bob Brown')).toHaveLength(1);
    expect(bookingRows()).toHaveLength(1); // Cleo only
    // the phase itself stays expanded
    expect(useViewStore.getState().expandedPhases.has(1)).toBe(true);

    fireEvent.click(toggle);
    expect(bookingRows()).toHaveLength(3);
  });

  it('renders one booking per person exactly as before', () => {
    renderRow(makePhase({ staffAssignments: [bookings[0], bookings[1]] as never }));
    expect(screen.queryByRole('button', { name: /bookings$/ })).not.toBeInTheDocument();
    expect(bookingRows().map((b) => (b.parentElement as HTMLElement).style.paddingLeft)).toEqual(['44px', '44px']);
  });

  it('shows the single allocation when the bookings agree', () => {
    renderRow(makePhase({ staffAssignments: [bookings[0], { ...bookings[2], allocation: 20 }] as never }));
    expect(screen.getByRole('button', { name: "Collapse Bob Brown's bookings" }).parentElement).toHaveTextContent('bookings20%');
  });
});
