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

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { getCommentCounts } from '@/api/endpoints/kanban';
import {
  collectProjectCards,
  groupCards,
  type KanbanCard as KanbanCardData,
} from '@/utils/kanbanCards';
import { KanbanDragProvider, useKanbanDrag } from '@/contexts/KanbanDragContext';
import { useUIStore } from '@/stores/uiStore';
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

  const siteProjects = useMemo(
    () =>
      projects
        .filter((p) => p.site_id === currentSite?.id && !p.archived)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projects, currentSite?.id]
  );

  // Resolve the board's project: the persisted choice if it is still valid for
  // this site, otherwise the first project.
  const activeProject = useMemo(() => {
    if (siteProjects.length === 0) return null;
    return siteProjects.find((p) => p.id === kanbanProjectId) ?? siteProjects[0];
  }, [siteProjects, kanbanProjectId]);

  // Keep the persisted id in step when it was stale (e.g. after a site switch).
  useEffect(() => {
    if (activeProject && activeProject.id !== kanbanProjectId) {
      setKanbanProjectId(activeProject.id);
    }
  }, [activeProject, kanbanProjectId, setKanbanProjectId]);

  // Comment counts are fetched only by this view - deliberately NOT folded into
  // GET /projects/{id}, which loadAllProjects() calls once per project.
  useEffect(() => {
    let cancelled = false;
    if (!activeProject) {
      setCommentCounts(new Map());
      return;
    }
    getCommentCounts(activeProject.id)
      .then((counts) => {
        if (!cancelled) setCommentCounts(counts);
      })
      .catch((err) => console.error('[Kanban] Failed to load comment counts:', err));
    return () => {
      cancelled = true;
    };
  }, [activeProject]);

  const allCards = useMemo(
    () => (activeProject ? collectProjectCards(activeProject) : []),
    [activeProject]
  );

  const visibleCards = useMemo(() => {
    if (!myTodoOnly || !currentUser) return allCards;
    return allCards.filter((c) => c.assigneeIds.includes(currentUser.id));
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
      project: activeProject ?? undefined,
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
    activeProject,
    staff,
  ]);

  const openKanbanCard = useUIStore((s) => s.openKanbanCardModal);

  // Mirror the server gate (app/services/card_access.py) so a card the server
  // would reject with 403 is not draggable in the first place.
  const isPrivileged = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  const canMoveCard = (card: KanbanCardData) =>
    Boolean(isPrivileged || (currentUser && card.assigneeIds.includes(currentUser.id)));

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
        projects={siteProjects}
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

      <KanbanDragProvider>
        <DraggableBoard
          lanes={lanes}
          showLaneHeaders={grouping !== 'none'}
          commentCounts={commentCounts}
          canMoveCard={canMoveCard}
          onOpenCard={handleOpenCard}
        />
      </KanbanDragProvider>
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
