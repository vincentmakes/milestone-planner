/**
 * ModalContainer mounts every (lazy-loaded) dialog; each one shows itself
 * when uiStore.activeModal names it, and only one is open at a time.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { ModalContainer } from '../ModalContainer';
import { resetAllStores, useAppStore, useUIStore } from '@/stores';
import { makeProject, makeSite, makeUser } from '@/test/factories';

beforeEach(() => {
  resetAllStores();
  useAppStore.setState({
    currentUser: makeUser({ role: 'admin' }),
    currentSite: makeSite(),
    projects: [makeProject({ id: 1 })],
  });
});

describe('ModalContainer', () => {
  it('shows no dialog while none is active', async () => {
    render(<ModalContainer />);
    await act(async () => {});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    ['phase', { projectId: 1 }, 'Add Phase'],
    ['staffAssignment', { projectId: 1 }, 'Assign Staff'],
    ['equipmentAssignment', { projectId: 1 }, 'Assign Equipment'],
    ['importProject', {}, 'Import Project'],
    ['equipmentBlock', {}, 'Block Equipment'],
  ] as const)('opens the %s dialog', async (modal, context, title) => {
    render(<ModalContainer />);
    act(() => useUIStore.getState().openModal(modal, context));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName(title);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    act(() => useUIStore.getState().closeModal());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
