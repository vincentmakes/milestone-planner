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
import { useUndoStore } from './undoStore';
import type {
  Site,
  Project,
  Staff,
  Equipment,
  EquipmentBlock,
  User,
  Vacation,
  BankHoliday,
  CompanyEvent,
  InstanceSettings,
  Skill,
  Tag,
  ProjectField,
  Team,
  Role,
  ApprovalPolicy,
  AbsenceType,
} from '@/types';
import type { TagGroup } from '@/utils/tags';
import { buildClosureIndex } from '@/utils/siteClosure';
import type { ClosureIndex } from '@/utils/siteClosure';
import { indexAbsenceTypes } from '@/utils/recurringVacation';
import { can } from '@/utils/permissions';
import type { AbsenceTypesById } from '@/utils/recurringVacation';

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
  equipmentBlocks: EquipmentBlock[];
  vacations: Vacation[];
  bankHolidays: BankHoliday[];
  bankHolidayDates: Set<string>;
  companyEvents: CompanyEvent[];
  companyEventDates: Set<string>;
  /** Day → site-closure events (derived from companyEvents, not persisted) */
  closureIndex: ClosureIndex;
  users: User[];
  instanceSettings: InstanceSettings | null;
  skills: Skill[];
  tags: Tag[];
  /**
   * @deprecated Task 4 shim: tag groups are gone (2.0.0); nothing loads this
   * any more, so it stays empty. Only the Gantt filter / Group by / Colour by
   * code still reads it until it moves to project fields.
   */
  tagGroups: TagGroup[];
  /** Project field definitions with their items, in display order */
  projectFields: ProjectField[];
  /** Teams of every site, including inactive ones */
  teams: Team[];
  /**
   * Roles with their matrices and user counts (tenant configuration). Loaded
   * on first use by hooks/useRoles, refreshed by the `roles` WS slice; empty
   * until then.
   */
  roles: Role[];
  /**
   * Who approves each own-booking action (tenant configuration). Loaded on
   * first use by hooks/useApprovalPolicies (the pending badge's tooltip),
   * refreshed by the `approvals` WS slice once loaded; empty until then.
   */
  approvalPolicies: ApprovalPolicy[];
  /** Tenant-wide absence categories, including inactive ones */
  absenceTypes: AbsenceType[];

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
  setEquipmentBlocks: (blocks: EquipmentBlock[]) => void;
  setVacations: (vacations: Vacation[]) => void;
  setBankHolidays: (holidays: BankHoliday[], holidayDates: Set<string>) => void;
  setCompanyEvents: (events: CompanyEvent[], eventDates: Set<string>) => void;
  setUsers: (users: User[]) => void;
  setInstanceSettings: (settings: InstanceSettings | null) => void;
  setSkills: (skills: Skill[]) => void;
  setTags: (tags: Tag[]) => void;
  /** @deprecated Task 4 shim, see `tagGroups` */
  setTagGroups: (tagGroups: TagGroup[]) => void;
  setProjectFields: (projectFields: ProjectField[]) => void;
  setTeams: (teams: Team[]) => void;
  setRoles: (roles: Role[]) => void;
  setApprovalPolicies: (approvalPolicies: ApprovalPolicy[]) => void;
  setAbsenceTypes: (absenceTypes: AbsenceType[]) => void;

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
  equipmentBlocks: [] as EquipmentBlock[],
  vacations: [] as Vacation[],
  bankHolidays: [] as BankHoliday[],
  bankHolidayDates: new Set<string>(),
  companyEvents: [] as CompanyEvent[],
  companyEventDates: new Set<string>(),
  closureIndex: new Map<string, CompanyEvent[]>() as ClosureIndex,
  users: [] as User[],
  instanceSettings: null as InstanceSettings | null,
  skills: [] as Skill[],
  tags: [] as Tag[],
  tagGroups: [] as TagGroup[],
  projectFields: [] as ProjectField[],
  teams: [] as Team[],
  roles: [] as Role[],
  approvalPolicies: [] as ApprovalPolicy[],
  absenceTypes: [] as AbsenceType[],

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

      setEquipmentBlocks: (equipmentBlocks) => set({ equipmentBlocks }),

      setVacations: (vacations) => set({ vacations }),

      setBankHolidays: (holidays, holidayDates) => set({
        bankHolidays: holidays,
        bankHolidayDates: holidayDates,
      }),

      setCompanyEvents: (events, eventDates) => set({
        companyEvents: events,
        companyEventDates: eventDates,
        closureIndex: buildClosureIndex(events),
      }),

      setUsers: (users) => set({ users }),

      setInstanceSettings: (settings) => set({ instanceSettings: settings }),

      setSkills: (skills) => set({ skills }),

      setTags: (tags) => set({ tags }),

      setTagGroups: (tagGroups) => set({ tagGroups }),

      setProjectFields: (projectFields) => set({ projectFields }),

      setTeams: (teams) => set({ teams }),

      setRoles: (roles) => set({ roles }),

      setApprovalPolicies: (approvalPolicies) => set({ approvalPolicies }),

      setAbsenceTypes: (absenceTypes) => set({ absenceTypes }),

      // -----------------------------------------
      // SELECTION SETTERS
      // -----------------------------------------
      setCurrentSite: (site) => {
        const prevId = get().currentSite?.id ?? null;
        set({
          currentSite: site,
          _persistedSiteId: site?.id ?? null,
        });
        if ((site?.id ?? null) !== prevId) {
          useUndoStore.getState().clear();
        }
      },

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
      reset: () => {
        useUndoStore.getState().clear();
        set(initialState);
      },
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

// Array-returning selectors (site projects/staff/equipment, …) were removed:
// under Zustand 5 a selector that allocates a new array on every call makes
// `useAppStore(selector)` re-render forever. Select the raw slice and filter
// with useMemo, or wrap the selector in useShallow.

/**
 * Sites of every staff member, keyed by staff id. GET /staff returns one row
 * per user-site pair, so the sets are rebuilt from the rows. Memoised on the
 * `staff` array so the Map keeps its identity between renders.
 */
let staffSiteIdsCache: { staff: Staff[]; map: Map<number, Set<number>> } | null = null;
export const selectStaffSiteIds = (state: AppState): Map<number, Set<number>> => {
  if (staffSiteIdsCache && staffSiteIdsCache.staff === state.staff) {
    return staffSiteIdsCache.map;
  }
  const map = new Map<number, Set<number>>();
  for (const row of state.staff) {
    const sites = map.get(row.id);
    if (sites) {
      sites.add(row.site_id);
    } else {
      map.set(row.id, new Set([row.site_id]));
    }
  }
  staffSiteIdsCache = { staff: state.staff, map };
  return map;
};

/**
 * Teams of every staff member across all their sites, keyed by staff id: the
 * union of `team_ids` over the user's per-site rows. Memoised on the `staff`
 * array like {@link selectStaffSiteIds}.
 */
let staffTeamIdsCache: { staff: Staff[]; map: Map<number, Set<number>> } | null = null;
export const selectStaffTeamIds = (state: AppState): Map<number, Set<number>> => {
  if (staffTeamIdsCache && staffTeamIdsCache.staff === state.staff) {
    return staffTeamIdsCache.map;
  }
  const map = new Map<number, Set<number>>();
  for (const row of state.staff) {
    let teams = map.get(row.id);
    if (!teams) {
      teams = new Set();
      map.set(row.id, teams);
    }
    for (const teamId of row.team_ids ?? []) teams.add(teamId);
  }
  staffTeamIdsCache = { staff: state.staff, map };
  return map;
};

/** Team id → site id. Memoised on the `teams` array. */
let teamSiteByIdCache: { teams: Team[]; map: Map<number, number> } | null = null;
export const selectTeamSiteById = (state: AppState): Map<number, number> => {
  if (teamSiteByIdCache && teamSiteByIdCache.teams === state.teams) {
    return teamSiteByIdCache.map;
  }
  const map = new Map(state.teams.map((t) => [t.id, t.site_id]));
  teamSiteByIdCache = { teams: state.teams, map };
  return map;
};

/**
 * Absence types keyed by id. Memoised on the `absenceTypes` array, so every
 * assignment bar, resource card and staff row shares one Map instead of
 * rebuilding it per render.
 */
let absenceTypesByIdCache: { types: AbsenceType[]; map: AbsenceTypesById } | null = null;
export const selectAbsenceTypesById = (state: AppState): AbsenceTypesById => {
  if (absenceTypesByIdCache && absenceTypesByIdCache.types === state.absenceTypes) {
    return absenceTypesByIdCache.map;
  }
  const map = indexAbsenceTypes(state.absenceTypes);
  absenceTypesByIdCache = { types: state.absenceTypes, map };
  return map;
};

/**
 * Whether the signed-in user may add and edit other people's absences
 * (`absences.manage_others`): the absence dialog's staff picker.
 */
export const selectCanManageOthersAbsences = (state: AppState): boolean =>
  can(state.currentUser, 'absences.manage_others');
