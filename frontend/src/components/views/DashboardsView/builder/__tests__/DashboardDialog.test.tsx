/**
 * DashboardDialog: New hands the values back without a request; Share…
 * saves the name, description, visibility and roles without a `widgets` key;
 * the name and (for *Shared with roles*) a role are required, the server's
 * refusal shows in a Notice, and one save runs at a time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '@/api/client';
import { dashboardsApi } from '@/api/endpoints/dashboards';
import { useAppStore } from '@/stores/appStore';
import { resetAllStores } from '@/stores';
import { makeRole, makeSystemRoles } from '@/test/factories';
import type { Dashboard } from '@/types';
import { DashboardDialog, NAME_REQUIRED, ROLES_REQUIRED } from '../DashboardDialog';
import type { DashboardMeta } from '../widgetDraft';

vi.mock('@/api/endpoints/dashboards', () => ({
  dashboardsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    query: vi.fn(),
    data: vi.fn(),
  },
}));

const api = vi.mocked(dashboardsApi);

const ROLES = makeSystemRoles(makeRole({ id: 4, key: 'team_lead', name: 'Team Lead', sort_order: 3 }));

const saved: Dashboard = {
  id: 7,
  name: 'Plan',
  description: null,
  visibility: 'everyone',
  role_ids: [],
  owner_id: 1,
  owner_name: 'Ada',
  is_default: false,
  widget_count: 2,
  can_edit: true,
  updated_at: '2026-10-23T10:00:00.000Z',
  widgets: [],
};

const EMPTY: DashboardMeta = { name: '', description: null, visibility: 'private', role_ids: [] };

function renderDialog(props: Partial<Parameters<typeof DashboardDialog>[0]> = {}) {
  const onDone = vi.fn();
  const onClose = vi.fn();
  render(<DashboardDialog mode="new" initial={EMPTY} onClose={onClose} onDone={onDone} {...props} />);
  return { onDone, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAllStores();
  useAppStore.setState({ roles: ROLES });
  api.list.mockResolvedValue([]);
  api.data.mockResolvedValue({ widgets: {}, loaded_at: '2026-10-23T10:00:00.000Z' });
  api.update.mockResolvedValue(saved);
});

describe('DashboardDialog', () => {
  it('hands the values of a new dashboard back, without a request', () => {
    const { onDone } = renderDialog();
    expect(screen.getByRole('dialog', { name: 'New dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Roles that see this dashboard' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: '  Capacity  ' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: ' Per team ' } });
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'everyone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create dashboard' }));
    expect(onDone).toHaveBeenCalledWith({
      name: 'Capacity',
      description: 'Per team',
      visibility: 'everyone',
      role_ids: [],
    });
    expect(api.create).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
  });

  it('requires a name', () => {
    const { onDone } = renderDialog();
    fireEvent.submit(screen.getByLabelText('Name *').closest('form')!);
    expect(screen.getByText(NAME_REQUIRED)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'A' } });
    expect(screen.queryByText(NAME_REQUIRED)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Name *')).toHaveAttribute('maxLength', '100');
  });

  it('requires a role when shared with roles, the administrators always included', () => {
    const { onDone } = renderDialog({ initial: { ...EMPTY, name: 'Leads' } });
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'roles' } });
    const group = screen.getByRole('group', { name: 'Roles that see this dashboard' });
    expect(within(group).getByRole('checkbox', { name: /Admin/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Create dashboard' }));
    expect(screen.getByRole('alert')).toHaveTextContent(ROLES_REQUIRED);
    expect(ROLES_REQUIRED).toBe('Choose at least one role');
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Team Lead' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create dashboard' }));
    expect(onDone).toHaveBeenCalledWith({ name: 'Leads', description: null, visibility: 'roles', role_ids: [4] });
  });

  it('shares a dashboard with a PUT that leaves its widgets alone', async () => {
    const { onDone } = renderDialog({
      mode: 'share',
      dashboardId: 7,
      initial: { name: 'Plan', description: 'Old', visibility: 'roles', role_ids: [2] },
    });
    expect(screen.getByRole('dialog', { name: 'Share dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Superuser' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Team Lead' }));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });
    expect(api.update).toHaveBeenCalledWith(7, {
      name: 'Plan',
      description: null,
      visibility: 'roles',
      role_ids: [2, 4],
    });
    expect(api.update.mock.calls[0][1]).not.toHaveProperty('widgets');
    expect(onDone).toHaveBeenCalled();
  });

  it('drops the roles of a dashboard no longer shared with roles', async () => {
    renderDialog({ mode: 'share', dashboardId: 7, initial: { name: 'Plan', description: null, visibility: 'roles', role_ids: [2] } });
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'private' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });
    expect(api.update).toHaveBeenCalledWith(7, { name: 'Plan', description: null, visibility: 'private', role_ids: [] });
  });

  it('shows the server’s refusal and stays open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.update.mockRejectedValueOnce(new ApiError('Choose at least one role', 400));
    const { onDone } = renderDialog({
      mode: 'share',
      dashboardId: 7,
      initial: { name: 'Plan', description: null, visibility: 'roles', role_ids: [9] },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one role');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('saves once on a double click', async () => {
    let release!: (d: Dashboard) => void;
    api.update.mockReturnValueOnce(new Promise<Dashboard>((r) => (release = r)));
    renderDialog({ mode: 'share', dashboardId: 7, initial: { ...EMPTY, name: 'Plan', visibility: 'everyone' } });
    const save = screen.getByRole('button', { name: 'Save Changes' });
    await act(async () => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(save).toHaveAttribute('aria-busy', 'true');
    await act(async () => release(saved));
    await waitFor(() => expect(save).not.toHaveAttribute('aria-busy'));
  });

  it('closes on Cancel', () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
