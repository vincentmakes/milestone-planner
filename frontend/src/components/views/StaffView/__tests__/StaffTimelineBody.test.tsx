/**
 * Vacation bars on the staff timeline follow the same rule as the left panel:
 * a person may edit their own absences, admins and superusers anyone's.
 * Otherwise a bar is tooltip-only (the backend would answer 403 on save).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, screen, act, within } from '@testing-library/react';
import { StaffTimelineBody } from '../StaffTimelineBody';
import { generateTimelineCells } from '@/components/gantt/utils';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import type { Staff, Vacation } from '@/types';
import { makeTeam } from '@/test/factories';

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
  useAppStore.setState({ currentUser: { name: 'Someone', ...user } as never });
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
    const closed = (row: HTMLElement, name: string) => within(row).queryAllByTitle(`Site closed: ${name}`).length;
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
