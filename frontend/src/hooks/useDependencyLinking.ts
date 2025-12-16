/**
 * useDependencyLinking - Hook for creating dependencies between phases/subphases
 * Handles the two-click flow: first click selects source, second click selects target
 */

import { useCallback } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { updatePhase, updateSubphase, loadAllProjects } from '@/api/endpoints/projects';
import { 
  cascadeParentDatesUp, 
  autoAdjustProjectDates,
  savePendingUpdates,
  cloneProject,
} from '@/components/gantt/utils';
import type { DependencyType, Phase, Subphase } from '@/types';

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

// Format date as YYYY-MM-DD
function formatDateLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function useDependencyLinking() {
  const { 
    isLinkingDependency, 
    linkingFrom,
    startLinking, 
    completeLinking, 
    cancelLinking 
  } = useUIStore();
  
  const { projects, setProjects } = useAppStore();

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

  // Check for circular dependency
  const hasCircularDependency = useCallback((
    projectId: number,
    startItemId: number, 
    checkItemId: number,
    itemType: ItemType
  ): boolean => {
    const visited = new Set<number>();
    const toCheck = [startItemId];
    
    const project = projects.find(p => p.id === projectId);
    if (!project) return false;

    while (toCheck.length > 0) {
      const currentId = toCheck.pop()!;
      if (currentId === checkItemId) return true;
      if (visited.has(currentId)) continue;
      visited.add(currentId);
      
      // Find the item and its dependencies
      let deps: { id: number; type: DependencyType }[] = [];
      
      if (itemType === 'phase') {
        const phase = (project.phases ?? []).find(p => p.id === currentId);
        if (phase?.dependencies) {
          deps = phase.dependencies;
        }
      } else {
        // Search subphases
        const searchDeps = (subphases: Subphase[]): { id: number; type: DependencyType }[] => {
          for (const sp of subphases) {
            if (sp.id === currentId && sp.dependencies) {
              return sp.dependencies;
            }
            if (sp.children?.length) {
              const found = searchDeps(sp.children);
              if (found.length) return found;
            }
          }
          return [];
        };
        
        for (const phase of project.phases ?? []) {
          deps = searchDeps(phase.children ?? []);
          if (deps.length) break;
        }
      }
      
      deps.forEach(d => toCheck.push(d.id));
    }
    
    return false;
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

    // If already linking, try to complete the dependency
    if (isLinkingDependency && linkingFrom) {
      // Must be same project
      if (linkingFrom.projectId !== projectId) {
        alert('Dependencies can only be created between items in the same project');
        cancelLinking();
        return;
      }

      // Can't link to self
      if (linkingFrom.itemId === itemId && linkingFrom.itemType === itemType) {
        cancelLinking();
        return;
      }

      // Check for circular dependency
      if (hasCircularDependency(projectId, itemId, linkingFrom.itemId, itemType)) {
        alert('Cannot create circular dependency');
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
  }, [isLinkingDependency, linkingFrom, startLinking, completeLinking, cancelLinking, hasCircularDependency]);

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
      
      // Check if dependency already exists
      if (currentDeps.some(d => d.id === fromItemId && d.type === depType)) {
        console.log('Dependency already exists');
        return;
      }

      // Create new dependencies array
      const newDeps = [...currentDeps, { id: fromItemId, type: depType }];

      // Calculate duration in days (use exact day difference to preserve duration)
      const toStartDate = new Date(toItem.start_date);
      const toEndDate = new Date(toItem.end_date);
      toStartDate.setHours(0, 0, 0, 0);
      toEndDate.setHours(0, 0, 0, 0);
      const durationDays = Math.round((toEndDate.getTime() - toStartDate.getTime()) / 86400000);

      // Calculate new dates for FS and SS dependencies (auto-align)
      let newStartDate = toItem.start_date;
      let newEndDate = toItem.end_date;
      let dayOffset = 0;

      if (depType === 'FS') {
        // Finish-to-Start: align target start with source end + 1 day
        const fromEnd = new Date(fromItem.end_date);
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
        const fromStart = new Date(fromItem.start_date);
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
          const childStart = new Date(child.start_date);
          const childEnd = new Date(child.end_date);
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
        console.log(`Saving ${childUpdates.length} child updates from dependency creation`);
        await savePendingUpdates(childUpdates);
      }
      
      // Save parent updates to server
      if (parentUpdates.length > 0) {
        console.log(`Saving ${parentUpdates.length} parent updates from dependency creation`);
        await savePendingUpdates(parentUpdates);
      }

    } catch (err) {
      console.error('Failed to create dependency:', err);
      // Reload on error
      const reloadedProjects = await loadAllProjects();
      setProjects(reloadedProjects);
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
