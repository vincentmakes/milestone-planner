/**
 * Custom column definition dialog: create a site or global column of each
 * type (list options validated and trimmed), edit name/options/width of an
 * existing one (type and scope fixed), delete after confirmation, errors.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CustomColumnModal } from '../CustomColumnModal';
import { resetAllStores, useAppStore } from '@/stores';
import { createCustomColumn, updateCustomColumn, deleteCustomColumn } from '@/api';
import { makeCustomColumn, makeSite } from '@/test/factories';
import { stubConfirm } from '@/test/confirmDialog';

vi.mock('@/api', () => ({
  createCustomColumn: vi.fn(),
  updateCustomColumn: vi.fn(),
  deleteCustomColumn: vi.fn(),
}));

const onClose = vi.fn();
const onSave = vi.fn();

function open(column: Parameters<typeof CustomColumnModal>[0]['column'] = null) {
  return render(<CustomColumnModal isOpen onClose={onClose} onSave={onSave} column={column} />);
}

const nameInput = () => screen.getByPlaceholderText('e.g., Priority, Status, Owner');
const options = () => screen.queryAllByPlaceholderText(/^Option \d+$/) as HTMLInputElement[];

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  vi.mocked(createCustomColumn).mockResolvedValue({} as never);
  vi.mocked(updateCustomColumn).mockResolvedValue({} as never);
  vi.mocked(deleteCustomColumn).mockResolvedValue({} as never);
  useAppStore.setState({ currentSite: makeSite({ id: 3, name: 'Zurich' }) });
});

describe('CustomColumnModal create', () => {
  it('requires a name', () => {
    open();
    expect(screen.getByText('Add Custom Column')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText('Column name is required')).toBeInTheDocument();
    expect(createCustomColumn).not.toHaveBeenCalled();
  });

  it('creates a site text column with the chosen width', async () => {
    open();
    expect(screen.getByText('This column will only be visible to Zurich')).toBeInTheDocument();
    fireEvent.change(nameInput(), { target: { value: '  Owner ' } });
    fireEvent.change(screen.getByRole('slider'), { target: { value: '200' } });
    expect(screen.getByText('200px')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(createCustomColumn).toHaveBeenCalledWith({ name: 'Owner', column_type: 'text', site_id: 3, width: 200 });
    expect(onSave).toHaveBeenCalled();
  });

  it('creates a global checkbox column', async () => {
    open();
    fireEvent.change(nameInput(), { target: { value: 'Approved' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'boolean' } });
    fireEvent.click(screen.getByRole('switch', { name: /Global column/ }));
    expect(screen.getByText('This column will be visible across all sites')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(createCustomColumn).toHaveBeenCalledWith({ name: 'Approved', column_type: 'boolean', site_id: null, width: 120 })
    );
  });

  it('manages list options and sends only the non-empty ones', async () => {
    open();
    fireEvent.change(nameInput(), { target: { value: 'Priority' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'list' } });
    expect(options()).toHaveLength(1);
    // a single option cannot be removed
    expect(screen.queryByTitle('Remove option')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText('At least one list option is required')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Add Option/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add Option/ }));
    fireEvent.change(options()[0], { target: { value: 'High' } });
    fireEvent.change(options()[1], { target: { value: 'Drop me' } });
    fireEvent.change(options()[2], { target: { value: 'Low' } });
    fireEvent.click(screen.getAllByTitle('Remove option')[1]);
    expect(options().map((o) => o.value)).toEqual(['High', 'Low']);
    fireEvent.click(screen.getByRole('button', { name: /Add Option/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createCustomColumn).toHaveBeenCalled());
    expect(vi.mocked(createCustomColumn).mock.calls[0][0]).toMatchObject({
      column_type: 'list',
      list_options: ['High', 'Low'],
    });
  });

  it('shows the save error and stays open', async () => {
    vi.mocked(createCustomColumn).mockRejectedValue(new Error('Duplicate column'));
    open();
    fireEvent.change(nameInput(), { target: { value: 'Owner' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Duplicate column')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('CustomColumnModal edit', () => {
  const priority = makeCustomColumn({ id: 7, name: 'Priority', list_options: ['High', 'Low'], width: 150, site_id: 3 });

  it('prefills, hides type and scope, and updates', async () => {
    open(priority);
    expect(screen.getByText('Edit Custom Column')).toBeInTheDocument();
    expect(nameInput()).toHaveValue('Priority');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(options().map((o) => o.value)).toEqual(['High', 'Low']);
    expect(screen.getByText('150px')).toBeInTheDocument();

    fireEvent.change(options()[1], { target: { value: 'Medium' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() =>
      expect(updateCustomColumn).toHaveBeenCalledWith(7, { name: 'Priority', list_options: ['High', 'Medium'], width: 150 })
    );
    expect(onSave).toHaveBeenCalled();
  });

  it('sends no options for a text column', async () => {
    open(makeCustomColumn({ id: 8, name: 'Notes', column_type: 'text', list_options: null as never }));
    expect(options()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(updateCustomColumn).toHaveBeenCalledWith(8, { name: 'Notes', list_options: undefined, width: 120 }));
  });

  it('deletes only after confirmation and reports failures', async () => {
    let answer = false;
    const confirm = stubConfirm(() => answer);
    open(priority);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Are you sure you want to delete this column? All values will be lost.',
          destructive: true,
        })
      )
    );
    expect(deleteCustomColumn).not.toHaveBeenCalled();

    answer = true;

    vi.mocked(deleteCustomColumn).mockRejectedValueOnce(new Error('In use'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('In use')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(deleteCustomColumn).toHaveBeenLastCalledWith(7);
    expect(onSave).toHaveBeenCalled();
  });

  it('closes with Cancel', () => {
    open(priority);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
