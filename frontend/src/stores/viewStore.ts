/**
 * View Store
 * Manages view/display state: view mode, timeline settings, expansion states,
 * sidebar/resource panel collapse, and overview panel visibility.
 * This state is persisted to localStorage via Zustand persist.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  ViewMode,
  CurrentView,
  ResourceTab,
  Project,
  Subphase,
} from '@/types';

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

/** Get all expandable items at each level for a project */
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

/** Get current expansion level for a project */
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

/** Expand to a specific level */
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
// STATE INTERFACE
// =============================================================================

interface ViewState {
  // ---------------------------------------------
  // VIEW STATE
  // ---------------------------------------------
  viewMode: ViewMode;
  currentView: CurrentView;
  currentDate: Date;
  cellWidth: number;
  currentResourceTab: ResourceTab;
  timelineScrollLeft: number;
  showAssignments: boolean;
  showStaffOverview: boolean;
  showEquipmentOverview: boolean;

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
  // UI LAYOUT STATE
  // ---------------------------------------------
  sidebarCollapsed: boolean;
  resourcePanelCollapsed: boolean;

  // ---------------------------------------------
  // ACTIONS - View State
  // ---------------------------------------------
  setViewMode: (mode: ViewMode) => void;
  setCurrentView: (view: CurrentView) => void;
  setCurrentDate: (date: Date) => void;
  setCellWidth: (width: number) => void;
  setCurrentResourceTab: (tab: ResourceTab) => void;
  setTimelineScrollLeft: (scrollLeft: number) => void;
  setShowAssignments: (show: boolean) => void;
  toggleShowAssignments: () => void;
  navigatePeriod: (direction: 1 | -1) => void;
  goToToday: () => void;
  setShowStaffOverview: (show: boolean) => void;
  toggleShowStaffOverview: () => void;
  setShowEquipmentOverview: (show: boolean) => void;
  toggleShowEquipmentOverview: () => void;

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
  expandAll: (projects: Project[]) => void;
  expandProjectLevel: (projectId: number, projects: Project[]) => void;
  collapseProjectLevel: (projectId: number, projects: Project[]) => void;

  // ---------------------------------------------
  // ACTIONS - UI Layout
  // ---------------------------------------------
  toggleSidebar: () => void;
  toggleResourcePanel: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setResourcePanelCollapsed: (collapsed: boolean) => void;

  // ---------------------------------------------
  // ACTIONS - Reset
  // ---------------------------------------------
  resetView: () => void;
}

// =============================================================================
// INITIAL STATE
// =============================================================================

const initialViewState = {
  // View state
  viewMode: 'month' as ViewMode,
  currentView: 'gantt' as CurrentView,
  currentDate: new Date(),
  cellWidth: 36,
  currentResourceTab: 'staff' as ResourceTab,
  timelineScrollLeft: 0,
  showAssignments: true,
  showStaffOverview: false,
  showEquipmentOverview: false,

  // Expanded states
  expandedProjects: new Set<number>(),
  expandedPhases: new Set<number>(),
  expandedSubphases: new Set<number>(),
  expandedStaff: new Set<number>(),
  expandedEquipment: new Set<number>(),
  expandedBankHolidays: false,

  // UI layout
  sidebarCollapsed: false,
  resourcePanelCollapsed: false,
};

// =============================================================================
// STORE CREATION
// =============================================================================

export const useViewStore = create<ViewState>()(
  persist(
    (set, get) => ({
      ...initialViewState,

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

      setShowAssignments: (show) => set({ showAssignments: show }),

      toggleShowAssignments: () => set((state) => ({ showAssignments: !state.showAssignments })),

      // Staff overview - closes equipment if opening staff
      setShowStaffOverview: (show) => set({
        showStaffOverview: show,
        showEquipmentOverview: show ? false : get().showEquipmentOverview,
      }),

      toggleShowStaffOverview: () => set((state) => ({
        showStaffOverview: !state.showStaffOverview,
        showEquipmentOverview: !state.showStaffOverview ? false : state.showEquipmentOverview,
      })),

      // Equipment overview - closes staff if opening equipment
      setShowEquipmentOverview: (show: boolean) => set({
        showEquipmentOverview: show,
        showStaffOverview: show ? false : get().showStaffOverview,
      }),

      toggleShowEquipmentOverview: () => set((state) => ({
        showEquipmentOverview: !state.showEquipmentOverview,
        showStaffOverview: !state.showEquipmentOverview ? false : state.showStaffOverview,
      })),

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

      expandAll: (projects: Project[]) => {
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

      expandProjectLevel: (projectId: number, projects: Project[]) => {
        const { expandedProjects, expandedPhases, expandedSubphases } = get();
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

      collapseProjectLevel: (projectId: number, projects: Project[]) => {
        const { expandedProjects, expandedPhases, expandedSubphases } = get();
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
      // UI LAYOUT ACTIONS
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
      resetView: () => set(initialViewState),
    }),
    {
      name: 'milestone-view-storage-v1',
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
        showStaffOverview: state.showStaffOverview,
        showEquipmentOverview: state.showEquipmentOverview,
        // Convert Sets to Arrays for JSON serialization
        expandedProjects: Array.from(state.expandedProjects),
        expandedPhases: Array.from(state.expandedPhases),
        expandedSubphases: Array.from(state.expandedSubphases),
        // Store current date as ISO string
        currentDateISO: state.currentDate.toISOString(),
      }),
      // Callback when hydration starts/completes
      onRehydrateStorage: () => {
        return (_state, error) => {
          if (error) {
            console.error('[ViewStore] Hydration error:', error);
          }
        };
      },
      // Custom merge to handle Sets properly
      merge: (persistedState, currentState) => {
        const persisted = ((persistedState as Record<string, unknown>)?.state ?? persistedState) as Record<string, unknown>;

        return {
          ...currentState,
          viewMode: (persisted?.viewMode as ViewMode) ?? currentState.viewMode,
          currentView: (persisted?.currentView as CurrentView) ?? currentState.currentView,
          cellWidth: (persisted?.cellWidth as number) ?? currentState.cellWidth,
          currentResourceTab: (persisted?.currentResourceTab as ResourceTab) ?? currentState.currentResourceTab,
          sidebarCollapsed: (persisted?.sidebarCollapsed as boolean) ?? currentState.sidebarCollapsed,
          resourcePanelCollapsed: (persisted?.resourcePanelCollapsed as boolean) ?? currentState.resourcePanelCollapsed,
          timelineScrollLeft: (persisted?.timelineScrollLeft as number) ?? currentState.timelineScrollLeft,
          showStaffOverview: (persisted?.showStaffOverview as boolean) ?? currentState.showStaffOverview,
          showEquipmentOverview: (persisted?.showEquipmentOverview as boolean) ?? currentState.showEquipmentOverview,
          // Convert Arrays back to Sets
          expandedProjects: Array.isArray(persisted?.expandedProjects)
            ? new Set(persisted.expandedProjects as number[])
            : currentState.expandedProjects,
          expandedPhases: Array.isArray(persisted?.expandedPhases)
            ? new Set(persisted.expandedPhases as number[])
            : currentState.expandedPhases,
          expandedSubphases: Array.isArray(persisted?.expandedSubphases)
            ? new Set(persisted.expandedSubphases as number[])
            : currentState.expandedSubphases,
          // Restore current date from ISO string
          currentDate: persisted?.currentDateISO
            ? new Date(persisted.currentDateISO as string)
            : currentState.currentDate,
        };
      },
    }
  )
);
