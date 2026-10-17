/**
 * Settings › Skills.
 *
 * - The form submits on Enter: a second Enter while the first create is still
 *   in flight must not send a second POST (duplicate skill).
 * - Typed input is reported to the Settings hub, which then asks before
 *   closing (Escape) instead of silently discarding it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { SkillsPanel } from '../panels/SkillsPanel';
import { SettingsHub } from '../SettingsHub';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import type { Skill, User } from '@/types';

const getAll = vi.fn();
const create = vi.fn();
vi.mock('@/api/endpoints/skills', () => ({
  skillsApi: {
    getAll: (...args: unknown[]) => getAll(...args),
    create: (...args: unknown[]) => create(...args),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

const skills: Skill[] = [{ id: 1, name: 'HPLC', color: '#3b82f6' } as Skill];

const admin: User = {
  id: 1,
  email: 'admin@demo.local',
  first_name: 'Ada',
  last_name: 'Admin',
  name: 'Ada Admin',
  role: 'admin',
  active: true,
  site_ids: [1],
};

/** A promise the test settles by hand, to keep a request "in flight" */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  getAll.mockReset().mockResolvedValue(skills);
  create.mockReset();
  useAppStore.setState({ currentUser: admin, skills: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => useUIStore.getState().closeModal());
});

async function openAddForm() {
  fireEvent.click(await screen.findByRole('button', { name: /Add Skill/ }));
  fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'GC-MS' } });
}

describe('SkillsPanel', () => {
  it('sends one create when the form is submitted twice before the first returns', async () => {
    const pending = deferred<Skill>();
    create.mockReturnValue(pending.promise);
    render(<SkillsPanel />);
    await openAddForm();
    const description = screen.getByLabelText('Description');
    fireEvent.change(description, { target: { value: 'Gas chromatography' } });
    expect(description).toHaveValue('Gas chromatography');

    const form = screen.getByLabelText('Name *').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'GC-MS', description: 'Gas chromatography' }));
    expect(screen.getByRole('button', { name: 'Create Skill' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create Skill' })).toHaveAttribute('aria-busy', 'true');

    await act(async () => pending.resolve({ id: 2, name: 'GC-MS', color: '#3b82f6' } as Skill));
    await waitFor(() => expect(screen.queryByLabelText('Name *')).not.toBeInTheDocument());
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('reports typed input as unsaved, and clears it when the form closes', async () => {
    const onDirtyChange = vi.fn();
    render(<SkillsPanel onDirtyChange={onDirtyChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /Add Skill/ }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'GC-MS' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('makes the Settings hub ask before Escape discards a half-filled skill', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    act(() => useUIStore.getState().openSettings('skills'));
    render(<SettingsHub />);
    await openAddForm();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(confirm).toHaveBeenCalledWith('You have unsaved changes. Are you sure you want to close?');
    expect(useUIStore.getState().activeModal).toBe('settingsHub');
    expect(screen.getByLabelText('Name *')).toHaveValue('GC-MS');

    confirm.mockReturnValue(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it('names every row action after its skill and picks the colour with the shared swatch picker', async () => {
    render(<SkillsPanel />);
    const edit = await screen.findByRole('button', { name: 'Edit HPLC' });
    expect(edit.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: 'Delete HPLC' })).toBeInTheDocument();

    fireEvent.click(edit);
    // One ColorSwatchPicker (round 28 px swatches, 40 px on touch) — not a
    // hand-rolled swatch row, which is how the Skills picker stretched on iPad.
    const picker = screen.getByRole('radiogroup', { name: 'Skill colour' });
    expect(within(picker).getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(picker).getByRole('radio', { name: 'Green' }));
    expect(within(picker).getByRole('radio', { name: 'Green' })).toHaveAttribute('aria-checked', 'true');
    expect(within(picker).getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'false');
    expect(within(picker).getByLabelText('Custom color')).toBeInTheDocument();
  });

  it('closes the hub without asking when nothing was typed', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    act(() => useUIStore.getState().openSettings('skills'));
    render(<SettingsHub />);
    fireEvent.click(await screen.findByRole('button', { name: /Add Skill/ }));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(confirm).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeModal).toBeNull();
  });
});
