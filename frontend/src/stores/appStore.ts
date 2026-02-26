/**
 * Main Application Store
 * Central data state management using Zustand.
 * Holds domain data (projects, staff, equipment, etc.), auth state,
 * current selections, and critical path calculations.
 *
 * View/display state has been moved to viewStore.ts
 * What-If mode state has been moved to whatIfStore.ts
 * Custom column state has been moved to customColumnStore.ts
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  Site,
  Project,
  Staff,
  Equipment,
  User,
  Vacation,
  BankHoliday,
  CompanyEvent,
  InstanceSettings,
  Skill,
} from '@/types';

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
  companyEvents: CompanyEvent[];
  companyEventDates: Set<string>;
  users: User[];
  instanceSettings: InstanceSettings | null;
  skills: Skill[];

  // ---------------------------------------------
  // CURRENT SELECTIONS
  // ---------------------------------------------
  currentSite: Site | null;
  currentUser: User | null;

  // Persisted site ID - saved/restored from localStorage
  // This is separate from currentSite because currentSite is a full object
  // that gets set by useDataLoader after data loads
  _persistedSiteId: number | null;

  // ---------------------------------------------
  // CRITICAL PATH
  // ---------------------------------------------
  /** Set of project IDs that have critical path display enabled */
  criticalPathEnabled: Set<number>;
  /** Cached critical path items per project: projectId -> Set of 'phase-{id}' or 'subphase-{id}' */
  criticalPathItems: Map<number, Set<string>>;

  // ---------------------------------------------
  // ACTIONS - Data Setters
  // ---------------------------------------------
  setSites: (sites: Site[]) => void;
  setProjects: (projects: Project[]) => void;
  setStaff: (staff: Staff[]) => void;
  setEquipment: (equipment: Equipment[]) => void;
  setVacations: (vacations: Vacation[]) => void;
  setBankHolidays: (holidays: BankHoliday[], holidayDates: Set<string>) => void;
  setCompanyEvents: (events: CompanyEvent[], eventDates: Set<string>) => void;
  setUsers: (users: User[]) => void;
  setInstanceSettings: (settings: InstanceSettings | null) => void;
  setSkills: (skills: Skill[]) => void;

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
  // ACTIONS - Critical Path
  // ---------------------------------------------
  toggleCriticalPath: (projectId: number) => void;
  recalculateCriticalPath: (projectId: number) => void;
  isCriticalPathEnabled: (projectId: number) => boolean;
  getCriticalPathItems: (projectId: number) => Set<string>;

  // ---------------------------------------------
  // ACTIONS - Reset
  // ---------------------------------------------
  reset: () => void;
}

// =============================================================================
// INITIAL STATE
// =============================================================================

const initialState = {
  // Auth state
  isAuthChecking: true,
  isAuthenticated: false,

  // Data
  sites: [] as Site[],
  projects: [] as Project[],
  staff: [] as Staff[],
  equipment: [] as Equipment[],
  vacations: [] as Vacation[],
  bankHolidays: [] as BankHoliday[],
  bankHolidayDates: new Set<string>(),
  companyEvents: [] as CompanyEvent[],
  companyEventDates: new Set<string>(),
  users: [] as User[],
  instanceSettings: null as InstanceSettings | null,
  skills: [] as Skill[],

  // Selections
  currentSite: null as Site | null,
  currentUser: null as User | null,
  _persistedSiteId: null as number | null,

  // Critical path
  criticalPathEnabled: new Set<number>(),
  criticalPathItems: new Map<number, Set<string>>(),
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

      setCompanyEvents: (events, eventDates) => set({
        companyEvents: events,
        companyEventDates: eventDates,
      }),

      setUsers: (users) => set({ users }),

      setInstanceSettings: (settings) => set({ instanceSettings: settings }),

      setSkills: (skills) => set({ skills }),

      // -----------------------------------------
      // SELECTION SETTERS
      // -----------------------------------------
      setCurrentSite: (site) => set({
        currentSite: site,
        _persistedSiteId: site?.id ?? null,
      }),

      setCurrentUser: (user) => set({ currentUser: user }),

      // -----------------------------------------
      // AUTH STATE ACTIONS
      // -----------------------------------------
      setAuthChecking: (isChecking) => set({ isAuthChecking: isChecking }),

      setAuthenticated: (isAuthenticated) => set({ isAuthenticated }),

      // -----------------------------------------
      // CRITICAL PATH ACTIONS
      // -----------------------------------------
      toggleCriticalPath: (projectId) => {
        const { criticalPathEnabled, criticalPathItems, projects } = get();
        const newEnabled = new Set(criticalPathEnabled);
        const newItems = new Map(criticalPathItems);

        if (newEnabled.has(projectId)) {
          // Disable critical path for this project
          newEnabled.delete(projectId);
          newItems.delete(projectId);
        } else {
          // Enable critical path for this project
          newEnabled.add(projectId);

          // Calculate critical path
          const project = projects.find(p => p.id === projectId);
          if (project) {
            // Dynamic import to avoid circular dependency
            import('@/components/gantt/utils/criticalPath').then(({ calculateCriticalPath }) => {
              const result = calculateCriticalPath(project);
              const updatedItems = new Map(get().criticalPathItems);
              updatedItems.set(projectId, result.criticalItems);
              set({ criticalPathItems: updatedItems });
            });
          }
        }

        set({ criticalPathEnabled: newEnabled, criticalPathItems: newItems });
      },

      recalculateCriticalPath: (projectId) => {
        const { criticalPathEnabled, projects } = get();

        // Only recalculate if critical path is enabled for this project
        if (!criticalPathEnabled.has(projectId)) return;

        const project = projects.find(p => p.id === projectId);
        if (project) {
          import('@/components/gantt/utils/criticalPath').then(({ calculateCriticalPath }) => {
            const result = calculateCriticalPath(project);
            const updatedItems = new Map(get().criticalPathItems);
            updatedItems.set(projectId, result.criticalItems);
            set({ criticalPathItems: updatedItems });
          });
        }
      },

      isCriticalPathEnabled: (projectId) => {
        return get().criticalPathEnabled.has(projectId);
      },

      getCriticalPathItems: (projectId) => {
        return get().criticalPathItems.get(projectId) || new Set();
      },

      // -----------------------------------------
      // RESET
      // -----------------------------------------
      reset: () => set(initialState),
    }),
    {
      name: 'milestone-app-storage-v3',
      storage: createJSONStorage(() => localStorage),
      // Only persist the site ID
      partialize: (state) => ({
        currentSiteId: state._persistedSiteId,
      }),
      onRehydrateStorage: () => {
        return (_state, error) => {
          if (error) {
            console.error('[AppStore] Hydration error:', error);
          }
        };
      },
      merge: (persistedState, currentState) => {
        const persisted = ((persistedState as Record<string, unknown>)?.state ?? persistedState) as Record<string, unknown>;

        return {
          ...currentState,
          _persistedSiteId: (persisted?.currentSiteId as number | null) ?? currentState._persistedSiteId,
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
