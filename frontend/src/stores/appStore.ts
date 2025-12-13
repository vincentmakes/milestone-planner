/**
 * Main Application Store
 * Central state management using Zustand
 * Mirrors the structure of the existing vanilla JS state.js
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { 
  Site, 
  Project,
  Subphase,
  Staff, 
  Equipment, 
  User, 
  Vacation, 
  BankHoliday,
  ViewMode,
  CurrentView,
  ResourceTab,
  InstanceSettings,
} from '@/types';

// =============================================================================
// WHAT-IF MODE TYPES
// =============================================================================

/** Represents a pending API operation for What-If mode */
export interface WhatIfOperation {
  id: string;
  method: 'POST' | 'PUT' | 'DELETE';
  url: string;
  body?: unknown;
  timestamp: number;
}

// =============================================================================
// STATE INTERFACE
// =============================================================================

interface AppState {
  // ---------------------------------------------
  // AUTH STATE
  // ---------------------------------------------
  isAuthChecking: boolean;
  isAuthenticated: boolean;
  
  // ---------------------------------------------
  // DATA
  // ---------------------------------------------
  sites: Site[];
  projects: Project[];
  staff: Staff[];
  equipment: Equipment[];
  vacations: Vacation[];
  bankHolidays: BankHoliday[];
  bankHolidayDates: Set<string>;
  users: User[];
  instanceSettings: InstanceSettings | null;
  
  // ---------------------------------------------
  // CURRENT SELECTIONS
  // ---------------------------------------------
  currentSite: Site | null;
  currentUser: User | null;
  
  // ---------------------------------------------
  // VIEW STATE
  // ---------------------------------------------
  viewMode: ViewMode;
  currentView: CurrentView;
  currentDate: Date;
  cellWidth: number;
  currentResourceTab: ResourceTab;
  timelineScrollLeft: number;  // Scroll position within timeline
  
  // ---------------------------------------------
  // EXPANDED STATES (for tree views)
  // ---------------------------------------------
  expandedProjects: Set<number>;
  expandedPhases: Set<number>;
  expandedSubphases: Set<number>;
  expandedStaff: Set<number>;
  expandedEquipment: Set<number>;
  expandedBankHolidays: boolean;
  
  // ---------------------------------------------
  // WHAT IF MODE
  // ---------------------------------------------
  whatIfMode: boolean;
  whatIfSnapshot: {
    projects: Project[];
  } | null;
  /** Queue of API operations to replay when applying What-If changes */
  whatIfPendingOperations: WhatIfOperation[];
  
  // ---------------------------------------------
  // UI STATE
  // ---------------------------------------------
  sidebarCollapsed: boolean;
  resourcePanelCollapsed: boolean;
  
  // ---------------------------------------------
  // ACTIONS - Data Setters
  // ---------------------------------------------
  setSites: (sites: Site[]) => void;
  setProjects: (projects: Project[]) => void;
  setStaff: (staff: Staff[]) => void;
  setEquipment: (equipment: Equipment[]) => void;
  setVacations: (vacations: Vacation[]) => void;
  setBankHolidays: (holidays: BankHoliday[], holidayDates: Set<string>) => void;
  setUsers: (users: User[]) => void;
  setInstanceSettings: (settings: InstanceSettings | null) => void;
  
  // ---------------------------------------------
  // ACTIONS - Selection Setters
  // ---------------------------------------------
  setCurrentSite: (site: Site | null) => void;
  setCurrentUser: (user: User | null) => void;
  
  // ---------------------------------------------
  // ACTIONS - Auth State
  // ---------------------------------------------
  setAuthChecking: (isChecking: boolean) => void;
  setAuthenticated: (isAuthenticated: boolean) => void;
  
  // ---------------------------------------------
  // ACTIONS - View State
  // ---------------------------------------------
  setViewMode: (mode: ViewMode) => void;
  setCurrentView: (view: CurrentView) => void;
  setCurrentDate: (date: Date) => void;
  setCellWidth: (width: number) => void;
  setCurrentResourceTab: (tab: ResourceTab) => void;
  setTimelineScrollLeft: (scrollLeft: number) => void;
  navigatePeriod: (direction: 1 | -1) => void;
  goToToday: () => void;
  
  // ---------------------------------------------
  // ACTIONS - Expanded States
  // ---------------------------------------------
  toggleProjectExpanded: (projectId: number) => void;
  togglePhaseExpanded: (phaseId: number) => void;
  toggleSubphaseExpanded: (subphaseId: number) => void;
  toggleStaffExpanded: (staffId: number) => void;
  toggleEquipmentExpanded: (equipmentId: number) => void;
  toggleBankHolidaysExpanded: () => void;
  ensureProjectExpanded: (projectId: number) => void;
  ensurePhaseExpanded: (phaseId: number) => void;
  ensureSubphaseExpanded: (subphaseId: number) => void;
  setExpandedProjects: (ids: Set<number>) => void;
  setExpandedPhases: (ids: Set<number>) => void;
  collapseAll: () => void;
  expandAll: () => void;
  expandProjectLevel: (projectId: number) => void;
  collapseProjectLevel: (projectId: number) => void;
  
  // ---------------------------------------------
  // ACTIONS - What If Mode
  // ---------------------------------------------
  enterWhatIfMode: () => void;
  exitWhatIfMode: (applyChanges: boolean) => Promise<void>;
  queueWhatIfOperation: (operation: Omit<WhatIfOperation, 'id' | 'timestamp'>) => void;
  
  // ---------------------------------------------
  // ACTIONS - UI State
  // ---------------------------------------------
  toggleSidebar: () => void;
  toggleResourcePanel: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setResourcePanelCollapsed: (collapsed: boolean) => void;
  
  // ---------------------------------------------
  // ACTIONS - Reset
  // ---------------------------------------------
  reset: () => void;
}

// =============================================================================
// DEFAULT CELL WIDTHS BY VIEW MODE
// =============================================================================

const VIEW_MODE_CELL_WIDTHS: Record<ViewMode, number> = {
  week: 100,
  month: 36,
  quarter: 50,
  year: 80,
};

// =============================================================================
// LEVEL EXPANSION HELPERS
// =============================================================================

interface LevelItem {
  type: 'phase' | 'subphase';
  id: number;
  hasChildren: boolean;
}

interface LevelMap {
  [level: number]: LevelItem[];
}

// Get all expandable items at each level for a project
function getProjectLevelItems(project: Project): { levels: LevelMap; maxLevel: number } {
  const levels: LevelMap = {
    1: [], // Phases
  };
  
  // Collect phases and their children
  for (const phase of (project.phases || [])) {
    if (!phase.is_milestone) {
      const children = phase.children || [];
      const hasChildren = children.length > 0;
      levels[1].push({ type: 'phase', id: phase.id, hasChildren });
      
      // Collect children recursively
      if (hasChildren) {
        collectSubphaseLevels(children, 2, levels);
      }
    }
  }
  
  // Find max level with content
  let maxLevel = 0;
  for (const lvl in levels) {
    if (levels[lvl] && levels[lvl].length > 0) {
      maxLevel = Math.max(maxLevel, parseInt(lvl));
    }
  }
  
  // Always allow expanding to at least level 1
  maxLevel = Math.max(maxLevel, 1);
  
  return { levels, maxLevel };
}

function collectSubphaseLevels(subphases: Subphase[], level: number, levels: LevelMap): void {
  if (!subphases || subphases.length === 0) return;
  if (!levels[level]) levels[level] = [];
  
  for (const sub of subphases) {
    const children = sub.children || [];
    const hasChildren = children.length > 0;
    levels[level].push({ type: 'subphase', id: sub.id, hasChildren });
    
    if (hasChildren) {
      collectSubphaseLevels(children, level + 1, levels);
    }
  }
}

// Get current expansion level for a project
function getCurrentExpansionLevel(
  project: Project,
  expandedProjects: Set<number>,
  expandedPhases: Set<number>,
  expandedSubphases: Set<number>
): number {
  if (!expandedProjects.has(project.id)) return 0;
  
  const { levels, maxLevel } = getProjectLevelItems(project);
  
  // If no phases, we're at level 1
  if (!levels[1] || levels[1].length === 0) return 1;
  
  // Check if ANY phase is expanded
  const anyPhaseExpanded = levels[1].some(item => expandedPhases.has(item.id));
  if (!anyPhaseExpanded) return 1;
  
  // At least one phase is expanded, so we're at level 2 minimum
  // Now check subphase levels
  for (let lvl = 2; lvl <= maxLevel; lvl++) {
    if (!levels[lvl] || levels[lvl].length === 0) continue;
    
    // Check if ANY subphase at this level is expanded
    const anyExpanded = levels[lvl].some(item => expandedSubphases.has(item.id));
    if (!anyExpanded) return lvl;
  }
  
  return maxLevel;
}

// Expand to a specific level
function expandToLevel(
  project: Project,
  targetLevel: number,
  levels: LevelMap,
  maxLevel: number,
  expandedProjects: Set<number>,
  expandedPhases: Set<number>,
  expandedSubphases: Set<number>
): { expandedProjects: Set<number>; expandedPhases: Set<number>; expandedSubphases: Set<number> } {
  const newExpandedProjects = new Set(expandedProjects);
  const newExpandedPhases = new Set(expandedPhases);
  const newExpandedSubphases = new Set(expandedSubphases);
  
  // Level 0: collapse project
  if (targetLevel === 0) {
    newExpandedProjects.delete(project.id);
    // Collapse all phases and subphases for this project
    for (const item of (levels[1] || [])) newExpandedPhases.delete(item.id);
    for (let lvl = 2; lvl <= maxLevel; lvl++) {
      for (const item of (levels[lvl] || [])) newExpandedSubphases.delete(item.id);
    }
  } else {
    // Expand project
    newExpandedProjects.add(project.id);
    
    // Level 1: show phases, collapse all phases (don't expand them)
    if (targetLevel === 1) {
      for (const item of (levels[1] || [])) newExpandedPhases.delete(item.id);
      for (let lvl = 2; lvl <= maxLevel; lvl++) {
        for (const item of (levels[lvl] || [])) newExpandedSubphases.delete(item.id);
      }
    } else {
      // Level 2+: expand phases to show subphases
      for (const item of (levels[1] || [])) {
        newExpandedPhases.add(item.id);
      }
      
      // For level 3+, expand subphases at levels below target
      for (let lvl = 2; lvl <= maxLevel; lvl++) {
        for (const item of (levels[lvl] || [])) {
          if (lvl < targetLevel) {
            // Expand this level to show next level
            newExpandedSubphases.add(item.id);
          } else {
            // Collapse this level
            newExpandedSubphases.delete(item.id);
          }
        }
      }
    }
  }
  
  return {
    expandedProjects: newExpandedProjects,
    expandedPhases: newExpandedPhases,
    expandedSubphases: newExpandedSubphases,
  };
}

// =============================================================================
// INITIAL STATE
// =============================================================================

const initialState = {
  // Auth state
  isAuthChecking: true,
  isAuthenticated: false,
  
  // Data
  sites: [],
  projects: [],
  staff: [],
  equipment: [],
  vacations: [],
  bankHolidays: [],
  bankHolidayDates: new Set<string>(),
  users: [],
  instanceSettings: null,
  
  // Selections
  currentSite: null,
  currentUser: null,
  
  // View state
  viewMode: 'month' as ViewMode,
  currentView: 'gantt' as CurrentView,
  currentDate: new Date(),
  cellWidth: 36,
  currentResourceTab: 'staff' as ResourceTab,
  timelineScrollLeft: 0,
  
  // Expanded states
  expandedProjects: new Set<number>(),
  expandedPhases: new Set<number>(),
  expandedSubphases: new Set<number>(),
  expandedStaff: new Set<number>(),
  expandedEquipment: new Set<number>(),
  expandedBankHolidays: false,
  
  // What If mode
  whatIfMode: false,
  whatIfSnapshot: null,
  whatIfPendingOperations: [],
  
  // UI state
  sidebarCollapsed: false,
  resourcePanelCollapsed: false,
};

// =============================================================================
// STORE CREATION
// =============================================================================

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      ...initialState,
      
      // -----------------------------------------
      // DATA SETTERS
      // -----------------------------------------
      setSites: (sites) => set({ sites }),
      
      setProjects: (projects) => set({ projects }),
      
      setStaff: (staff) => set({ staff }),
      
      setEquipment: (equipment) => set({ equipment }),
      
      setVacations: (vacations) => set({ vacations }),
      
      setBankHolidays: (holidays, holidayDates) => set({ 
        bankHolidays: holidays,
        bankHolidayDates: holidayDates,
      }),
      
      setUsers: (users) => set({ users }),
      
      setInstanceSettings: (settings) => set({ instanceSettings: settings }),
      
      // -----------------------------------------
      // SELECTION SETTERS
      // -----------------------------------------
      setCurrentSite: (site) => set({ currentSite: site }),
      
      setCurrentUser: (user) => set({ currentUser: user }),
      
      // -----------------------------------------
      // AUTH STATE ACTIONS
      // -----------------------------------------
      setAuthChecking: (isChecking) => set({ isAuthChecking: isChecking }),
      
      setAuthenticated: (isAuthenticated) => set({ isAuthenticated }),
      
      // -----------------------------------------
      // VIEW STATE ACTIONS
      // -----------------------------------------
      setViewMode: (mode) => set({ 
        viewMode: mode,
        cellWidth: VIEW_MODE_CELL_WIDTHS[mode],
      }),
      
      setCurrentView: (view) => set({ currentView: view }),
      
      setCurrentDate: (date) => set({ currentDate: date }),
      
      setCellWidth: (width) => set({ cellWidth: width }),
      
      setCurrentResourceTab: (tab) => set({ currentResourceTab: tab }),
      
      setTimelineScrollLeft: (scrollLeft) => set({ timelineScrollLeft: scrollLeft }),
      
      navigatePeriod: (direction) => {
        const { viewMode, currentDate } = get();
        const newDate = new Date(currentDate);
        
        switch (viewMode) {
          case 'week':
            newDate.setDate(newDate.getDate() + direction * 7);
            break;
          case 'month':
            newDate.setMonth(newDate.getMonth() + direction);
            break;
          case 'quarter':
            newDate.setMonth(newDate.getMonth() + direction * 3);
            break;
          case 'year':
            newDate.setFullYear(newDate.getFullYear() + direction);
            break;
        }
        
        set({ currentDate: newDate });
      },
      
      goToToday: () => set({ currentDate: new Date() }),
      
      // -----------------------------------------
      // EXPANDED STATE ACTIONS
      // -----------------------------------------
      toggleProjectExpanded: (projectId) => set((state) => {
        const expanded = new Set(state.expandedProjects);
        if (expanded.has(projectId)) {
          expanded.delete(projectId);
        } else {
          expanded.add(projectId);
        }
        return { expandedProjects: expanded };
      }),
      
      togglePhaseExpanded: (phaseId) => set((state) => {
        const expanded = new Set(state.expandedPhases);
        if (expanded.has(phaseId)) {
          expanded.delete(phaseId);
        } else {
          expanded.add(phaseId);
        }
        return { expandedPhases: expanded };
      }),
      
      toggleSubphaseExpanded: (subphaseId) => set((state) => {
        const expanded = new Set(state.expandedSubphases);
        if (expanded.has(subphaseId)) {
          expanded.delete(subphaseId);
        } else {
          expanded.add(subphaseId);
        }
        return { expandedSubphases: expanded };
      }),
      
      toggleStaffExpanded: (staffId) => set((state) => {
        const expanded = new Set(state.expandedStaff);
        if (expanded.has(staffId)) {
          expanded.delete(staffId);
        } else {
          expanded.add(staffId);
        }
        return { expandedStaff: expanded };
      }),
      
      toggleEquipmentExpanded: (equipmentId) => set((state) => {
        const expanded = new Set(state.expandedEquipment);
        if (expanded.has(equipmentId)) {
          expanded.delete(equipmentId);
        } else {
          expanded.add(equipmentId);
        }
        return { expandedEquipment: expanded };
      }),
      
      toggleBankHolidaysExpanded: () => set((state) => ({
        expandedBankHolidays: !state.expandedBankHolidays,
      })),
      
      // Ensure expanded (only add, never remove)
      ensureProjectExpanded: (projectId) => set((state) => {
        if (state.expandedProjects.has(projectId)) return state;
        const expanded = new Set(state.expandedProjects);
        expanded.add(projectId);
        return { expandedProjects: expanded };
      }),
      
      ensurePhaseExpanded: (phaseId) => set((state) => {
        if (state.expandedPhases.has(phaseId)) return state;
        const expanded = new Set(state.expandedPhases);
        expanded.add(phaseId);
        return { expandedPhases: expanded };
      }),
      
      ensureSubphaseExpanded: (subphaseId) => set((state) => {
        if (state.expandedSubphases.has(subphaseId)) return state;
        const expanded = new Set(state.expandedSubphases);
        expanded.add(subphaseId);
        return { expandedSubphases: expanded };
      }),
      
      setExpandedProjects: (ids) => set({ expandedProjects: ids }),
      
      setExpandedPhases: (ids) => set({ expandedPhases: ids }),
      
      collapseAll: () => set({
        expandedProjects: new Set(),
        expandedPhases: new Set(),
        expandedSubphases: new Set(),
        expandedStaff: new Set(),
        expandedEquipment: new Set(),
      }),
      
      expandAll: () => {
        const { projects } = get();
        const projectIds = new Set(projects.map(p => p.id));
        const phaseIds = new Set<number>();
        const subphaseIds = new Set<number>();
        
        // Collect all phase and subphase IDs
        projects.forEach(project => {
          project.phases?.forEach(phase => {
            phaseIds.add(phase.id);
            const collectSubphases = (children: typeof phase.children) => {
              children?.forEach(child => {
                subphaseIds.add(child.id);
                collectSubphases(child.children);
              });
            };
            collectSubphases(phase.children);
          });
        });
        
        set({
          expandedProjects: projectIds,
          expandedPhases: phaseIds,
          expandedSubphases: subphaseIds,
        });
      },
      
      expandProjectLevel: (projectId: number) => {
        const { projects, expandedProjects, expandedPhases, expandedSubphases } = get();
        const project = projects.find(p => p.id === projectId);
        if (!project) return;
        
        // Get current level and calculate next level
        const { levels, maxLevel } = getProjectLevelItems(project);
        const currentLevel = getCurrentExpansionLevel(project, expandedProjects, expandedPhases, expandedSubphases);
        const targetLevel = Math.min(currentLevel + 1, maxLevel);
        
        // Apply the new level
        const newState = expandToLevel(project, targetLevel, levels, maxLevel, expandedProjects, expandedPhases, expandedSubphases);
        set(newState);
      },
      
      collapseProjectLevel: (projectId: number) => {
        const { projects, expandedProjects, expandedPhases, expandedSubphases } = get();
        const project = projects.find(p => p.id === projectId);
        if (!project) return;
        
        // Get current level and calculate previous level
        const { levels, maxLevel } = getProjectLevelItems(project);
        const currentLevel = getCurrentExpansionLevel(project, expandedProjects, expandedPhases, expandedSubphases);
        const targetLevel = Math.max(currentLevel - 1, 0);
        
        // Apply the new level
        const newState = expandToLevel(project, targetLevel, levels, maxLevel, expandedProjects, expandedPhases, expandedSubphases);
        set(newState);
      },
      
      // -----------------------------------------
      // WHAT IF MODE ACTIONS
      // -----------------------------------------
      enterWhatIfMode: () => {
        const { projects } = get();
        set({
          whatIfMode: true,
          whatIfSnapshot: {
            projects: structuredClone(projects),
          },
          whatIfPendingOperations: [],
        });
      },
      
      exitWhatIfMode: async (applyChanges) => {
        const { whatIfSnapshot, whatIfPendingOperations } = get();
        
        if (!applyChanges && whatIfSnapshot) {
          // Discard: Restore original state
          set({
            projects: whatIfSnapshot.projects,
            whatIfMode: false,
            whatIfSnapshot: null,
            whatIfPendingOperations: [],
          });
        } else if (applyChanges && whatIfPendingOperations.length > 0) {
          // Apply: Execute all pending operations
          console.log(`[What If] Applying ${whatIfPendingOperations.length} pending operations...`);
          
          // Import the API client to make real requests
          const { apiRequest, clientConfig } = await import('@/api/client');
          
          // Temporarily disable What-If mode check for these requests
          const originalIsWhatIfMode = clientConfig.isWhatIfMode;
          clientConfig.isWhatIfMode = () => false;
          
          try {
            for (const op of whatIfPendingOperations) {
              console.log(`[What If] Executing: ${op.method} ${op.url}`);
              await apiRequest(op.url, {
                method: op.method,
                body: op.body,
              });
            }
            console.log('[What If] All operations applied successfully');
          } catch (error) {
            console.error('[What If] Failed to apply operations:', error);
            // Note: Some operations may have succeeded, so we don't restore snapshot
            // User should reload to see actual state
          } finally {
            // Restore the What-If mode check
            clientConfig.isWhatIfMode = originalIsWhatIfMode;
          }
          
          set({
            whatIfMode: false,
            whatIfSnapshot: null,
            whatIfPendingOperations: [],
          });
        } else {
          // No changes or no pending ops, just exit
          set({
            whatIfMode: false,
            whatIfSnapshot: null,
            whatIfPendingOperations: [],
          });
        }
      },
      
      queueWhatIfOperation: (operation) => {
        set((state) => ({
          whatIfPendingOperations: [
            ...state.whatIfPendingOperations,
            {
              ...operation,
              id: `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              timestamp: Date.now(),
            },
          ],
        }));
      },
      
      // -----------------------------------------
      // UI STATE ACTIONS
      // -----------------------------------------
      toggleSidebar: () => set((state) => ({
        sidebarCollapsed: !state.sidebarCollapsed,
      })),
      
      toggleResourcePanel: () => set((state) => ({
        resourcePanelCollapsed: !state.resourcePanelCollapsed,
      })),
      
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      
      setResourcePanelCollapsed: (collapsed) => set({ resourcePanelCollapsed: collapsed }),
      
      // -----------------------------------------
      // RESET
      // -----------------------------------------
      reset: () => set(initialState),
    }),
    {
      name: 'milestone-app-storage',
      storage: createJSONStorage(() => localStorage),
      // Only persist certain fields
      partialize: (state) => ({
        viewMode: state.viewMode,
        currentView: state.currentView,
        cellWidth: state.cellWidth,
        currentResourceTab: state.currentResourceTab,
        sidebarCollapsed: state.sidebarCollapsed,
        resourcePanelCollapsed: state.resourcePanelCollapsed,
        timelineScrollLeft: state.timelineScrollLeft,
        // Convert Sets to Arrays for JSON serialization
        expandedProjects: Array.from(state.expandedProjects),
        expandedPhases: Array.from(state.expandedPhases),
        expandedSubphases: Array.from(state.expandedSubphases),
        // Store current site ID
        currentSiteId: state.currentSite?.id,
        // Store current date as ISO string
        currentDateISO: state.currentDate.toISOString(),
      }),
      // Callback when hydration starts/completes
      onRehydrateStorage: () => {
        console.log('[AppStore] Starting hydration from localStorage...');
        return (state, error) => {
          if (error) {
            console.error('[AppStore] Hydration error:', error);
          } else if (state) {
            console.log('[AppStore] Hydration complete:', {
              viewMode: state.viewMode,
              currentDate: state.currentDate?.toISOString?.(),
              cellWidth: state.cellWidth,
            });
          }
        };
      },
      // Custom merge to handle Sets properly
      merge: (persistedState, currentState) => {
        // Zustand persist stores data in { state: { ... }, version: ... } format
        // The persistedState might be the unwrapped state or the wrapped object
        const persisted = (persistedState as any)?.state ?? persistedState as any;
        console.log('[AppStore] Merging persisted state:', {
          raw: persistedState,
          unwrapped: persisted,
        });
        
        return {
          ...currentState,
          // Only restore the view state fields, not currentSiteId (that's handled by useDataLoader)
          viewMode: persisted?.viewMode ?? currentState.viewMode,
          currentView: persisted?.currentView ?? currentState.currentView,
          cellWidth: persisted?.cellWidth ?? currentState.cellWidth,
          currentResourceTab: persisted?.currentResourceTab ?? currentState.currentResourceTab,
          sidebarCollapsed: persisted?.sidebarCollapsed ?? currentState.sidebarCollapsed,
          resourcePanelCollapsed: persisted?.resourcePanelCollapsed ?? currentState.resourcePanelCollapsed,
          timelineScrollLeft: persisted?.timelineScrollLeft ?? currentState.timelineScrollLeft,
          // Convert Arrays back to Sets
          expandedProjects: Array.isArray(persisted?.expandedProjects) 
            ? new Set(persisted.expandedProjects) 
            : currentState.expandedProjects,
          expandedPhases: Array.isArray(persisted?.expandedPhases) 
            ? new Set(persisted.expandedPhases) 
            : currentState.expandedPhases,
          expandedSubphases: Array.isArray(persisted?.expandedSubphases) 
            ? new Set(persisted.expandedSubphases) 
            : currentState.expandedSubphases,
          // Restore current date from ISO string
          currentDate: persisted?.currentDateISO 
            ? new Date(persisted.currentDateISO)
            : currentState.currentDate,
        };
      },
    }
  )
);

// =============================================================================
// SELECTORS (for derived state)
// =============================================================================

/**
 * Get projects filtered by current site (non-archived)
 */
export const selectSiteProjects = (state: AppState): Project[] => {
  return state.projects.filter(
    p => p.site_id === state.currentSite?.id && !p.archived
  );
};

/**
 * Get archived projects for current site
 */
export const selectArchivedProjects = (state: AppState): Project[] => {
  return state.projects.filter(
    p => p.site_id === state.currentSite?.id && p.archived
  );
};

/**
 * Get staff for current site
 */
export const selectSiteStaff = (state: AppState): Staff[] => {
  return state.staff.filter(s => s.site_id === state.currentSite?.id);
};

/**
 * Get equipment for current site
 */
export const selectSiteEquipment = (state: AppState): Equipment[] => {
  return state.equipment.filter(e => e.site_id === state.currentSite?.id);
};

/**
 * Check if user can manage resources (admin or superuser)
 */
export const selectCanManageResources = (state: AppState): boolean => {
  return state.currentUser?.role === 'admin' || state.currentUser?.role === 'superuser';
};

/**
 * Check if user is admin
 */
export const selectIsAdmin = (state: AppState): boolean => {
  return state.currentUser?.role === 'admin';
};
