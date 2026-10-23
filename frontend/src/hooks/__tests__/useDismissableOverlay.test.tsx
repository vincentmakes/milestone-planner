/**
 * useDismissableOverlay — the one dismiss behaviour for dropdowns, popovers
 * and menus. Each behaviour has its own case so a regression names itself:
 * outside mousedown, capture-phase Escape (stopped, focus back to the
 * trigger), Tab out through `onBlur`, nothing while closed, and listeners
 * gone on close and on unmount.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismissableOverlay } from '../useDismissableOverlay';
import { useConfirmStore } from '@/stores/confirmStore';

function Overlay({ onClose, initiallyOpen = true }: { onClose?: () => void; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { onBlur } = useDismissableOverlay({
    open,
    onClose: () => {
      setOpen(false);
      onClose?.();
    },
    wrapperRef,
    triggerRef,
  });
  return (
    <div>
      <div ref={wrapperRef} data-testid="wrapper" onBlur={onBlur}>
        <button ref={triggerRef} type="button" onClick={() => setOpen((o) => !o)}>
          Trigger
        </button>
        {open && (
          <div role="dialog" aria-label="Panel">
            <label>
              Option <input type="checkbox" />
            </label>
            <button type="button">Inside</button>
          </div>
        )}
      </div>
      <button type="button">Outside</button>
    </div>
  );
}

/** The panel portaled to <body>, outside the wrapper in the DOM (AnchoredPanel's shape). */
function PortaledOverlay({ onClose, withPanelRef = true }: { onClose?: () => void; withPanelRef?: boolean }) {
  const [open, setOpen] = useState(true);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { onBlur } = useDismissableOverlay({
    open,
    onClose: () => {
      setOpen(false);
      onClose?.();
    },
    wrapperRef,
    triggerRef,
    panelRef: withPanelRef ? panelRef : undefined,
  });
  return (
    <div>
      <div ref={wrapperRef} data-testid="wrapper" onBlur={onBlur}>
        <button ref={triggerRef} type="button" onClick={() => setOpen((o) => !o)}>
          Trigger
        </button>
        {open &&
          createPortal(
            <div ref={panelRef} role="dialog" aria-label="Panel">
              <label>
                Option <input type="checkbox" />
              </label>
              <button type="button">Inside</button>
            </div>,
            document.body
          )}
      </div>
      <button type="button">Outside</button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useDismissableOverlay', () => {
  it('closes on a mousedown outside the wrapper, not inside it', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Inside' }));
    fireEvent.mouseDown(screen.getByText('Option'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Panel' })).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape in the capture phase, stops it there and refocuses the trigger', () => {
    const onClose = vi.fn();
    const bubbled = vi.fn();
    document.addEventListener('keydown', bubbled);
    render(<Overlay onClose={onClose} />);
    screen.getByRole('button', { name: 'Inside' }).focus();

    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Trigger' })).toHaveFocus();
    // The bubbling listener (the app-wide shortcut handler stands here) never saw Escape
    expect(bubbled.mock.calls.map(([e]) => (e as KeyboardEvent).key)).toEqual(['Enter']);
    document.removeEventListener('keydown', bubbled);
  });

  it('closes when focus leaves the wrapper, but not when it moves inside or drops to the body', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);
    const wrapper = screen.getByTestId('wrapper');
    const inside = screen.getByRole('button', { name: 'Inside' });
    const outside = screen.getByRole('button', { name: 'Outside' });

    fireEvent.blur(wrapper, { relatedTarget: inside });
    fireEvent.blur(wrapper, { relatedTarget: null });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.blur(wrapper, { relatedTarget: outside });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does nothing while closed', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} initiallyOpen={false} />);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.blur(screen.getByTestId('wrapper'), { relatedTarget: screen.getByRole('button', { name: 'Outside' }) });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('removes its document listeners on close and on unmount', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(<Overlay />);

    const added = add.mock.calls.filter(([type]) => type === 'mousedown' || type === 'keydown');
    expect(added).toHaveLength(2);
    expect(added.find(([type]) => type === 'keydown')?.[2]).toBe(true); // capture

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' })); // closes
    const removedTypes = remove.mock.calls.map(([type]) => type).filter((t) => t === 'mousedown' || t === 'keydown');
    expect(removedTypes.sort()).toEqual(['keydown', 'mousedown']);

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' })); // reopens, listeners back
    unmount();
    const afterUnmount = remove.mock.calls.map(([type]) => type).filter((t) => t === 'mousedown' || t === 'keydown');
    expect(afterUnmount).toHaveLength(4);
  });

  it('reads the latest onClose without re-registering listeners', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const first = vi.fn();
    const second = vi.fn();
    function Latest({ onClose }: { onClose: () => void }) {
      const wrapperRef = useRef<HTMLDivElement>(null);
      useDismissableOverlay({ open: true, onClose, wrapperRef });
      return <div ref={wrapperRef} />;
    }
    const { rerender } = render(<Latest onClose={first} />);
    rerender(<Latest onClose={second} />);
    fireEvent.mouseDown(document.body);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(add.mock.calls.filter(([type]) => type === 'mousedown')).toHaveLength(1);
  });

  it('stands down while an in-app confirmation is pending, and resumes after', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);
    let id = 0;
    act(() => {
      id = useConfirmStore.getState().enqueue({ message: 'Delete?' }, vi.fn());
    });

    // Escape and an outside mousedown belong to the confirm on top.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Panel' })).toBeInTheDocument();

    act(() => useConfirmStore.getState().settle(id, false));
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('with a panel portaled out of the wrapper (panelRef)', () => {
    it('stays open on a mousedown inside the portaled panel, closes outside both', () => {
      const onClose = vi.fn();
      render(<PortaledOverlay onClose={onClose} />);
      const panel = screen.getByRole('dialog', { name: 'Panel' });
      expect(screen.getByTestId('wrapper')).not.toContainElement(panel);

      fireEvent.mouseDown(screen.getByRole('button', { name: 'Inside' }));
      fireEvent.mouseDown(screen.getByText('Option'));
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Trigger' }));
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('without panelRef the portaled panel counts as outside (why the option exists)', () => {
      const onClose = vi.fn();
      render(<PortaledOverlay onClose={onClose} withPanelRef={false} />);
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Inside' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('sees focus moves in the panel through the wrapper (React bubbles through the portal)', () => {
      const onClose = vi.fn();
      render(<PortaledOverlay onClose={onClose} />);
      const inside = screen.getByRole('button', { name: 'Inside' });

      // Trigger → panel, and inside the panel: still open
      fireEvent.blur(screen.getByRole('button', { name: 'Trigger' }), { relatedTarget: inside });
      fireEvent.blur(screen.getByRole('checkbox'), { relatedTarget: inside });
      fireEvent.blur(inside, { relatedTarget: null });
      expect(onClose).not.toHaveBeenCalled();

      // Tab out of the portaled panel: the blur reaches the wrapper's onBlur
      fireEvent.blur(inside, { relatedTarget: screen.getByRole('button', { name: 'Outside' }) });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('Escape inside the portaled panel closes it and refocuses the trigger', () => {
      const onClose = vi.fn();
      render(<PortaledOverlay onClose={onClose} />);
      screen.getByRole('button', { name: 'Inside' }).focus();
      fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Trigger' })).toHaveFocus();
    });
  });
});
