/**
 * View Store
 * Manages view/display state: view mode, timeline settings, expansion states,
 * sidebar/resource panel collapse, and overview panel visibility.
 * This state is persisted to localStorage via Zustand persist.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { KanbanGrouping } from '@/utils/kanbanCards';
import { SITE_KEY_PATTERN, siteKey } from '@/utils/tags';
import type { ColorByChoice, ProjectFilter } from '@/utils/projectFilters';
import type { TeamFilter } from '@/utils/teams';
import { navigateDate } from '@/utils/date';
import { useWhatIfStore } from './whatIfStore';
import type {
  ViewMode,
  CurrentView,
  ResourceTab,
  Project,
} from '@/types';
import { getProjectLevelItems, getCurrentExpansionLevel } from '@/utils/projectLevels';
import type { LevelMap } from '@/utils/projectLevels';

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
// PERSISTENCE HELPERS
// =============================================================================

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => Number.isInteger(v)) : [];
}

/**
 * Rebuild persisted project filters, dropping malformed and empty entries and
 * keys that are not `siteKey`s (legacy site-id-only keys cannot tell which
 * tenant they belong to); null if absent/invalid.
 */
function sanitizeProjectFilters(value: unknown): Record<string, ProjectFilter> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, ProjectFilter> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!SITE_KEY_PATTERN.test(key) || !raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const filter = {
      optionIds: numberArray(entry.optionIds),
      noneFieldIds: numberArray(entry.noneFieldIds),
      tagIds: numberArray(entry.tagIds),
    };
    if (filter.optionIds.length > 0 || filter.noneFieldIds.length > 0 || filter.tagIds.length > 0) {
      out[key] = filter;
    }
  }
  return out;
}

/**
 * Rebuild persisted team filters like {@link sanitizeProjectFilters}: same key
 * rule, malformed and empty entries dropped; null if absent/invalid.
 */
function sanitizeTeamFilters(value: unknown): Record<string, TeamFilter> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, TeamFilter> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!SITE_KEY_PATTERN.test(key) || !raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const filter = { teamIds: numberArray(entry.teamIds), noTeam: entry.noTeam === true };
    if (filter.teamIds.length > 0 || filter.noTeam) out[key] = filter;
  }
  return out;
}

/** Shape of a Gantt section key (see components/gantt/utils/projectSections.ts). */
const GANTT_SECTION_KEY_PATTERN = /^(field-\d+|none)$/;

/**
 * Rebuild a persisted per-site field choice (siteKey → project field id: the
 * Gantt "Group by"); null if absent/invalid.
 */
function sanitizeSiteFieldIds(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (SITE_KEY_PATTERN.test(key) && Number.isInteger(raw)) out[key] = raw as number;
  }
  return out;
}

/**
 * Rebuild a persisted per-site "Colour by" choice (siteKey → project field id
 * or `'tags'`); null if absent/invalid.
 */
function sanitizeSiteColorBy(value: unknown): Record<string, ColorByChoice> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, ColorByChoice> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (SITE_KEY_PATTERN.test(key) && (Number.isInteger(raw) || raw === 'tags')) {
      out[key] = raw as ColorByChoice;
    }
  }
  return out;
}

/** Rebuild persisted collapsed Gantt sections (siteKey → section keys); null if absent/invalid. */
function sanitizeCollapsedGanttSections(value: unknown): Record<string, string[]> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!SITE_KEY_PATTERN.test(key) || !Array.isArray(raw)) continue;
    const keys = [
      ...new Set(raw.filter((k): k is string => typeof k === 'string' && GANTT_SECTION_KEY_PATTERN.test(k))),
    ];
    if (keys.length > 0) out[key] = keys;
  }
  return out;
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
  // KANBAN STATE
  // ---------------------------------------------
  /** Project whose board is shown. Null = fall back to the first site project. */
  kanbanProjectId: number | null;
  kanbanGrouping: KanbanGrouping;
  /** Custom column driving the swimlanes when kanbanGrouping === 'customColumn'. */
  kanbanGroupingColumnId: number | null;
  kanbanMyTodoOnly: boolean;

  // ---------------------------------------------
  // PROJECT FILTER (Gantt + Kanban)
  // ---------------------------------------------
  /**
   * Project filter (field items, "(None)" per field, tags) per tenant + site,
   * keyed by `siteKey(siteId)` (`"<tenant slug>:<site id>"`). Absent = no
   * filter. A per-browser preference: deliberately not cleared by
   * resetAllStores(). Replaced the pre-2.0 `tagFilters` (dropped on load).
   */
  projectFilters: Record<string, ProjectFilter>;
  /**
   * Header team filter per tenant + site, keyed by `siteKey(siteId)`.
   * Absent = "Whole site". Per-browser, like `projectFilters`.
   */
  teamFilters: Record<string, TeamFilter>;

  // ---------------------------------------------
  // GANTT GROUPING
  // ---------------------------------------------
  /**
   * Dropdown project field the Gantt project list is grouped by, per tenant +
   * site (`siteKey`). Absent = no grouping. Per-browser, like `projectFilters`.
   */
  ganttGrouping: Record<string, number>;
  /** Collapsed Gantt sections (`field-<item id>` / `none`) per tenant + site. */
  collapsedGanttSections: Record<string, string[]>;
  /**
   * What the Gantt project bars are coloured by, per tenant + site
   * (`siteKey`): a dropdown project field id or `'tags'`. Absent = default
   * colours. Per-browser, like `ganttGrouping`, and independent of it.
   */
  ganttColorBy: Record<string, ColorByChoice>;

  // ---------------------------------------------
  // EXPANDED STATES (for tree views)
  // Projects, phases and subphases are persisted; the rest are session-only
  // (left out of `partialize` and `merge` on purpose): expandedStaff,
  // expandedEquipment, expandedBankHolidays and collapsedStaffGroups.
  // ---------------------------------------------
  expandedProjects: Set<number>;
  expandedPhases: Set<number>;
  expandedSubphases: Set<number>;
  expandedStaff: Set<number>;
  expandedEquipment: Set<number>;
  expandedBankHolidays: boolean;
  /**
   * Gantt per-person booking groups (a person with 2+ bookings on one card)
   * the user collapsed, keyed `"<level>:<cardId>:<staffId>"` (`staffGroupKey`
   * in components/gantt/utils/staffGroups.ts). Groups start expanded, so only
   * collapsed ones are listed. Session-only.
   */
  collapsedStaffGroups: Set<string>;

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
  setKanbanProjectId: (projectId: number | null) => void;
  setKanbanGrouping: (grouping: KanbanGrouping, columnId?: number | null) => void;
  setKanbanMyTodoOnly: (only: boolean) => void;
  toggleKanbanMyTodoOnly: () => void;
  /** Set a site's project filter (current tenant); an empty filter removes the entry. */
  setProjectFilter: (siteId: number, filter: ProjectFilter) => void;
  clearProjectFilter: (siteId: number) => void;
  /** Set a site's team filter (current tenant); an empty filter removes the entry (Whole site). */
  setTeamFilter: (siteId: number, filter: TeamFilter) => void;
  clearTeamFilter: (siteId: number) => void;
  /**
   * Group a site's Gantt by a dropdown project field; null removes the
   * grouping and that site's collapsed sections. Switching to another field
   * also clears them (section keys belong to the previous field's items).
   */
  setGanttGrouping: (siteId: number, fieldId: number | null) => void;
  toggleGanttSection: (siteId: number, key: string) => void;
  /** Replace a site's collapsed sections (collapse all / expand all = []). */
  setGanttSectionsCollapsed: (siteId: number, keys: string[]) => void;
  /** Colour a site's Gantt project bars by a project field or the tags; null = default colours. */
  setGanttColorBy: (siteId: number, choice: ColorByChoice | null) => void;
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
  toggleStaffGroup: (key: string) => void;
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
  /** Back to today at scroll 0 — called when a session ends, so the next sign-in opens on today */
  resetTimelinePosition: () => void;
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

  // Kanban state
  kanbanProjectId: null as number | null,
  kanbanGrouping: 'none' as KanbanGrouping,
  kanbanGroupingColumnId: null as number | null,
  kanbanMyTodoOnly: false,

  // Project filter + team filter
  projectFilters: {} as Record<string, ProjectFilter>,
  teamFilters: {} as Record<string, TeamFilter>,

  // Gantt grouping
  ganttGrouping: {} as Record<string, number>,
  collapsedGanttSections: {} as Record<string, string[]>,

  // Gantt colour by
  ganttColorBy: {} as Record<string, ColorByChoice>,

  // Expanded states
  expandedProjects: new Set<number>(),
  expandedPhases: new Set<number>(),
  expandedSubphases: new Set<number>(),
  expandedStaff: new Set<number>(),
  expandedEquipment: new Set<number>(),
  expandedBankHolidays: false,
  collapsedStaffGroups: new Set<string>(),

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

      // What-If is Gantt-only: mirror of the uiStore Settings-hub guard, so
      // any present or future caller is refused, not just the gated buttons.
      // 'gantt' stays allowed so the sandbox can always be returned to.
      setCurrentView: (view) => {
        if (view !== 'gantt' && useWhatIfStore.getState().whatIfMode) return;
        set({ currentView: view });
      },

      setCurrentDate: (date) => set({ currentDate: date }),

      setCellWidth: (width) => set({ cellWidth: width }),

      setCurrentResourceTab: (tab) => set({ currentResourceTab: tab }),

      setTimelineScrollLeft: (scrollLeft) => set({ timelineScrollLeft: scrollLeft }),

      setShowAssignments: (show) => set({ showAssignments: show }),

      toggleShowAssignments: () => set((state) => ({ showAssignments: !state.showAssignments })),

      // ---------------------------------------------
      // Kanban
      // ---------------------------------------------
      setKanbanProjectId: (projectId) => set({ kanbanProjectId: projectId }),

      setKanbanGrouping: (grouping, columnId = null) => set({
        kanbanGrouping: grouping,
        // Only meaningful for customColumn grouping; cleared otherwise so a
        // stale column id can't resurrect when switching back.
        kanbanGroupingColumnId: grouping === 'customColumn' ? columnId : null,
      }),

      setKanbanMyTodoOnly: (only) => set({ kanbanMyTodoOnly: only }),

      toggleKanbanMyTodoOnly: () => set((state) => ({
        kanbanMyTodoOnly: !state.kanbanMyTodoOnly,
      })),

      // ---------------------------------------------
      // Project filter
      // ---------------------------------------------
      setProjectFilter: (siteId, filter) => set((state) => {
        const key = siteKey(siteId);
        const next = { ...state.projectFilters };
        const optionIds = [...new Set(filter.optionIds)];
        const noneFieldIds = [...new Set(filter.noneFieldIds)];
        const tagIds = [...new Set(filter.tagIds)];
        if (optionIds.length === 0 && noneFieldIds.length === 0 && tagIds.length === 0) {
          delete next[key];
        } else {
          next[key] = { optionIds, noneFieldIds, tagIds };
        }
        return { projectFilters: next };
      }),

      clearProjectFilter: (siteId) => set((state) => {
        const key = siteKey(siteId);
        if (!(key in state.projectFilters)) return state;
        const next = { ...state.projectFilters };
        delete next[key];
        return { projectFilters: next };
      }),

      // ---------------------------------------------
      // Team filter
      // ---------------------------------------------
      setTeamFilter: (siteId, filter) => set((state) => {
        const key = siteKey(siteId);
        const next = { ...state.teamFilters };
        const teamIds = [...new Set(filter.teamIds)];
        const noTeam = filter.noTeam === true;
        if (teamIds.length === 0 && !noTeam) {
          delete next[key];
        } else {
          next[key] = { teamIds, noTeam };
        }
        return { teamFilters: next };
      }),

      clearTeamFilter: (siteId) => set((state) => {
        const key = siteKey(siteId);
        if (!(key in state.teamFilters)) return state;
        const next = { ...state.teamFilters };
        delete next[key];
        return { teamFilters: next };
      }),

      // ---------------------------------------------
      // Gantt grouping
      // ---------------------------------------------
      setGanttGrouping: (siteId, fieldId) => set((state) => {
        const key = siteKey(siteId);
        if (fieldId !== null && state.ganttGrouping[key] === fieldId) return state;
        if (fieldId === null && !(key in state.ganttGrouping) && !(key in state.collapsedGanttSections)) {
          return state;
        }
        const grouping = { ...state.ganttGrouping };
        if (fieldId === null) delete grouping[key];
        else grouping[key] = fieldId;
        const collapsed = { ...state.collapsedGanttSections };
        delete collapsed[key];
        return { ganttGrouping: grouping, collapsedGanttSections: collapsed };
      }),

      toggleGanttSection: (siteId, sectionKey) => set((state) => {
        const key = siteKey(siteId);
        const current = state.collapsedGanttSections[key] ?? [];
        const keys = current.includes(sectionKey)
          ? current.filter((k) => k !== sectionKey)
          : [...current, sectionKey];
        const collapsed = { ...state.collapsedGanttSections };
        if (keys.length === 0) delete collapsed[key];
        else collapsed[key] = keys;
        return { collapsedGanttSections: collapsed };
      }),

      setGanttSectionsCollapsed: (siteId, sectionKeys) => set((state) => {
        const key = siteKey(siteId);
        const keys = [...new Set(sectionKeys)];
        if (keys.length === 0 && !(key in state.collapsedGanttSections)) return state;
        const collapsed = { ...state.collapsedGanttSections };
        if (keys.length === 0) delete collapsed[key];
        else collapsed[key] = keys;
        return { collapsedGanttSections: collapsed };
      }),

      setGanttColorBy: (siteId, choice) => set((state) => {
        const key = siteKey(siteId);
        if (choice === null ? !(key in state.ganttColorBy) : state.ganttColorBy[key] === choice) {
          return state;
        }
        const colorBy = { ...state.ganttColorBy };
        if (choice === null) delete colorBy[key];
        else colorBy[key] = choice;
        return { ganttColorBy: colorBy };
      }),

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
        // date-fns month arithmetic clamps to the month end (Jan 31 + 1 month
        // = Feb 28/29); Date#setMonth overflows into March.
        set({ currentDate: navigateDate(new Date(currentDate), direction, viewMode) });
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

      toggleStaffGroup: (key) => set((state) => {
        const collapsed = new Set(state.collapsedStaffGroups);
        if (collapsed.has(key)) {
          collapsed.delete(key);
        } else {
          collapsed.add(key);
        }
        return { collapsedStaffGroups: collapsed };
      }),

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
        // Booking groups reopen expanded with their card
        collapsedStaffGroups: new Set(),
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
          // "Expand all" opens the per-person booking groups too
          collapsedStaffGroups: new Set(),
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
      // "Today" is read when the view is reset, not when this module loaded.
      resetView: () => set({ ...initialViewState, currentDate: new Date() }),
      resetTimelinePosition: () => set({ currentDate: new Date(), timelineScrollLeft: 0 }),
    }),
    {
      name: 'milestone-view-storage-v1',
      storage: createJSONStorage(() => localStorage),
      // Only persist certain fields. Deliberately NOT the timeline scroll
      // offset or currentDate: the app always opens on today. A restored
      // pixel offset is relative to a timeline that starts months before the
      // restored date, so it reopened wherever the user last was (e.g. a
      // year back). Both stay in memory, so switching views keeps the place.
      partialize: (state) => ({
        viewMode: state.viewMode,
        currentView: state.currentView,
        cellWidth: state.cellWidth,
        currentResourceTab: state.currentResourceTab,
        sidebarCollapsed: state.sidebarCollapsed,
        resourcePanelCollapsed: state.resourcePanelCollapsed,
        showStaffOverview: state.showStaffOverview,
        showEquipmentOverview: state.showEquipmentOverview,
        kanbanProjectId: state.kanbanProjectId,
        kanbanGrouping: state.kanbanGrouping,
        kanbanGroupingColumnId: state.kanbanGroupingColumnId,
        kanbanMyTodoOnly: state.kanbanMyTodoOnly,
        projectFilters: state.projectFilters,
        teamFilters: state.teamFilters,
        ganttGrouping: state.ganttGrouping,
        collapsedGanttSections: state.collapsedGanttSections,
        ganttColorBy: state.ganttColorBy,
        // Convert Sets to Arrays for JSON serialization
        expandedProjects: Array.from(state.expandedProjects),
        expandedPhases: Array.from(state.expandedPhases),
        expandedSubphases: Array.from(state.expandedSubphases),
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
          showStaffOverview: (persisted?.showStaffOverview as boolean) ?? currentState.showStaffOverview,
          showEquipmentOverview: (persisted?.showEquipmentOverview as boolean) ?? currentState.showEquipmentOverview,
          // Every field added to partialize above MUST also be listed here
          // -- this merge is field-by-field, not a spread of `persisted`, so
          // an omission silently resets the value on every reload. The
          // session-only Sets (expandedStaff / expandedEquipment /
          // expandedBankHolidays / collapsedStaffGroups) are in neither.
          kanbanProjectId: (persisted?.kanbanProjectId as number | null) ?? currentState.kanbanProjectId,
          kanbanGrouping: (persisted?.kanbanGrouping as KanbanGrouping) ?? currentState.kanbanGrouping,
          kanbanGroupingColumnId: (persisted?.kanbanGroupingColumnId as number | null) ?? currentState.kanbanGroupingColumnId,
          kanbanMyTodoOnly: (persisted?.kanbanMyTodoOnly as boolean) ?? currentState.kanbanMyTodoOnly,
          // Same rule for the per-site preferences (validated: it is
          // user-editable storage). A pre-2.0 `tagFilters` entry is dropped:
          // its tag-group shape has no project-field equivalent.
          projectFilters: sanitizeProjectFilters(persisted?.projectFilters) ?? currentState.projectFilters,
          teamFilters: sanitizeTeamFilters(persisted?.teamFilters) ?? currentState.teamFilters,
          ganttGrouping: sanitizeSiteFieldIds(persisted?.ganttGrouping) ?? currentState.ganttGrouping,
          collapsedGanttSections:
            sanitizeCollapsedGanttSections(persisted?.collapsedGanttSections) ?? currentState.collapsedGanttSections,
          ganttColorBy: sanitizeSiteColorBy(persisted?.ganttColorBy) ?? currentState.ganttColorBy,
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
        };
      },
    }
  )
);
