/**
 * Auto-Calculation Engine
 *
 * Handles the automatic date adjustments that follow a move or resize:
 * 1. Parent expansion - when a child extends beyond parent bounds, the parent expands
 *    (and contracts to the union of its children)
 * 2. Project date adjustment - project dates encompass all phases
 *
 * Dependencies are NOT cascaded on move: a dependency aligns the successor only
 * when it is created, and moving a predecessor afterwards leaves its successors
 * where they are so users keep manual lead/lag control (see CLAUDE.md,
 * "Auto-calculation semantics"). `cascadeDependentPhases` /
 * `cascadeDependentSubphases` below are opt-in helpers that `processPhaseMove` /
 * `processSubphaseMove` deliberately never call.
 */

import type { Project, Phase, Subphase, Dependency, DependencyType, StaffAssignment, StaffAssignmentLevel, EquipmentAssignment } from '@/types';
import { updatePhase, updateSubphase, updateProject, updateStaffAssignment, updateEquipmentAssignment } from '@/api/endpoints/projects';
import { parseLocalDate, formatLocalDate, toDateOnly } from '@/utils/date';
import { isPendingAssignment } from '@/utils/kanbanCards';

// Accumulated updates to batch save to server
export interface PendingUpdate {
  type: 'phase' | 'subphase' | 'project' | 'staffAssignment' | 'equipmentAssignment';
  id: number;
  start_date: string;
  end_date: string;
  // Additional fields for project update
  name?: string;
  pm_id?: number | null;
  customer?: string | null;
  sales_pm?: string | null;
  volume?: number | null;
  confirmed?: boolean;
  // Additional fields for staff assignment update
  allocation?: number;
  /**
   * Staff assignment only: the route family to PUT (ids are unique per level).
   * Absent = 'project', the only level whose rows carry dates of their own.
   */
  level?: StaffAssignmentLevel;
  /**
   * Phase/subphase only: the full dependency list to write. Set by undo/redo
   * (diffProjects) when a snapshot's links differ from the current ones, so a
   * link created or removed after the snapshot is restored on the server too.
   */
  dependencies?: Dependency[];
}

// Every model date string is parsed with parseLocalDate (local midnight) and
// written back with formatLocalDate (local components). Never `new Date(str)`:
// that is UTC midnight and lands on the previous day west of UTC.
const formatDateLocal = formatLocalDate;

/**
 * Move staff assignments by offset.
 *
 * Only project-level rows have dates of their own: phase and subphase rows
 * follow their item, so they are never cascaded (their ids are unique per
 * level only, and a PUT on the project route would hit another row). Pending
 * rows are own bookings awaiting approval: they keep their requested dates
 * (an editor's write on one is refused by the server).
 */
function moveStaffAssignmentsByOffset(
  assignments: StaffAssignment[],
  level: StaffAssignmentLevel,
  dayOffset: number,
  pendingUpdates: PendingUpdate[]
): void {
  if (level !== 'project') return;
  for (const assignment of assignments) {
    if (isPendingAssignment(assignment)) continue;
    // Skip assignments without valid dates
    if (!assignment.start_date || !assignment.end_date) {
      console.warn(`[autoCalculation] Skipping staff assignment ${assignment.id} - missing dates`);
      continue;
    }
    
    const oldStart = parseLocalDate(assignment.start_date);
    const oldEnd = parseLocalDate(assignment.end_date);
    
    // Skip if dates are invalid
    if (isNaN(oldStart.getTime()) || isNaN(oldEnd.getTime())) {
      console.warn(`[autoCalculation] Skipping staff assignment ${assignment.id} - invalid dates`);
      continue;
    }
    
    const newStart = new Date(oldStart);
    newStart.setDate(newStart.getDate() + dayOffset);
    
    const newEnd = new Date(oldEnd);
    newEnd.setDate(newEnd.getDate() + dayOffset);
    
    assignment.start_date = formatDateLocal(newStart);
    assignment.end_date = formatDateLocal(newEnd);
    
    pendingUpdates.push({
      type: 'staffAssignment',
      id: assignment.id,
      level,
      start_date: assignment.start_date,
      end_date: assignment.end_date,
      allocation: assignment.allocation ?? 100, // Backend requires allocation
    });
  }
}

/**
 * Move equipment assignments by offset
 */
function moveEquipmentAssignmentsByOffset(
  assignments: EquipmentAssignment[],
  dayOffset: number,
  pendingUpdates: PendingUpdate[]
): void {
  for (const assignment of assignments) {
    // Skip assignments without valid dates
    if (!assignment.start_date || !assignment.end_date) {
      console.warn(`[autoCalculation] Skipping equipment assignment ${assignment.id} - missing dates`);
      continue;
    }
    
    const oldStart = parseLocalDate(assignment.start_date);
    const oldEnd = parseLocalDate(assignment.end_date);
    
    // Skip if dates are invalid
    if (isNaN(oldStart.getTime()) || isNaN(oldEnd.getTime())) {
      console.warn(`[autoCalculation] Skipping equipment assignment ${assignment.id} - invalid dates`);
      continue;
    }
    
    const newStart = new Date(oldStart);
    newStart.setDate(newStart.getDate() + dayOffset);
    
    const newEnd = new Date(oldEnd);
    newEnd.setDate(newEnd.getDate() + dayOffset);
    
    assignment.start_date = formatDateLocal(newStart);
    assignment.end_date = formatDateLocal(newEnd);
    
    pendingUpdates.push({
      type: 'equipmentAssignment',
      id: assignment.id,
      start_date: assignment.start_date,
      end_date: assignment.end_date,
    });
  }
}

/**
 * Move all children (subphases) by a given number of days
 * Used when parent is dragged - children should move with it
 * Also moves staff and equipment assignments
 */
export function moveChildrenByOffset(
  children: Subphase[],
  dayOffset: number,
  pendingUpdates: PendingUpdate[]
): void {
  for (const child of children) {
    const oldStart = parseLocalDate(child.start_date);
    const oldEnd = parseLocalDate(child.end_date);
    
    const newStart = new Date(oldStart);
    newStart.setDate(newStart.getDate() + dayOffset);
    
    const newEnd = new Date(oldEnd);
    newEnd.setDate(newEnd.getDate() + dayOffset);
    
    child.start_date = formatDateLocal(newStart);
    child.end_date = formatDateLocal(newEnd);
    
    pendingUpdates.push({
      type: 'subphase',
      id: child.id,
      start_date: child.start_date,
      end_date: child.end_date,
    });
    
    // Staff assignments on this subphase follow it (no dates of their own)
    if (child.staffAssignments?.length) {
      moveStaffAssignmentsByOffset(child.staffAssignments, 'subphase', dayOffset, pendingUpdates);
    }
    
    // Move equipment assignments on this subphase
    if (child.equipmentAssignments?.length) {
      moveEquipmentAssignmentsByOffset(child.equipmentAssignments, dayOffset, pendingUpdates);
    }
    
    // Recursively move nested children
    if (child.children?.length) {
      moveChildrenByOffset(child.children, dayOffset, pendingUpdates);
    }
  }
}

/**
 * Move all phases and their children by a given number of days
 * Used when project is dragged - all phases should move with it
 * Also moves all staff and equipment assignments
 */
export function movePhasesWithProject(
  project: Project,
  dayOffset: number,
  pendingUpdates: PendingUpdate[]
): void {
  for (const phase of project.phases ?? []) {
    const oldStart = parseLocalDate(phase.start_date);
    const oldEnd = parseLocalDate(phase.end_date);
    
    const newStart = new Date(oldStart);
    newStart.setDate(newStart.getDate() + dayOffset);
    
    const newEnd = new Date(oldEnd);
    newEnd.setDate(newEnd.getDate() + dayOffset);
    
    phase.start_date = formatDateLocal(newStart);
    phase.end_date = formatDateLocal(newEnd);
    
    pendingUpdates.push({
      type: 'phase',
      id: phase.id,
      start_date: phase.start_date,
      end_date: phase.end_date,
    });
    
    // Staff assignments on this phase follow it (no dates of their own)
    if (phase.staffAssignments?.length) {
      moveStaffAssignmentsByOffset(phase.staffAssignments, 'phase', dayOffset, pendingUpdates);
    }
    
    // Move equipment assignments on this phase
    if (phase.equipmentAssignments?.length) {
      moveEquipmentAssignmentsByOffset(phase.equipmentAssignments, dayOffset, pendingUpdates);
    }
    
    // Move all subphases of this phase
    if (phase.children?.length) {
      moveChildrenByOffset(phase.children, dayOffset, pendingUpdates);
    }
  }
  
  // Move project-level staff assignments
  if (project.staffAssignments?.length) {
    moveStaffAssignmentsByOffset(project.staffAssignments, 'project', dayOffset, pendingUpdates);
  }
  
  // Move project-level equipment assignments
  if (project.equipmentAssignments?.length) {
    moveEquipmentAssignmentsByOffset(project.equipmentAssignments, dayOffset, pendingUpdates);
  }
}

/**
 * Calculate new dates for dependent phases/subphases based on dependency type
 */
function calculateDependentDates(
  predecessorStart: Date,
  predecessorEnd: Date,
  successorStart: Date,
  successorEnd: Date,
  depType: DependencyType,
  lag: number = 0
): { newStart: Date; newEnd: Date } {
  const duration = Math.round((successorEnd.getTime() - successorStart.getTime()) / 86400000);
  
  let newStart: Date;
  let newEnd: Date;
  
  switch (depType) {
    case 'FS': {
      // Finish-to-Start: successor starts after predecessor ends
      newStart = new Date(predecessorEnd);
      newStart.setDate(newStart.getDate() + 1 + lag);
      newEnd = new Date(newStart);
      newEnd.setDate(newEnd.getDate() + duration);
      break;
    }
    case 'SS': {
      // Start-to-Start: successor starts when/after predecessor starts
      newStart = new Date(predecessorStart);
      newStart.setDate(newStart.getDate() + lag);
      newEnd = new Date(newStart);
      newEnd.setDate(newEnd.getDate() + duration);
      break;
    }
    case 'FF': {
      // Finish-to-Finish: successor ends when/after predecessor ends
      newEnd = new Date(predecessorEnd);
      newEnd.setDate(newEnd.getDate() + lag);
      newStart = new Date(newEnd);
      newStart.setDate(newStart.getDate() - duration);
      break;
    }
    case 'SF': {
      // Start-to-Finish: successor ends when/after predecessor starts
      newEnd = new Date(predecessorStart);
      newEnd.setDate(newEnd.getDate() + lag);
      newStart = new Date(newEnd);
      newStart.setDate(newStart.getDate() - duration);
      break;
    }
    default: {
      // Default to FS
      newStart = new Date(predecessorEnd);
      newStart.setDate(newStart.getDate() + 1 + lag);
      newEnd = new Date(newStart);
      newEnd.setDate(newEnd.getDate() + duration);
    }
  }
  
  return { newStart, newEnd };
}

/**
 * Find a phase by ID in a project
 */
function findPhaseById(project: Project, phaseId: number): Phase | null {
  return (project.phases ?? []).find(p => p.id === phaseId) ?? null;
}

/**
 * Find a subphase by ID recursively in a project
 */
function findSubphaseById(project: Project, subphaseId: number): Subphase | null {
  const searchChildren = (children: Subphase[]): Subphase | null => {
    for (const child of children) {
      if (child.id === subphaseId) return child;
      if (child.children?.length) {
        const found = searchChildren(child.children);
        if (found) return found;
      }
    }
    return null;
  };
  
  for (const phase of project.phases ?? []) {
    if (phase.children?.length) {
      const found = searchChildren(phase.children);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Find the parent of a subphase (could be a phase or another subphase)
 */
function findParentOfSubphase(
  project: Project, 
  subphaseId: number
): { parent: Phase | Subphase; type: 'phase' | 'subphase' } | null {
  for (const phase of project.phases ?? []) {
    for (const child of phase.children ?? []) {
      if (child.id === subphaseId) {
        return { parent: phase, type: 'phase' };
      }
      const result = findParentRecursive(child, subphaseId);
      if (result) return result;
    }
  }
  return null;
}

function findParentRecursive(
  parent: Subphase, 
  targetId: number
): { parent: Subphase; type: 'subphase' } | null {
  for (const child of parent.children ?? []) {
    if (child.id === targetId) {
      return { parent, type: 'subphase' };
    }
    const result = findParentRecursive(child, targetId);
    if (result) return result;
  }
  return null;
}

/**
 * Cascade dependency updates to successor phases
 * When a phase/subphase moves, all its dependents need to be adjusted
 */
export function cascadeDependentPhases(
  project: Project,
  changedPhaseId: number,
  pendingUpdates: PendingUpdate[]
): void {
  const changedPhase = findPhaseById(project, changedPhaseId);
  if (!changedPhase) return;
  
  const predecessorEnd = parseLocalDate(changedPhase.end_date);
  const predecessorStart = parseLocalDate(changedPhase.start_date);
  
  // Find all phases that depend on the changed phase
  for (const phase of project.phases ?? []) {
    const deps = phase.dependencies ?? [];
    // Entries naming a subphase predecessor are not about this phase
    const dep = deps.find(d => d.id === changedPhaseId && d.entity !== 'subphase');
    
    if (dep) {
      const successorStart = parseLocalDate(phase.start_date);
      const successorEnd = parseLocalDate(phase.end_date);
      
      const { newStart, newEnd } = calculateDependentDates(
        predecessorStart,
        predecessorEnd,
        successorStart,
        successorEnd,
        dep.type || 'FS',
        dep.lag ?? 0
      );
      
      // Check if dates actually changed
      if (newStart.getTime() !== successorStart.getTime() || 
          newEnd.getTime() !== successorEnd.getTime()) {
        // Update in memory
        phase.start_date = formatDateLocal(newStart);
        phase.end_date = formatDateLocal(newEnd);
        
        // Queue for server update
        pendingUpdates.push({
          type: 'phase',
          id: phase.id,
          start_date: phase.start_date,
          end_date: phase.end_date,
        });
        
        // Recursively cascade to phases that depend on this one
        cascadeDependentPhases(project, phase.id, pendingUpdates);
      }
    }
  }
}

/**
 * Cascade dependency updates to successor subphases within a project
 */
export function cascadeDependentSubphases(
  project: Project,
  changedSubphaseId: number,
  pendingUpdates: PendingUpdate[]
): void {
  const changedSubphase = findSubphaseById(project, changedSubphaseId);
  if (!changedSubphase) return;
  
  const predecessorEnd = parseLocalDate(changedSubphase.end_date);
  const predecessorStart = parseLocalDate(changedSubphase.start_date);
  
  // Helper to search for dependent subphases recursively
  const findDependentSubphases = (children: Subphase[]): void => {
    for (const subphase of children) {
      const deps = subphase.dependencies ?? [];
      // Entries naming a phase predecessor are not about this subphase
      const dep = deps.find(d => d.id === changedSubphaseId && d.entity !== 'phase');
      
      if (dep) {
        const successorStart = parseLocalDate(subphase.start_date);
        const successorEnd = parseLocalDate(subphase.end_date);
        
        const { newStart, newEnd } = calculateDependentDates(
          predecessorStart,
          predecessorEnd,
          successorStart,
          successorEnd,
          dep.type || 'FS',
          dep.lag ?? 0
        );
        
        // Check if dates actually changed
        if (newStart.getTime() !== successorStart.getTime() || 
            newEnd.getTime() !== successorEnd.getTime()) {
          // Update in memory
          subphase.start_date = formatDateLocal(newStart);
          subphase.end_date = formatDateLocal(newEnd);
          
          // Queue for server update
          pendingUpdates.push({
            type: 'subphase',
            id: subphase.id,
            start_date: subphase.start_date,
            end_date: subphase.end_date,
          });
          
          // Recursively cascade to subphases that depend on this one
          cascadeDependentSubphases(project, subphase.id, pendingUpdates);
        }
      }
      
      // Search in children
      if (subphase.children?.length) {
        findDependentSubphases(subphase.children);
      }
    }
  };
  
  // Search all phases' children
  for (const phase of project.phases ?? []) {
    if (phase.children?.length) {
      findDependentSubphases(phase.children);
    }
  }
}

/**
 * Cascade parent dates upward when a child changes
 * - Expands parent if child extends beyond bounds
 * - Contracts parent to match children bounds (parent = union of all children)
 * This walks up the tree from the changed item to the phase level
 */
export function cascadeParentDatesUp(
  project: Project,
  changedSubphaseId: number,
  pendingUpdates: PendingUpdate[]
): void {
  let currentId = changedSubphaseId;
  let parentInfo = findParentOfSubphase(project, currentId);
  
  while (parentInfo) {
    const parent = parentInfo.parent;
    const children = parent.children ?? [];
    
    if (children.length === 0) break;
    
    // Calculate bounds from all children
    let earliestStart: Date | null = null;
    let latestEnd: Date | null = null;
    
    for (const child of children) {
      const start = parseLocalDate(child.start_date);
      const end = parseLocalDate(child.end_date);
      if (!earliestStart || start < earliestStart) earliestStart = start;
      if (!latestEnd || end > latestEnd) latestEnd = end;
    }
    
    if (!earliestStart || !latestEnd) break;
    
    const currentStart = parseLocalDate(parent.start_date);
    const currentEnd = parseLocalDate(parent.end_date);
    
    let needsUpdate = false;
    
    // Update start to match earliest child (expand OR contract)
    if (earliestStart.getTime() !== currentStart.getTime()) {
      parent.start_date = formatDateLocal(earliestStart);
      needsUpdate = true;
    }
    
    // Update end to match latest child (expand OR contract)
    if (latestEnd.getTime() !== currentEnd.getTime()) {
      parent.end_date = formatDateLocal(latestEnd);
      needsUpdate = true;
    }
    
    if (needsUpdate) {
      pendingUpdates.push({
        type: parentInfo.type,
        id: parent.id,
        start_date: parent.start_date,
        end_date: parent.end_date,
      });
    }
    
    // Move up to the next parent
    if (parentInfo.type === 'phase') {
      // We've reached a phase, now update project
      autoAdjustProjectDates(project, pendingUpdates);
      break;
    } else {
      currentId = parent.id;
      parentInfo = findParentOfSubphase(project, currentId);
    }
  }
}

/**
 * Cascade phase dates to match children (subphases)
 * Parent = union of all children dates
 */
export function cascadePhaseDatesFromChildren(
  project: Project,
  phaseId: number,
  pendingUpdates: PendingUpdate[]
): void {
  const phase = findPhaseById(project, phaseId);
  if (!phase || !phase.children?.length) return;
  
  let earliestStart: Date | null = null;
  let latestEnd: Date | null = null;
  
  for (const child of phase.children) {
    const start = parseLocalDate(child.start_date);
    const end = parseLocalDate(child.end_date);
    if (!earliestStart || start < earliestStart) earliestStart = start;
    if (!latestEnd || end > latestEnd) latestEnd = end;
  }
  
  if (!earliestStart || !latestEnd) return;
  
  const currentStart = parseLocalDate(phase.start_date);
  const currentEnd = parseLocalDate(phase.end_date);
  
  let needsUpdate = false;
  
  // Update start to match earliest child
  if (earliestStart.getTime() !== currentStart.getTime()) {
    phase.start_date = formatDateLocal(earliestStart);
    needsUpdate = true;
  }
  
  // Update end to match latest child
  if (latestEnd.getTime() !== currentEnd.getTime()) {
    phase.end_date = formatDateLocal(latestEnd);
    needsUpdate = true;
  }
  
  if (needsUpdate) {
    pendingUpdates.push({
      type: 'phase',
      id: phase.id,
      start_date: phase.start_date,
      end_date: phase.end_date,
    });
    
    // Also update project dates
    autoAdjustProjectDates(project, pendingUpdates);
  }
}

/**
 * Auto-adjust project dates based on phase dates
 * Project start = earliest phase start
 * Project end = latest phase end
 */
export function autoAdjustProjectDates(
  project: Project,
  pendingUpdates: PendingUpdate[]
): void {
  const phases = project.phases ?? [];
  if (phases.length === 0) return;
  
  let earliestStart: Date | null = null;
  let latestEnd: Date | null = null;
  
  for (const phase of phases) {
    const phaseStart = parseLocalDate(phase.start_date);
    const phaseEnd = parseLocalDate(phase.end_date);
    
    if (!earliestStart || phaseStart < earliestStart) {
      earliestStart = phaseStart;
    }
    if (!latestEnd || phaseEnd > latestEnd) {
      latestEnd = phaseEnd;
    }
  }
  
  if (!earliestStart || !latestEnd) return;
  
  const newStartDate = formatDateLocal(earliestStart);
  const newEndDate = formatDateLocal(latestEnd);
  
  const currentStartDate = project.start_date ? toDateOnly(project.start_date) : project.start_date;
  const currentEndDate = project.end_date ? toDateOnly(project.end_date) : project.end_date;
  if (currentStartDate !== newStartDate || currentEndDate !== newEndDate) {
    project.start_date = newStartDate;
    project.end_date = newEndDate;
    
    // Check if we already have a project update queued
    const existingIdx = pendingUpdates.findIndex(
      u => u.type === 'project' && u.id === project.id
    );
    
    if (existingIdx >= 0) {
      // Update existing
      pendingUpdates[existingIdx].start_date = newStartDate;
      pendingUpdates[existingIdx].end_date = newEndDate;
    } else {
      // Add new
      pendingUpdates.push({
        type: 'project',
        id: project.id,
        start_date: newStartDate,
        end_date: newEndDate,
        name: project.name,
        pm_id: project.pm_id,
        customer: project.customer,
        sales_pm: project.sales_pm,
        volume: project.volume,
        confirmed: project.confirmed,
      });
    }
  }
}

/** One cascaded write that the server rejected. */
export interface PendingUpdateFailure {
  update: PendingUpdate;
  error: unknown;
}

/**
 * Thrown by savePendingUpdates when at least one write failed. Every update is
 * still attempted (they are independent rows), then the failures are reported
 * together so the caller runs the optimistic-write failure protocol once
 * (reload from the server + clear the undo stack).
 */
export class PendingUpdatesError extends Error {
  readonly failures: PendingUpdateFailure[];
  readonly total: number;

  constructor(failures: PendingUpdateFailure[], total: number) {
    super(
      `${failures.length} of ${total} update(s) failed to save: ` +
        failures.map((f) => `${f.update.type} ${f.update.id}`).join(', ')
    );
    this.name = 'PendingUpdatesError';
    this.failures = failures;
    this.total = total;
  }
}

function persistPendingUpdate(update: PendingUpdate): Promise<unknown> {
  switch (update.type) {
    case 'phase':
      return updatePhase(update.id, {
        start_date: update.start_date,
        end_date: update.end_date,
        ...(update.dependencies !== undefined ? { dependencies: update.dependencies } : {}),
      });
    case 'subphase':
      return updateSubphase(update.id, {
        start_date: update.start_date,
        end_date: update.end_date,
        ...(update.dependencies !== undefined ? { dependencies: update.dependencies } : {}),
      });
    case 'project':
      return updateProject(update.id, {
        name: update.name!,
        start_date: update.start_date,
        end_date: update.end_date,
        pm_id: update.pm_id,
        customer: update.customer,
        sales_pm: update.sales_pm,
        volume: update.volume,
        confirmed: update.confirmed,
      });
    case 'staffAssignment':
      return updateStaffAssignment(
        update.id,
        {
          start_date: update.start_date,
          end_date: update.end_date,
          allocation: update.allocation ?? 100, // Backend requires allocation
        },
        update.level ?? 'project'
      );
    case 'equipmentAssignment':
      return updateEquipmentAssignment(update.id, {
        start_date: update.start_date,
        end_date: update.end_date,
      });
    default:
      return Promise.resolve();
  }
}

/**
 * Save all pending updates to the server.
 *
 * All updates are attempted; if any fails, a PendingUpdatesError listing the
 * failures is thrown after the others settle. Callers must treat that like
 * any other persist failure: reload from the server and clear the undo stack
 * (see utils/persistFailure.ts).
 */
export async function savePendingUpdates(pendingUpdates: PendingUpdate[]): Promise<void> {
  const results = await Promise.allSettled(pendingUpdates.map(persistPendingUpdate));

  const failures: PendingUpdateFailure[] = [];
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const update = pendingUpdates[i];
      console.error(`Failed to save ${update.type} ${update.id}:`, result.reason);
      failures.push({ update, error: result.reason });
    }
  });

  if (failures.length > 0) {
    throw new PendingUpdatesError(failures, pendingUpdates.length);
  }
}

/**
 * Main entry point: Process all auto-calculations after a phase moves
 * 
 * NOTE: We do NOT cascade to dependent phases here. Dependencies only auto-align
 * at creation time. After that, users have full manual control and can position
 * dependent items with any lead/lag they want.
 * 
 * We DO update project dates to encompass all phases.
 */
export function processPhaseMove(
  project: Project,
  _phaseId: number,
  _oldEndDate: string,
  _newEndDate: string
): PendingUpdate[] {
  const pendingUpdates: PendingUpdate[] = [];
  
  // Update project dates to encompass all phases
  autoAdjustProjectDates(project, pendingUpdates);
  
  return pendingUpdates;
}

/**
 * Main entry point: Process all auto-calculations after a subphase moves
 * 
 * NOTE: We do NOT cascade to dependent subphases here. Dependencies only auto-align
 * at creation time. After that, users have full manual control.
 * 
 * We DO cascade parent dates upward when a child extends beyond parent bounds.
 */
export function processSubphaseMove(
  project: Project,
  subphaseId: number,
  _oldEndDate: string,
  _newEndDate: string
): PendingUpdate[] {
  const pendingUpdates: PendingUpdate[] = [];
  
  // Cascade parent dates upward (subphase → parent subphase → phase → project)
  // This expands parents when children extend beyond their bounds
  cascadeParentDatesUp(project, subphaseId, pendingUpdates);
  
  return pendingUpdates;
}

/**
 * Deep clone a project to avoid mutations
 */
export function cloneProject(project: Project): Project {
  return JSON.parse(JSON.stringify(project));
}
