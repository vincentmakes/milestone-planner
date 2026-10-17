/**
 * Equipment overview: site-scoped equipment with today's status, a type
 * filter, expandable rows listing blocks (managed by admins/superusers) and
 * project/phase bookings, and the panel resizer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { EquipmentView } from '../EquipmentView';
import { resetAllStores, useAppStore, useUIStore } from '@/stores';
import { deleteEquipmentBlock } from '@/api';
import { formatDateISO } from '@/utils/date';
import { makeEquipment, makePhase, makeProject, makeSite, makeUser } from '@/test/factories';
import { stubConfirm } from '@/test/confirmDialog';
import type { EquipmentBlock } from '@/types';

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
