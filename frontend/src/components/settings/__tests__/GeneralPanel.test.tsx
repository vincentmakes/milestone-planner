/**
 * Settings › General: superusers get the per-browser theme picker only (the
 * backend only lets admins save instance settings), admins get everything plus
 * Save and the unsaved-changes report to the hub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { GeneralPanel } from '../panels/GeneralPanel';
import { useAppStore } from '@/stores/appStore';
import type { User, UserRole } from '@/types';
import { asSignedIn } from '@/test/permissionFixtures';

const getSetting = vi.fn();
const updateSetting = vi.fn();
vi.mock('@/api/endpoints/settings', () => ({
  getSetting: (...args: unknown[]) => getSetting(...args),
  updateSetting: (...args: unknown[]) => updateSetting(...args),
}));

function setRole(role: UserRole) {
  const user: User = {
    id: 1,
    email: 'someone@example.com',
    first_name: 'Some',
    last_name: 'One',
    name: 'Some One',
    role,
    active: true,
    is_resource: role !== 'admin',
    site_ids: [1],
  };
  useAppStore.setState({ currentUser: asSignedIn(user) });
}

describe('GeneralPanel', () => {
  beforeEach(() => {
    getSetting.mockReset().mockResolvedValue({ value: null });
    updateSetting.mockReset().mockResolvedValue({});
  });

  it('shows superusers the appearance picker only, without Save', () => {
    setRole('superuser');
    const onDirtyChange = vi.fn();
    render(<GeneralPanel onDirtyChange={onDirtyChange} />);

    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Application Title')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Branding' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    expect(getSetting).not.toHaveBeenCalled();
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  it('shows admins the instance settings, reports unsaved changes and saves them', async () => {
    setRole('admin');
    const onDirtyChange = vi.fn();
    render(<GeneralPanel onDirtyChange={onDirtyChange} />);

    const title = await screen.findByLabelText('Application Title');
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Branding' })).toBeInTheDocument();

    fireEvent.change(title, { target: { value: 'Lab Planner' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('Settings saved successfully')).toBeInTheDocument();
    expect(updateSetting).toHaveBeenCalledWith('instance_title', 'Lab Planner');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });


  it('saves once when Save is clicked twice before the first save settles', async () => {
    setRole('admin');
    let finish: (value: unknown) => void = () => {};
    updateSetting.mockImplementation(() => new Promise((r) => { finish = r; }));
    render(<GeneralPanel onDirtyChange={vi.fn()} />);
    const title = await screen.findByLabelText('Application Title');
    fireEvent.change(title, { target: { value: 'Lab Planner' } });

    // Both clicks in one act(): React batches the first click's state update,
    // so the button is still enabled when the second click lands.
    const save = screen.getByRole('button', { name: 'Save Changes' });
    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    expect(updateSetting).toHaveBeenCalledTimes(1);
    expect(save).toHaveAttribute('aria-busy', 'true');

    await act(async () => finish({}));
    expect(await screen.findByText('Settings saved successfully')).toBeInTheDocument();
    expect(updateSetting).toHaveBeenCalledTimes(1);
  });
});
