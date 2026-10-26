/**
 * Kanban View
 *
 * One board per project, rendering the same records as the Gantt chart:
 * a card is a leaf phase or subphase (see utils/kanbanCards.ts). Columns are
 * the card status; swimlanes are the chosen grouping.
 *
 * The board needs no dedicated endpoint - GET /projects/{id} already returns
 * the whole tree, so everything here derives from appStore.projects and
 * converges through the existing `change:phase` WebSocket refetch.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { getCommentCounts, getSiteCommentCounts } from '@/api/endpoints/kanban';
import {
  collectCardsForProjects,
  groupCards,
  type KanbanCard as KanbanCardData,
} from '@/utils/kanbanCards';
import { orderSiteProjects } from '@/utils/storage';
import { can } from '@/utils/permissions';
import { useFilteredProjects } from '@/hooks/useProjectFilter';
import { useTeamFilteredProjects } from '@/hooks/useTeamFilter';
import { KanbanDragProvider, useKanbanDrag } from '@/contexts/KanbanDragContext';
import { useUIStore } from '@/stores/uiStore';
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import { KanbanToolbar } from './KanbanToolbar';
import { KanbanBoard } from './KanbanBoard';
import styles from './KanbanView.module.css';

export function KanbanView() {
  // Read the raw slice and filter locally: selectSiteProjects allocates a new
  // array on every call, which re-renders on any store change (see ArchivedView).
  const projects = useAppStore((s) => s.projects);
  const currentSite = useAppStore((s) => s.currentSite);
  const currentUser = useAppStore((s) => s.currentUser);
  const staff = useAppStore((s) => s.staff);

  const kanbanProjectId = useViewStore((s) => s.kanbanProjectId);
  const setKanbanProjectId = useViewStore((s) => s.setKanbanProjectId);
  const grouping = useViewStore((s) => s.kanbanGrouping);
  const groupingColumnId = useViewStore((s) => s.kanbanGroupingColumnId);
  const setKanbanGrouping = useViewStore((s) => s.setKanbanGrouping);
  const myTodoOnly = useViewStore((s) => s.kanbanMyTodoOnly);
  const toggleMyTodo = useViewStore((s) => s.toggleKanbanMyTodoOnly);

  const customColumns = useCustomColumnStore((s) => s.customColumns);
  const customColumnValues = useCustomColumnStore((s) => s.customColumnValues);

  const [commentCounts, setCommentCounts] = useState<Map<string, number>>(new Map());

  // Same ordering the Gantt uses, so the two views agree.
  const siteProjects = useMemo(
    () => orderSiteProjects(projects, currentSite?.id),
    [projects, currentSite?.id]
  );

  // The per-site project and team filters (shared with the Gantt) narrow the
  // picker and the "All projects" board.
  const filteredProjects = useTeamFilteredProjects(useFilteredProjects(siteProjects));

  // A null id means "All projects"; a stale id (e.g. after a site switch, or a
  // project the filter now hides) also falls back to showing everything
  // rather than silently picking one.
  const activeProject = useMemo(
    () =>
      kanbanProjectId === null
        ? null
        : filteredProjects.find((p) => p.id === kanbanProjectId) ?? null,
    [filteredProjects, kanbanProjectId]
  );

  /** The projects on the board, in Gantt order. */
  const boardProjects = useMemo(
    () => (activeProject ? [activeProject] : filteredProjects),
    [activeProject, filteredProjects]
  );

  // Comment counts are fetched only by this view - deliberately NOT folded into
  // GET /projects/{id}, which loadAllProjects() calls once per project.
  //
  // Keyed on ids, not on the project object: every projects refetch (each WS
  // change) replaces the object and used to re-request the counts. They are
  // refetched when they can actually have changed instead: another user's
  // comment (a `card_comment` change) or this user closing a card, whose
  // modal is where comments are written.
  const activeProjectId = activeProject?.id ?? null;
  const currentSiteId = currentSite?.id ?? null;
  const cardModalOpen = useUIStore((s) => s.activeModal === 'kanbanCard');
  const { recentChanges } = useWebSocketContext();
  const latestCommentChange = useMemo(
    () =>
      recentChanges.reduce(
        (latest, c) => (c.entity_type === 'card_comment' ? Math.max(latest, c._receivedAt ?? 0) : latest),
        0
      ),
    [recentChanges]
  );
  // recentChanges expires entries after 30 s; only a newer change refetches.
  const [commentRevision, setCommentRevision] = useState(0);
  const lastCommentChangeRef = useRef(0);
  useEffect(() => {
    if (latestCommentChange > lastCommentChangeRef.current) {
      lastCommentChangeRef.current = latestCommentChange;
      setCommentRevision((r) => r + 1);
    }
  }, [latestCommentChange]);

  useEffect(() => {
    if (cardModalOpen) return;
    let cancelled = false;
    // One site-wide query for "All projects" rather than one request per board.
    const load = activeProjectId !== null
      ? getCommentCounts(activeProjectId)
      : currentSiteId !== null
        ? getSiteCommentCounts(currentSiteId)
        : null;
    if (!load) {
      setCommentCounts(new Map());
      return;
    }
    load
      .then((counts) => {
        if (!cancelled) setCommentCounts(counts);
      })
      .catch((err) => console.error('[Kanban] Failed to load comment counts:', err));
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, currentSiteId, cardModalOpen, commentRevision]);

  const allCards = useMemo(() => collectCardsForProjects(boardProjects), [boardProjects]);

  // My Todo: the cards I am on, and the ones I asked to join (my booking
  // awaits approval; the card shows a pending badge).
  const visibleCards = useMemo(() => {
    if (!myTodoOnly || !currentUser) return allCards;
    return allCards.filter(
      (c) => c.assigneeIds.includes(currentUser.id) || c.pendingAssigneeIds.includes(currentUser.id)
    );
  }, [allCards, myTodoOnly, currentUser]);

  const listColumns = useMemo(
    () => customColumns.filter((c) => c.column_type === 'list'),
    [customColumns]
  );

  const lanes = useMemo(() => {
    const staffNames = new Map(staff.map((s) => [s.id, s.name]));
    const column = listColumns.find((c) => c.id === groupingColumnId);
    const customValues = new Map<string, string | undefined>();
    if (column) {
      for (const card of visibleCards) {
        customValues.set(
          card.key,
          customColumnValues[`${column.id}-${card.entityType}-${card.entityId}`] ?? undefined
        );
      }
    }
    return groupCards(visibleCards, grouping, {
      projects: boardProjects,
      staffNames,
      customValues,
      customOptions: column?.list_options ?? [],
    });
  }, [
    visibleCards,
    grouping,
    groupingColumnId,
    listColumns,
    customColumnValues,
    boardProjects,
    staff,
  ]);

  const openKanbanCard = useUIStore((s) => s.openKanbanCardModal);

  // Mirror the server gate (app/services/card_access.py) so a card the server
  // would reject with 403 is not draggable in the first place: kanban.move_any
  // (or managing the project), or kanban.move_assigned on the card's assignees.
  const canMoveCard = (card: KanbanCardData) =>
    can(currentUser, 'kanban.move_any', projects.find((p) => p.id === card.projectId)) ||
    Boolean(currentUser && card.assigneeIds.includes(currentUser.id) && can(currentUser, 'kanban.move_assigned'));

  const handleOpenCard = (card: KanbanCardData) => {
    openKanbanCard(card.entityType, card.entityId, card.projectId);
  };

  if (!currentSite) {
    return <div className={styles.placeholder}>Select a site to see its boards.</div>;
  }

  if (siteProjects.length === 0) {
    return (
      <div className={styles.placeholder}>
        No active projects in {currentSite.name}. Create a project to start a board.
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <KanbanToolbar
        projects={filteredProjects}
        selectedProjectId={activeProject?.id ?? null}
        onSelectProject={setKanbanProjectId}
        grouping={grouping}
        groupingColumnId={groupingColumnId}
        listColumns={listColumns}
        onChangeGrouping={setKanbanGrouping}
        myTodoOnly={myTodoOnly}
        onToggleMyTodo={toggleMyTodo}
        cardCount={visibleCards.length}
        totalCount={allCards.length}
      />

      {filteredProjects.length === 0 ? (
        // Keep the toolbar (and its filter) reachable so the filter can be cleared.
        <div className={styles.placeholder}>
          No projects in {currentSite.name} match the filter.
        </div>
      ) : (
        <KanbanDragProvider>
          <DraggableBoard
            lanes={lanes}
            showLaneHeaders={grouping !== 'none'}
            commentCounts={commentCounts}
            canMoveCard={canMoveCard}
            onOpenCard={handleOpenCard}
          />
        </KanbanDragProvider>
      )}
    </div>
  );
}

/**
 * Thin wrapper so the board can consume the drag context, which only exists
 * below KanbanDragProvider.
 */
function DraggableBoard(props: {
  lanes: ReturnType<typeof groupCards>;
  showLaneHeaders: boolean;
  commentCounts: Map<string, number>;
  canMoveCard: (card: KanbanCardData) => boolean;
  onOpenCard: (card: KanbanCardData) => void;
}) {
  const {
    draggingCardKey,
    dropTarget,
    handleDragStart,
    handleDragEnd,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useKanbanDrag();

  return (
    <KanbanBoard
      {...props}
      onCardDragStart={handleDragStart}
      onCardDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      dropTarget={dropTarget}
      draggingCardKey={draggingCardKey}
    />
  );
}
