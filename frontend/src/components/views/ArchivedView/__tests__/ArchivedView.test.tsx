/**
 * The archived view's edit button opens the project editor (which can also
 * unarchive the project), so it is offered to project editors only:
 * `projects.edit_any`, or the project's manager (utils/permissions.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ArchivedView } from '../ArchivedView';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useViewStore } from '@/stores/viewStore';
import { tagFilterKey } from '@/utils/tags';
import { makeTeam, makeUser } from '@/test/factories';
import { buildEventDateSet } from '@/api';
import { formatDateISO } from '@/utils/date';
import type { CompanyEvent, Project } from '@/types';

vi.mock('@/hooks', () => ({
  useScrollSync: vi.fn(),
}));

const archived = {
  id: 5,
  name: 'Legacy Assay',
  site_id: 1,
  pm_id: 42,
  pm_name: 'Pat Manager',
  customer: 'Acme',
  confirmed: true,
  archived: true,
  start_date: '2025-01-01',
  end_date: '2025-06-30',
  phases: [],
  staffAssignments: [],
  equipmentAssignments: [],
} as unknown as Project;

function seed(user: { id: number; role: 'admin' | 'superuser' | 'user' }) {
  useAppStore.setState({
    projects: [archived],
    currentSite: { id: 1, name: 'Basel' } as never,
    currentUser: makeUser({ name: 'Someone', ...user }),
  });
}

const editButton = () => screen.queryByTitle('Edit project');

beforeEach(() => {
  useUIStore.setState({ activeModal: null, editingProject: null });
});

describe('ArchivedView edit button', () => {
  it('sits in the compact text and icon scale (compact-ui on its root)', () => {
    seed({ id: 1, role: 'admin' });
    const { container } = render(<ArchivedView />);
    expect(container.firstElementChild).toHaveClass('compact-ui');
  });

  it.each(['admin', 'superuser'] as const)('is offered to a %s and opens the editor', (role) => {
    seed({ id: 1, role });
    render(<ArchivedView />);

    fireEvent.click(editButton()!);
    expect(useUIStore.getState().activeModal).toBe('project');
    expect(useUIStore.getState().editingProject?.id).toBe(5);
  });

  it("is offered to the project's manager", () => {
    seed({ id: 42, role: 'user' });
    render(<ArchivedView />);
    expect(editButton()).toBeInTheDocument();
  });

  it('is hidden from a plain user who does not manage the project', () => {
    seed({ id: 7, role: 'user' });
    render(<ArchivedView />);
    expect(screen.getByText('Legacy Assay')).toBeInTheDocument();
    expect(editButton()).not.toBeInTheDocument();
  });
});

describe('ArchivedView customer', () => {
  afterEach(() => useAppStore.setState({ instanceSettings: null }));

  it('shows the customer, or "No Customer" named with the field label as given', () => {
    seed({ id: 1, role: 'admin' });
    const { unmount } = render(<ArchivedView />);
    expect(screen.getByText('Acme')).toBeInTheDocument();
    unmount();

    useAppStore.setState({
      projects: [{ ...archived, customer: null }],
      instanceSettings: { project_field_labels: '{"customer":"Client"}' },
    });
    const second = render(<ArchivedView />);
    expect(screen.getByText('No Client')).toBeInTheDocument();
    second.unmount();

    useAppStore.setState({ instanceSettings: null });
    render(<ArchivedView />);
    expect(screen.getByText('No Customer')).toBeInTheDocument();
  });

  it('leaves the customer out while the Customer field is hidden', () => {
    seed({ id: 1, role: 'admin' });
    useAppStore.setState({ instanceSettings: { project_fields_hidden: '["customer"]' } });
    render(<ArchivedView />);
    expect(screen.getByText('Pat Manager')).toBeInTheDocument();
    expect(screen.queryByText('Acme')).not.toBeInTheDocument();
    expect(screen.queryByText(' · ')).not.toBeInTheDocument();
  });
});

describe('ArchivedView team filter', () => {
  afterEach(() => {
    useViewStore.setState({ teamFilters: {} });
    useAppStore.setState({ teams: [], companyEvents: [], companyEventDates: new Set() });
  });

  it('with an active team filter, hides non-matching projects and keeps matching ones', () => {
    useAppStore.setState({
      projects: [
        { ...archived, team_ids: [1] },
        { ...archived, id: 6, name: 'Old Pilot', team_ids: [2] },
      ],
      teams: [makeTeam({ id: 1, site_id: 1 }), makeTeam({ id: 2, site_id: 1, name: 'Process' })],
      currentSite: { id: 1, name: 'Basel' } as never,
      currentUser: makeUser({ id: 1, name: 'Someone', role: 'admin' }),
    });
    useViewStore.setState({ teamFilters: { [tagFilterKey(1)]: { teamIds: [1], noTeam: false } } });
    render(<ArchivedView />);
    expect(screen.getByText('Legacy Assay')).toBeInTheDocument();
    expect(screen.queryByText('Old Pilot')).not.toBeInTheDocument();
  });

  it('with an active team filter, drops company events of other teams from the timeline', () => {
    const isoOffset = (days: number) => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      return formatDateISO(d);
    };
    const teamEvents: CompanyEvent[] = [
      { id: 81, site_id: 1, site_ids: [1], date: isoOffset(2), end_date: null, name: 'Team B review', team_ids: [2] },
      { id: 82, site_id: 1, site_ids: [1], date: isoOffset(3), end_date: null, name: 'Site audit', team_ids: [] },
    ];
    seed({ id: 1, role: 'admin' });
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1, name: 'A' }), makeTeam({ id: 2, site_id: 1, name: 'B' })],
      companyEvents: teamEvents,
      companyEventDates: buildEventDateSet(teamEvents),
    });
    useViewStore.setState({
      viewMode: 'month',
      currentDate: new Date(),
      teamFilters: { [tagFilterKey(1)]: { teamIds: [1], noTeam: false } },
    });
    render(<ArchivedView />);
    expect(screen.getAllByTitle('Site audit').length).toBeGreaterThan(0);
    expect(screen.queryAllByTitle('Team B review')).toHaveLength(0);

    act(() => useViewStore.setState({ teamFilters: {} }));
    expect(screen.getAllByTitle('Team B review').length).toBeGreaterThan(0);
  });
});
