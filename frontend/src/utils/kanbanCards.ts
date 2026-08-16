/**
 * Kanban card derivation.
 *
 * The Kanban board is a second rendering of the Gantt tree, not a separate
 * dataset. A *card* is a leaf work item:
 *
 *   - a phase with no children          -> card (and its own swimlane)
 *   - a phase with children             -> swimlane, NOT a card
 *   - a subphase with no children       -> card, in its top-level phase's lane
 *   - a subphase with children          -> neither; it only contributes to the
 *                                          breadcrumb path of its descendants
 *
 * Milestones are leaves by construction, so they become cards (rendered with a
 * diamond marker). Excluding them would make their status unreachable from the
 * board while the status/completion sync kept mutating it invisibly.
 *
 * This module also mirrors app/services/card_status.py. The two must stay
 * byte-for-byte equivalent -- that mirror is what lets the board apply an
 * optimistic update that matches what the server will do. The shared matrix is
 * asserted on both sides (tests/test_card_status.py and
 * src/utils/__tests__/cardStatusMirror.test.ts).
 */

import type {
  CardStatus,
  Phase,
  Project,
  StaffAssignment,
  Subphase,
} from '@/types';

// =============================================================================
// STATUS <-> COMPLETION MIRROR (mirrors app/services/card_status.py)
// =============================================================================

export const CARD_STATUSES: CardStatus[] = ['todo', 'in_progress', 'blocked', 'done'];

export const STATUS_LABELS: Record<CardStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
};

/** Completion applied when a card enters In Progress with no real progress yet. */
export const DEFAULT_IN_PROGRESS_COMPLETION = 50;

/**
 * Derive the status implied by a completion percentage.
 * `blocked` survives an in-progress percentage: a percentage cannot express
 * *why* work has stalled, so editing the Gantt slider must not silently unblock.
 */
export function statusFromCompletion(
  completion: number | null | undefined,
  currentStatus: CardStatus | undefined
): CardStatus {
  if (completion === null || completion === undefined || completion <= 0) return 'todo';
  if (completion >= 100) return 'done';
  return currentStatus === 'blocked' ? 'blocked' : 'in_progress';
}

/**
 * Derive the completion implied by a status.
 * `blocked` deliberately leaves completion untouched.
 */
export function completionForStatus(
  status: CardStatus,
  currentCompletion: number | null | undefined
): number | null {
  if (status === 'todo') return 0;
  if (status === 'done') return 100;
  if (status === 'in_progress') {
    if (
      currentCompletion !== null &&
      currentCompletion !== undefined &&
      currentCompletion >= 1 &&
      currentCompletion <= 99
    ) {
      return currentCompletion;
    }
    return DEFAULT_IN_PROGRESS_COMPLETION;
  }
  return currentCompletion ?? null;
}

/**
 * Apply a status to a phase/subphase object in place, keeping completion in
 * step. Returns the resulting pair so callers can reconcile against the
 * server's echo without a refetch.
 */
export function applyStatusToCard(
  item: Pick<Phase, 'status' | 'completion'>,
  status: CardStatus
): { status: CardStatus; completion: number | null } {
  item.completion = completionForStatus(status, item.completion);
  item.status = status;
  return { status: item.status, completion: item.completion ?? null };
}

// =============================================================================
// CARD DERIVATION
// =============================================================================

export interface KanbanCard {
  entityType: 'phase' | 'subphase';
  entityId: number;
  /** Stable React key / lookup key across both entity types. */
  key: string;
  projectId: number;
  projectName: string;
  name: string;
  startDate: string;
  endDate: string;
  status: CardStatus;
  completion: number | null;
  isMilestone: boolean;
  color: string;
  orderIndex: number;
  /** 0 for a leaf phase, >=1 for a subphase. */
  depth: number;
  assignments: StaffAssignment[];
  assigneeIds: number[];
  /** Top-level phase this card belongs to; null when the card IS a leaf phase. */
  swimlanePhaseId: number | null;
  swimlanePhaseName: string | null;
  /** Breadcrumb, e.g. "Design / DoE setup". */
  path: string;
}

export function cardKey(entityType: 'phase' | 'subphase', entityId: number): string {
  return `${entityType}-${entityId}`;
}

function assigneeIdsOf(assignments: StaffAssignment[]): number[] {
  return Array.from(new Set(assignments.map((a) => a.staff_id)));
}

function collectFromSubphases(
  subphases: Subphase[],
  project: Project,
  swimlanePhaseId: number,
  swimlanePhaseName: string,
  parentPath: string,
  depth: number,
  out: KanbanCard[]
): void {
  for (const sub of subphases) {
    const path = parentPath ? `${parentPath} / ${sub.name}` : sub.name;
    const children = sub.children ?? [];

    if (children.length > 0) {
      // Not a card and not a lane -- it only extends the breadcrumb.
      collectFromSubphases(
        children,
        project,
        swimlanePhaseId,
        swimlanePhaseName,
        path,
        depth + 1,
        out
      );
      continue;
    }

    const assignments = sub.staffAssignments ?? [];
    out.push({
      entityType: 'subphase',
      entityId: sub.id,
      key: cardKey('subphase', sub.id),
      projectId: project.id,
      projectName: project.name,
      name: sub.name,
      startDate: sub.start_date,
      endDate: sub.end_date,
      status: sub.status ?? 'todo',
      completion: sub.completion ?? null,
      isMilestone: Boolean(sub.is_milestone),
      color: sub.color,
      orderIndex: sub.order_index ?? 0,
      depth,
      assignments,
      assigneeIds: assigneeIdsOf(assignments),
      swimlanePhaseId,
      swimlanePhaseName,
      path,
    });
  }
}

/** Derive every Kanban card for one project, in board order. */
export function collectProjectCards(project: Project): KanbanCard[] {
  const cards: KanbanCard[] = [];

  for (const phase of project.phases ?? []) {
    const children = phase.children ?? [];

    if (children.length === 0) {
      // A leaf phase is itself a card. It gets its own lane when grouping by
      // phase, rather than being orphaned into an "Other" bucket.
      const assignments = phase.staffAssignments ?? [];
      cards.push({
        entityType: 'phase',
        entityId: phase.id,
        key: cardKey('phase', phase.id),
        projectId: project.id,
        projectName: project.name,
        name: phase.name,
        startDate: phase.start_date,
        endDate: phase.end_date,
        status: phase.status ?? 'todo',
        completion: phase.completion ?? null,
        isMilestone: Boolean(phase.is_milestone),
        color: phase.color,
        orderIndex: phase.order_index ?? 0,
        depth: 0,
        assignments,
        assigneeIds: assigneeIdsOf(assignments),
        swimlanePhaseId: null,
        swimlanePhaseName: null,
        path: phase.name,
      });
      continue;
    }

    collectFromSubphases(children, project, phase.id, phase.name, phase.name, 1, cards);
  }

  return cards;
}

/** Derive cards across several projects (used by the due-soon scan). */
export function collectCardsForProjects(projects: Project[]): KanbanCard[] {
  return projects.flatMap(collectProjectCards);
}

// =============================================================================
// GROUPING
// =============================================================================

export type KanbanGrouping = 'none' | 'phase' | 'assignee' | 'customColumn';

export interface KanbanLane {
  key: string;
  label: string;
  cards: KanbanCard[];
}

export interface GroupingContext {
  /** Ordering + labels for lanes when grouping by phase. */
  project?: Project;
  /** staff_id -> display name, for assignee lanes. */
  staffNames?: Map<number, string>;
  /** card key -> custom column value, for custom-column lanes. */
  customValues?: Map<string, string | undefined>;
  /** Declared options of the chosen custom column, in display order. */
  customOptions?: string[];
}

const UNASSIGNED_KEY = '__unassigned__';
const NO_VALUE_KEY = '__none__';

/** Group cards into swimlanes. Columns are always status; lanes are the rows. */
export function groupCards(
  cards: KanbanCard[],
  grouping: KanbanGrouping,
  ctx: GroupingContext = {}
): KanbanLane[] {
  if (grouping === 'none') {
    return [{ key: 'all', label: 'All cards', cards }];
  }

  if (grouping === 'phase') {
    const lanes = new Map<string, KanbanLane>();
    // Seed lanes in project phase order so empty lanes still render in place.
    for (const phase of ctx.project?.phases ?? []) {
      const isLeafPhase = (phase.children ?? []).length === 0;
      const key = `phase-${phase.id}`;
      if (isLeafPhase || (phase.children ?? []).length > 0) {
        lanes.set(key, { key, label: phase.name, cards: [] });
      }
    }
    for (const card of cards) {
      // A leaf phase card lives in its own lane; a subphase card in its
      // top-level phase's lane.
      const laneId = card.swimlanePhaseId ?? card.entityId;
      const key = `phase-${laneId}`;
      const lane = lanes.get(key);
      if (lane) {
        lane.cards.push(card);
      } else {
        lanes.set(key, {
          key,
          label: card.swimlanePhaseName ?? card.name,
          cards: [card],
        });
      }
    }
    return Array.from(lanes.values());
  }

  if (grouping === 'assignee') {
    const lanes = new Map<string, KanbanLane>();
    for (const card of cards) {
      if (card.assigneeIds.length === 0) {
        const lane = lanes.get(UNASSIGNED_KEY) ?? {
          key: UNASSIGNED_KEY,
          label: 'Unassigned',
          cards: [],
        };
        lane.cards.push(card);
        lanes.set(UNASSIGNED_KEY, lane);
        continue;
      }
      // A card with several assignees appears in each of their lanes.
      for (const staffId of card.assigneeIds) {
        const key = `staff-${staffId}`;
        const label =
          ctx.staffNames?.get(staffId) ??
          card.assignments.find((a) => a.staff_id === staffId)?.staff_name ??
          `Staff ${staffId}`;
        const lane = lanes.get(key) ?? { key, label, cards: [] };
        lane.cards.push(card);
        lanes.set(key, lane);
      }
    }
    // Alphabetical, with Unassigned pinned last.
    return Array.from(lanes.values()).sort((a, b) => {
      if (a.key === UNASSIGNED_KEY) return 1;
      if (b.key === UNASSIGNED_KEY) return -1;
      return a.label.localeCompare(b.label);
    });
  }

  // customColumn
  const lanes = new Map<string, KanbanLane>();
  for (const option of ctx.customOptions ?? []) {
    lanes.set(option, { key: option, label: option, cards: [] });
  }
  for (const card of cards) {
    const value = ctx.customValues?.get(card.key);
    const key = value && value.length > 0 ? value : NO_VALUE_KEY;
    const lane = lanes.get(key) ?? {
      key,
      label: key === NO_VALUE_KEY ? '(none)' : key,
      cards: [],
    };
    lane.cards.push(card);
    lanes.set(key, lane);
  }
  // Declared option order, with "(none)" pinned last.
  const declared = ctx.customOptions ?? [];
  return Array.from(lanes.values()).sort((a, b) => {
    if (a.key === NO_VALUE_KEY) return 1;
    if (b.key === NO_VALUE_KEY) return -1;
    return declared.indexOf(a.key) - declared.indexOf(b.key);
  });
}

// =============================================================================
// DUE / OVERDUE
// =============================================================================

export type DueState = 'overdue' | 'due-soon' | null;

/** A card is "due soon" within this many days of its end date. */
export const DUE_SOON_DAYS = 7;

/**
 * Classify a card by its end date, relative to today.
 * Done cards are never flagged - finished work cannot be overdue.
 */
export function dueStateOf(card: KanbanCard, today: Date = new Date()): DueState {
  if (card.status === 'done' || !card.endDate) return null;
  const midnight = new Date(today);
  midnight.setHours(0, 0, 0, 0);
  const end = new Date(`${card.endDate}T00:00:00`);
  if (Number.isNaN(end.getTime())) return null;
  const days = Math.round((end.getTime() - midnight.getTime()) / 86_400_000);
  if (days < 0) return 'overdue';
  if (days <= DUE_SOON_DAYS) return 'due-soon';
  return null;
}

/** Cards in one lane belonging to one status column, in stable board order. */
export function cardsForColumn(cards: KanbanCard[], status: CardStatus): KanbanCard[] {
  return cards
    .filter((c) => c.status === status)
    .sort((a, b) => {
      if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
      if (a.startDate !== b.startDate) return a.startDate.localeCompare(b.startDate);
      return a.name.localeCompare(b.name);
    });
}
