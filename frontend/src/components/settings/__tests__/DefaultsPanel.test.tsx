/**
 * Settings › Features & defaults: loads the six settings, saves only the keys
 * that changed in the backend's canonical form (compact JSON lists,
 * `true` / `false`), merges them into appStore.instanceSettings, re-reads
 * /auth/me after a Kanban switch change (the broadcast skips the saver),
 * reports unsaved input to the hub and shows a refused value in a Notice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { DefaultsPanel } from '../panels/DefaultsPanel';
import { resetAllStores, useAppStore } from '@/stores';
import { makeUser } from '@/test/factories';
import type { InstanceSettings, Skill } from '@/types';

const api = vi.hoisted(() => ({
  getInstanceSettings: vi.fn(),
  updateSetting: vi.fn(),
  getEquipmentTypes: vi.fn(),
  checkAuth: vi.fn(),
}));
vi.mock('@/api/endpoints/settings', () => ({
  getInstanceSettings: api.getInstanceSettings,
  updateSetting: api.updateSetting,
}));
vi.mock('@/api/endpoints/equipment', () => ({ getEquipmentTypes: api.getEquipmentTypes }));
vi.mock('@/api/endpoints/auth', () => ({ checkAuth: api.checkAuth }));

const SKILLS: Skill[] = [
  { id: 1, name: 'Chromatography', color: '#3b82f6' },
  { id: 2, name: 'Fermentation', color: '#10b981' },
  { id: 3, name: 'Microscopy', color: '#f59e0b' },
];

const STORED: InstanceSettings = {
  instance_title: 'Lab',
  gantt_default_panel: 'staff',
  // 9 was deleted since
  staff_panel_default_skills: '[2,9]',
  // "Old type" was renamed since
  equipment_panel_default_types: '["HPLC","Old type"]',
  kanban_enabled: 'true',
  nager_enabled: 'true',
  new_project_preselect_phases: 'true',
};

const skillsGroup = () => screen.getByRole('group', { name: 'Staff panel skills' });
const typesGroup = () => screen.getByRole('group', { name: 'Equipment panel types' });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

beforeEach(() => {
  resetAllStores();
  for (const fn of Object.values(api)) fn.mockReset();
  api.getInstanceSettings.mockResolvedValue(STORED);
  api.getEquipmentTypes.mockResolvedValue(['GC', 'HPLC']);
  api.updateSetting.mockImplementation(async (key: string, value: string) => ({ key, value }));
  api.checkAuth.mockResolvedValue({ user: null });
  useAppStore.setState({
    currentUser: makeUser({ id: 1, role: 'admin' }),
    skills: SKILLS,
    instanceSettings: { ...STORED },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderPanel(onDirtyChange = vi.fn()) {
  render(<DefaultsPanel onDirtyChange={onDirtyChange} />);
  await screen.findByLabelText('Open the Gantt with');
  return onDirtyChange;
}

describe('DefaultsPanel', () => {
  it('shows the stored values, with stale skills and types listed so they can be unticked', async () => {
    await renderPanel();

    expect(screen.getByLabelText('Open the Gantt with')).toHaveValue('staff');
    expect(within(skillsGroup()).getByRole('checkbox', { name: 'Fermentation' })).toBeChecked();
    expect(within(skillsGroup()).getByRole('checkbox', { name: 'Chromatography' })).not.toBeChecked();
    expect(within(skillsGroup()).getByRole('checkbox', { name: 'Skill #9 (no longer exists)' })).toBeChecked();
    expect(within(typesGroup()).getByRole('checkbox', { name: 'HPLC' })).toBeChecked();
    expect(within(typesGroup()).getByRole('checkbox', { name: 'GC' })).not.toBeChecked();
    expect(within(typesGroup()).getByRole('checkbox', { name: 'Old type (no longer exists)' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Kanban board' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Bank-holiday import (Nager)' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Pre-select predefined phases in new projects' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Kanban board' })).toHaveAccessibleDescription(
      'When off, nobody sees the board, whatever their role.'
    );
    expect(screen.getByRole('switch', { name: 'Bank-holiday import (Nager)' })).toHaveAccessibleDescription(
      'Holidays already imported stay; refresh and automatic fetching stop.'
    );
    // The defaults seed the panels below the Gantt only (the standalone views open unfiltered).
    expect(screen.getByText(/^The Staff panel below the Gantt opens showing only people/)).toBeInTheDocument();
    expect(screen.getByText(/^The Equipment panel below the Gantt opens showing only these types/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });

  it('saves every control under its key in the canonical form and merges it into the store', async () => {
    await renderPanel();

    fireEvent.change(screen.getByLabelText('Open the Gantt with'), { target: { value: 'equipment' } });
    // Ticked out of order: the list is saved sorted
    fireEvent.click(within(skillsGroup()).getByRole('checkbox', { name: 'Microscopy' }));
    fireEvent.click(within(skillsGroup()).getByRole('checkbox', { name: 'Chromatography' }));
    fireEvent.click(within(skillsGroup()).getByRole('checkbox', { name: 'Skill #9 (no longer exists)' }));
    fireEvent.click(within(typesGroup()).getByRole('checkbox', { name: 'GC' }));
    fireEvent.click(within(typesGroup()).getByRole('checkbox', { name: 'Old type (no longer exists)' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Kanban board' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Bank-holiday import (Nager)' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Pre-select predefined phases in new projects' }));
    save();

    expect(await screen.findByText('Settings saved')).toBeInTheDocument();
    expect(api.updateSetting.mock.calls).toEqual([
      ['gantt_default_panel', 'equipment'],
      ['staff_panel_default_skills', '[1,2,3]'],
      ['equipment_panel_default_types', '["GC","HPLC"]'],
      ['kanban_enabled', 'false'],
      ['nager_enabled', 'false'],
      ['new_project_preselect_phases', 'false'],
    ]);
    expect(useAppStore.getState().instanceSettings).toEqual({
      instance_title: 'Lab',
      gantt_default_panel: 'equipment',
      staff_panel_default_skills: '[1,2,3]',
      equipment_panel_default_types: '["GC","HPLC"]',
      kanban_enabled: 'false',
      nager_enabled: 'false',
      new_project_preselect_phases: 'false',
    });
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });

  it('saves only the keys that changed, and does not re-read /auth/me without a Kanban change', async () => {
    await renderPanel();

    fireEvent.click(screen.getByRole('switch', { name: 'Pre-select predefined phases in new projects' }));
    save();

    await screen.findByText('Settings saved');
    expect(api.updateSetting).toHaveBeenCalledTimes(1);
    expect(api.updateSetting).toHaveBeenCalledWith('new_project_preselect_phases', 'false');
    expect(api.checkAuth).not.toHaveBeenCalled();
  });

  it('turns the Gantt completion badges off (on by default, with what stays)', async () => {
    await renderPanel();
    const badges = screen.getByRole('switch', { name: 'Show completion badges in the Gantt' });
    expect(badges).toBeChecked();
    expect(
      screen.getByText('Off hides the % badges on project, phase and subphase rows; the bar fill and the progress slider stay.')
    ).toBeInTheDocument();

    fireEvent.click(badges);
    save();

    await screen.findByText('Settings saved');
    expect(api.updateSetting.mock.calls).toEqual([['gantt_completion_badges', 'false']]);
    expect(useAppStore.getState().instanceSettings?.gantt_completion_badges).toBe('false');
  });

  it('treats the same set ticked in another order as unchanged', async () => {
    api.getInstanceSettings.mockResolvedValue({ ...STORED, staff_panel_default_skills: '[2,1]' });
    const onDirtyChange = await renderPanel();

    fireEvent.click(within(skillsGroup()).getByRole('checkbox', { name: 'Chromatography' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(within(skillsGroup()).getByRole('checkbox', { name: 'Chromatography' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });

  it('re-reads /auth/me after a Kanban change, so the saver loses the board at once', async () => {
    const withoutBoard = makeUser({ id: 1, role: 'admin', permissions: ['projects.view', 'settings.general'] });
    api.checkAuth.mockResolvedValue({ user: withoutBoard });
    await renderPanel();

    fireEvent.click(screen.getByRole('switch', { name: 'Kanban board' }));
    save();

    await waitFor(() => expect(api.checkAuth).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useAppStore.getState().currentUser).toEqual(withoutBoard));
    expect(api.updateSetting).toHaveBeenCalledWith('kanban_enabled', 'false');
  });

  it('keeps the signed-in user when /auth/me cannot be read', async () => {
    const before = useAppStore.getState().currentUser;
    await renderPanel();
    fireEvent.click(screen.getByRole('switch', { name: 'Kanban board' }));
    save();
    await waitFor(() => expect(api.checkAuth).toHaveBeenCalledTimes(1));
    await screen.findByText('Settings saved');
    expect(useAppStore.getState().currentUser).toBe(before);
  });

  it('reports unsaved input to the hub, and clears it on Reset and after saving', async () => {
    const onDirtyChange = await renderPanel();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.change(screen.getByLabelText('Open the Gantt with'), { target: { value: 'none' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByLabelText('Open the Gantt with')).toHaveValue('staff');

    fireEvent.click(screen.getByRole('switch', { name: 'Bank-holiday import (Nager)' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    save();
    await screen.findByText('Settings saved');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('shows a refused value in a Notice and keeps the failed and later keys unsaved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.updateSetting.mockImplementation(async (key: string, value: string) => {
      if (key === 'kanban_enabled') throw new Error('Invalid value for kanban_enabled');
      return { key, value };
    });
    const onDirtyChange = await renderPanel();

    fireEvent.change(screen.getByLabelText('Open the Gantt with'), { target: { value: 'none' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Kanban board' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Bank-holiday import (Nager)' }));
    save();

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid value for kanban_enabled');
    expect(api.updateSetting.mock.calls.map(([key]) => key)).toEqual(['gantt_default_panel', 'kanban_enabled']);
    // The panel choice reached the server; the switches did not
    expect(useAppStore.getState().instanceSettings?.gantt_default_panel).toBe('none');
    expect(useAppStore.getState().instanceSettings?.kanban_enabled).toBe('true');
    expect(api.checkAuth).not.toHaveBeenCalled();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    api.updateSetting.mockClear().mockImplementation(async (key: string, value: string) => ({ key, value }));
    save();
    await screen.findByText('Settings saved');
    expect(api.updateSetting.mock.calls).toEqual([
      ['kanban_enabled', 'false'],
      ['nager_enabled', 'false'],
    ]);
  });

  it('clears a save error as soon as a control changes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.updateSetting.mockRejectedValue(new Error('Invalid value for nager_enabled'));
    await renderPanel();
    fireEvent.click(screen.getByRole('switch', { name: 'Bank-holiday import (Nager)' }));
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid value for nager_enabled');

    fireEvent.click(screen.getByRole('switch', { name: 'Kanban board' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('drops a stale row once it is unticked and saved', async () => {
    await renderPanel();
    fireEvent.click(within(skillsGroup()).getByRole('checkbox', { name: 'Skill #9 (no longer exists)' }));
    fireEvent.click(within(typesGroup()).getByRole('checkbox', { name: 'Old type (no longer exists)' }));
    // Still listed while unsaved, so it can be ticked again
    expect(within(skillsGroup()).getByRole('checkbox', { name: 'Skill #9 (no longer exists)' })).not.toBeChecked();
    save();

    await screen.findByText('Settings saved');
    expect(api.updateSetting.mock.calls).toEqual([
      ['staff_panel_default_skills', '[2]'],
      ['equipment_panel_default_types', '["HPLC"]'],
    ]);
    expect(within(skillsGroup()).queryByRole('checkbox', { name: /no longer exists/ })).not.toBeInTheDocument();
    expect(within(typesGroup()).queryByRole('checkbox', { name: /no longer exists/ })).not.toBeInTheDocument();
  });

  it('saves once when Save is clicked twice before the first save settles', async () => {
    let finish: (value: unknown) => void = () => {};
    api.updateSetting.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await renderPanel();
    fireEvent.click(screen.getByRole('switch', { name: 'Bank-holiday import (Nager)' }));

    const button = screen.getByRole('button', { name: 'Save Changes' });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(button).toHaveAttribute('aria-busy', 'true');
    await act(async () => finish({}));
    expect(api.updateSetting).toHaveBeenCalledTimes(1);
  });

  it('shows an empty text without skills or equipment types', async () => {
    useAppStore.setState({ skills: [] });
    api.getInstanceSettings.mockResolvedValue({ ...STORED, staff_panel_default_skills: '[]', equipment_panel_default_types: '[]' });
    api.getEquipmentTypes.mockResolvedValue([]);
    await renderPanel();
    expect(screen.getByText('No skills yet. Add them in Skills.')).toBeInTheDocument();
    expect(screen.getByText('No equipment types yet.')).toBeInTheDocument();
  });

  it('shows a load failure in a Notice', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.getEquipmentTypes.mockRejectedValue(new Error('down'));
    render(<DefaultsPanel onDirtyChange={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load settings');
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
  });
});
