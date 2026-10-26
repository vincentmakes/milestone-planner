/**
 * ProjectModal + TagPicker: "Manage tags…" is disabled while the project save
 * is in flight — otherwise the hub would open and then be closed again by the
 * resolving save's own closeModal().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ProjectModal } from '../ProjectModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { updateProject } from '@/api/endpoints/projects';
import { makeStaff, makeTeam, makeUser } from '@/test/factories';
import { dateValue, pickEnd, pickRange } from '@/test/datePicker';
import { optionLabel, pickOption, pickerOptions, pickerTrigger } from '@/test/searchableSelect';
import { useViewStore } from '@/stores/viewStore';
import { tagFilterKey } from '@/utils/tags';
import type { Project, Site } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({
  createProject: vi.fn().mockResolvedValue({}),
  updateProject: vi.fn(),
  loadAllProjects: vi.fn(async () => (await import('@/stores/appStore')).useAppStore.getState().projects),
}));
vi.mock('@/api/endpoints/settings', () => ({ getPredefinedPhases: vi.fn(async () => []) }));

const project = {
  id: 9,
  name: 'Bioprocess Scale-Up',
  site_id: 1,
  customer: null,
  pm_id: null,
  sales_pm: null,
  volume: null,
  confirmed: false,
  archived: false,
  start_date: '2026-09-01',
  end_date: '2026-10-01',
  tags: [],
  phases: [],
  staffAssignments: [],
  equipmentAssignments: [],
} as unknown as Project;

beforeEach(() => {
  useAppStore.setState({
    currentSite: { id: 1, name: 'Basel' } as Site,
    currentUser: makeUser({ id: 1, name: 'Ada Admin', role: 'admin' }),
    staff: [],
    projects: [project],
    tags: [],
    projectFields: [],
  });
  act(() => useUIStore.getState().openProjectModal(project));
});

afterEach(() => {
  useUIStore.getState().closeModal();
  useViewStore.setState({ teamFilters: {} });
  useAppStore.setState({ teams: [] });
  vi.restoreAllMocks();
});

describe('ProjectModal tag picker during save', () => {
  it('disables "Manage tags…" and the tag search until the save settles', async () => {
    let resolve: (v: unknown) => void = () => {};
    vi.mocked(updateProject).mockImplementationOnce(() => new Promise((r) => { resolve = r; }) as never);
    render(<ProjectModal />);

    const link = screen.getByRole('button', { name: 'Manage tags…' });
    expect(link).toBeEnabled();

    const save = screen.getByRole('button', { name: 'Save Changes' });
    fireEvent.click(save);
    // The label stays; the shared Button shows the spinner and reports aria-busy
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('aria-busy', 'true');
    expect(link).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Find a tag' })).toBeDisabled();

    await act(async () => {
      resolve({});
    });
    expect(useUIStore.getState().activeModal).toBeNull();
  });
});

describe('ProjectModal fields', () => {
  it('labels every shared Input / Select and keeps "Select PM" selectable', async () => {
    vi.mocked(updateProject).mockResolvedValueOnce({} as never);
    useAppStore.setState({ staff: [makeStaff({ id: 4, name: 'Bob Brown', role: 'Engineer', site_id: 1 })] });
    render(<ProjectModal />);

    expect(screen.getByLabelText('Project Name *')).toHaveValue('Bioprocess Scale-Up');
    expect(dateValue('Start Date *')).toBe('2026-09-01');
    expect(dateValue('End Date *')).toBe('2026-10-01');
    expect(screen.getByLabelText('Customer')).toHaveValue('');
    expect(screen.getByLabelText('Sales PM')).toHaveValue('');
    expect(screen.getByLabelText('Volume')).toHaveValue(null);

    expect(pickerTrigger(/^Project Manager/)).toHaveAccessibleName('Project Manager Select PM');
    const rows = pickerOptions(/^Project Manager/);
    expect(rows.map(optionLabel)).toEqual(['Select PM', 'Bob Brown']);
    expect(rows.map((o) => o.getAttribute('aria-disabled'))).toEqual([null, null]);
    expect(rows[1]).toHaveTextContent('Bob Brown Engineer');
    pickOption(/^Project Manager/, 'Bob Brown');
    expect(pickerTrigger(/^Project Manager/)).toHaveAccessibleName('Project Manager Bob Brown');
    pickOption(/^Project Manager/, 'Select PM');
    expect(pickerTrigger(/^Project Manager/)).toHaveAccessibleName('Project Manager Select PM');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });
    expect(updateProject).toHaveBeenCalledWith(
      9,
      expect.objectContaining({ name: 'Bioprocess Scale-Up', pm_id: null })
    );
  });

  it('finds the project manager by name or job title and saves the pick', async () => {
    vi.mocked(updateProject).mockResolvedValueOnce({} as never);
    useAppStore.setState({
      staff: [
        makeStaff({ id: 4, name: 'Bob Brown', role: 'Engineer', site_id: 1 }),
        makeStaff({ id: 5, name: 'Alice Martin', role: 'Chemist', site_id: 1 }),
      ],
    });
    render(<ProjectModal />);
    fireEvent.click(pickerTrigger(/^Project Manager/));
    const search = screen.getByRole('combobox', { name: 'Find a person' });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: 'chem' } });
    expect(pickerOptions(/^Project Manager/).map(optionLabel)).toEqual(['Select PM', 'Alice Martin']);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(pickerTrigger(/^Project Manager/)).toHaveAccessibleName('Project Manager Alice Martin');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });
    expect(updateProject).toHaveBeenCalledWith(9, expect.objectContaining({ pm_id: 5 }));
  });

  // The rule itself is proven in dateRangeLogic.test; this guards the form's payload wiring
  it('never lets the end precede the start', async () => {
    vi.mocked(updateProject).mockResolvedValueOnce({} as never);
    render(<ProjectModal />);
    // An end picked before the start becomes the new start, keeping the duration
    pickEnd('End Date *', '2026-08-20');
    expect(dateValue('Start Date *')).toBe('2026-08-20');
    expect(dateValue('End Date *')).toBe('2026-09-19');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });
    expect(updateProject).toHaveBeenCalledWith(9, expect.objectContaining({ start_date: '2026-08-20', end_date: '2026-09-19' }));
  });

  it('saves what was typed into each field', async () => {
    vi.mocked(updateProject).mockResolvedValueOnce({} as never);
    render(<ProjectModal />);

    pickRange('Start Date *', '2026-09-15', '2026-11-30');
    expect(dateValue('Start Date *')).toBe('2026-09-15');
    expect(dateValue('End Date *')).toBe('2026-11-30');

    const edits: [string, string][] = [
      ['Project Name *', 'Catalyst Optimization'],
      ['Customer', 'Acme'],
      ['Sales PM', 'Sam Sales'],
    ];
    for (const [label, value] of edits) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
      expect(screen.getByLabelText(label)).toHaveValue(value);
    }
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '250000' } });
    expect(screen.getByLabelText('Volume')).toHaveValue(250000);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });
    expect(updateProject).toHaveBeenCalledWith(9, expect.objectContaining({
      name: 'Catalyst Optimization',
      start_date: '2026-09-15',
      end_date: '2026-11-30',
      customer: 'Acme',
      sales_pm: 'Sam Sales',
      volume: 250000,
    }));
  });

  it('offers Confirmed and Archived as switches and saves their new values', async () => {
    vi.mocked(updateProject).mockResolvedValueOnce({} as never);
    render(<ProjectModal />);

    const confirmed = screen.getByRole('switch', { name: 'Confirmed' });
    const archived = screen.getByRole('switch', { name: 'Archived' });
    expect(confirmed).not.toBeChecked();
    expect(archived).not.toBeChecked();
    fireEvent.click(confirmed);
    fireEvent.click(archived);
    expect(confirmed).toBeChecked();
    expect(archived).toBeChecked();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });
    expect(updateProject).toHaveBeenCalledWith(9, expect.objectContaining({ confirmed: true, archived: true }));
  });
});

describe('ProjectModal PM picker with a team filter', () => {
  it('keeps the currently selected item even when it no longer matches', () => {
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1 }), makeTeam({ id: 2, site_id: 1, name: 'Process' })],
      staff: [
        makeStaff({ id: 42, name: 'Pat Manager', site_id: 1, team_ids: [2] }),
        makeStaff({ id: 43, name: 'Ann Teamer', site_id: 1, team_ids: [1] }),
        makeStaff({ id: 44, name: 'Out Sider', site_id: 1, team_ids: [2] }),
      ],
    });
    useViewStore.setState({ teamFilters: { [tagFilterKey(1)]: { teamIds: [1], noTeam: false } } });
    act(() => useUIStore.getState().openProjectModal({ ...project, pm_id: 42 }));
    render(<ProjectModal />);

    expect(pickerTrigger(/^Project Manager/)).toHaveAccessibleName('Project Manager Pat Manager');
    const rows = pickerOptions(/^Project Manager/);
    expect(rows.map(optionLabel)).toEqual(['Select PM', 'Pat Manager', 'Ann Teamer']);
    expect(rows[1]).toHaveAttribute('aria-selected', 'true');
  });
});
