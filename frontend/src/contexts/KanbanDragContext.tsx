/**
 * Kanban drag-and-drop.
 *
 * Hand-rolled on HTML5 drag events, following ReorderContext (row reordering)
 * and useResourceDragDrop (resource assignment) -- the two existing DnD
 * implementations in this codebase. No DnD library is added.
 *
 * The move is optimistic: the card jumps columns immediately, the request
 * follows, and a failure reloads from the server and clears undo history, per
 * the optimistic-write failure protocol.
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUndoStore } from '@/stores/undoStore';
import { loadAllProjects } from '@/api/endpoints/projects';
import { moveCard } from '@/api/endpoints/kanban';
import { applyStatusToCard, type KanbanCard } from '@/utils/kanbanCards';
import type { CardStatus, Phase, Project, Subphase } from '@/types';

interface DragPayload {
  kind: 'kanban-card';
  entityType: 'phase' | 'subphase';
  entityId: number;
  projectId: number;
  fromStatus: CardStatus;
  cardKey: string;
}

interface DropTarget {
  laneKey: string;
  status: CardStatus;
}

interface KanbanDragContextValue {
  draggingCardKey: string | null;
  dropTarget: DropTarget | null;
  handleDragStart: (e: React.DragEvent, card: KanbanCard) => void;
  handleDragEnd: () => void;
  handleDragOver: (e: React.DragEvent, laneKey: string, status: CardStatus) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent, laneKey: string, status: CardStatus) => void;
}

const KanbanDragContext = createContext<KanbanDragContextValue | null>(null);

export function useKanbanDrag(): KanbanDragContextValue {
  const ctx = useContext(KanbanDragContext);
  if (!ctx) throw new Error('useKanbanDrag must be used within a KanbanDragProvider');
  return ctx;
}

/** Walk a cloned project tree and return the phase/subphase with this id. */
function findCardInProject(
  project: Project,
  entityType: 'phase' | 'subphase',
  entityId: number
): Phase | Subphase | null {
  for (const phase of project.phases ?? []) {
    if (entityType === 'phase' && phase.id === entityId) return phase;
    const found = findInSubphases(phase.children ?? [], entityId);
    if (entityType === 'subphase' && found) return found;
  }
  return null;
}

function findInSubphases(subphases: Subphase[], entityId: number): Subphase | null {
  for (const sub of subphases) {
    if (sub.id === entityId) return sub;
    const found = findInSubphases(sub.children ?? [], entityId);
    if (found) return found;
  }
  return null;
}

export function KanbanDragProvider({ children }: { children: ReactNode }) {
  const [draggingCardKey, setDraggingCardKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  // dataTransfer.getData() returns "" during dragover in every major browser,
  // so the payload is mirrored into a ref for the highlight/drop logic.
  const payloadRef = useRef<DragPayload | null>(null);
  const dragImageRef = useRef<HTMLElement | null>(null);

  const cleanup = useCallback(() => {
    if (dragImageRef.current) {
      dragImageRef.current.remove();
      dragImageRef.current = null;
    }
    payloadRef.current = null;
    setDraggingCardKey(null);
    setDropTarget(null);
    document.body.classList.remove('kanban-dragging');
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent, card: KanbanCard) => {
    const payload: DragPayload = {
      kind: 'kanban-card',
      entityType: card.entityType,
      entityId: card.entityId,
      projectId: card.projectId,
      fromStatus: card.status,
      cardKey: card.key,
    };

    payloadRef.current = payload;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/json', JSON.stringify(payload));

    // Custom drag image: clone the card offscreen so the ghost matches the card
    // rather than the browser's default translucent snapshot.
    const node = e.currentTarget as HTMLElement;
    const rect = node.getBoundingClientRect();
    const clone = node.cloneNode(true) as HTMLElement;
    clone.style.position = 'absolute';
    clone.style.top = '-1000px';
    clone.style.left = '-1000px';
    clone.style.width = `${rect.width}px`;
    clone.style.opacity = '0.9';
    document.body.appendChild(clone);
    dragImageRef.current = clone;
    e.dataTransfer.setDragImage(clone, 20, rect.height / 2);

    setDraggingCardKey(card.key);
    document.body.classList.add('kanban-dragging');
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent, laneKey: string, status: CardStatus) => {
      if (!payloadRef.current) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget((prev) =>
        prev?.laneKey === laneKey && prev?.status === status ? prev : { laneKey, status }
      );
    },
    []
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Moving onto a child element fires dragleave on the parent; ignore those
    // or the highlight flickers constantly.
    const related = e.relatedTarget as Node | null;
    if (related && (e.currentTarget as HTMLElement).contains(related)) return;
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, _laneKey: string, status: CardStatus) => {
      e.preventDefault();
      const payload = payloadRef.current;
      cleanup();

      if (!payload || payload.kind !== 'kanban-card') return;
      if (payload.fromStatus === status) return; // dropped back where it started

      void commitMove(payload, status);
    },
    [cleanup]
  );

  return (
    <KanbanDragContext.Provider
      value={{
        draggingCardKey,
        dropTarget,
        handleDragStart,
        handleDragEnd: cleanup,
        handleDragOver,
        handleDragLeave,
        handleDrop,
      }}
    >
      {children}
    </KanbanDragContext.Provider>
  );
}

/**
 * Optimistic move, then persist.
 *
 * Deliberately does NOT go through savePendingUpdates: PendingUpdate is
 * date-only and cannot express a status, and it swallows per-item errors, which
 * would leave the board silently diverged from the database.
 */
async function commitMove(payload: DragPayload, status: CardStatus): Promise<void> {
  const { setProjects } = useAppStore.getState();
  const projects = useAppStore.getState().projects;

  const next = structuredClone(projects) as Project[];
  const project = next.find((p) => p.id === payload.projectId);
  if (!project) return;

  const card = findCardInProject(project, payload.entityType, payload.entityId);
  if (!card) return;

  const optimistic = applyStatusToCard(card, status);
  setProjects(next);

  try {
    const result = await moveCard(payload.entityType, payload.entityId, status);

    // Reconcile against the server's echo. Skipped in What-If mode, where the
    // response is a synthetic success and the local state is the truth.
    if (
      !result?.whatIfMode &&
      result &&
      (result.status !== optimistic.status || result.completion !== optimistic.completion)
    ) {
      const reconciled = structuredClone(useAppStore.getState().projects) as Project[];
      const p = reconciled.find((x) => x.id === payload.projectId);
      const c = p && findCardInProject(p, payload.entityType, payload.entityId);
      if (c) {
        c.status = result.status;
        c.completion = result.completion;
        useAppStore.getState().setProjects(reconciled);
      }
    }
  } catch (err) {
    console.error('[Kanban] Failed to move card:', err);
    // Optimistic-write failure protocol: reload from the server and drop the
    // undo stack, which is now stale against fresh server state.
    try {
      useAppStore.getState().setProjects(await loadAllProjects());
    } catch (reloadErr) {
      console.error('[Kanban] Reload after failed move also failed:', reloadErr);
    }
    useUndoStore.getState().clear();
    window.alert('Could not move the card. The board has been refreshed.');
  }
}
