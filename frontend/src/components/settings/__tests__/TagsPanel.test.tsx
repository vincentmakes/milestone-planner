/**
 * Settings › Tags: tags are listed per group (group order) with an "Other"
 * section for ungrouped ones; every write reloads both lists into the store;
 * there is no group-level colouring switch; server conflicts (409) are shown
 * inline; deletes ask first.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { TagsPanel } from '../panels/TagsPanel';
import { useAppStore } from '@/stores/appStore';
import type { Site, Tag, TagGroup } from '@/types';

const api = vi.hoisted(() => ({
  tagsApi: {
    getAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    reorder: vi.fn(),
  },
  tagGroupsApi: {
    getAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    reorder: vi.fn(),
  },
}));
vi.mock('@/api', () => api);
const { tagsApi, tagGroupsApi } = api;

const SITES: Site[] = [
  { id: 1, name: 'Basel' } as Site,
  { id: 2, name: 'Zurich' } as Site,
];

const GROUPS: TagGroup[] = [
  // Deliberately out of order: the panel sorts by sort_order
  { id: 20, name: 'Customer', single_select: false, sort_order: 1 },
  { id: 10, name: 'Status', single_select: true, sort_order: 0 },
];

const TAGS: Tag[] = [
  { id: 1, name: 'Active', color: '#10b981', group_id: 10, all_sites: true, site_ids: [], sort_order: 0 },
  { id: 2, name: 'On hold', color: '#f59e0b', group_id: 10, all_sites: true, site_ids: [], sort_order: 1 },
  { id: 3, name: 'Pharma', color: '#3b82f6', group_id: 20, all_sites: false, site_ids: [2], sort_order: 2 },
  { id: 4, name: 'Internal', color: '#8b5cf6', group_id: null, all_sites: true, site_ids: [], sort_order: 3 },
];

beforeEach(() => {
  for (const fn of [...Object.values(tagsApi), ...Object.values(tagGroupsApi)]) fn.mockReset();
  tagsApi.getAll.mockResolvedValue(TAGS);
  tagGroupsApi.getAll.mockResolvedValue(GROUPS);
  useAppStore.setState({ sites: SITES, tags: [], tagGroups: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function rowIds(section: HTMLElement): (string | undefined)[] {
  return within(section)
    .getAllByTestId(/^tag-/)
    .map((row) => row.dataset.testid);
}

describe('TagsPanel', () => {
  it('lists groups in order and tags per group, with ungrouped tags under "Other"', async () => {
    render(<TagsPanel />);
    await screen.findByText('Pharma');

    const groupRows = screen.getAllByTestId(/^group-/);
    expect(groupRows.map((r) => r.dataset.testid)).toEqual(['group-10', 'group-20']);

    const sections = screen.getAllByRole('group').filter((g) =>
      ['Status', 'Customer', 'Other'].includes(g.getAttribute('aria-label') ?? '')
    );
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual(['Status', 'Customer', 'Other']);
    expect(within(sections[0]).getByText('Active')).toBeInTheDocument();
    expect(within(sections[0]).getByText('On hold')).toBeInTheDocument();
    expect(within(sections[1]).getByText('Pharma')).toBeInTheDocument();
    expect(within(sections[1]).getByText('Zurich')).toBeInTheDocument();
    expect(within(sections[2]).getByText('Internal')).toBeInTheDocument();
    expect(rowIds(sections[0])).toEqual(['tag-1', 'tag-2']);

    // The store receives both lists
    expect(useAppStore.getState().tags).toEqual(TAGS);
    expect(useAppStore.getState().tagGroups.map((g) => g.id)).toEqual([10, 20]);
  });

  it('creates a group and reloads both lists', async () => {
    const created: TagGroup = { id: 30, name: 'Region', single_select: true, sort_order: 2 };
    tagGroupsApi.create.mockResolvedValue(created);
    render(<TagsPanel />);
    await screen.findByText('Pharma');
    expect(tagsApi.getAll).toHaveBeenCalledTimes(1);

    tagGroupsApi.getAll.mockResolvedValue([...GROUPS, created]);
    fireEvent.change(screen.getByLabelText('New group name'), { target: { value: '  Region ' } });
    const form = screen.getByLabelText('New group name').closest('form')!;
    fireEvent.click(within(form).getByRole('switch'));
    fireEvent.submit(form);

    await screen.findByTestId('group-30');
    expect(tagGroupsApi.create).toHaveBeenCalledTimes(1);
    expect(tagGroupsApi.create).toHaveBeenCalledWith({ name: 'Region', single_select: true });
    expect(tagsApi.getAll).toHaveBeenCalledTimes(2);
    expect(tagGroupsApi.getAll).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().tagGroups.map((g) => g.id)).toEqual([10, 20, 30]);
    expect(screen.getByLabelText('New group name')).toHaveValue('');
  });

  it('toggles single select alone and has no project-colouring switch', async () => {
    tagGroupsApi.update.mockResolvedValue({});
    render(<TagsPanel />);
    await screen.findByText('Pharma');

    // Colouring is a per-user Gantt choice ("Colour by"), not a group setting
    expect(screen.queryByRole('switch', { name: /^Colour projects/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Single select: Status' }));
    await waitFor(() =>
      expect(tagGroupsApi.update).toHaveBeenCalledWith(10, { single_select: false })
    );
  });

  it('shows a 409 conflict message from the server inline', async () => {
    const message = '3 projects hold several tags of this group; leave one per project first.';
    tagGroupsApi.update.mockRejectedValue(new Error(message));
    render(<TagsPanel />);
    await screen.findByText('Pharma');

    fireEvent.click(screen.getByRole('switch', { name: 'Single select: Customer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    // The lists are reloaded after the failed write
    await waitFor(() => expect(tagGroupsApi.getAll).toHaveBeenCalledTimes(2));
  });

  it('shows the conflict and reloads both lists after a failed tag update', async () => {
    const message = 'A project already holds a tag of the single-select group Status.';
    tagsApi.update.mockRejectedValue(new Error(message));
    render(<TagsPanel />);
    await screen.findByText('Pharma');
    expect(tagsApi.getAll).toHaveBeenCalledTimes(1);

    // The server state after the failure: the store is reset to it.
    const reloaded = TAGS.map((t) => (t.id === 4 ? { ...t, name: 'Internal (server)' } : t));
    tagsApi.getAll.mockResolvedValue(reloaded);
    fireEvent.change(screen.getByLabelText('Group of Internal'), { target: { value: '10' } });

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    await waitFor(() => expect(tagsApi.getAll).toHaveBeenCalledTimes(2));
    expect(tagGroupsApi.getAll).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(useAppStore.getState().tags).toEqual(reloaded));
  });

  it('shows the error and reloads both lists after a failed tag delete', async () => {
    tagsApi.delete.mockRejectedValue(new Error('Tag not found'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<TagsPanel />);
    await screen.findByText('Pharma');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Pharma' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tag not found');
    await waitFor(() => expect(tagsApi.getAll).toHaveBeenCalledTimes(2));
    expect(tagGroupsApi.getAll).toHaveBeenCalledTimes(2);
  });

  it('moves a tag to another group through its group select', async () => {
    tagsApi.update.mockResolvedValue({});
    render(<TagsPanel />);
    await screen.findByText('Pharma');

    fireEvent.change(screen.getByLabelText('Group of Internal'), { target: { value: '10' } });
    await waitFor(() => expect(tagsApi.update).toHaveBeenCalledWith(4, { group_id: 10 }));

    fireEvent.change(screen.getByLabelText('Group of Pharma'), { target: { value: '' } });
    await waitFor(() => expect(tagsApi.update).toHaveBeenCalledWith(3, { group_id: null }));
  });

  it('asks before deleting a tag or a group, and deletes only when confirmed', async () => {
    tagsApi.delete.mockResolvedValue(undefined);
    tagGroupsApi.delete.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<TagsPanel />);
    await screen.findByText('Pharma');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Pharma' }));
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('The tag is removed from every project'));
    expect(tagsApi.delete).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Pharma' }));
    await waitFor(() => expect(tagsApi.delete).toHaveBeenCalledWith(3));

    fireEvent.click(screen.getByRole('button', { name: 'Delete group Customer' }));
    expect(confirm).toHaveBeenLastCalledWith(
      expect.stringContaining('Tags in this group are kept and become ungrouped')
    );
    await waitFor(() => expect(tagGroupsApi.delete).toHaveBeenCalledWith(20));
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
      })
    );
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it('cancels an inline group rename with Escape without bubbling to the hub', async () => {
    const onKeyDown = vi.fn();
    render(
      <div onKeyDown={onKeyDown}>
        <TagsPanel />
      </div>
    );
    await screen.findByText('Pharma');

    fireEvent.click(screen.getByRole('button', { name: 'Rename Status' }));
    const input = screen.getByLabelText('Group name');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Group name')).not.toBeInTheDocument();
  });

  it('adds one tag when the add form is submitted twice', async () => {
    let finish!: () => void;
    tagsApi.create.mockReturnValue(new Promise<void>((r) => (finish = r)));
    render(<TagsPanel />);
    await screen.findByText('Pharma');

    const input = screen.getByLabelText('New tag name');
    fireEvent.change(input, { target: { value: 'Priority' } });
    fireEvent.change(screen.getByLabelText('New tag group'), { target: { value: '20' } });
    const form = input.closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(tagsApi.create).toHaveBeenCalledTimes(1);
    expect(tagsApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Priority', group_id: 20, all_sites: true })
    );
    finish();
    await waitFor(() => expect(tagsApi.getAll).toHaveBeenCalledTimes(2));
  });
});
