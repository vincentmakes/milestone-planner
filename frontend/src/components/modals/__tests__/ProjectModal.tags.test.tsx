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
import { makeStaff } from '@/test/factories';
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
    currentUser: { id: 1, name: 'Ada Admin', role: 'admin' } as never,
    staff: [],
    projects: [project],
    tags: [],
    tagGroups: [],
  });
  act(() => useUIStore.getState().openProjectModal(project));
});

afterEach(() => {
  useUIStore.getState().closeModal();
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
    useAppStore.setState({ staff: [makeStaff({ id: 4, name: 'Bob Brown', site_id: 1 })] });
    render(<ProjectModal />);

    expect(screen.getByLabelText('Project Name *')).toHaveValue('Bioprocess Scale-Up');
    expect(screen.getByLabelText('Start Date *')).toHaveValue('2026-09-01');
    expect(screen.getByLabelText('End Date *')).toHaveValue('2026-10-01');
    expect(screen.getByLabelText('Customer')).toHaveValue('');
    expect(screen.getByLabelText('Sales PM')).toHaveValue('');
    expect(screen.getByLabelText('Project Volume (CHF)')).toHaveValue(null);

    const pm = screen.getByLabelText('Project Manager') as HTMLSelectElement;
    expect(pm.value).toBe('');
    expect(Array.from(pm.options).map((o) => [o.value, o.text, o.disabled])).toEqual([
      ['', 'Select PM', false],
      ['4', 'Bob Brown', false],
    ]);
    fireEvent.change(pm, { target: { value: '4' } });
    expect(pm.value).toBe('4');
    fireEvent.change(pm, { target: { value: '' } });
    expect(pm.value).toBe('');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });
    expect(updateProject).toHaveBeenCalledWith(9, expect.objectContaining({ name: 'Bioprocess Scale-Up' }));
  });

  it('saves what was typed into each field', async () => {
    vi.mocked(updateProject).mockResolvedValueOnce({} as never);
    render(<ProjectModal />);

    const edits: [string, string][] = [
      ['Project Name *', 'Catalyst Optimization'],
      ['Start Date *', '2026-09-15'],
      ['End Date *', '2026-11-30'],
      ['Customer', 'Acme'],
      ['Sales PM', 'Sam Sales'],
    ];
    for (const [label, value] of edits) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
      expect(screen.getByLabelText(label)).toHaveValue(value);
    }
    fireEvent.change(screen.getByLabelText('Project Volume (CHF)'), { target: { value: '250000' } });
    expect(screen.getByLabelText('Project Volume (CHF)')).toHaveValue(250000);

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

    const confirmed = screen.getByRole('switch', { name: 'Project Confirmed' });
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
