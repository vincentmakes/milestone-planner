/**
 * Vacation bars on the staff timeline follow the same rule as the left panel:
 * a person may edit their own absences, admins and superusers anyone's.
 * Otherwise a bar is tooltip-only (the backend would answer 403 on save).
 * The workload heatmap draws one block per run of days that read the same,
 * titled with its dates.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  function renderBookings(
    assignments: StaffAssignmentWithContext[],
    viewMode: 'month' | 'quarter' = 'month',
    vacations: Vacation[] = []
  ) {
    seedUser({ id: 1, role: 'admin' });
    // No site closure left over from another test
    act(() => useAppStore.getState().setCompanyEvents([], new Set()));
    const cells = generateTimelineCells(new Date(2026, 8, 15), viewMode, new Set(), []);
    const utils = render(
      <StaffTimelineBody
        staff={[bob]}
        assignmentsMap={new Map([[4, assignments]])}
        vacationsMap={new Map([[4, vacations]])}
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

  it('draws a 5-day 75 % booking as one solid block, five cells wide (1 px inset each side), with one label', () => {
    const { cells, blocks } = renderBookings([booking({})]);
    expect(blocks()).toHaveLength(1);
    const [block] = blocks();
    const monday = cells.findIndex((c) => c.dateStr === '2026-09-14');
    expect(block.style.left).toBe(`${monday * 30 + 1}px`);
    expect(block.style.width).toBe(`${5 * 30 - 2}px`);
    // 14 px tall, 2 px under the indicator area's top (row 44 − area 18)
    expect(block.style.top).toBe(`${44 - 18 + 2}px`);
    expect(block.style.height).toBe('14px');
    // Solid: the colour comes from the stylesheet's state class, no gradient fill
    expect(block.className).toMatch(/partial/);
    expect(block.style.background).toBe('');
    expect(block.getAttribute('style')).not.toMatch(/gradient/);
    expect(block).toHaveTextContent(/^75%$/);
    expect(block.title).toBe(`75% allocated · ${formatMediumDate('2026-09-14')} – ${formatMediumDate('2026-09-18')}`);
  });

  it('splits where the allocation changes and names a one-day block with its date', () => {
    const { blocks } = renderBookings([
      booking({ end_date: '2026-09-17' }),
      booking({ id: 32, allocation: 25, start_date: '2026-09-18', end_date: '2026-09-18' }),
    ]);
    expect(blocks().map((b) => b.textContent)).toEqual(['75%', '25%']);
    expect(blocks().map((b) => b.style.width)).toEqual(['118px', '28px']);
    expect(blocks()[1].title).toBe(`25% allocated · ${formatMediumDate('2026-09-18')}`);
  });

  it('keeps Home Office days inside the block, each underlined on its own day', () => {
    useAppStore.setState({
      absenceTypes: [
        { id: 2, name: 'Home Office', color: '#0ea5e9', counts_as_unavailable: false, sort_order: 0, is_active: true },
      ],
    });
    const remote = (id: number, date: string): Vacation => ({
      id,
      staff_id: 4,
      start_date: date,
      end_date: date,
      description: 'Remote day',
      absence_type_id: 2,
    });
    // Mon–Fri 14–18 September 2026, Home Office on Monday and Wednesday
    const { cells, blocks } = renderBookings([booking({})], 'month', [
      remote(41, '2026-09-14'),
      remote(42, '2026-09-16'),
    ]);
    expect(blocks()).toHaveLength(1);
    const [block] = blocks();
    expect(block.style.width).toBe(`${5 * 30 - 2}px`);
    expect(block).toHaveTextContent(/^75%$/);
    const underlines = within(block).getAllByTestId('available-absence-day');
    expect(underlines).toHaveLength(2);
    // Days 0 and 2 of the run, one cell wide, in the absence type's colour
    // Under its own day: the block starts 1 px into its first cell
    expect(underlines.map((u) => u.style.left)).toEqual(['-1px', '59px']);
    expect(underlines.map((u) => u.style.width)).toEqual(['30px', '30px']);
    expect(underlines[0].style.getPropertyValue('--absence-color')).toBe('#0ea5e9');
    expect(underlines[0].className).toMatch(/availableAbsenceDay/);
    expect(cells.findIndex((c) => c.dateStr === '2026-09-14') * 30 + 1).toBe(parseInt(block.style.left, 10));
    expect(block.title).toBe(
      `75% allocated · ${formatMediumDate('2026-09-14')} – ${formatMediumDate('2026-09-18')}` +
        `\nHome Office: Remote day · ${formatMediumDate('2026-09-14')}, ${formatMediumDate('2026-09-16')}`
    );
  });

  it('cuts a 23-day run into blocks of 10, 10 and 3 days, each labelled and titled with its dates', () => {
    // Weekends are working days: 23 days in a row, Mon 7 to Tue 29 Sep 2026
    useAppStore.setState({ instanceSettings: { weekend_working_days: 'true' } });
    try {
      const { cells, blocks } = renderBookings([booking({ start_date: '2026-09-07', end_date: '2026-09-29' })]);
      const first = cells.findIndex((c) => c.dateStr === '2026-09-07');
      expect(cells[first + 22].dateStr).toBe('2026-09-29');
      expect(blocks().map((b) => b.style.width)).toEqual([`${10 * 30 - 2}px`, `${10 * 30 - 2}px`, `${3 * 30 - 2}px`]);
      expect(blocks().map((b) => b.style.left)).toEqual(
        [0, 10, 20].map((offset) => `${(first + offset) * 30 + 1}px`)
      );
      expect(blocks().map((b) => b.textContent)).toEqual(['75%', '75%', '75%']);
      expect(blocks()[2].title).toBe(
        `75% allocated · ${formatMediumDate('2026-09-27')} – ${formatMediumDate('2026-09-29')}`
      );
    } finally {
      useAppStore.setState({ instanceSettings: null });
    }
  });

  it('draws no block at quarter zoom', () => {
    const { blocks } = renderBookings([booking({})], 'quarter');
    expect(blocks()).toHaveLength(0);
  });

  describe('across a weekend (weekends shown)', () => {
    // Thu 17 .. Tue 22 September 2026
    const acrossWeekend = booking({ start_date: '2026-09-17', end_date: '2026-09-22' });

    beforeEach(() => {
      useAppStore.setState({ instanceSettings: { show_weekends: 'true' } });
    });
    afterEach(() => {
      useAppStore.setState({ instanceSettings: null });
    });

    it('books nothing on Saturday and Sunday by default: two blocks around them', () => {
      const { blocks } = renderBookings([acrossWeekend]);
      expect(blocks().map((b) => b.style.width)).toEqual(['58px', '58px']);
      expect(blocks().map((b) => b.textContent)).toEqual(['75%', '75%']);
    });

    it('draws one block over the weekend when weekends are working days', () => {
      useAppStore.setState({ instanceSettings: { show_weekends: 'true', weekend_working_days: 'true' } });
      const { blocks } = renderBookings([acrossWeekend]);
      expect(blocks().map((b) => b.style.width)).toEqual(['178px']);
    });
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
