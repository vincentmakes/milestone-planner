/**
 * Vacation bars on the staff timeline follow the same rule as the left panel:
 * a person may edit their own absences, admins and superusers anyone's.
 * Otherwise a bar is tooltip-only (the backend would answer 403 on save).
 * The workload heatmap draws one block per run of days that read the same,
 * titled with its dates.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, screen, act, within } from '@testing-library/react';
import { StaffTimelineBody } from '../StaffTimelineBody';
import { generateTimelineCells } from '@/components/gantt/utils';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { tagFilterKey } from '@/utils/tags';
import { formatMediumDate } from '@/utils/date';
import type { Staff, Vacation } from '@/types';
import { makeTeam, makeUser } from '@/test/factories';
import type { StaffAssignmentWithContext } from '../StaffView';

const bob: Staff = { id: 4, name: 'Bob Brown', site_id: 1, active: true };

const holiday: Vacation = {
  id: 21,
  staff_id: 4,
  start_date: '2026-09-10',
  end_date: '2026-09-12',
  description: 'Holidays',
};

function renderBody() {
  const cells = generateTimelineCells(new Date(2026, 8, 15), 'month', new Set(), []);
  return render(
    <StaffTimelineBody
      staff={[bob]}
      assignmentsMap={new Map()}
      vacationsMap={new Map([[4, [holiday]]])}
      rowHeights={new Map([[4, 44]])}
      expandedStaff={new Set()}
      expandedBankHolidays={false}
      expandedCompanyEvents={false}
      cells={cells}
      cellWidth={30}
      totalWidth={cells.length * 30}
      viewMode="month"
    />
  );
}

function seedUser(user: { id: number; role: 'admin' | 'superuser' | 'user' }) {
  useAppStore.setState({ currentUser: makeUser({ name: 'Someone', ...user }) });
}

const vacationBar = () => screen.getByTestId('staff-bar-vacation-21');

beforeEach(() => {
  useUIStore.setState({ activeModal: null, editingVacation: null });
  useAppStore.setState({ bankHolidays: [], companyEvents: [], absenceTypes: [] });
});

describe('StaffTimelineBody vacation bars', () => {
  it('open the absence editor for the person themselves', () => {
    seedUser({ id: 4, role: 'user' });
    renderBody();
    fireEvent.click(vacationBar());

    expect(useUIStore.getState().activeModal).toBe('vacation');
    expect(useUIStore.getState().editingVacation?.id).toBe(21);
  });

  it.each(['admin', 'superuser'] as const)('open the absence editor for a %s', (role) => {
    seedUser({ id: 1, role });
    renderBody();
    fireEvent.click(vacationBar());

    expect(useUIStore.getState().activeModal).toBe('vacation');
  });

  it('are tooltip-only on a colleague\'s absence for a plain user', () => {
    seedUser({ id: 7, role: 'user' });
    renderBody();
    fireEvent.click(vacationBar());

    expect(useUIStore.getState().activeModal).toBeNull();
    expect(useUIStore.getState().editingVacation).toBeNull();
  });
});

describe('StaffTimelineBody site closures', () => {
  it('marks a team-restricted closure for members only and a whole-site closure for everyone', () => {
    const member: Staff = { ...bob, team_ids: [1] };
    const colleague: Staff = { id: 5, name: 'Carol White', site_id: 1, active: true, team_ids: [2] };
    const noTeam: Staff = { id: 6, name: 'Dave Doe', site_id: 1, active: true, team_ids: [] };
    const people = [member, colleague, noTeam];
    seedUser({ id: 1, role: 'admin' });
    useAppStore.setState({
      staff: people,
      teams: [makeTeam({ id: 1, site_id: 1 }), makeTeam({ id: 2, site_id: 1, name: 'Process' })],
    });
    act(() =>
      useAppStore.getState().setCompanyEvents(
        [
          { id: 3, site_id: 1, site_ids: [1], team_ids: [1], date: '2026-09-15', name: 'Team offsite', counts_as_unavailable: true },
          { id: 4, site_id: 1, site_ids: [1], team_ids: [], date: '2026-09-16', name: 'Shutdown', counts_as_unavailable: true },
        ],
        new Set(['2026-09-15', '2026-09-16'])
      )
    );
    const cells = generateTimelineCells(new Date(2026, 8, 15), 'month', new Set(), []);
    const { container } = render(
      <StaffTimelineBody
        staff={people}
        assignmentsMap={new Map()}
        vacationsMap={new Map()}
        rowHeights={new Map(people.map((p) => [p.id, 44]))}
        expandedStaff={new Set()}
        expandedBankHolidays={false}
        expandedCompanyEvents={false}
        cells={cells}
        cellWidth={30}
        totalWidth={cells.length * 30}
        viewMode="month"
      />
    );

    const rows = Array.from(container.querySelectorAll<HTMLElement>('[class*="staffWrapper"]'));
    expect(rows).toHaveLength(3);
    // The block's title carries its dates after the tooltip
    const closed = (row: HTMLElement, name: string) =>
      within(row).queryAllByTitle(new RegExp(`^Site closed: ${name} · `)).length;
    // The member
    expect(closed(rows[0], 'Team offsite')).toBe(1);
    expect(closed(rows[0], 'Shutdown')).toBe(1);
    // A member of another team and someone in no team, on the same site
    for (const row of rows.slice(1)) {
      expect(closed(row, 'Team offsite')).toBe(0);
      expect(closed(row, 'Shutdown')).toBe(1);
    }
  });
});

describe('StaffTimelineBody workload blocks', () => {
  const booking = (over: Partial<StaffAssignmentWithContext>): StaffAssignmentWithContext => ({
    id: 31,
    staff_id: 4,
    allocation: 75,
    start_date: '2026-09-14',
    end_date: '2026-09-18',
    projectName: 'Formulation study',
    projectId: 9,
    level: 'project',
    ...over,
  });

  function renderBookings(assignments: StaffAssignmentWithContext[], viewMode: 'month' | 'quarter' = 'month') {
    seedUser({ id: 1, role: 'admin' });
    // No site closure left over from another test
    act(() => useAppStore.getState().setCompanyEvents([], new Set()));
    const cells = generateTimelineCells(new Date(2026, 8, 15), viewMode, new Set(), []);
    const utils = render(
      <StaffTimelineBody
        staff={[bob]}
        assignmentsMap={new Map([[4, assignments]])}
        vacationsMap={new Map()}
        rowHeights={new Map([[4, 44]])}
        expandedStaff={new Set()}
        expandedBankHolidays={false}
        expandedCompanyEvents={false}
        cells={cells}
        cellWidth={30}
        totalWidth={cells.length * 30}
        viewMode={viewMode}
      />
    );
    const blocks = () => [...utils.container.querySelectorAll<HTMLElement>('[class*="workloadCell"]')];
    return { ...utils, cells, blocks };
  }

  it('draws a 5-day 75 % booking as one block, five cells wide, with one badge', () => {
    const { cells, blocks } = renderBookings([booking({})]);
    expect(blocks()).toHaveLength(1);
    const [block] = blocks();
    const monday = cells.findIndex((c) => c.dateStr === '2026-09-14');
    expect(block.style.left).toBe(`${monday * 30}px`);
    expect(block.style.width).toBe(`${5 * 30}px`);
    expect(block).toHaveTextContent(/^75%$/);
    expect(block.title).toBe(`75% allocated · ${formatMediumDate('2026-09-14')} – ${formatMediumDate('2026-09-18')}`);
  });

  it('splits where the allocation changes and names a one-day block with its date', () => {
    const { blocks } = renderBookings([
      booking({ end_date: '2026-09-17' }),
      booking({ id: 32, allocation: 25, start_date: '2026-09-18', end_date: '2026-09-18' }),
    ]);
    expect(blocks().map((b) => b.textContent)).toEqual(['75%', '25%']);
    expect(blocks().map((b) => b.style.width)).toEqual(['120px', '30px']);
    expect(blocks()[1].title).toBe(`25% allocated · ${formatMediumDate('2026-09-18')}`);
  });

  it('draws no block at quarter zoom', () => {
    const { blocks } = renderBookings([booking({})], 'quarter');
    expect(blocks()).toHaveLength(0);
  });
});

describe('StaffTimelineBody company events row', () => {
  it('draws only the events the header team filter shows', () => {
    seedUser({ id: 1, role: 'admin' });
    useAppStore.setState({
      currentSite: { id: 1, name: 'Basel' } as never,
      teams: [makeTeam({ id: 1, site_id: 1, name: 'A' }), makeTeam({ id: 2, site_id: 1, name: 'B' })],
      companyEvents: [
        { id: 7, site_id: 1, site_ids: [1], team_ids: [2], date: '2026-09-15', name: 'Team B review' },
        { id: 8, site_id: 1, site_ids: [1], team_ids: [], date: '2026-09-16', name: 'Site audit' },
      ],
    });
    useViewStore.setState({ teamFilters: { [tagFilterKey(1)]: { teamIds: [1], noTeam: false } } });
    const cells = generateTimelineCells(new Date(2026, 8, 15), 'month', new Set(), []);
    render(
      <StaffTimelineBody
        staff={[]}
        assignmentsMap={new Map()}
        vacationsMap={new Map()}
        rowHeights={new Map()}
        expandedStaff={new Set()}
        expandedBankHolidays={false}
        expandedCompanyEvents
        cells={cells}
        cellWidth={30}
        totalWidth={cells.length * 30}
        viewMode="month"
      />
    );
    expect(screen.getByTitle('Site audit')).toBeInTheDocument();
    expect(screen.queryByTitle('Team B review')).not.toBeInTheDocument();

    act(() => useViewStore.setState({ teamFilters: {} }));
    expect(screen.getByTitle('Team B review')).toBeInTheDocument();
  });
});

describe('StaffTimelineBody event strip', () => {
  // The strip sits in the timeline header's events row (TimelineHeader)
  it.each(['month', 'quarter'] as const)('draws no event strip in the body at %s zoom', (viewMode) => {
    seedUser({ id: 1, role: 'admin' });
    const cells = generateTimelineCells(new Date(2026, 8, 15), viewMode, new Set(), [], new Set(['2026-09-16']), [
      { id: 7, date: '2026-09-16', name: 'ISO audit', color: '#f59e0b' },
    ]);
    const { container } = render(
      <StaffTimelineBody
        staff={[bob]}
        assignmentsMap={new Map()}
        vacationsMap={new Map()}
        rowHeights={new Map([[4, 44]])}
        expandedStaff={new Set()}
        expandedBankHolidays={false}
        expandedCompanyEvents={false}
        cells={cells}
        cellWidth={30}
        totalWidth={cells.length * 30}
        viewMode={viewMode}
      />
    );
    expect(container.querySelector('[class*="markerLayer"]')).toBeNull();
    expect(container.querySelector('button[class*="markerBadge"]')).toBeNull();
    expect(container.querySelector('[data-tooltip]')).toBeNull();
  });
});
