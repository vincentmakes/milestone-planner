/**
 * Shared utilities for recursive subphase search operations.
 *
 * These functions traverse the nested Phase -> Subphase -> Subphase tree
 * structure and are used by StaffAssignmentModal, EquipmentAssignmentModal,
 * and SubphaseModal.
 */

import type { Phase, Subphase } from '@/types';

/**
 * Recursively search through an array of subphases (children) to find one by ID.
 */
function findSubphaseInChildren(children: Subphase[], targetId: number): Subphase | null {
  for (const child of children) {
    if (child.id === targetId) return child;
    if (child.children && child.children.length > 0) {
      const found = findSubphaseInChildren(child.children, targetId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Find a subphase by its ID, searching recursively through all phases and
 * their nested subphase trees.
 */
export function findSubphaseById(phases: Phase[], subphaseId: number): Subphase | null {
  for (const phase of phases) {
    const found = findSubphaseInChildren(phase.children || [], subphaseId);
    if (found) return found;
  }
  return null;
}

/**
 * Find the top-level Phase that contains a given subphase (at any nesting depth).
 */
export function findPhaseContainingSubphase(phases: Phase[], subphaseId: number): Phase | null {
  for (const phase of phases) {
    const found = findSubphaseInChildren(phase.children || [], subphaseId);
    if (found) return phase;
  }
  return null;
}

/**
 * Find the immediate parent Subphase of a given subphase. Returns null if
 * the subphase is a direct child of a Phase (i.e., has no parent subphase)
 * or if the subphase is not found.
 */
export function findParentSubphase(phases: Phase[], subphaseId: number): Subphase | null {
  const target = findSubphaseById(phases, subphaseId);
  if (!target || !target.parent_subphase_id) return null;
  return findSubphaseById(phases, target.parent_subphase_id);
}
