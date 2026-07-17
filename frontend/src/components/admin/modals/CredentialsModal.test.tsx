import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CredentialsModal } from './CredentialsModal';

describe('CredentialsModal (admin portal modal close behavior)', () => {
  const renderModal = (onClose = vi.fn()) => {
    const { container } = render(
      <CredentialsModal
        title="Tenant Credentials"
        email="admin@example.com"
        password="secret"
        onClose={onClose}
      />
    );
    return { onClose, overlay: container.firstElementChild as HTMLElement };
  };

  it('does NOT close when the overlay (backdrop) is clicked', () => {
    const { onClose, overlay } = renderModal();
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when the Escape key is pressed', () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the Close button is clicked', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
