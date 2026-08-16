import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KanbanCard } from './KanbanCard';
import type { KanbanCard as KanbanCardData } from '@/utils/kanbanCards';

function makeCard(over: Partial<KanbanCardData> = {}): KanbanCardData {
  return {
    entityType: 'subphase',
    entityId: 10,
    key: 'subphase-10',
    projectId: 1,
    projectName: 'Bioprocess Scale-Up',
    name: 'DoE setup',
    startDate: '2026-09-01',
    endDate: '2026-09-14',
    status: 'todo',
    completion: null,
    isMilestone: false,
    color: '#06b6d4',
    orderIndex: 0,
    depth: 1,
    assignments: [],
    assigneeIds: [],
    swimlanePhaseId: 1,
    swimlanePhaseName: 'Design',
    path: 'Design / DoE setup',
    ...over,
  };
}

function renderCard(props: Partial<Parameters<typeof KanbanCard>[0]> = {}) {
  const onOpen = vi.fn();
  render(
    <KanbanCard
      card={makeCard()}
      commentCount={0}
      canMove={false}
      onOpen={onOpen}
      {...props}
    />
  );
  return onOpen;
}

describe('KanbanCard', () => {
  it('renders the card name and breadcrumb', () => {
    renderCard();
    expect(screen.getByText('DoE setup')).toBeInTheDocument();
    expect(screen.getByText('Design / DoE setup')).toBeInTheDocument();
  });

  it('opens the card when clicked', () => {
    const onOpen = renderCard();
    fireEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  // The board mirrors the server gate in app/services/card_access.py: a card
  // the server would reject with 403 must not be draggable in the first place.
  it('is not draggable for a user who is not assigned', () => {
    renderCard({ canMove: false });
    expect(screen.getByRole('button')).not.toHaveAttribute('draggable', 'true');
  });

  it('is draggable when the user may move it', () => {
    renderCard({ canMove: true, onDragStart: vi.fn() });
    expect(screen.getByRole('button')).toHaveAttribute('draggable', 'true');
  });

  it('does not fire drag handlers when the user may not move it', () => {
    const onDragStart = vi.fn();
    renderCard({ canMove: false, onDragStart });
    fireEvent.dragStart(screen.getByRole('button'));
    expect(onDragStart).not.toHaveBeenCalled();
  });

  it('shows a comment count only when there are comments', () => {
    const { unmount } = render(
      <KanbanCard card={makeCard()} commentCount={0} canMove={false} onOpen={vi.fn()} />
    );
    expect(screen.queryByTitle(/comment/)).not.toBeInTheDocument();
    unmount();

    render(<KanbanCard card={makeCard()} commentCount={3} canMove={false} onOpen={vi.fn()} />);
    expect(screen.getByTitle('3 comment(s)')).toBeInTheDocument();
  });

  it('marks a milestone card', () => {
    renderCard({ card: makeCard({ isMilestone: true }) });
    expect(screen.getByLabelText('DoE setup (milestone)')).toBeInTheDocument();
  });

  it('flags an overdue card that is not done', () => {
    renderCard({ card: makeCard({ endDate: '2020-01-01', status: 'in_progress' }) });
    expect(screen.getByText('Overdue')).toBeInTheDocument();
  });

  it('never flags a done card as overdue', () => {
    renderCard({ card: makeCard({ endDate: '2020-01-01', status: 'done' }) });
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
  });
});
