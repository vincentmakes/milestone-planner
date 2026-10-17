/**
 * Vacation bars on the staff timeline follow the same rule as the left panel:
 * a person may edit their own absences, admins and superusers anyone's.
 * Otherwise a bar is tooltip-only (the backend would answer 403 on save).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { StaffTimelineBody } from '../StaffTimelineBody';
import { generateTimelineCells } from '@/components/gantt/utils';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import type { Staff, Vacation } from '@/types';

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
