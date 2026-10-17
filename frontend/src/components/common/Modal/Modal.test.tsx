import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { Modal } from './Modal';
import { useUIStore } from '@/stores/uiStore';

beforeEach(() => {
  useUIStore.setState({ openModalCount: 0 });
});

describe('Modal', () => {
  const renderModal = (onClose = vi.fn()) => {
    render(
      <Modal isOpen={true} onClose={onClose} title="Test Modal">
        <p>Modal content</p>
      </Modal>
    );
    return onClose;
  };

  it('renders title and content when open', () => {
    renderModal();
    expect(screen.getByText('Test Modal')).toBeInTheDocument();
    expect(screen.getByText('Modal content')).toBeInTheDocument();
  });

  it('does NOT close when the overlay (backdrop) is clicked', () => {
    const onClose = renderModal();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when the Escape key is pressed', () => {
    const onClose = renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the close button is clicked', () => {
    const onClose = renderModal();
    fireEvent.click(screen.getByLabelText('Close modal'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on Escape when closeOnEscape is false', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose} title="Test Modal" closeOnEscape={false}>
        <p>Modal content</p>
      </Modal>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Modal focus', () => {
  function Opener({ children, closeOnEscape }: { children?: React.ReactNode; closeOnEscape?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <Modal isOpen={open} onClose={() => setOpen(false)} title="Focus" closeOnEscape={closeOnEscape}>
          <input aria-label="First" />
          <button type="button">Middle</button>
          {children}
        </Modal>
      </>
    );
  }

  it('labels the dialog by its own title id, so nested dialogs do not share one', () => {
    render(
      <>
        <Modal isOpen onClose={vi.fn()} title="Outer">
          <p>outer</p>
        </Modal>
        <Modal isOpen onClose={vi.fn()} title="Inner">
          <p>inner</p>
        </Modal>
      </>
    );
    const [outer, inner] = screen.getAllByRole('dialog');
    expect(outer).toHaveAccessibleName('Outer');
    expect(inner).toHaveAccessibleName('Inner');
    expect(outer.getAttribute('aria-labelledby')).not.toBe(inner.getAttribute('aria-labelledby'));
  });

  it('keeps Tab inside the dialog in both directions', () => {
    render(<Opener />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    // Focus order inside the dialog: Close modal, First, Middle
    const close = screen.getByRole('button', { name: 'Close modal' });
    const middle = screen.getByRole('button', { name: 'Middle' });

    middle.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(middle).toHaveFocus();

    // From the container itself (where focus lands on open) Tab goes to the first control
    (screen.getByRole('dialog').firstElementChild as HTMLElement).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();

    // Focus that escaped (e.g. to the opener behind the dialog) is pulled back in
    screen.getByRole('button', { name: 'Open' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
  });

  it('gives focus back to the opener when it closes', () => {
    render(<Opener />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(opener).not.toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('counts itself as open for the keyboard shortcuts, including when unmounted while open', () => {
    const { unmount } = render(
      <Modal isOpen onClose={vi.fn()} title="Counted">
        <p>x</p>
      </Modal>
    );
    expect(useUIStore.getState().openModalCount).toBe(1);
    unmount();
    expect(useUIStore.getState().openModalCount).toBe(0);
  });

  it('traps Tab only in the innermost dialog', () => {
    render(
      <>
        <Modal isOpen onClose={vi.fn()} title="Outer">
          <button type="button">Outer button</button>
        </Modal>
        <Modal isOpen onClose={vi.fn()} title="Inner">
          <button type="button">Inner button</button>
        </Modal>
      </>
    );
    const innerButton = screen.getByRole('button', { name: 'Inner button' });
    innerButton.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    // Wrapped to the inner dialog's first control (its close button), never to the outer one
    const innerClose = screen.getAllByRole('button', { name: 'Close modal' })[1];
    expect(innerClose).toHaveFocus();
  });

  it('closes only the innermost dialog on Escape', () => {
    const outerClose = vi.fn();
    function Nested() {
      // The inner dialog opens after the outer one, as a confirmation would.
      const [innerOpen, setInnerOpen] = useState(false);
      return (
        <Modal isOpen onClose={outerClose} title="Outer">
          <button type="button" onClick={() => setInnerOpen(true)}>
            Open inner
          </button>
          <Modal isOpen={innerOpen} onClose={() => setInnerOpen(false)} title="Inner">
            <p>inner</p>
          </Modal>
        </Modal>
      );
    }
    render(<Nested />);
    fireEvent.click(screen.getByRole('button', { name: 'Open inner' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(2);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Outer');
    expect(outerClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(outerClose).toHaveBeenCalledTimes(1);
  });
});
