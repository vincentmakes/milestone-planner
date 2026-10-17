import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';
import { confirmAction } from '@/utils/confirmDialog';
import { useConfirmStore } from '@/stores/confirmStore';
import { useUIStore } from '@/stores/uiStore';
import { resetAllStores } from '@/stores';

beforeEach(() => {
  useUIStore.setState({ openModalCount: 0 });
});

/** Ask inside act() so the dialog renders before the assertions. */
function ask(options: Parameters<typeof confirmAction>[0]): Promise<boolean> {
  let pending!: Promise<boolean>;
  act(() => {
    pending = confirmAction(options);
  });
  return pending;
}

describe('ConfirmDialog', () => {
  it('renders nothing while the queue is empty', () => {
    render(<ConfirmDialog />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the request with the default title and buttons', () => {
    render(<ConfirmDialog />);
    void ask({ message: 'Archive this project?' });

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Please confirm');
    expect(screen.getByText('Archive this project?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('accepts a bare string as the message', () => {
    render(<ConfirmDialog />);
    void ask('Proceed?');
    expect(screen.getByText('Proceed?')).toBeInTheDocument();
  });

  it('resolves true on Confirm and closes', async () => {
    render(<ConfirmDialog />);
    const answer = ask({ message: 'Go?' });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(useConfirmStore.getState().queue).toHaveLength(0);
  });

  it('resolves false on Cancel', async () => {
    render(<ConfirmDialog />);
    const answer = ask({ message: 'Go?' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(answer).resolves.toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('resolves false on the header close button', async () => {
    render(<ConfirmDialog />);
    const answer = ask({ message: 'Go?' });
    fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));
    await expect(answer).resolves.toBe(false);
  });

  it('resolves false on Escape', async () => {
    render(<ConfirmDialog />);
    const answer = ask({ message: 'Go?' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await expect(answer).resolves.toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders a destructive request with a danger Delete button', () => {
    render(<ConfirmDialog />);
    void ask({ message: 'Delete the phase?', destructive: true });
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm.className).toMatch(/danger/);
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toMatch(/secondary/);
  });

  it('uses the primary variant when not destructive', () => {
    render(<ConfirmDialog />);
    void ask({ message: 'Go?' });
    expect(screen.getByRole('button', { name: 'Confirm' }).className).toMatch(/primary/);
  });

  it('uses a custom title and button labels', async () => {
    render(<ConfirmDialog />);
    const answer = ask({
      message: 'Leave without saving?',
      title: 'Unsaved changes',
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      destructive: true,
    });
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Unsaved changes');
    expect(screen.getByRole('button', { name: 'Keep editing' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    await expect(answer).resolves.toBe(true);
  });

  it('puts Cancel before the confirm button', () => {
    render(<ConfirmDialog />);
    void ask({ message: 'Go?' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(cancel.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('splits the message into paragraphs on blank lines and keeps single line breaks', () => {
    render(<ConfirmDialog />);
    void ask({ message: 'First paragraph.\n\nSecond line one\nSecond line two\n\n\nThird.' });
    const paragraphs = screen.getByRole('dialog').querySelectorAll('p');
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]).toHaveTextContent('First paragraph.');
    expect(paragraphs[1].querySelectorAll('br')).toHaveLength(1);
    expect(paragraphs[1].textContent).toBe('Second line oneSecond line two');
    expect(paragraphs[2]).toHaveTextContent('Third.');
  });

  it('asks queued requests one after the other and resolves each', async () => {
    render(<ConfirmDialog />);
    const first = ask({ message: 'First?' });
    const second = ask({ message: 'Second?' });

    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText('First?')).toBeInTheDocument();
    expect(screen.queryByText('Second?')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await expect(first).resolves.toBe(true);
    expect(screen.getByText('Second?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(second).resolves.toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('counts as one open modal while shown', () => {
    render(<ConfirmDialog />);
    void ask({ message: 'Go?' });
    expect(useUIStore.getState().openModalCount).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useUIStore.getState().openModalCount).toBe(0);
  });

  it('focuses Cancel on open and gives focus back to the previously focused element', async () => {
    render(
      <>
        <button type="button">Remove row</button>
        <ConfirmDialog />
      </>
    );
    const trigger = screen.getByRole('button', { name: 'Remove row' });
    trigger.focus();

    const answer = ask({ message: 'Remove?', destructive: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await answer;
    expect(trigger).toHaveFocus();
  });

  it('answers a pending request false when every store is reset (logout, 401)', async () => {
    render(<ConfirmDialog />);
    const first = ask({ message: 'First?' });
    const second = ask({ message: 'Second?' });

    act(() => resetAllStores());

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(useConfirmStore.getState().queue).toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(useUIStore.getState().openModalCount).toBe(0);
  });
});
