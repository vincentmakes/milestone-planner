/**
 * DependencyPopup is a small popover over an arrow: it dismisses like every
 * other overlay (outside mousedown, Escape, Tab out — `useDismissableOverlay`)
 * and deletes the link in one click, below the modal layer.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DependencyPopup } from '../DependencyPopup';
import { stubConfirm } from '@/test/confirmDialog';

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

  it('deletes on click, without a confirmation, editors only', () => {
    const confirm = stubConfirm(true);
    const { onDelete } = renderPopup();
    fireEvent.click(screen.getByRole('button', { name: /Remove|Delete/ }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();

    cleanup();
    renderPopup({ canDelete: false });
    expect(screen.queryByRole('button', { name: /Remove|Delete/ })).not.toBeInTheDocument();
  });

  it('sits below the modal layer, so no dialog can open behind it', () => {
    // Read through Node's fs: under Vitest a `.module.css` import is a stub.
    const css = readFileSync(join(__dirname, '..', 'DependencyPopup.module.css'), 'utf8');
    const variables = readFileSync(join(__dirname, '..', '..', '..', '..', 'styles', 'variables.css'), 'utf8');
    const token = css.match(/\.popup\s*\{[^}]*z-index:\s*var\((--z-[a-z-]+)\)/)?.[1];
    expect(token).toBeDefined();
    const value = (name: string) => Number(variables.match(new RegExp(`${name}:\\s*(\\d+);`))?.[1]);
    expect(value(token!)).toBeLessThan(value('--z-modal-backdrop'));
  });

  it('renders nothing while hidden', () => {
    renderPopup({ visible: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
