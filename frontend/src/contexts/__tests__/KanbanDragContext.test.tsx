/**
 * Kanban drag-and-drop: drag start/over/leave/drop state, the optimistic card
 * move, reconciliation against the server echo, the What-If skip, and the
 * failure protocol (the shared recoverFromPersistFailure: reload from the
 * server, clear undo; then tell the user).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { KanbanDragProvider, useKanbanDrag } from '../KanbanDragContext';
import { moveCard } from '@/api/endpoints/kanban';
import { loadAllProjects } from '@/api/endpoints/projects';
import { useAppStore } from '@/stores/appStore';
import { useUndoStore } from '@/stores/undoStore';
import { resetAllStores } from '@/stores';
import { makePhase, makeProject, makeSubphase } from '@/test/factories';
import type { KanbanCard } from '@/utils/kanbanCards';
import type { CardStatus } from '@/types';

vi.mock('@/api/endpoints/kanban', () => ({ moveCard: vi.fn() }));
vi.mock('@/api/endpoints/projects', () => ({ loadAllProjects: vi.fn() }));

function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    entityType: 'subphase',
    entityId: 20,
    key: 'subphase-20',
    projectId: 1,
    projectName: 'Bioprocess Scale-Up',
    name: 'Lab work',
    startDate: '2026-01-05',
    endDate: '2026-01-30',
    status: 'todo',
    completion: 0,
    isMilestone: false,
    color: '#000',
    orderIndex: 0,
    depth: 1,
    assignments: [],
    assigneeIds: [],
    swimlanePhaseId: 10,
    swimlanePhaseName: 'Feasibility',
    path: 'Feasibility / Lab work',
    ...overrides,
  };
}

function Board({ dragged }: { dragged: KanbanCard }) {
  const drag = useKanbanDrag();
  const lane = (status: CardStatus) => (
    <div
      data-testid={`lane-${status}`}
      onDragOver={(e) => drag.handleDragOver(e, 'lane', status)}
      onDragLeave={drag.handleDragLeave}
      onDrop={(e) => drag.handleDrop(e, 'lane', status)}
    >
      <span data-testid={`inner-${status}`}>inner</span>
    </div>
  );
  const target = drag.dropTarget ? `${drag.dropTarget.laneKey}:${drag.dropTarget.status}` : 'none';
  return (
    <div data-testid="board">
      <div
        data-testid="card"
        draggable
        onDragStart={(e) => drag.handleDragStart(e, dragged)}
        onDragEnd={drag.handleDragEnd}
      >
        {dragged.name}
      </div>
      {lane('todo')}
      {lane('done')}
      {lane('in_progress')}
      <output data-testid="state">
        {drag.draggingCardKey ?? 'none'}|{target}
      </output>
    </div>
  );
}

function dataTransfer() {
  return { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '', dropEffect: '' };
}

// The drag image is a clone of the card appended to <body>: query inside the board.
const el = (id: string) => within(screen.getByTestId('board')).getByTestId(id);
const state = () => el('state').textContent;

/** jsdom has no DragEvent: testing-library drops `relatedTarget`, so set it on the event. */
function dragLeave(target: HTMLElement, relatedTarget: Node | null) {
  const event = createEvent.dragLeave(target);
  Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
  fireEvent(target, event);
}

function seedProject() {
  const sub = makeSubphase({ id: 20, status: 'todo', completion: 0 });
  const phase = makePhase({ id: 10, status: 'todo', completion: 0, children: [sub] });
  const leaf = makePhase({ id: 11, status: 'todo', completion: 0 });
  useAppStore.setState({ projects: [makeProject({ id: 1, phases: [phase, leaf] })] });
}

const storedSub = () => useAppStore.getState().projects[0].phases[0].children[0];

function renderBoard(dragged = card()) {
  return render(
    <KanbanDragProvider>
      <Board dragged={dragged} />
    </KanbanDragProvider>
  );
}

function dragTo(status: CardStatus) {
  const dt = dataTransfer();
  fireEvent.dragStart(el('card'), { dataTransfer: dt });
  fireEvent.dragOver(el(`lane-${status}`), { dataTransfer: dt });
  fireEvent.drop(el(`lane-${status}`), { dataTransfer: dt });
  return dt;
}

beforeEach(() => {
  resetAllStores();
  vi.mocked(moveCard).mockReset();
  vi.mocked(loadAllProjects).mockReset();
  seedProject();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KanbanDragProvider', () => {
  it('tracks the dragged card, a drag image and the hovered lane, and cleans up on drag end', () => {
    renderBoard();
    const dt = dataTransfer();
    // dragover before any drag started is ignored
    fireEvent.dragOver(el('lane-done'), { dataTransfer: dt });
    expect(state()).toBe('none|none');

    fireEvent.dragStart(el('card'), { dataTransfer: dt });
    expect(dt.effectAllowed).toBe('move');
    expect(dt.setData).toHaveBeenCalledWith(
      'application/json',
      expect.stringContaining('"cardKey":"subphase-20"')
    );
    expect(dt.setDragImage).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains('kanban-dragging')).toBe(true);
    expect(state()).toBe('subphase-20|none');

    fireEvent.dragOver(el('lane-done'), { dataTransfer: dt });
    expect(dt.dropEffect).toBe('move');
    expect(state()).toBe('subphase-20|lane:done');

    // Leaving onto a child keeps the highlight; leaving the lane clears it.
    dragLeave(el('lane-done'), el('inner-done'));
    expect(state()).toBe('subphase-20|lane:done');
    dragLeave(el('lane-done'), null);
    expect(state()).toBe('subphase-20|none');

    fireEvent.dragEnd(el('card'));
    expect(state()).toBe('none|none');
    expect(document.body.classList.contains('kanban-dragging')).toBe(false);
    const ghost = (dt.setDragImage.mock.calls[0] as unknown[])[0] as HTMLElement;
    expect(document.body.contains(ghost)).toBe(false);
  });

  it('ignores a drop back onto the original column', () => {
    renderBoard();
    dragTo('todo');
    expect(moveCard).not.toHaveBeenCalled();
    expect(state()).toBe('none|none');
  });

  it('ignores a drop without a drag in progress', () => {
    renderBoard();
    fireEvent.drop(el('lane-done'));
    expect(moveCard).not.toHaveBeenCalled();
  });

  it('moves the card optimistically and keeps it when the server agrees', async () => {
    vi.mocked(moveCard).mockResolvedValue({ success: true, status: 'done', completion: 100 });
    renderBoard();
    dragTo('done');
    expect(storedSub()).toMatchObject({ status: 'done', completion: 100 });
    await waitFor(() => expect(moveCard).toHaveBeenCalledWith('subphase', 20, 'done'));
    expect(storedSub()).toMatchObject({ status: 'done', completion: 100 });
  });

  it('reconciles a leaf phase against the server echo', async () => {
    vi.mocked(moveCard).mockResolvedValue({ success: true, status: 'in_progress', completion: 35 });
    renderBoard(card({ entityType: 'phase', entityId: 11, key: 'phase-11' }));
    dragTo('in_progress');
    await waitFor(() =>
      expect(useAppStore.getState().projects[0].phases[1]).toMatchObject({
        status: 'in_progress',
        completion: 35,
      })
    );
  });

  it('keeps the optimistic state for a What-If synthetic response', async () => {
    vi.mocked(moveCard).mockResolvedValue({ success: true, whatIfMode: true } as never);
    renderBoard();
    dragTo('done');
    await waitFor(() => expect(moveCard).toHaveBeenCalled());
    await act(async () => {});
    expect(storedSub()).toMatchObject({ status: 'done', completion: 100 });
  });

  it('does nothing for a card or project that is no longer in the store', () => {
    const view = renderBoard(card({ entityId: 999, key: 'subphase-999' }));
    dragTo('done');
    view.unmount();
    renderBoard(card({ projectId: 42 }));
    dragTo('done');
    expect(moveCard).not.toHaveBeenCalled();
    expect(storedSub().status).toBe('todo');
  });

  it('reloads, clears undo and alerts when the move fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.mocked(moveCard).mockRejectedValue(new Error('403'));
    const fresh = [makeProject({ id: 1, name: 'From server' })];
    vi.mocked(loadAllProjects).mockResolvedValue(fresh);
    useUndoStore.getState().saveState([], 'earlier edit');

    renderBoard();
    dragTo('done');
    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith('Could not move the card. The board has been refreshed.')
    );
    expect(useAppStore.getState().projects).toBe(fresh);
    expect(useUndoStore.getState().canUndo).toBe(false);
    expect(error).toHaveBeenCalledWith(
      '[Kanban] persist failed, reloading from the server:',
      expect.any(Error)
    );
  });

  it('still clears undo when the reload after a failure also fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.mocked(moveCard).mockRejectedValue(new Error('500'));
    vi.mocked(loadAllProjects).mockRejectedValue(new Error('offline'));
    useUndoStore.getState().saveState([], 'earlier edit');

    renderBoard();
    dragTo('done');
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        '[Kanban] reload after failed persist also failed:',
        expect.any(Error)
      )
    );
    expect(useUndoStore.getState().canUndo).toBe(false);
  });

  // Last: a render that throws leaves React's root in a state RTL's cleanup
  // does not fully undo.
  it('throws when used outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const silence = (e: ErrorEvent) => e.preventDefault();
    window.addEventListener('error', silence);
    expect(() => render(<Board dragged={card()} />)).toThrow(
      'useKanbanDrag must be used within a KanbanDragProvider'
    );
    window.removeEventListener('error', silence);
  });
});
