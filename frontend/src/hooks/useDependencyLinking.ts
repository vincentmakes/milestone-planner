/**
 * useDependencyLinking - Hook for creating dependencies between phases/subphases
 * Handles the two-click flow: first click selects source, second click selects target
 */

import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { updatePhase, updateSubphase } from '@/api/endpoints/projects';
import { parseLocalDate, formatLocalDate } from '@/utils/date';
import { recoverFromPersistFailure } from '@/utils/persistFailure';
import { 
  cascadeParentDatesUp, 
  autoAdjustProjectDates,
  savePendingUpdates,
  cloneProject,
  dependencyMatches,
  wouldCreateDependencyCycle,
} from '@/components/gantt/utils';
import { canEditProjectById } from '@/utils/permissions';
import type { Dependency, DependencyType, Phase, Subphase } from '@/types';

type LinkZone = 'start' | 'end';
type ItemType = 'phase' | 'subphase';

// Determine dependency type based on source and target zones
function determineDependencyType(fromZone: LinkZone, toZone: LinkZone): DependencyType {
  if (fromZone === 'end' && toZone === 'start') return 'FS';  // Finish-to-Start (most common)
  if (fromZone === 'start' && toZone === 'start') return 'SS'; // Start-to-Start
  if (fromZone === 'end' && toZone === 'end') return 'FF';     // Finish-to-Finish
  if (fromZone === 'start' && toZone === 'end') return 'SF';   // Start-to-Finish (rare)
  return 'FS'; // Default
}

// Format date as YYYY-MM-DD (local calendar components)
const formatDateLocal = formatLocalDate;

export function useDependencyLinking() {
  // Selectors only (useShallow), not a whole-store subscription.
  const {
    isLinkingDependency,
    linkingFrom,
    startLinking,
    completeLinking,
    cancelLinking,
  } = useUIStore(
    useShallow((s) => ({
      isLinkingDependency: s.isLinkingDependency,
      linkingFrom: s.linkingFrom,
      startLinking: s.startLinking,
      completeLinking: s.completeLinking,
      cancelLinking: s.cancelLinking,
    }))
  );
  
  const projects = useAppStore((s) => s.projects);
  const setProjects = useAppStore((s) => s.setProjects);
  const currentUser = useAppStore((s) => s.currentUser);

  // Find a phase by ID across all projects
  const findPhase = useCallback((phaseId: number): { project: typeof projects[0], phase: Phase } | null => {
    for (const project of projects) {
      const phase = (project.phases ?? []).find(p => p.id === phaseId);
      if (phase) return { project, phase };
    }
    return null;
  }, [projects]);

  // Find a subphase by ID (recursive search)
  const findSubphase = useCallback((subphaseId: number): { project: typeof projects[0], subphase: Subphase } | null => {
    const searchSubphases = (subphases: Subphase[]): Subphase | null => {
      for (const sp of subphases) {
        if (sp.id === subphaseId) return sp;
        if (sp.children?.length) {
          const found = searchSubphases(sp.children);
          if (found) return found;
        }
      }
      return null;
    };

    for (const project of projects) {
      for (const phase of project.phases ?? []) {
        const subphase = searchSubphases(phase.children ?? []);
        if (subphase) return { project, subphase };
      }
    }
    return null;
  }, [projects]);

  // Would linking from -> to close a cycle? Walks phase and subphase
  // dependencies alike, resolving each entry by its `entity` (legacy entries
  // phase-first), so a phase <-> subphase cycle is caught too.
  const hasCircularDependency = useCallback((
    projectId: number,
    from: { id: number; type: ItemType },
    to: { id: number; type: ItemType }
  ): boolean => {
    const project = projects.find(p => p.id === projectId);
    if (!project) return false;
    return wouldCreateDependencyCycle(project, from, to);
  }, [projects]);

  // Handle link zone click
  const handleLinkZoneClick = useCallback((
    e: React.MouseEvent,
    projectId: number,
    itemId: number,
    itemType: ItemType,
    zone: LinkZone
  ) => {
    e.stopPropagation();
    e.preventDefault();

    // Only the project's editors (admin, superuser, its manager) link items.
    if (!canEditProjectById(currentUser, projects, projectId)) return;

    // If already linking, try to complete the dependency
    if (isLinkingDependency && linkingFrom) {
      // Must be same project
      if (linkingFrom.projectId !== projectId) {
        useUIStore.getState().showFlash('Dependencies can only be created between items in the same project', 'warning');
        cancelLinking();
        return;
      }

      // Can't link to self
      if (linkingFrom.itemId === itemId && linkingFrom.itemType === itemType) {
        cancelLinking();
        return;
      }

      // Check for circular dependency
      if (hasCircularDependency(
        projectId,
        { id: linkingFrom.itemId, type: linkingFrom.itemType as ItemType },
        { id: itemId, type: itemType }
      )) {
        useUIStore.getState().showFlash('Cannot create circular dependency', 'warning');
        cancelLinking();
        return;
      }

      // Determine dependency type
      const depType = determineDependencyType(linkingFrom.zone as LinkZone, zone);

      // Create the dependency
      createDependency(
        projectId,
        linkingFrom.itemId,
        linkingFrom.itemType as ItemType,
        itemId,
        itemType,
        depType
      );

      completeLinking();
      return;
    }

    // Start new linking
    startLinking(projectId, itemId, itemType, zone);
  }, [isLinkingDependency, linkingFrom, startLinking, completeLinking, cancelLinking, hasCircularDependency, currentUser, projects]);

  // Create dependency and save to server
  const createDependency = useCallback(async (
    projectId: number,
    fromItemId: number,
    fromItemType: ItemType,
    toItemId: number,
    toItemType: ItemType,
    depType: DependencyType
  ) => {
    try {
      // Find source and target items
      let fromItem: Phase | Subphase | null = null;
      let toItem: Phase | Subphase | null = null;

      if (fromItemType === 'phase') {
        const result = findPhase(fromItemId);
        if (result) fromItem = result.phase;
      } else {
        const result = findSubphase(fromItemId);
        if (result) fromItem = result.subphase;
      }

      if (toItemType === 'phase') {
        const result = findPhase(toItemId);
        if (result) toItem = result.phase;
      } else {
        const result = findSubphase(toItemId);
        if (result) toItem = result.subphase;
      }

      if (!fromItem || !toItem) {
        console.error('Could not find source or target item');
        return;
      }

      // Get current dependencies
      const currentDeps = toItem.dependencies ?? [];
      
      // Check if dependency already exists (legacy entries without
      // `entity`/`type` included)
      const project = projects.find(p => p.id === projectId);
      const fromRef = { id: fromItemId, type: fromItemType };
      if (project && currentDeps.some(d => dependencyMatches(project, d, fromRef, depType))) {
        return;
      }

      // Create new dependencies array. `entity` names the predecessor's kind:
      // phase and subphase ids are separate sequences, so the id alone is
      // ambiguous.
      const newDeps: Dependency[] = [...currentDeps, { id: fromItemId, type: depType, entity: fromItemType }];

      // Calculate duration in days (use exact day difference to preserve duration)
      const toStartDate = parseLocalDate(toItem.start_date);
      const toEndDate = parseLocalDate(toItem.end_date);
      toStartDate.setHours(0, 0, 0, 0);
      toEndDate.setHours(0, 0, 0, 0);
      const durationDays = Math.round((toEndDate.getTime() - toStartDate.getTime()) / 86400000);

      // Calculate new dates for FS and SS dependencies (auto-align)
      let newStartDate = toItem.start_date;
      let newEndDate = toItem.end_date;
      let dayOffset = 0;

      if (depType === 'FS') {
        // Finish-to-Start: align target start with source end + 1 day
        const fromEnd = parseLocalDate(fromItem.end_date);
        fromEnd.setHours(0, 0, 0, 0);
        const newStart = new Date(fromEnd);
        newStart.setDate(newStart.getDate() + 1);
        
        const newEnd = new Date(newStart);
        newEnd.setDate(newEnd.getDate() + durationDays);
        
        newStartDate = formatDateLocal(newStart);
        newEndDate = formatDateLocal(newEnd);
        dayOffset = Math.round((newStart.getTime() - toStartDate.getTime()) / 86400000);
      } else if (depType === 'SS') {
        // Start-to-Start: align target start with source start
        const fromStart = parseLocalDate(fromItem.start_date);
        fromStart.setHours(0, 0, 0, 0);
        const newStart = new Date(fromStart);
        
        const newEnd = new Date(newStart);
        newEnd.setDate(newEnd.getDate() + durationDays);
        
        newStartDate = formatDateLocal(newStart);
        newEndDate = formatDateLocal(newEnd);
        dayOffset = Math.round((newStart.getTime() - toStartDate.getTime()) / 86400000);
      }
      // FF and SF don't auto-move

      // Collect child updates for cascading
      const childUpdates: { type: 'subphase'; id: number; start_date: string; end_date: string }[] = [];
      
      // Helper to move children by offset
      const moveChildrenByOffset = (children: Subphase[], offset: number) => {
        for (const child of children) {
          const childStart = parseLocalDate(child.start_date);
          const childEnd = parseLocalDate(child.end_date);
          childStart.setDate(childStart.getDate() + offset);
          childEnd.setDate(childEnd.getDate() + offset);
          
          const newChildStart = formatDateLocal(childStart);
          const newChildEnd = formatDateLocal(childEnd);
          
          child.start_date = newChildStart;
          child.end_date = newChildEnd;
          
          childUpdates.push({
            type: 'subphase',
            id: child.id,
            start_date: newChildStart,
            end_date: newChildEnd,
          });
          
          // Recursively move nested children
          if (child.children?.length) {
            moveChildrenByOffset(child.children, offset);
          }
        }
      };

      // Collect parent updates for cascading
      const parentUpdates: { type: 'phase' | 'subphase' | 'project'; id: number; start_date: string; end_date: string }[] = [];

      // Build updated projects with cascading
      const updatedProjects = projects.map(project => {
        if (project.id !== projectId) return project;

        // Clone the project for mutation
        const projectCopy = cloneProject(project);

        if (toItemType === 'phase') {
          // Update the phase
          const phase = (projectCopy.phases ?? []).find(p => p.id === toItemId);
          if (phase) {
            phase.dependencies = newDeps;
            phase.start_date = newStartDate;
            phase.end_date = newEndDate;
            
            // Move children if phase moved
            if (dayOffset !== 0 && phase.children?.length) {
              moveChildrenByOffset(phase.children, dayOffset);
            }
          }
          
          // Cascade phase dates from children (in case it contracted)
          // Then adjust project dates
          autoAdjustProjectDates(projectCopy, parentUpdates);
          
        } else {
          // Update subphase recursively
          const updateSubphaseInTree = (subphases: Subphase[]): boolean => {
            for (const sp of subphases) {
              if (sp.id === toItemId) {
                sp.dependencies = newDeps;
                sp.start_date = newStartDate;
                sp.end_date = newEndDate;
                
                // Move children if subphase moved
                if (dayOffset !== 0 && sp.children?.length) {
                  moveChildrenByOffset(sp.children, dayOffset);
                }
                return true;
              }
              if (sp.children?.length && updateSubphaseInTree(sp.children)) {
                return true;
              }
            }
            return false;
          };

          for (const phase of projectCopy.phases ?? []) {
            if (phase.children?.length && updateSubphaseInTree(phase.children)) {
              break;
            }
          }
          
          // Cascade parent dates upward (subphase → parent subphase → phase → project)
          if (dayOffset !== 0) {
            cascadeParentDatesUp(projectCopy, toItemId, parentUpdates);
          }
        }

        return projectCopy;
      });

      setProjects(updatedProjects);

      // Save to server
      if (toItemType === 'phase') {
        await updatePhase(toItemId, {
          start_date: newStartDate,
          end_date: newEndDate,
          dependencies: newDeps,
        });
      } else {
        await updateSubphase(toItemId, {
          start_date: newStartDate,
          end_date: newEndDate,
          dependencies: newDeps,
        });
      }
      
      // Save child updates to server
      if (childUpdates.length > 0) {
        await savePendingUpdates(childUpdates);
      }
      
      // Save parent updates to server
      if (parentUpdates.length > 0) {
        await savePendingUpdates(parentUpdates);
      }

    } catch (err) {
      // Optimistic-write failure protocol: reload + clear the undo stack.
      await recoverFromPersistFailure('Dependency linking', err);
    }
  }, [projects, setProjects, findPhase, findSubphase]);

  // Cancel linking (e.g., on Escape or click outside)
  const handleCancelLinking = useCallback(() => {
    if (isLinkingDependency) {
      cancelLinking();
    }
  }, [isLinkingDependency, cancelLinking]);

  return {
    isLinkingDependency,
    linkingFrom,
    handleLinkZoneClick,
    handleCancelLinking,
  };
}
