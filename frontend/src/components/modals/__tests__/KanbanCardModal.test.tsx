/**
 * The no-backdrop-close rule is CI-enforced (see CLAUDE.md and Modal.test.tsx).
 * A comment half-typed into this modal must survive a stray click on the
 * backdrop, which is exactly what a text-selection drag ending outside does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { KanbanCardModal } from '../KanbanCardModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { createComment } from '@/api/endpoints/kanban';
import type { Phase, Project, Subphase } from '@/types';

vi.mock('@/api/endpoints/kanban', () => ({
  getComments: vi.fn().mockResolvedValue([]),
  createComment: vi.fn().mockResolvedValue({}),
  deleteComment: vi.fn(),
  assignCard: vi.fn(),
  unassignCard: vi.fn(),
  moveCard: vi.fn(),
}));

vi.mock('@/api/endpoints/projects', () => ({
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

// The modal derives its card from appStore.projects, so an empty store renders
// "This card no longer exists" and the composer never mounts.
function seedProject(): Project {
  const sub: Subphase = {
    id: 10,
    project_id: 1,
    parent_phase_id: 1,
    parent_subphase_id: null,
    name: 'DoE setup',
    start_date: '2026-09-01',
    end_date: '2026-09-14',
    color: '#06b6d4',
    order_index: 0,
    completion: null,
    status: 'todo',
    is_milestone: false,
    dependencies: [],
    children: [],
    staffAssignments: [
      {
        id: 1,
        staff_id: 4,
        staff_name: 'Bob Brown',
        allocation: 80,
        start_date: '2026-09-01',
        end_date: '2026-09-14',
      },
    ],
    equipmentAssignments: [],
  };

  const phase: Phase = {
    id: 1,
    project_id: 1,
    name: 'Design',
    start_date: '2026-09-01',
    end_date: '2026-09-30',
    color: '#000',
    order_index: 0,
    completion: null,
    status: 'todo',
    is_milestone: false,
    dependencies: [],
    children: [sub],
    staffAssignments: [],
    equipmentAssignments: [],
  };

  return {
    id: 1,
    name: 'Bioprocess Scale-Up',
    site_id: 1,
    confirmed: true,
    archived: false,
    phases: [phase],
    staffAssignments: [],
    equipmentAssignments: [],
  } as unknown as Project;
}

function seedStore() {
  useAppStore.setState({
    projects: [seedProject()],
    staff: [
      { id: 7, name: 'Alice Anderson', site_id: 1, active: true, role: 'Engineer' },
      // Same user on a second site — the picker must not show them twice.
      { id: 7, name: 'Alice Anderson', site_id: 2, active: true, role: 'Engineer' },
      { id: 4, name: 'Bob Brown', site_id: 1, active: true, role: 'Analyst' },
    ] as never,
    currentUser: { id: 1, role: 'admin' } as never,
  });
  useUIStore.getState().openKanbanCardModal('subphase', 10, 1);
}

const composer = () => screen.getByLabelText('Comment') as HTMLTextAreaElement;

/**
 * Scope option queries to the mention listbox: the assignee <select> on this
 * same modal is full of native <option> elements, which carry the same role.
 */
const mentionOptions = () => within(screen.getByRole('listbox')).getAllByRole('option');

/** fireEvent.change does not move the caret; the component reads selectionStart. */
function type(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value, selectionStart: value.length } });
}

/**
 * A real browser follows every keydown with a keyup, and the component tracks
 * the caret on keyup. Firing only keydown hides bugs where the keyup path
 * undoes what keydown just did — which is exactly what happened once.
 */
function press(textarea: HTMLTextAreaElement, key: string) {
  fireEvent.keyDown(textarea, { key });
  fireEvent.keyUp(textarea, { key });
}

describe('KanbanCardModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedStore();
  });

  it('renders nothing when a different modal is active', () => {
    useUIStore.getState().closeModal();
    const { container } = render(<KanbanCardModal />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the card and its composer', () => {
    render(<KanbanCardModal />);
    expect(screen.getByText('Design / DoE setup')).toBeInTheDocument();
    expect(composer()).toBeInTheDocument();
  });

  it('does NOT close when the overlay (backdrop) is clicked', () => {
    render(<KanbanCardModal />);
    fireEvent.click(screen.getByRole('dialog'));
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

describe('KanbanCardModal @-mentions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedStore();
  });

  it('opens the picker on @ with the card assignee first', () => {
    render(<KanbanCardModal />);
    type(composer(), 'hi @');

    const options = mentionOptions();
    expect(options[0]).toHaveTextContent('Bob Brown'); // assigned to this card
    expect(screen.getByText('On this card')).toBeInTheDocument();
  });

  it('lists a multi-site person only once', () => {
    render(<KanbanCardModal />);
    type(composer(), '@');
    const listed = mentionOptions().filter((o) => o.textContent?.includes('Alice Anderson'));
    expect(listed).toHaveLength(1);
  });

  it('excludes the current user, who cannot be notified anyway', () => {
    useAppStore.setState({ currentUser: { id: 7, role: 'admin' } as never });
    render(<KanbanCardModal />);
    type(composer(), '@');
    expect(mentionOptions().some((o) => o.textContent?.includes('Alice Anderson'))).toBe(false);
  });

  it('filters as you type', () => {
    render(<KanbanCardModal />);
    type(composer(), '@Ali');
    const options = mentionOptions();
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Alice Anderson');
  });

  it('closes the picker when nothing matches', () => {
    render(<KanbanCardModal />);
    type(composer(), '@zzzz');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('inserts the mention with ArrowDown then Enter', () => {
    render(<KanbanCardModal />);
    const textarea = composer();
    type(textarea, 'hi @Ali');

    press(textarea, 'ArrowDown');
    press(textarea, 'Enter');

    expect(textarea.value).toBe('hi @Alice Anderson ');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does not swallow Enter when nothing is highlighted', () => {
    render(<KanbanCardModal />);
    const textarea = composer();
    type(textarea, 'hi @Ali');

    // No ArrowDown: Enter must fall through as a newline, not pick a mention.
    press(textarea, 'Enter');
    expect(textarea.value).toBe('hi @Ali');
  });

  it('sends a token body and the mentioned id', async () => {
    render(<KanbanCardModal />);
    const textarea = composer();
    type(textarea, 'ping @Ali');
    press(textarea, 'ArrowDown');
    press(textarea, 'Enter');

    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    expect(createComment).toHaveBeenCalledWith(
      'subphase',
      10,
      'ping @[Alice Anderson](7)',
      [7]
    );
  });

  it('demotes a mention whose text is edited, so it notifies nobody', () => {
    render(<KanbanCardModal />);
    const textarea = composer();
    type(textarea, '@Ali');
    press(textarea, 'ArrowDown');
    press(textarea, 'Enter');

    // Mangle the inserted name — the anchor must drop.
    type(textarea, '@Alice Andersonx');
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    expect(createComment).toHaveBeenCalledWith('subphase', 10, '@Alice Andersonx', []);
  });

  it('does not notify a hand-typed name', () => {
    render(<KanbanCardModal />);
    type(composer(), 'thanks @Bob Brown');
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    expect(createComment).toHaveBeenCalledWith('subphase', 10, 'thanks @Bob Brown', []);
  });

  // The regression guard for the Escape-propagation trap: Modal listens on
  // document, and React's synthetic stopPropagation does not stop it.
  it('Escape closes only the picker, leaving the modal open', () => {
    render(<KanbanCardModal />);
    const textarea = composer();
    type(textarea, '@Ali');
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    press(textarea, 'Escape');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(useUIStore.getState().activeModal).toBe('kanbanCard');
  });

  it('a second Escape then closes the modal', () => {
    render(<KanbanCardModal />);
    const textarea = composer();
    type(textarea, '@Ali');
    press(textarea, 'Escape');
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it('keeps the highlight between ArrowDown and Enter', () => {
    // Regression: the caret tracker ran on keyup and reset the active option,
    // so Enter fell through and inserted a newline instead of the mention.
    render(<KanbanCardModal />);
    const textarea = composer();
    type(textarea, '@Ali');
    press(textarea, 'ArrowDown');
    press(textarea, 'Enter');
    expect(textarea.value).toBe('@Alice Anderson ');
  });

  it('stays closed after Escape until the text changes', () => {
    // Regression: the keyup after Escape recomputed the query and reopened it.
    render(<KanbanCardModal />);
    const textarea = composer();
    type(textarea, '@Ali');
    press(textarea, 'Escape');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    // A click elsewhere in the field must not revive it either.
    fireEvent.click(textarea);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    // Typing does.
    type(textarea, '@Alic');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('does not open the picker inside an email address', () => {
    render(<KanbanCardModal />);
    type(composer(), 'mail bob@exa');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('renders a mirror for the highlight overlay', () => {
    // The modal renders through a portal, so it is not inside `container`.
    render(<KanbanCardModal />);
    expect(document.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });
});
