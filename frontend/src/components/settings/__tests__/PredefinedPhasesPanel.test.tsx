/**
 * Settings › Predefined phases: load, add, inline rename (Enter / blur /
 * Escape), activate/deactivate, delete with confirmation, drag-to-reorder,
 * error alerts, and a read-only list for plain users.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, createEvent, waitFor } from '@testing-library/react';
import { PredefinedPhasesPanel } from '../panels/PredefinedPhasesPanel';
import { resetAllStores, useAppStore } from '@/stores';
import { apiGet, apiPost, apiPut, apiDelete } from '@/api/client';
import { makeUser } from '@/test/factories';
import type { PredefinedPhase } from '@/types';

vi.mock('@/api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

const phases: PredefinedPhase[] = [
  { id: 1, name: 'Feasibility', sort_order: 0, is_active: true },
  { id: 2, name: 'Scale-up', sort_order: 1, is_active: false },
  { id: 3, name: 'Transfer', sort_order: 2, is_active: true },
];

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetAllStores();
  useAppStore.setState({ currentUser: makeUser({ role: 'superuser' }) });
  vi.mocked(apiGet).mockReset().mockResolvedValue(phases);
  vi.mocked(apiPost).mockReset().mockResolvedValue({});
  vi.mocked(apiPut).mockReset().mockResolvedValue({});
  vi.mocked(apiDelete).mockReset().mockResolvedValue({});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => {
    errorSpy.mockRestore();
  };
});

async function renderPanel() {
  render(<PredefinedPhasesPanel />);
  await screen.findByText('Feasibility');
}

const item = (name: string) => screen.getByText(name).closest('[draggable]') as HTMLElement;

describe('PredefinedPhasesPanel', () => {
  it('loads all templates, showing a loading state first', async () => {
    render(<PredefinedPhasesPanel />);
    expect(screen.getByText('Loading phases...')).toBeInTheDocument();
    expect(await screen.findByText('Transfer')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/api/predefined-phases/all');
    expect(item('Scale-up').className).toMatch(/inactive/);
    expect(screen.getAllByTitle('Deactivate')).toHaveLength(2);
    expect(screen.getAllByTitle('Activate')).toHaveLength(1);
  });

  it('shows the empty state and survives a failed load', async () => {
    vi.mocked(apiGet).mockRejectedValueOnce(new Error('down'));
    render(<PredefinedPhasesPanel />);
    expect(await screen.findByText('No predefined phases. Add one below.')).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('adds a trimmed phase by button or Enter and reloads', async () => {
    await renderPanel();
    const input = screen.getByPlaceholderText('New phase name...');
    const add = screen.getByRole('button', { name: 'Add Phase' });
    expect(add).toBeDisabled();

    fireEvent.change(input, { target: { value: '  Validation ' } });
    fireEvent.click(add);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/predefined-phases', { name: 'Validation' }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(apiGet).toHaveBeenCalledTimes(2);

    fireEvent.change(input, { target: { value: 'Report' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/predefined-phases', { name: 'Report' }));
  });

  it('shows the error in place when adding fails and keeps the typed name', async () => {
    vi.mocked(apiPost).mockRejectedValue(new Error('Name already exists'));
    await renderPanel();
    const input = screen.getByPlaceholderText('New phase name...');
    fireEvent.change(input, { target: { value: 'Feasibility' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Name already exists');
    expect(input).toHaveValue('Feasibility');
  });

  it('renames inline on Enter, ignores blanks and cancels on Escape', async () => {
    await renderPanel();
    fireEvent.click(screen.getByText('Feasibility'));
    const editor = screen.getByDisplayValue('Feasibility');
    fireEvent.change(editor, { target: { value: 'Feasibility study' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/predefined-phases/1', { name: 'Feasibility study' })
    );

    fireEvent.click(await screen.findByText('Transfer'));
    const blank = screen.getByDisplayValue('Transfer');
    fireEvent.change(blank, { target: { value: '   ' } });
    fireEvent.blur(blank);
    expect(screen.queryByDisplayValue('   ')).not.toBeInTheDocument();
    expect(apiPut).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Transfer'));
    const escaped = screen.getByDisplayValue('Transfer');
    fireEvent.keyDown(escaped, { key: 'Escape' });
    expect(screen.queryByDisplayValue('Transfer')).not.toBeInTheDocument();
    expect(apiPut).toHaveBeenCalledTimes(1);
  });

  it('shows the error in place when a rename fails', async () => {
    vi.mocked(apiPut).mockRejectedValue(new Error('Rename refused'));
    await renderPanel();
    fireEvent.click(screen.getByText('Feasibility'));
    const editor = screen.getByDisplayValue('Feasibility');
    fireEvent.change(editor, { target: { value: 'X' } });
    fireEvent.blur(editor);
    expect(await screen.findByRole('alert')).toHaveTextContent('Rename refused');
  });

  it('toggles a phase active state', async () => {
    await renderPanel();
    fireEvent.click(screen.getByTitle('Activate'));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/predefined-phases/2', { is_active: true })
    );
    fireEvent.click(screen.getAllByTitle('Deactivate')[0]);
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/predefined-phases/1', { is_active: false })
    );

    vi.mocked(apiPut).mockRejectedValueOnce(new Error('nope'));
    fireEvent.click(screen.getByTitle('Activate'));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });

  it('exposes the active toggle as a pressed button named after the phase', async () => {
    await renderPanel();
    const feasibility = screen.getByRole('button', { name: 'Deactivate Feasibility' });
    expect(feasibility).toHaveAttribute('aria-pressed', 'true');
    expect(feasibility.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    const scaleUp = screen.getByRole('button', { name: 'Activate Scale-up' });
    expect(scaleUp).toHaveAttribute('aria-pressed', 'false');

    expect(screen.getByRole('button', { name: 'Delete Transfer' })).toHaveAttribute('title', 'Delete');
  });

  it('deletes only after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    await renderPanel();
    fireEvent.click(screen.getAllByTitle('Delete')[1]);
    expect(confirm).toHaveBeenCalledWith('Are you sure you want to delete "Scale-up"?');
    expect(apiDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByTitle('Delete')[1]);
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/api/predefined-phases/2'));

    vi.mocked(apiDelete).mockRejectedValueOnce(new Error('In use'));
    fireEvent.click(screen.getAllByTitle('Delete')[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent('In use');
    confirm.mockRestore();
  });

  it('reorders by drag and drop', async () => {
    await renderPanel();
    const dragOverAt = (el: HTMLElement, clientY: number) => {
      const event = createEvent.dragOver(el);
      Object.defineProperty(event, 'clientY', { value: clientY });
      fireEvent(el, event);
    };

    fireEvent.dragStart(item('Feasibility'), { dataTransfer: { effectAllowed: '' } });
    expect(item('Feasibility').className).toMatch(/dragging/);
    dragOverAt(item('Transfer'), 5);
    expect(item('Transfer').className).toMatch(/dropAfter/);
    fireEvent.drop(item('Transfer'));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/predefined-phases/reorder', { phase_order: [2, 3, 1] })
    );

    fireEvent.dragStart(item('Transfer'), { dataTransfer: { effectAllowed: '' } });
    dragOverAt(item('Feasibility'), -5);
    expect(item('Feasibility').className).toMatch(/dropBefore/);
    fireEvent.dragLeave(item('Feasibility'));
    expect(item('Feasibility').className).not.toMatch(/dropBefore/);
    dragOverAt(item('Feasibility'), -5);
    vi.mocked(apiPut).mockRejectedValueOnce(new Error('x'));
    fireEvent.drop(item('Feasibility'));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/predefined-phases/reorder', { phase_order: [3, 1, 2] })
    );
    // the failed reorder reloads the list
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
  });

  it('ignores a drop without a target and clears the drag on drag end', async () => {
    await renderPanel();
    fireEvent.dragStart(item('Feasibility'), { dataTransfer: { effectAllowed: '' } });
    // hovering the dragged item itself sets no target
    fireEvent.dragOver(item('Feasibility'));
    fireEvent.drop(item('Feasibility'));
    expect(apiPut).not.toHaveBeenCalled();

    fireEvent.dragStart(item('Feasibility'), { dataTransfer: { effectAllowed: '' } });
    fireEvent.dragEnd(item('Feasibility'));
    expect(item('Feasibility').className).not.toMatch(/dragging/);
  });

  it('is read-only for plain users', async () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user' }) });
    await renderPanel();
    expect(item('Feasibility')).toHaveAttribute('draggable', 'false');
    expect(screen.queryByTitle('Delete')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('New phase name...')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Feasibility'));
    expect(screen.queryByDisplayValue('Feasibility')).not.toBeInTheDocument();
  });
});
