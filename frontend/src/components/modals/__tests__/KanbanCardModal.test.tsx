/**
 * The no-backdrop-close rule is CI-enforced (see CLAUDE.md and Modal.test.tsx).
 * A comment half-typed into this modal must survive a stray click on the
 * backdrop, which is exactly what a text-selection drag ending outside does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KanbanCardModal } from '../KanbanCardModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';

vi.mock('@/api/endpoints/kanban', () => ({
  getComments: vi.fn().mockResolvedValue([]),
  createComment: vi.fn(),
  deleteComment: vi.fn(),
  assignCard: vi.fn(),
  unassignCard: vi.fn(),
  moveCard: vi.fn(),
}));

vi.mock('@/api/endpoints/projects', () => ({
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

describe('KanbanCardModal', () => {
  beforeEach(() => {
    useAppStore.setState({
      projects: [],
      staff: [],
      currentUser: { id: 1, role: 'admin' } as never,
    });
    useUIStore.getState().openKanbanCardModal('subphase', 10, 1);
  });

  it('renders nothing when a different modal is active', () => {
    useUIStore.getState().closeModal();
    const { container } = render(<KanbanCardModal />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does NOT close when the overlay (backdrop) is clicked', () => {
    render(<KanbanCardModal />);
    const closeModal = vi.spyOn(useUIStore.getState(), 'closeModal');
    fireEvent.click(screen.getByRole('dialog'));
    expect(closeModal).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeModal).toBe('kanbanCard');
  });

  it('closes on Escape', () => {
    render(<KanbanCardModal />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it('closes via the close button', () => {
    render(<KanbanCardModal />);
    fireEvent.click(screen.getByLabelText('Close modal'));
    expect(useUIStore.getState().activeModal).toBeNull();
  });
});
