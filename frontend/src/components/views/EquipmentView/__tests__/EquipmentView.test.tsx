/**
 * Equipment overview: site-scoped equipment with today's status, a type
 * filter, expandable rows listing blocks (managed by admins/superusers) and
 * project/phase bookings, and the panel resizer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { EquipmentView } from '../EquipmentView';
import { resetAllStores, useAppStore, useUIStore, useViewStore } from '@/stores';
import { tagFilterKey } from '@/utils/tags';
import { deleteEquipmentBlock } from '@/api';
import { formatDateISO } from '@/utils/date';
import { makeEquipment, makePhase, makeProject, makeSite, makeTeam, makeUser } from '@/test/factories';
import { stubConfirm } from '@/test/confirmDialog';
import { buildEventDateSet } from '@/api';
import type { CompanyEvent, EquipmentBlock } from '@/types';

const refreshEquipmentBlocks = vi.fn();

vi.mock('@/hooks/useDataLoader', () => ({
  useDataLoader: () => ({ refreshEquipmentBlocks }),
}));

vi.mock('@/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api')>()),
  deleteEquipmentBlock: vi.fn(),
}));

function isoOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return formatDateISO(d);
}

const reactor = makeEquipment({ id: 1, name: 'Bioreactor 50L', type: 'Bioreactor' });
const hplc = makeEquipment({ id: 2, name: 'HPLC Agilent', type: 'Analytics' });
const spare = makeEquipment({ id: 3, name: 'Spare centrifuge', type: '' });
const elsewhere = makeEquipment({ id: 4, name: 'Remote mixer', type: 'Mixer', site_id: 2 });

const block: EquipmentBlock = {
  id: 90,
  equipment_id: 2,
  start_date: isoOffset(-1),
  end_date: isoOffset(1),
  reason: 'Maintenance',
  description: 'Pump service',
};

function seed(role: 'admin' | 'superuser' | 'user' = 'admin') {
  useAppStore.setState({
    currentSite: makeSite({ id: 1 }),
    currentUser: makeUser({ id: 1, role }),
    equipment: [hplc, reactor, spare, elsewhere],
    equipmentBlocks: [block, { ...block, id: 91, equipment_id: 4 }],
    projects: [
      makeProject({
        id: 10,
        name: 'Bioprocess Scale-Up',
        equipmentAssignments: [
          { id: 501, equipment_id: 1, start_date: isoOffset(-2), end_date: isoOffset(2) },
          { id: 502, equipment_id: 1, start_date: isoOffset(-1), end_date: isoOffset(3) },
        ],
        phases: [
          makePhase({
            id: 20,
            name: 'Feasibility',
            start_date: '2026-03-02',
            end_date: '2026-03-02',
            equipmentAssignments: [{ id: 601, equipment_id: 1, start_date: '', end_date: '' }],
          }),
        ],
      }),
      makeProject({
        id: 11,
        archived: true,
        equipmentAssignments: [{ id: 701, equipment_id: 3, start_date: isoOffset(-1), end_date: isoOffset(1) }],
      }),
    ],
  });
}

const rowFor = (name: string) => screen.getByText(name).closest('[draggable]') as HTMLElement;
const countBadge = () => screen.getByText('Equipment Overview').nextElementSibling as HTMLElement;
const panelOf = () =>
  screen.getByText('Equipment Overview').parentElement!.parentElement!.parentElement as HTMLElement;

beforeEach(() => {
  resetAllStores();
  refreshEquipmentBlocks.mockReset();
  vi.mocked(deleteEquipmentBlock).mockReset();
});

describe('EquipmentView panel', () => {
  it("lists the site's equipment by name with today's status and overlap warnings", () => {
    seed();
    render(<EquipmentView />);

    expect(countBadge()).toHaveTextContent('3');
    const panel = within(panelOf());
    expect(panel.queryByText('Remote mixer')).not.toBeInTheDocument();

    expect(within(rowFor('Bioreactor 50L')).getByText('In use')).toBeInTheDocument();
    expect(within(rowFor('HPLC Agilent')).getByText('Blocked')).toBeInTheDocument();
    // archived project bookings do not count
    expect(within(rowFor('Spare centrifuge')).getByText('Available')).toBeInTheDocument();
    expect(within(rowFor('Spare centrifuge')).getByText('Equipment')).toBeInTheDocument();
    // two overlapping bookings on the reactor
    expect(
      within(rowFor('Bioreactor 50L')).getByTitle('This equipment has overlapping bookings or blocks')
    ).toBeInTheDocument();
    expect(
      within(rowFor('HPLC Agilent')).queryByTitle('This equipment has overlapping bookings or blocks')
    ).not.toBeInTheDocument();
  });

  it('keeps the compact text and icon scale on its root (compact-ui)', () => {
    useAppStore.setState({ currentSite: makeSite(), currentUser: makeUser(), equipment: [] });
    const { container } = render(<EquipmentView />);
    expect(container.firstElementChild).toHaveClass('compact-ui');
  });

  it('shows the empty state and no type filter without equipment', () => {
    useAppStore.setState({ currentSite: makeSite(), currentUser: makeUser(), equipment: [] });
    render(<EquipmentView />);
    expect(screen.getByText('No equipment found')).toBeInTheDocument();
    expect(screen.queryByText('All Types')).not.toBeInTheDocument();
  });

  it('filters by type, selects all and clears', () => {
    seed();
    render(<EquipmentView />);

    fireEvent.click(screen.getByRole('button', { name: /All Types/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Analytics' }));
    expect(screen.queryByText('Bioreactor 50L')).not.toBeInTheDocument();
    expect(screen.getAllByText('Analytics').length).toBeGreaterThan(0);
    expect(countBadge()).toHaveTextContent('1');

    fireEvent.click(screen.getByText('Select All'));
    expect(screen.getByText('2 types')).toBeInTheDocument();
    // typeless equipment is hidden as soon as a type filter applies
    expect(screen.queryByText('Spare centrifuge')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Bioreactor' }));
    fireEvent.click(screen.getByText('Clear'));
    expect(screen.getByText('Spare centrifuge')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Select All')).not.toBeInTheDocument();
  });

  it("starts the Gantt panel with the admin's default types found at the site, ignoring unknown ones; Clear works for the session", () => {
    seed();
    // Mixer exists only at another site, Gone nowhere
    useAppStore.setState({ instanceSettings: { equipment_panel_default_types: '["Analytics","Mixer","Gone"]' } });
    const { unmount } = render(<EquipmentView embedded />);

    expect(screen.getByText('HPLC Agilent')).toBeInTheDocument();
    expect(screen.queryByText('Bioreactor 50L')).not.toBeInTheDocument();
    expect(countBadge()).toHaveTextContent('1');

    fireEvent.click(screen.getByRole('button', { name: /Analytics/ }));
    expect(screen.getByRole('checkbox', { name: 'Analytics' })).toBeChecked();
    fireEvent.click(screen.getByText('Clear'));
    expect(screen.getByText('Bioreactor 50L')).toBeInTheDocument();
    expect(countBadge()).toHaveTextContent('3');

    // The next opening applies the default again
    unmount();
    render(<EquipmentView embedded />);
    expect(screen.queryByText('Bioreactor 50L')).not.toBeInTheDocument();
  });

  it("re-seeds the Gantt panel's filter with each site's own default types when the site changes", () => {
    seed();
    useAppStore.setState({ instanceSettings: { equipment_panel_default_types: '["Analytics","Mixer"]' } });
    render(<EquipmentView embedded />);
    expect(screen.getByRole('button', { name: /Analytics/ })).toBeInTheDocument();

    // Mixer is the only default type at site 2
    act(() => useAppStore.setState({ currentSite: makeSite({ id: 2, name: 'Zurich' }) }));
    expect(screen.getByRole('button', { name: /Mixer/ })).toBeInTheDocument();
    expect(screen.getByText('Remote mixer')).toBeInTheDocument();
    expect(countBadge()).toHaveTextContent('1');

    // A site without any default type opens unfiltered
    act(() =>
      useAppStore.setState({
        currentSite: makeSite({ id: 3, name: 'Lyon' }),
        equipment: [...useAppStore.getState().equipment, makeEquipment({ id: 5, name: 'Lyon oven', type: 'Oven', site_id: 3 })],
      })
    );
    expect(screen.getByRole('button', { name: /All Types/ })).toBeInTheDocument();
    expect(screen.getByText('Lyon oven')).toBeInTheDocument();
  });

  it('starts unfiltered when no default type exists at the site', () => {
    seed();
    useAppStore.setState({ instanceSettings: { equipment_panel_default_types: '["Mixer"]' } });
    render(<EquipmentView embedded />);
    expect(screen.getByRole('button', { name: /All Types/ })).toBeInTheDocument();
    expect(countBadge()).toHaveTextContent('3');
  });

  it('starts the standalone view unfiltered with default types set, also after a site change', () => {
    seed();
    useAppStore.setState({ instanceSettings: { equipment_panel_default_types: '["Analytics","Mixer"]' } });
    render(<EquipmentView />);
    expect(screen.getByRole('button', { name: /All Types/ })).toBeInTheDocument();
    expect(countBadge()).toHaveTextContent('3');
    expect(screen.getByText('Bioreactor 50L')).toBeInTheDocument();

    act(() => useAppStore.setState({ currentSite: makeSite({ id: 2, name: 'Zurich' }) }));
    expect(screen.getByRole('button', { name: /All Types/ })).toBeInTheDocument();
  });

  it('with an active team filter, hides non-matching equipment and keeps matching ones', () => {
    seed();
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1 }), makeTeam({ id: 2, site_id: 1, name: 'Process' })],
      equipment: [{ ...hplc, team_ids: [1] }, { ...reactor, team_ids: [2] }, { ...spare, team_ids: [] }],
    });
    useViewStore.setState({ teamFilters: { [tagFilterKey(1)]: { teamIds: [1], noTeam: false } } });
    render(<EquipmentView />);
    expect(screen.getByText('HPLC Agilent')).toBeInTheDocument();
    // Open to the whole site, so it stays
    expect(screen.getByText('Spare centrifuge')).toBeInTheDocument();
    expect(screen.queryByText('Bioreactor 50L')).not.toBeInTheDocument();
  });

  it('with an active team filter, drops company events of other teams from the timeline', () => {
    seed();
    const teamEvents: CompanyEvent[] = [
      { id: 81, site_id: 1, site_ids: [1], date: isoOffset(2), end_date: null, name: 'Team B review', team_ids: [2] },
      { id: 82, site_id: 1, site_ids: [1], date: isoOffset(3), end_date: null, name: 'Site audit', team_ids: [] },
    ];
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
    render(<EquipmentView />);
    expect(screen.getAllByTitle('Site audit').length).toBeGreaterThan(0);
    expect(screen.queryAllByTitle('Team B review')).toHaveLength(0);

    act(() => useViewStore.setState({ teamFilters: {} }));
    expect(screen.getAllByTitle('Team B review').length).toBeGreaterThan(0);
  });
});

describe('EquipmentView expanded rows', () => {
  it('opens the type filter as a dialog that Escape closes, focus back on the trigger', () => {
    seed();
    render(<EquipmentView />);
    const trigger = screen.getByRole('button', { name: /All Types/ });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Filter equipment' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Filter equipment' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('portals the type filter out of the header, right-aligned; a mousedown in it keeps it open', () => {
    seed();
    render(<EquipmentView />);
    const trigger = screen.getByRole('button', { name: /All Types/ });
    fireEvent.click(trigger);
    const panel = screen.getByRole('dialog', { name: 'Filter equipment' });
    expect(trigger.parentElement).not.toContainElement(panel);
    expect(panel).toHaveAttribute('data-align', 'end');
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Select All' }));
    expect(screen.getByRole('dialog', { name: 'Filter equipment' })).toBeInTheDocument();
  });

  it('lists bookings with their level and the project/phase names', () => {
    seed();
    render(<EquipmentView />);
    fireEvent.click(rowFor('Bioreactor 50L'));
    const panel = within(panelOf());
    expect(panel.getAllByText('Project')).toHaveLength(2);
    expect(panel.getByText('Phase')).toBeInTheDocument();
    expect(panel.getByText('Bioprocess Scale-Up › Feasibility')).toBeInTheDocument();
    // a phase booking without dates takes the (single-day) phase dates
    expect(panel.getByText('Mar 2, 2026')).toBeInTheDocument();
    expect(panel.getByText('Add block (maintenance / defect)')).toBeInTheDocument();

    fireEvent.click(rowFor('Bioreactor 50L'));
    expect(panel.queryByText('Phase')).not.toBeInTheDocument();
  });

  it('opens the block editor for an existing block and for a new one', () => {
    seed('superuser');
    render(<EquipmentView />);
    fireEvent.click(rowFor('HPLC Agilent'));
    const panel = within(panelOf());

    fireEvent.click(panel.getByText('Pump service'));
    expect(useUIStore.getState().activeModal).toBe('equipmentBlock');
    expect(useUIStore.getState().editingEquipmentBlock?.id).toBe(90);

    useUIStore.setState({ activeModal: null, editingEquipmentBlock: null });
    fireEvent.click(panel.getByText('Add block (maintenance / defect)'));
    expect(useUIStore.getState().activeModal).toBe('equipmentBlock');
    expect(useUIStore.getState().editingEquipmentBlock).toBeNull();
  });

  it('deletes a block after confirmation and refreshes the blocks', async () => {
    seed();
    let answer = false;
    const confirm = stubConfirm(() => answer);
    vi.mocked(deleteEquipmentBlock).mockResolvedValue(undefined as never);
    render(<EquipmentView />);
    fireEvent.click(rowFor('HPLC Agilent'));

    await act(async () => {
      fireEvent.click(screen.getByTitle('Delete block'));
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Delete this equipment block?', destructive: true })
    );
    expect(deleteEquipmentBlock).not.toHaveBeenCalled();

    answer = true;
    fireEvent.click(screen.getByTitle('Delete block'));
    await waitFor(() => expect(refreshEquipmentBlocks).toHaveBeenCalled());
    expect(deleteEquipmentBlock).toHaveBeenCalledWith(90);
    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it('logs and skips the refresh when the delete fails', async () => {
    seed();
    stubConfirm(true);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(deleteEquipmentBlock).mockRejectedValue(new Error('x'));
    render(<EquipmentView />);
    fireEvent.click(rowFor('HPLC Agilent'));
    fireEvent.click(screen.getByTitle('Delete block'));
    await waitFor(() => expect(err).toHaveBeenCalled());
    expect(refreshEquipmentBlocks).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('is read-only for a user who manages no project', () => {
    seed('user');
    render(<EquipmentView />);
    expect(rowFor('HPLC Agilent')).toHaveAttribute('draggable', 'false');

    fireEvent.click(rowFor('HPLC Agilent'));
    const panel = within(panelOf());
    fireEvent.click(panel.getByText('Pump service'));
    expect(useUIStore.getState().activeModal).toBeNull();
    expect(panel.queryByTitle('Delete block')).not.toBeInTheDocument();

    fireEvent.click(rowFor('Spare centrifuge'));
    expect(panel.getByText('No bookings or blocks')).toBeInTheDocument();
  });
});

describe('EquipmentView layout', () => {
  it('resizes the standalone panel within bounds', () => {
    seed();
    render(<EquipmentView />);
    const panel = panelOf();
    expect(panel.style.width).toBe('320px');
    fireEvent.mouseDown(panel.nextElementSibling as HTMLElement, { clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 400 });
    expect(panel.style.width).toBe('500px');
    fireEvent.mouseUp(document);
    expect(document.body.style.userSelect).toBe('');
  });

  it('delegates the width to the parent when embedded', () => {
    seed();
    const onPanelWidthChange = vi.fn();
    const { container } = render(
      <EquipmentView embedded panelWidth={264} height={180} onPanelWidthChange={onPanelWidthChange} />
    );
    expect((container.firstChild as HTMLElement).style.height).toBe('180px');
    const panel = panelOf();
    expect(panel.style.width).toBe('260px');
    fireEvent.mouseDown(panel.nextElementSibling as HTMLElement, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 0 });
    fireEvent.mouseUp(document);
    expect(onPanelWidthChange).toHaveBeenCalledWith(200);
  });
});
