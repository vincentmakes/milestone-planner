/**
 * DependencyPopup is a small popover over an arrow: it dismisses like every
 * other overlay (outside mousedown, Escape, Tab out — `useDismissableOverlay`)
 * and asks before deleting the link.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DependencyPopup } from '../DependencyPopup';

function renderPopup(overrides: Partial<React.ComponentProps<typeof DependencyPopup>> = {}) {
  const onClose = vi.fn();
  const onDelete = vi.fn();
  render(
    <div>
      <button type="button">outside</button>
      <DependencyPopup
        visible
        x={10}
        y={10}
        dependencyType="FS"
        fromName="Feasibility"
        toName="Scale-up"
        onClose={onClose}
        onDelete={onDelete}
        {...overrides}
      />
    </div>
  );
  return { onClose, onDelete };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DependencyPopup', () => {
  it('is a labelled dialog that closes from its button, on Escape and on an outside click', () => {
    const { onClose } = renderPopup();
    const dialog = screen.getByRole('dialog', { name: 'Finish-to-Start dependency' });
    expect(dialog).toHaveTextContent('Feasibility');
    expect(dialog).toHaveTextContent('Scale-up');

    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close dependency details' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('closes when focus leaves it', () => {
    const { onClose } = renderPopup();
    fireEvent.blur(screen.getByRole('dialog'), { relatedTarget: screen.getByRole('button', { name: 'outside' }) });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('deletes only after confirmation, and only for editors', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { onDelete } = renderPopup();
    const remove = screen.getByRole('button', { name: /Remove|Delete/ });
    fireEvent.click(remove);
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(remove);
    expect(confirm).toHaveBeenLastCalledWith('Remove this FS dependency?');
    expect(onDelete).toHaveBeenCalledTimes(1);

    cleanup();
    renderPopup({ canDelete: false });
    expect(screen.queryByRole('button', { name: /Remove|Delete/ })).not.toBeInTheDocument();
  });

  it('renders nothing while hidden', () => {
    renderPopup({ visible: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
