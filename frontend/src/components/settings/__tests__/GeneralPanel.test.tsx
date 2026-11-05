/**
 * Settings › General: superusers get the per-browser theme picker only (the
 * backend only lets admins save instance settings), admins get everything plus
 * Save and the unsaved-changes report to the hub. Data management opens the
 * audit log as a sub-view for system.audit_log holders.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { GeneralPanel } from '../panels/GeneralPanel';
import styles from '../panels/GeneralPanel.module.css';
import { useAppStore } from '@/stores/appStore';
import type { User, UserRole } from '@/types';
import { asSignedIn } from '@/test/permissionFixtures';
import { makeUser } from '@/test/factories';

const getSetting = vi.fn();
const updateSetting = vi.fn();
vi.mock('@/api/endpoints/settings', () => ({
  getSetting: (...args: unknown[]) => getSetting(...args),
  updateSetting: (...args: unknown[]) => updateSetting(...args),
}));
// The log talks to /audit-log; the sub-view only needs something to show.
vi.mock('../panels/audit-log/AuditLogPanel', () => ({
  AuditLogPanel: () => <div>Audit log panel</div>,
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

  describe('Default View and Week Starts On toggles', () => {
    it('marks the selected option and moves the mark on click', async () => {
      setRole('admin');
      render(<GeneralPanel onDirtyChange={vi.fn()} />);
      await screen.findByLabelText('Application Title');

      expect(screen.getByRole('button', { name: 'Month' })).toHaveClass(styles.selected);
      expect(screen.getByRole('button', { name: 'Year' })).not.toHaveClass(styles.selected);
      expect(screen.getByRole('button', { name: 'Monday' })).toHaveClass(styles.selected);

      fireEvent.click(screen.getByRole('button', { name: 'Year' }));
      fireEvent.click(screen.getByRole('button', { name: 'Sunday' }));
      expect(screen.getByRole('button', { name: 'Year' })).toHaveClass(styles.selected);
      expect(screen.getByRole('button', { name: 'Month' })).not.toHaveClass(styles.selected);
      expect(screen.getByRole('button', { name: 'Sunday' })).toHaveClass(styles.selected);
      expect(screen.getByRole('button', { name: 'Monday' })).not.toHaveClass(styles.selected);
    });

    it('fills the selected option with the accent and its on-accent text (readable in every theme)', () => {
      // jsdom cannot compute colours, so the rule itself is the contract: the
      // selected text was a fixed white on the pale --accent-blue-alpha tint,
      // near-invisible in the light themes.
      const css = readFileSync(join(__dirname, '..', 'panels', 'GeneralPanel.module.css'), 'utf8');
      const rule = /\.optionButton\.selected\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
      expect(rule).toMatch(/background:\s*var\(--accent-blue\);/);
      expect(rule).toMatch(/color:\s*var\(--text-on-accent\);/);
    });
  });

  describe('audit log retention (Data management)', () => {
    const field = () => screen.findByLabelText('Retention period (days)');
    const keepForever = () => screen.getByRole('switch', { name: 'Keep audit entries indefinitely' });
    const save = () => screen.getByRole('button', { name: 'Save Changes' });

    it('loads the stored value, with its limits and help', async () => {
      setRole('admin');
      getSetting.mockImplementation(async (key: string) =>
        key === 'audit_log_retention_days' ? { value: '90' } : { value: null }
      );
      render(<GeneralPanel onDirtyChange={vi.fn()} />);

      const input = await field();
      expect(getSetting).toHaveBeenCalledWith('audit_log_retention_days');
      expect(screen.getByRole('heading', { name: 'Data management' })).toBeInTheDocument();
      expect(screen.getByText('Audit log retention')).toBeInTheDocument();
      expect(input).toHaveValue(90);
      expect(input).toHaveAttribute('type', 'number');
      expect(input).toHaveAttribute('min', '0');
      expect(input).toHaveAttribute('max', '3650');
      expect(input).toHaveAttribute('step', '1');
      expect(screen.getByText('0 = keep indefinitely. Maximum 3650 days.')).toBeInTheDocument();
      expect(keepForever()).not.toBeChecked();
    });

    it('defaults to 365 days and saves a change with Save, updating the store', async () => {
      setRole('admin');
      useAppStore.setState({ instanceSettings: { audit_log_retention_days: '365' } });
      const onDirtyChange = vi.fn();
      render(<GeneralPanel onDirtyChange={onDirtyChange} />);

      const input = await field();
      expect(input).toHaveValue(365);
      fireEvent.change(input, { target: { value: '30' } });
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      expect(updateSetting).not.toHaveBeenCalled();

      fireEvent.click(save());
      expect(await screen.findByText('Settings saved successfully')).toBeInTheDocument();
      expect(updateSetting).toHaveBeenCalledTimes(1);
      expect(updateSetting).toHaveBeenCalledWith('audit_log_retention_days', '30');
      expect(useAppStore.getState().instanceSettings?.audit_log_retention_days).toBe('30');
    });

    it('turns the switch on for 0 and off back to 365', async () => {
      setRole('admin');
      render(<GeneralPanel onDirtyChange={vi.fn()} />);
      const input = await field();

      fireEvent.click(keepForever());
      expect(input).toHaveValue(0);
      expect(keepForever()).toBeChecked();

      fireEvent.click(keepForever());
      expect(input).toHaveValue(365);
      expect(keepForever()).not.toBeChecked();

      fireEvent.change(input, { target: { value: '0' } });
      expect(keepForever()).toBeChecked();

      fireEvent.click(save());
      expect(await screen.findByText('Settings saved successfully')).toBeInTheDocument();
      expect(updateSetting).toHaveBeenCalledWith('audit_log_retention_days', '0');
    });

    it('refuses 3651 and an empty value: an error, and Save stays disabled', async () => {
      setRole('admin');
      render(<GeneralPanel onDirtyChange={vi.fn()} />);
      const input = await field();

      fireEvent.change(input, { target: { value: '3651' } });
      expect(screen.getByText('Enter a whole number of days from 0 to 3650.')).toBeInTheDocument();
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(keepForever()).not.toBeChecked();
      expect(save()).toBeDisabled();
      fireEvent.click(save());
      expect(updateSetting).not.toHaveBeenCalled();

      fireEvent.change(input, { target: { value: '' } });
      expect(save()).toBeDisabled();

      fireEvent.change(input, { target: { value: '3650' } });
      expect(screen.queryByText('Enter a whole number of days from 0 to 3650.')).not.toBeInTheDocument();
      expect(save()).toBeEnabled();
    });
  });

  describe('audit log row and sub-view (Data management)', () => {
    const openButton = () => screen.queryByRole('button', { name: 'Open audit log' });
    const back = () => screen.getByRole('button', { name: 'Back to General' });

    function setPermissions(permissions: string[]) {
      useAppStore.setState({ currentUser: makeUser({ role: 'x', permissions }) });
    }

    beforeEach(() => {
      useAppStore.setState({ instanceSettings: { audit_log_retention_days: '365' } });
    });

    it('shows the row only with system.audit_log', async () => {
      setPermissions(['settings.general']);
      const { unmount } = render(<GeneralPanel onDirtyChange={vi.fn()} />);
      await screen.findByLabelText('Retention period (days)');
      expect(openButton()).not.toBeInTheDocument();
      unmount();

      setRole('superuser');
      const { unmount: unmountSuperuser } = render(<GeneralPanel onDirtyChange={vi.fn()} />);
      expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
      expect(openButton()).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Data management' })).not.toBeInTheDocument();
      unmountSuperuser();

      setRole('admin');
      render(<GeneralPanel onDirtyChange={vi.fn()} />);
      await screen.findByLabelText('Retention period (days)');
      expect(openButton()).toBeInTheDocument();
      expect(screen.getByText('Audit log')).toBeInTheDocument();
      expect(screen.getByText('Who signed in, what changed and who exported what.')).toBeInTheDocument();
      expect(screen.getByText('Kept 365 days')).toBeInTheDocument();
    });

    it('reads the retention from the live setting: indefinitely for 0, 365 for a malformed value', async () => {
      setRole('admin');
      useAppStore.setState({ instanceSettings: { audit_log_retention_days: '0' } });
      render(<GeneralPanel onDirtyChange={vi.fn()} />);
      await screen.findByLabelText('Retention period (days)');
      expect(screen.getByText('Kept indefinitely')).toBeInTheDocument();

      act(() => useAppStore.setState({ instanceSettings: { audit_log_retention_days: '90' } }));
      expect(screen.getByText('Kept 90 days')).toBeInTheDocument();

      act(() => useAppStore.setState({ instanceSettings: { audit_log_retention_days: 'soon' } }));
      expect(screen.getByText('Kept 365 days')).toBeInTheDocument();
    });

    it('opens the log in place of the form, and Back returns to it', async () => {
      setRole('admin');
      render(<GeneralPanel onDirtyChange={vi.fn()} />);
      await screen.findByLabelText('Application Title');

      fireEvent.click(openButton()!);
      expect(await screen.findByText('Audit log panel')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Audit log' })).toBeInTheDocument();
      // The form stays mounted, hidden
      expect(screen.getByLabelText('Application Title')).not.toBeVisible();
      expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
      expect(back()).toHaveFocus();

      fireEvent.click(back());
      expect(screen.queryByText('Audit log panel')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Application Title')).toBeVisible();
      expect(openButton()).toHaveFocus();
    });

    it('starts on the form again when remounted (the hub closed and reopened)', async () => {
      setRole('admin');
      const { unmount } = render(<GeneralPanel onDirtyChange={vi.fn()} />);
      await screen.findByLabelText('Application Title');
      fireEvent.click(openButton()!);
      expect(await screen.findByText('Audit log panel')).toBeInTheDocument();
      unmount();

      render(<GeneralPanel onDirtyChange={vi.fn()} />);
      expect(await screen.findByLabelText('Application Title')).toBeVisible();
      expect(screen.queryByText('Audit log panel')).not.toBeInTheDocument();
    });

    it('keeps unsaved edits (and the hub guard armed) while the log is open', async () => {
      setRole('admin');
      const onDirtyChange = vi.fn();
      render(<GeneralPanel onDirtyChange={onDirtyChange} />);
      const input = await screen.findByLabelText('Retention period (days)');
      fireEvent.change(input, { target: { value: '30' } });
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      const reportsBefore = onDirtyChange.mock.calls.length;

      fireEvent.click(openButton()!);
      expect(await screen.findByText('Audit log panel')).toBeInTheDocument();
      // No "clean" report: the hub still asks before switching section or closing
      expect(onDirtyChange.mock.calls.slice(reportsBefore)).not.toContainEqual([false]);
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);

      fireEvent.click(back());
      expect(screen.getByLabelText('Retention period (days)')).toHaveValue(30);
      expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
    });

    it('scrolls the hub pane back to the top when the log opens', async () => {
      setRole('admin');
      const pane = document.createElement('div');
      document.body.appendChild(pane);
      Object.defineProperty(pane, 'scrollTop', { value: 640, writable: true });
      render(<GeneralPanel onDirtyChange={vi.fn()} />, { container: pane });
      await screen.findByLabelText('Application Title');

      fireEvent.click(openButton()!);
      expect(await screen.findByText('Audit log panel')).toBeInTheDocument();
      expect(pane.scrollTop).toBe(0);
      pane.remove();
    });

    it('gives a system.audit_log holder without settings.general the row under the appearance picker', async () => {
      setPermissions(['system.audit_log']);
      render(<GeneralPanel onDirtyChange={vi.fn()} />);

      expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Data management' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Retention period (days)')).not.toBeInTheDocument();
      expect(getSetting).not.toHaveBeenCalled();

      fireEvent.click(openButton()!);
      expect(await screen.findByText('Audit log panel')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Appearance' })).not.toBeInTheDocument();
      fireEvent.click(back());
      expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    });
  });
});
