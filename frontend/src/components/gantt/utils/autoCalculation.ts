/**
 * Auto-Calculation Engine
 * 
 * Handles automatic date adjustments for:
 * 1. Dependency cascading - when a predecessor moves, successors adjust
 * 2. Parent expansion - when a child extends beyond parent bounds, parent expands
 * 3. Project date adjustment - project dates encompass all phases
 */

import type { Project, Phase, Subphase, DependencyType, StaffAssignment, EquipmentAssignment } from '@/types';
import { updatePhase, updateSubphase, updateProject, updateStaffAssignment, updateEquipmentAssignment } from '@/api/endpoints/projects';

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
}

/**
 * Format date as YYYY-MM-DD
 */
function formatDateLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Move staff assignments by offset
 */
function moveStaffAssignmentsByOffset(
  assignments: StaffAssignment[],
  dayOffset: number,
  pendingUpdates: PendingUpdate[]
): void {
  for (const assignment of assignments) {
    const oldStart = new Date(assignment.start_date);
    const oldEnd = new Date(assignment.end_date);
    
    const newStart = new Date(oldStart);
    newStart.setDate(newStart.getDate() + dayOffset);
    
    const newEnd = new Date(oldEnd);
    newEnd.setDate(newEnd.getDate() + dayOffset);
    
    assignment.start_date = formatDateLocal(newStart);
    assignment.end_date = formatDateLocal(newEnd);
    
    pendingUpdates.push({
      type: 'staffAssignment',
      id: assignment.id,
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
    const oldStart = new Date(assignment.start_date);
    const oldEnd = new Date(assignment.end_date);
    
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
    const oldStart = new Date(child.start_date);
    const oldEnd = new Date(child.end_date);
    
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
    
    // Move staff assignments on this subphase
    if (child.staffAssignments?.length) {
      moveStaffAssignmentsByOffset(child.staffAssignments, dayOffset, pendingUpdates);
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
    const oldStart = new Date(phase.start_date);
    const oldEnd = new Date(phase.end_date);
    
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
    
    // Move staff assignments on this phase
    if (phase.staffAssignments?.length) {
      moveStaffAssignmentsByOffset(phase.staffAssignments, dayOffset, pendingUpdates);
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
    moveStaffAssignmentsByOffset(project.staffAssignments, dayOffset, pendingUpdates);
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
  
  const predecessorEnd = new Date(changedPhase.end_date);
  const predecessorStart = new Date(changedPhase.start_date);
  
  // Find all phases that depend on the changed phase
  for (const phase of project.phases ?? []) {
    const deps = phase.dependencies ?? [];
    const dep = deps.find(d => d.id === changedPhaseId);
    
    if (dep) {
      const successorStart = new Date(phase.start_date);
      const successorEnd = new Date(phase.end_date);
      
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
  
  const predecessorEnd = new Date(changedSubphase.end_date);
  const predecessorStart = new Date(changedSubphase.start_date);
  
  // Helper to search for dependent subphases recursively
  const findDependentSubphases = (children: Subphase[]): void => {
    for (const subphase of children) {
      const deps = subphase.dependencies ?? [];
      const dep = deps.find(d => d.id === changedSubphaseId);
      
      if (dep) {
        const successorStart = new Date(subphase.start_date);
        const successorEnd = new Date(subphase.end_date);
        
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
      const start = new Date(child.start_date);
      const end = new Date(child.end_date);
      if (!earliestStart || start < earliestStart) earliestStart = start;
      if (!latestEnd || end > latestEnd) latestEnd = end;
    }
    
    if (!earliestStart || !latestEnd) break;
    
    const currentStart = new Date(parent.start_date);
    const currentEnd = new Date(parent.end_date);
    
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
    const start = new Date(child.start_date);
    const end = new Date(child.end_date);
    if (!earliestStart || start < earliestStart) earliestStart = start;
    if (!latestEnd || end > latestEnd) latestEnd = end;
  }
  
  if (!earliestStart || !latestEnd) return;
  
  const currentStart = new Date(phase.start_date);
  const currentEnd = new Date(phase.end_date);
  
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
    const phaseStart = new Date(phase.start_date);
    const phaseEnd = new Date(phase.end_date);
    
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
  
  if (project.start_date !== newStartDate || project.end_date !== newEndDate) {
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

/**
 * Save all pending updates to the server
 */
export async function savePendingUpdates(pendingUpdates: PendingUpdate[]): Promise<void> {
  const promises = pendingUpdates.map(update => {
    if (update.type === 'phase') {
      return updatePhase(update.id, {
        start_date: update.start_date,
        end_date: update.end_date,
      }).catch(err => console.error(`Failed to save phase ${update.id}:`, err));
    } else if (update.type === 'subphase') {
      return updateSubphase(update.id, {
        start_date: update.start_date,
        end_date: update.end_date,
      }).catch(err => console.error(`Failed to save subphase ${update.id}:`, err));
    } else if (update.type === 'project') {
      return updateProject(update.id, {
        name: update.name!,
        start_date: update.start_date,
        end_date: update.end_date,
        pm_id: update.pm_id,
        customer: update.customer,
        sales_pm: update.sales_pm,
        volume: update.volume,
        confirmed: update.confirmed,
      }).catch(err => console.error(`Failed to save project ${update.id}:`, err));
    } else if (update.type === 'staffAssignment') {
      return updateStaffAssignment(update.id, {
        start_date: update.start_date,
        end_date: update.end_date,
        allocation: update.allocation ?? 100, // Backend requires allocation
      }).catch(err => console.error(`Failed to save staff assignment ${update.id}:`, err));
    } else if (update.type === 'equipmentAssignment') {
      return updateEquipmentAssignment(update.id, {
        start_date: update.start_date,
        end_date: update.end_date,
      }).catch(err => console.error(`Failed to save equipment assignment ${update.id}:`, err));
    }
    return Promise.resolve();
  });
  
  await Promise.all(promises);
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
