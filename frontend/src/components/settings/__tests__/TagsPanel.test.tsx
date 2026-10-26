/**
 * Settings › Tags: one flat list in tag order (tag groups became dropdown
 * project fields in 2.0.0); every write reloads the list into the store;
 * server conflicts (409) are shown inline; deletes ask first; drag reorders.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { TagsPanel } from '../panels/TagsPanel';
import { useAppStore } from '@/stores/appStore';
import { stubConfirm } from '@/test/confirmDialog';
import type { Site, Tag } from '@/types';
import { makeTeam } from '@/test/factories';

const api = vi.hoisted(() => ({
  tagsApi: {
    getAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    reorder: vi.fn(),
  },
}));
vi.mock('@/api', () => api);
const { tagsApi } = api;

const SITES: Site[] = [
  { id: 1, name: 'Basel' } as Site,
  { id: 2, name: 'Zurich' } as Site,
];

const TAGS: Tag[] = [
  // Deliberately out of order: the panel sorts by sort_order
  { id: 3, name: 'Pharma', color: '#3b82f6', all_sites: false, site_ids: [2], sort_order: 2 },
  { id: 1, name: 'Active', color: '#10b981', all_sites: true, site_ids: [], sort_order: 0 },
  { id: 2, name: 'On hold', color: '#f59e0b', all_sites: true, site_ids: [], sort_order: 1 },
  { id: 4, name: 'Internal', color: '#8b5cf6', all_sites: true, site_ids: [], sort_order: 3 },
];

beforeEach(() => {
  for (const fn of Object.values(tagsApi)) fn.mockReset();
  tagsApi.getAll.mockResolvedValue(TAGS);
  useAppStore.setState({ sites: SITES, tags: [], teams: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function rowIds(): (string | undefined)[] {
  return screen.getAllByTestId(/^tag-/).map((row) => row.dataset.testid);
}

/** Drag `from` onto the lower half of `to` (jsdom rects are all zero: clientY 1 is "after") */
function dragOnto(from: HTMLElement, to: HTMLElement, clientY = 1) {
  const dataTransfer = { effectAllowed: '', setData: vi.fn() };
  fireEvent.dragStart(from, { dataTransfer });
  fireEvent.dragOver(to, { clientY, dataTransfer });
  fireEvent.drop(to, { dataTransfer });
}

describe('TagsPanel', () => {
  it('lists every tag in one list in tag order, with its sites, and fills the store', async () => {
    render(<TagsPanel />);
    await screen.findByText('Pharma');

    expect(rowIds()).toEqual(['tag-1', 'tag-2', 'tag-3', 'tag-4']);
    expect(within(screen.getByTestId('tag-3')).getByText('Zurich')).toBeInTheDocument();
    // No groups left: no group block, no group select, no section headings
    expect(screen.queryByText('Groups')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('New tag group')).not.toBeInTheDocument();
    expect(useAppStore.getState().tags).toEqual(TAGS);
  });

  it('shows the conflict and reloads the list after a failed tag update', async () => {
    const message = '1 project at another site uses this tag';
    tagsApi.update.mockRejectedValue(new Error(message));
    render(<TagsPanel />);
    await screen.findByText('Pharma');
    expect(tagsApi.getAll).toHaveBeenCalledTimes(1);

    // The server state after the failure: the store is reset to it.
    const reloaded = TAGS.map((t) => (t.id === 4 ? { ...t, name: 'Internal (server)' } : t));
    tagsApi.getAll.mockResolvedValue(reloaded);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Internal' }));
    fireEvent.click(within(screen.getByTestId('tag-4')).getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    await waitFor(() => expect(tagsApi.getAll).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useAppStore.getState().tags).toEqual(reloaded));
  });

  it('shows the error and reloads the list after a failed tag delete', async () => {
    tagsApi.delete.mockRejectedValue(new Error('Tag not found'));
    stubConfirm(true);
    render(<TagsPanel />);
    await screen.findByText('Pharma');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Pharma' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tag not found');
    await waitFor(() => expect(tagsApi.getAll).toHaveBeenCalledTimes(2));
  });

  it('shows the load error', async () => {
    tagsApi.getAll.mockRejectedValue(new Error('Server down'));
    render(<TagsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Server down');
  });

  it('asks before deleting a tag, and deletes only when confirmed', async () => {
    tagsApi.delete.mockResolvedValue(undefined);
    const confirm = stubConfirm(false);
    render(<TagsPanel />);
    await screen.findByText('Pharma');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete Pharma' }));
    });
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: 'Delete the tag "Pharma"? The tag is removed from every project.',
        destructive: true,
      })
    );
    expect(tagsApi.delete).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Pharma' }));
    await waitFor(() => expect(tagsApi.delete).toHaveBeenCalledWith(3));
  });

  it('reorders by drag and drop: shown at once, then persisted as the full order', async () => {
    tagsApi.reorder.mockResolvedValue({ success: true });
    render(<TagsPanel />);
    await screen.findByText('Pharma');

    // Hovering a row then leaving it clears the drop marker
    const dataTransfer = { effectAllowed: '' };
    fireEvent.dragStart(screen.getByTestId('tag-1'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('tag-2'), { clientY: 1, dataTransfer });
    expect(screen.getByTestId('tag-2').className).toMatch(/dropAfter/);
    fireEvent.dragLeave(screen.getByTestId('tag-2'));
    expect(screen.getByTestId('tag-2').className).not.toMatch(/dropAfter/);
    fireEvent.dragEnd(screen.getByTestId('tag-1'));

    dragOnto(screen.getByTestId('tag-1'), screen.getByTestId('tag-3'));
    await waitFor(() => expect(tagsApi.reorder).toHaveBeenCalledWith([2, 3, 1, 4]));
  });

  it('edits a tag\'s sites and reports the unsaved edit to the hub', async () => {
    tagsApi.update.mockResolvedValue({});
    const onDirtyChange = vi.fn();
    render(<TagsPanel onDirtyChange={onDirtyChange} />);
    await screen.findByText('Pharma');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Internal' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    const row = screen.getByTestId('tag-4');
    fireEvent.click(within(row).getByRole('switch', { name: 'All sites' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    // No site picked yet: can't save a tag that applies nowhere
    expect(within(row).getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.click(within(row).getByRole('checkbox', { name: 'Basel' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(tagsApi.update).toHaveBeenCalledWith(4, {
        name: 'Internal',
        color: '#8b5cf6',
        all_sites: false,
        site_ids: [1],
        team_ids: [],
      })
    );
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  describe('team scope', () => {
    const TEAMS = [
      makeTeam({ id: 1, site_id: 1, name: 'Analytics' }),
      makeTeam({ id: 2, site_id: 1, name: 'Process' }),
      makeTeam({ id: 3, site_id: 2, name: 'Zurich lab' }),
    ];
    beforeEach(() => useAppStore.setState({ teams: TEAMS }));

    it('sends team_ids when the tag is limited to teams', async () => {
      tagsApi.update.mockResolvedValue({});
      const onDirtyChange = vi.fn();
      render(<TagsPanel onDirtyChange={onDirtyChange} />);
      await screen.findByText('Internal');
      fireEvent.click(screen.getByRole('button', { name: 'Edit Internal' }));

      const row = screen.getByTestId('tag-4');
      // All sites in scope: one switch per site with teams
      expect(within(row).getByRole('switch', { name: 'Whole site — Zurich' })).toBeChecked();
      fireEvent.click(within(row).getByRole('switch', { name: 'Whole site — Basel' }));
      fireEvent.click(within(row).getByRole('checkbox', { name: 'Analytics' }));
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(tagsApi.update).toHaveBeenCalledWith(4, expect.objectContaining({ all_sites: true, team_ids: [1] }))
      );
    });

    it('whole site sends []', async () => {
      tagsApi.update.mockResolvedValue({});
      tagsApi.getAll.mockResolvedValue(TAGS.map((t) => (t.id === 4 ? { ...t, team_ids: [1, 3] } : t)));
      render(<TagsPanel />);
      await screen.findByText('Internal');
      fireEvent.click(screen.getByRole('button', { name: 'Edit Internal' }));

      const row = screen.getByTestId('tag-4');
      expect(within(row).getByRole('checkbox', { name: 'Analytics' })).toBeChecked();
      fireEvent.click(within(row).getByRole('switch', { name: 'Whole site — Basel' }));
      fireEvent.click(within(row).getByRole('switch', { name: 'Whole site — Zurich' }));
      fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(tagsApi.update).toHaveBeenCalledWith(4, expect.objectContaining({ team_ids: [] }))
      );
    });

    it('shows the team limit in the row', async () => {
      tagsApi.getAll.mockResolvedValue(TAGS.map((t) => (t.id === 4 ? { ...t, team_ids: [1, 3] } : t)));
      render(<TagsPanel />);
      const row = await screen.findByTestId('tag-4');
      expect(within(row).getByText('All sites · limited to 2 teams')).toBeInTheDocument();
      expect(within(screen.getByTestId('tag-1')).getByText('All sites')).toBeInTheDocument();
    });
  });

  it('renames inline: Enter saves, Escape cancels without bubbling to the hub', async () => {
    tagsApi.update.mockResolvedValue({});
    const onKeyDown = vi.fn();
    render(
      <div onKeyDown={onKeyDown}>
        <TagsPanel />
      </div>
    );
    await screen.findByText('Pharma');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Active' }));
    const input = screen.getByLabelText('Tag name');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Tag name')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Active' }));
    fireEvent.change(screen.getByLabelText('Tag name'), { target: { value: 'Running' } });
    fireEvent.keyDown(screen.getByLabelText('Tag name'), { key: 'Enter' });
    await waitFor(() =>
      expect(tagsApi.update).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'Running' }))
    );
  });

  it('adds one tag when the add form is submitted twice', async () => {
    let finish!: () => void;
    tagsApi.create.mockReturnValue(new Promise<void>((r) => (finish = r)));
    render(<TagsPanel />);
    await screen.findByText('Pharma');

    const input = screen.getByLabelText('New tag name');
    fireEvent.change(input, { target: { value: 'Priority' } });
    const form = input.closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(tagsApi.create).toHaveBeenCalledTimes(1);
    expect(tagsApi.create).toHaveBeenCalledWith({ name: 'Priority', color: expect.any(String), all_sites: true });
    finish();
    await waitFor(() => expect(tagsApi.getAll).toHaveBeenCalledTimes(2));
  });
});
