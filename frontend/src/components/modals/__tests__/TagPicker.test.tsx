/**
 * TagPicker: a pure picker over the store's tags.
 * - Escape inside the dropdown closes only the dropdown, not the dialog it
 *   sits in (ProjectModal): the shared Modal listens for Escape on document,
 *   so the picker stops propagation while its dropdown is open.
 * - Only tags applying to the project's site are offered.
 * - Single-select groups behave like radio buttons.
 * - Admins get a "Manage tags…" shortcut to Settings → Tags.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { Modal } from '@/components/common/Modal';
import { TagPicker, TAG_PICKER_PLACEHOLDER, MANAGE_TAGS_CONFIRM } from '../TagPicker';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { stubConfirm } from '@/test/confirmDialog';
import type { Tag, TagGroup } from '@/types';

function tag(id: number, name: string, extra: Partial<Tag> = {}): Tag {
  return { id, name, color: '#3b82f6', group_id: null, all_sites: true, site_ids: [], sort_order: 0, ...extra };
}

const TYPE: TagGroup = { id: 1, name: 'Project type', single_select: true, sort_order: 0 };
const AREA: TagGroup = { id: 2, name: 'Area', single_select: false, sort_order: 1 };

const tags: Tag[] = [
  tag(1, 'Pilot'),
  tag(2, 'Internal', { group_id: 1 }),
  tag(3, 'Customer', { group_id: 1, sort_order: 1 }),
  tag(4, 'Bio', { group_id: 2 }),
  tag(5, 'Chem', { group_id: 2 }),
  tag(6, 'Basel only', { all_sites: false, site_ids: [2] }),
];

function Harness({ initial = [] as number[], siteId = 1 as number | null }) {
  const [selected, setSelected] = useState(new Set(initial));
  return (
    <>
      <TagPicker selectedIds={selected} onChange={setSelected} siteId={siteId} />
      <output data-testid="selected">{[...selected].sort().join(',')}</output>
    </>
  );
}

function openDropdown() {
  const search = screen.getByPlaceholderText(TAG_PICKER_PLACEHOLDER);
  fireEvent.focus(search);
  return { search, listbox: screen.getByRole('listbox') };
}

beforeEach(() => {
  useAppStore.setState({
    tags,
    tagGroups: [AREA, TYPE],
    currentUser: { id: 1, name: 'Ada Admin', role: 'admin' } as never,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (useWhatIfStore.getState().whatIfMode) await useWhatIfStore.getState().exitWhatIfMode(false);
  useUIStore.getState().closeModal();
});

describe('TagPicker inside a modal', () => {
  it('Escape closes the dropdown and leaves the dialog open; a second Escape closes the dialog', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Edit Project">
        <TagPicker selectedIds={new Set()} onChange={vi.fn()} siteId={1} />
      </Modal>
    );

    const { search } = openDropdown();
    expect(screen.getByText('Pilot')).toBeInTheDocument();

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByText('Pilot')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('TagPicker options', () => {
  it('lists tags in group sections, ungrouped last', () => {
    render(<Harness />);
    const { listbox } = openDropdown();
    const groups = within(listbox).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Project type', 'Area', 'Other']);
    expect(within(groups[0]).getAllByRole('option').map((o) => o.textContent)).toEqual(['Internal', 'Customer']);
    expect(within(groups[0]).getByText('pick one')).toBeInTheDocument();
  });

  it('only offers tags that apply to the site', () => {
    const { unmount } = render(<Harness siteId={1} />);
    openDropdown();
    expect(screen.queryByText('Basel only')).not.toBeInTheDocument();
    unmount();

    render(<Harness siteId={2} />);
    openDropdown();
    expect(screen.getByText('Basel only')).toBeInTheDocument();
  });

  it('hides selected pills for tags not applying to the site', () => {
    render(<Harness initial={[1, 6]} siteId={1} />);
    expect(screen.getByLabelText('Remove Pilot')).toBeInTheDocument();
    expect(screen.queryByLabelText('Remove Basel only')).not.toBeInTheDocument();
  });

  it('replaces the choice inside a single-select group, adds freely elsewhere', () => {
    render(<Harness initial={[2]} />);
    const { listbox } = openDropdown();
    fireEvent.click(within(listbox).getByRole('option', { name: 'Customer' }));
    expect(screen.getByTestId('selected').textContent).toBe('3');

    fireEvent.focus(screen.getByPlaceholderText(TAG_PICKER_PLACEHOLDER));
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Bio' }));
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Chem' }));
    expect(screen.getByTestId('selected').textContent).toBe('3,4,5');

    // Clicking a selected option deselects it
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Bio' }));
    expect(screen.getByTestId('selected').textContent).toBe('3,5');
  });

  it('filters by search and picks an exact match on Enter', () => {
    render(<Harness />);
    const { search } = openDropdown();
    fireEvent.change(search, { target: { value: 'chem' } });
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Chem']);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByTestId('selected').textContent).toBe('5');

    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No tags match')).toBeInTheDocument();
  });

  it('picks the only remaining match on Enter, and nothing while several match', () => {
    render(<Harness />);
    const { search } = openDropdown();
    fireEvent.change(search, { target: { value: 'i' } }); // Pilot, Internal, Bio
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByTestId('selected').textContent).toBe('');

    fireEvent.change(search, { target: { value: 'he' } }); // only Chem
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByTestId('selected').textContent).toBe('5');
  });

  it('exposes the search box as a combobox controlling the listbox', () => {
    render(<Harness />);
    const search = screen.getByRole('combobox', { name: 'Find a tag' });
    expect(search).toHaveAttribute('aria-expanded', 'false');
    expect(search).toHaveAttribute('aria-autocomplete', 'list');
    expect(search).not.toHaveAttribute('aria-controls');
    const { listbox } = openDropdown();
    expect(search).toHaveAttribute('aria-expanded', 'true');
    expect(search).toHaveAttribute('aria-controls', listbox.id);
  });

  it('shows an empty state when no tag applies to the site', () => {
    useAppStore.setState({ tags: [tag(6, 'Basel only', { all_sites: false, site_ids: [2] })] });
    render(<Harness siteId={1} />);
    openDropdown();
    expect(screen.getByText('No tags for this site')).toBeInTheDocument();
  });
});

describe('TagPicker "Manage tags…"', () => {
  it('is admin-only', () => {
    useAppStore.setState({ currentUser: { id: 2, name: 'Sue', role: 'superuser' } as never });
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Manage tags…' })).not.toBeInTheDocument();
  });

  it('is disabled with the search box and pills while the dialog is saving', () => {
    const confirm = stubConfirm(true);
    useUIStore.setState({ activeModal: 'project', editingProject: { id: 9 } as never });
    render(<TagPicker selectedIds={new Set([1])} onChange={vi.fn()} siteId={1} disabled />);
    const link = screen.getByRole('button', { name: 'Manage tags…' });
    expect(link).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Find a tag' })).toBeDisabled();
    expect(screen.getByLabelText('Remove Pilot')).toBeDisabled();

    fireEvent.click(link);
    expect(confirm).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeModal).toBe('project');
  });

  it('closes the project dialog and opens Settings → Tags after confirming', async () => {
    useUIStore.setState({ activeModal: 'project', editingProject: { id: 9 } as never });
    let answer = false;
    const confirm = stubConfirm(() => answer);
    render(<Harness />);
    const link = screen.getByRole('button', { name: 'Manage tags…' });

    fireEvent.click(link);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith({
      title: 'Manage tags',
      message: MANAGE_TAGS_CONFIRM,
      confirmLabel: 'Open settings',
    });
    expect(useUIStore.getState()).toMatchObject({ activeModal: 'project', editingProject: { id: 9 } });

    answer = true;
    fireEvent.click(link);
    await waitFor(() => expect(useUIStore.getState().activeModal).toBe('settingsHub'));
    expect(confirm).toHaveBeenCalledTimes(2);
    const ui = useUIStore.getState();
    expect(ui.settingsSection).toBe('tags');
    expect(ui.editingProject).toBeNull();
  });

  it('is disabled with the What-If hint while What-If is active, keeping the dialog', () => {
    const confirm = stubConfirm(true);
    useUIStore.setState({ activeModal: 'project', editingProject: { id: 9 } as never });
    useWhatIfStore.getState().enterWhatIfMode([]);
    render(<Harness />);
    const link = screen.getByRole('button', { name: 'Manage tags…' });
    expect(link).toBeDisabled();
    expect(link).toHaveAttribute('title', whatIfUnavailableMessage('Managing tags'));
    // Picking tags is a plan edit and stays available.
    expect(screen.getByRole('combobox', { name: 'Find a tag' })).toBeEnabled();

    fireEvent.click(link);
    expect(confirm).not.toHaveBeenCalled();
    expect(useUIStore.getState()).toMatchObject({ activeModal: 'project', editingProject: { id: 9 } });
  });
});
