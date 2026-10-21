/**
 * UI Store
 * Manages transient UI state like modals, tooltips, and editing states
 * This state is NOT persisted - it resets on page refresh
 *
 * The Settings hub is unreachable while What-If mode is active: openSettings()
 * and every legacy alias key refuse to open it. Configuration deletes (sites,
 * equipment, users, ...) bypass the What-If queue and cascade on the server,
 * while the sandbox keeps showing the orphaned plan data.
 */

import { create } from 'zustand';
import { useWhatIfStore } from './whatIfStore';
import type {
  Project,
  Phase,
  Subphase,
  StaffAssignment,
  EquipmentAssignment,
  Vacation,
  EquipmentBlock,
  Staff,
  Equipment,
  User,
} from '@/types';

// =============================================================================
// MODAL TYPES
// =============================================================================

export type ModalType = 
  | 'project'
  | 'phase'
  | 'subphase'
  | 'staffAssignment'
  | 'equipmentAssignment'
  | 'vacation'
  | 'site'
  | 'siteManagement'
  | 'manageSites'
  | 'userManagement'
  | 'ssoConfig'
  | 'manageEquipment'
  | 'predefinedPhases'
  | 'importProject'
  | 'settings'
  | 'instanceTitle'
  | 'addStaff'
  | 'editStaff'
  | 'addEquipment'
  | 'editEquipment'
  | 'bankHoliday'
  | 'customHoliday'
  | 'companyEvent'
  | 'equipmentBlock'
  | 'kanbanCard'
  | 'settingsHub'
  | 'myAbsences';

// =============================================================================
// SETTINGS HUB
// =============================================================================

/** Sections of the Settings hub (see components/settings/sections.tsx) */
export type SettingsSectionId =
  | 'general'
  | 'sites'
  | 'teams'
  | 'bank-holidays'
  | 'company-events'
  | 'users'
  | 'skills'
  | 'absence-types'
  | 'equipment'
  | 'equipment-types'
  | 'predefined-phases'
  | 'tags'
  | 'sso';

/**
 * What the opened section should do first: show a site, open its "add" form,
 * or open the item with this id in edit mode. `siteId` scopes site-bound items
 * (holidays, events).
 */
export type SettingsIntent =
  | { type: 'view'; siteId: number }
  | { type: 'add'; siteId?: number }
  | { type: 'edit'; id: number; siteId?: number };

/**
 * Legacy modal keys that now open the Settings hub at a section. Callers keep
 * using openModal()/setActiveModal() with these keys; the hub opens instead.
 */
const SETTINGS_MODAL_ALIASES = new Map<string, SettingsSectionId>([
  ['settings', 'general'],
  ['manageSites', 'sites'],
  ['siteManagement', 'sites'],
  ['site', 'sites'],
  ['bankHoliday', 'bank-holidays'],
  ['customHoliday', 'bank-holidays'],
  ['companyEvent', 'company-events'],
  ['userManagement', 'users'],
  ['manageEquipment', 'equipment'],
  ['predefinedPhases', 'predefined-phases'],
  ['ssoConfig', 'sso'],
]);

/** Legacy keys whose old modal was an "add" form */
const SETTINGS_ADD_ALIASES = new Set(['customHoliday', 'companyEvent']);

// =============================================================================
// STATE INTERFACE
// =============================================================================

export interface FlashNotice {
  id: number;
  message: string;
  tone: 'error' | 'warning' | 'info';
}

interface UIState {
  // ---------------------------------------------
  // MODAL STATE
  // ---------------------------------------------
  activeModal: ModalType | null;
  
  // Settings hub: active section and the action it should take on open
  settingsSection: SettingsSectionId | null;
  settingsIntent: SettingsIntent | null;

  // Editing context for modals
  editingProject: Project | null;
  editingPhase: Phase | null;
  editingSubphase: Subphase | null;
  editingStaffAssignment: StaffAssignment | null;
  editingEquipmentAssignment: EquipmentAssignment | null;
  editingVacation: Vacation | null;
  editingEquipmentBlock: EquipmentBlock | null;
  editingStaff: Staff | null;
  editingEquipment: Equipment | null;
  editingUser: User | null;
  
  // Context for creating new items
  modalContext: {
    projectId?: number;
    phaseId?: number;
    subphaseId?: number;
    staffId?: number;
    equipmentId?: number;
    siteId?: number;
    // Kanban card detail (a card is a leaf phase or subphase)
    cardEntityType?: 'phase' | 'subphase';
    cardEntityId?: number;
    cardProjectId?: number;
    // Modal to reopen when this one closes (e.g. VacationModal opened from My absences)
    returnTo?: ModalType;
    // Phantom sibling presets
    phantomPreset?: {
      startDate: string;
      endDate: string;
      predecessorId: number;
      dependencyType: 'SS' | 'FS';
      parentId?: number | null;
      parentType?: 'phase' | 'subphase';
    };
  };
  
  // ---------------------------------------------
  // TOOLTIP STATE
  // ---------------------------------------------
  tooltip: {
    visible: boolean;
    content: string;
    x: number;
    y: number;
  };
  
  // ---------------------------------------------
  // DRAG & DROP STATE
  // ---------------------------------------------
  isDragging: boolean;
  dragType: 'project' | 'phase' | 'subphase' | 'staffAssignment' | 'equipmentAssignment' | null;
  dragItemId: number | null;
  
  // ---------------------------------------------
  // RESIZE STATE
  // ---------------------------------------------
  isResizing: boolean;
  resizeEdge: 'left' | 'right' | null;
  resizeItemId: number | null;
  resizeItemType: 'phase' | 'subphase' | 'staffAssignment' | 'equipmentAssignment' | null;
  
  // ---------------------------------------------
  // DRAG/RESIZE INDICATOR STATE
  // ---------------------------------------------
  dragIndicator: {
    visible: boolean;
    left: number;      // Position from left of timeline body
    top: number;       // Position from top of timeline body
    type: 'drag' | 'resize';
    lagDays?: number;
    date?: string;
    duration?: number;
    edge?: 'left' | 'right';
  };
  
  // ---------------------------------------------
  // DEPENDENCY LINKING STATE
  // ---------------------------------------------
  isLinkingDependency: boolean;
  linkingFrom: { 
    projectId: number; 
    itemId: number;
    itemType: 'phase' | 'subphase';
    zone: 'start' | 'end';
  } | null;
  
  // ---------------------------------------------
  // PHANTOM SIBLING MODE
  // ---------------------------------------------
  phantomSiblingMode: {
    projectId: number;
    sourceId: number;
    type: 'phase' | 'subphase';
    dependencyType: 'SS' | 'FS';
    phantomStart: string;
    phantomEnd: string;
    phantomColor: string;
    siblingDurationDays: number;
    sourceIndex: number;
    // Parent info for subphases
    parentId?: number | null;
    parentType?: 'phase' | 'subphase';
  } | null;
  
  // ---------------------------------------------
  // FLASH NOTICE (detached errors — see layout/FlashNotice.tsx)
  // ---------------------------------------------
  flashNotice: FlashNotice | null;

  /**
   * Shared `Modal` instances currently open, whether or not they were opened
   * through `activeModal` (the custom-column dialogs live in ProjectPanel's
   * local state). `useKeyboardShortcuts` stands down while this is > 0.
   */
  openModalCount: number;

  // ---------------------------------------------
  // LOADING STATES
  // ---------------------------------------------
  isLoading: boolean;
  loadingMessage: string;
  
  // ---------------------------------------------
  // CONTEXT MENU STATE
  // ---------------------------------------------
  contextMenu: {
    visible: boolean;
    x: number;
    y: number;
    type: 'project' | 'phase' | 'subphase' | 'staffAssignment' | 'equipmentAssignment' | null;
    targetId: number | null;
    projectId?: number;
    phaseId?: number;
    subphaseId?: number;
    // For assignment context - extra data
    assignmentData?: {
      staffId?: number;
      equipmentId?: number;
      name?: string;
      allocation?: number;
      startDate?: string;
      endDate?: string;
    };
  };
  
  // ---------------------------------------------
  // TIMELINE SCROLL STATE
  // ---------------------------------------------
  scrollToTodayTrigger: number; // increment to trigger scroll
  scrollToDateTrigger: { date: string; timestamp: number } | null; // trigger scroll to specific date
  
  // Zoom trigger: { direction: 1 for in, -1 for out, newCellWidth }
  zoomTrigger: { direction: 1 | -1; newCellWidth: number; timestamp: number } | null;
  
  // ---------------------------------------------
  // ACTIONS - Modals
  // ---------------------------------------------
  openModal: (type: ModalType, context?: UIState['modalContext']) => void;
  closeModal: () => void;

  // Settings hub. Without a section it reopens the last one shown.
  openSettings: (section?: SettingsSectionId, intent?: SettingsIntent) => void;
  setSettingsSection: (section: SettingsSectionId) => void;
  clearSettingsIntent: () => void;
  
  // Edit mode setters
  setEditingProject: (project: Project | null) => void;
  setEditingPhase: (phase: Phase | null) => void;
  setEditingSubphase: (subphase: Subphase | null) => void;
  setEditingStaffAssignment: (assignment: StaffAssignment | null) => void;
  setEditingEquipmentAssignment: (assignment: EquipmentAssignment | null) => void;
  setEditingVacation: (vacation: Vacation | null) => void;
  setEditingStaff: (staff: Staff | null) => void;
  setEditingEquipment: (equipment: Equipment | null) => void;
  setEditingUser: (user: User | null) => void;
  
  // Convenience modal openers
  openProjectModal: (project?: Project) => void;
  openKanbanCardModal: (
    entityType: 'phase' | 'subphase',
    entityId: number,
    projectId: number
  ) => void;
  openPhaseModal: (phase?: Phase, projectId?: number) => void;
  openSubphaseModal: (subphase?: Subphase, phaseId?: number, projectId?: number, parentSubphaseId?: number) => void;
  /** Open the vacation dialog; `returnTo` reopens that modal when it closes */
  openVacationModal: (vacation?: Vacation, staffId?: number, returnTo?: ModalType) => void;
  openEquipmentBlockModal: (block?: EquipmentBlock, equipmentId?: number) => void;
  setActiveModal: (modal: ModalType | string | null) => void;
  
  // ---------------------------------------------
  // ACTIONS - Tooltip
  // ---------------------------------------------
  showTooltip: (content: string, x: number, y: number) => void;
  hideTooltip: () => void;
  
  // ---------------------------------------------
  // ACTIONS - Drag & Drop
  // ---------------------------------------------
  startDrag: (type: 'project' | 'phase' | 'subphase' | 'staffAssignment' | 'equipmentAssignment', itemId: number) => void;
  endDrag: () => void;
  
  // ---------------------------------------------
  // ACTIONS - Resize
  // ---------------------------------------------
  startResize: (
    itemType: 'phase' | 'subphase' | 'staffAssignment' | 'equipmentAssignment', 
    itemId: number, 
    edge: 'left' | 'right'
  ) => void;
  endResize: () => void;
  
  // ---------------------------------------------
  // ACTIONS - Drag/Resize Indicator
  // ---------------------------------------------
  showDragIndicator: (left: number, top: number, lagDays: number) => void;
  showResizeIndicator: (left: number, top: number, date: string, duration: number, edge: 'left' | 'right') => void;
  hideIndicator: () => void;
  
  // ---------------------------------------------
  // ACTIONS - Dependency Linking
  // ---------------------------------------------
  startLinking: (
    projectId: number, 
    itemId: number, 
    itemType: 'phase' | 'subphase',
    zone: 'start' | 'end'
  ) => void;
  completeLinking: () => void;
  cancelLinking: () => void;
  
  // ---------------------------------------------
  // ACTIONS - Phantom Sibling
  // ---------------------------------------------
  startPhantomSibling: (config: NonNullable<UIState['phantomSiblingMode']>) => void;
  updatePhantomPosition: (phantomStart: string, phantomEnd: string) => void;
  endPhantomSibling: () => void;
  
  // ---------------------------------------------
  // ACTIONS - Loading
  // ---------------------------------------------
  setLoading: (loading: boolean, message?: string) => void;

  /** Called by the shared Modal on open / close (registry for the keyboard shortcuts). */
  modalOpened: () => void;
  modalClosed: () => void;

  /** Show a detached message bottom-right (errors from actions with no form of their own). */
  showFlash: (message: string, tone?: FlashNotice['tone']) => void;
  /** Clear the flash; with an id, only if that flash is still the one showing. */
  dismissFlash: (id?: number) => void;
  
  // ---------------------------------------------
  // ACTIONS - Context Menu
  // ---------------------------------------------
  showContextMenu: (
    type: 'project' | 'phase' | 'subphase' | 'staffAssignment' | 'equipmentAssignment',
    targetId: number,
    x: number,
    y: number,
    projectId?: number,
    phaseId?: number,
    subphaseId?: number,
    assignmentData?: {
      staffId?: number;
      equipmentId?: number;
      name?: string;
      allocation?: number;
      startDate?: string;
      endDate?: string;
    }
  ) => void;
  hideContextMenu: () => void;
  
  // ---------------------------------------------
  // ACTIONS - Timeline Scroll
  // ---------------------------------------------
  triggerScrollToToday: () => void;
  triggerScrollToDate: (date: string) => void;
  clearScrollToDateTrigger: () => void;
  triggerZoom: (direction: 1 | -1, newCellWidth: number) => void;
  clearZoomTrigger: () => void;
  
  // ---------------------------------------------
  // RESOURCE DRAG-DROP STATE (from ResourcePanel)
  // ---------------------------------------------
  resourceDrag: {
    active: boolean;
    type: 'staff' | 'equipment' | null;
    resourceId: number | null;
    resourceName: string | null;
    // Target info while dragging over timeline
    targetProjectId: number | null;
    targetPhaseId: number | null;
    targetSubphaseId: number | null;
    // Preview bar position
    previewStart: string | null;
    previewEnd: string | null;
  };
  
  // ---------------------------------------------
  // ACTIONS - Resource Drag-Drop
  // ---------------------------------------------
  startResourceDrag: (type: 'staff' | 'equipment', resourceId: number, resourceName: string) => void;
  updateResourceDragTarget: (
    projectId: number | null, 
    phaseId: number | null, 
    subphaseId: number | null,
    previewStart: string | null,
    previewEnd: string | null
  ) => void;
  endResourceDrag: () => void;
}

// =============================================================================
// INITIAL STATE
// =============================================================================

const initialState = {
  // Modals
  activeModal: null,
  settingsSection: null,
  settingsIntent: null,
  editingProject: null,
  editingPhase: null,
  editingSubphase: null,
  editingStaffAssignment: null,
  editingEquipmentAssignment: null,
  editingVacation: null,
  editingEquipmentBlock: null,
  editingStaff: null,
  editingEquipment: null,
  editingUser: null,
  modalContext: {},
  
  // Tooltip
  tooltip: {
    visible: false,
    content: '',
    x: 0,
    y: 0,
  },
  
  // Context menu
  contextMenu: {
    visible: false,
    x: 0,
    y: 0,
    type: null,
    targetId: null,
    projectId: undefined,
    phaseId: undefined,
    subphaseId: undefined,
    assignmentData: undefined,
  },
  
  // Drag & Drop
  isDragging: false,
  dragType: null,
  dragItemId: null,
  
  // Resize
  isResizing: false,
  resizeEdge: null,
  resizeItemId: null,
  resizeItemType: null,
  
  // Drag/Resize Indicator
  dragIndicator: {
    visible: false,
    left: 0,
    top: 0,
    type: 'drag' as const,
  },
  
  // Dependency Linking
  isLinkingDependency: false,
  linkingFrom: null,
  
  // Phantom Sibling
  phantomSiblingMode: null,
  
  // Loading
  isLoading: false,
  loadingMessage: '',
  flashNotice: null,
  openModalCount: 0,
  
  // Timeline scroll
  scrollToTodayTrigger: 0,
  scrollToDateTrigger: null,
  
  // Zoom trigger
  zoomTrigger: null,
  
  // Resource Drag-Drop
  resourceDrag: {
    active: false,
    type: null,
    resourceId: null,
    resourceName: null,
    targetProjectId: null,
    targetPhaseId: null,
    targetSubphaseId: null,
    previewStart: null,
    previewEnd: null,
  },
};

// =============================================================================
// STORE CREATION
// =============================================================================

/**
 * State update that opens the Settings hub for a legacy modal key, or null when
 * the key is not an alias.
 */
function settingsAliasState(
  modal: string
): Pick<UIState, 'activeModal' | 'settingsSection' | 'settingsIntent'> | null {
  const section = SETTINGS_MODAL_ALIASES.get(modal);
  if (!section) return null;
  const intent: SettingsIntent | null = SETTINGS_ADD_ALIASES.has(modal) ? { type: 'add' } : null;
  return { activeModal: 'settingsHub', settingsSection: section, settingsIntent: intent };
}

/** True while What-If mode is active — the Settings hub must not open then. */
function settingsHubBlocked(): boolean {
  return useWhatIfStore.getState().whatIfMode;
}

/** Does this modal key open the Settings hub (directly or as a legacy alias)? */
function opensSettingsHub(modal: string): boolean {
  return modal === 'settingsHub' || SETTINGS_MODAL_ALIASES.has(modal);
}

export const useUIStore = create<UIState>()((set) => ({
  ...initialState,
  
  // -----------------------------------------
  // MODAL ACTIONS
  // -----------------------------------------
  openModal: (type, context = {}) => set((state) =>
    opensSettingsHub(type) && settingsHubBlocked()
      ? state
      : {
          ...(settingsAliasState(type) ?? { activeModal: type }),
          modalContext: context,
        }
  ),

  openSettings: (section, intent) => set((state) =>
    settingsHubBlocked()
      ? state
      : {
          activeModal: 'settingsHub',
          settingsSection: section ?? state.settingsSection,
          settingsIntent: intent ?? null,
        }
  ),

  setSettingsSection: (section) => set({
    settingsSection: section,
    settingsIntent: null,
  }),

  clearSettingsIntent: () => set({ settingsIntent: null }),
  
  closeModal: () => set({
    activeModal: null,
    settingsIntent: null,
    editingProject: null,
    editingPhase: null,
    editingSubphase: null,
    editingStaffAssignment: null,
    editingEquipmentAssignment: null,
    editingVacation: null,
    editingEquipmentBlock: null,
    editingStaff: null,
    editingEquipment: null,
    editingUser: null,
    modalContext: {},
  }),
  
  setEditingProject: (project) => set({ editingProject: project }),
  setEditingPhase: (phase) => set({ editingPhase: phase }),
  setEditingSubphase: (subphase) => set({ editingSubphase: subphase }),
  setEditingStaffAssignment: (assignment) => set({ editingStaffAssignment: assignment }),
  setEditingEquipmentAssignment: (assignment) => set({ editingEquipmentAssignment: assignment }),
  setEditingVacation: (vacation) => set({ editingVacation: vacation }),
  setEditingStaff: (staff) => set({ editingStaff: staff }),
  setEditingEquipment: (equipment) => set({ editingEquipment: equipment }),
  setEditingUser: (user) => set({ editingUser: user }),
  
  // Convenience modal openers
  openProjectModal: (project) => set({
    activeModal: 'project',
    editingProject: project || null,
  }),
  
  openKanbanCardModal: (entityType, entityId, projectId) => set({
    activeModal: 'kanbanCard',
    modalContext: {
      cardEntityType: entityType,
      cardEntityId: entityId,
      cardProjectId: projectId,
      projectId,
    },
  }),

  openPhaseModal: (phase, projectId) => set({
    activeModal: 'phase',
    editingPhase: phase || null,
    modalContext: projectId ? { projectId } : {},
  }),
  
  openSubphaseModal: (subphase, phaseId, projectId, parentSubphaseId) => set({
    activeModal: 'subphase',
    editingSubphase: subphase || null,
    modalContext: { phaseId, projectId, subphaseId: parentSubphaseId },
  }),
  
  openVacationModal: (vacation, staffId, returnTo) => set({
    activeModal: 'vacation',
    editingVacation: vacation || null,
    modalContext: {
      ...(staffId ? { staffId } : {}),
      ...(returnTo ? { returnTo } : {}),
    },
  }),

  openEquipmentBlockModal: (block, equipmentId) => set({
    activeModal: 'equipmentBlock',
    editingEquipmentBlock: block || null,
    modalContext: equipmentId ? { equipmentId } : {},
  }),
  
  setActiveModal: (modal) => set((state) =>
    modal && opensSettingsHub(modal) && settingsHubBlocked()
      ? state
      : (modal && settingsAliasState(modal)) || {
          activeModal: modal as ModalType | null,
        }
  ),
  
  // -----------------------------------------
  // TOOLTIP ACTIONS
  // -----------------------------------------
  showTooltip: (content, x, y) => set({
    tooltip: { visible: true, content, x, y },
  }),
  
  hideTooltip: () => set({
    tooltip: { visible: false, content: '', x: 0, y: 0 },
  }),
  
  // -----------------------------------------
  // DRAG & DROP ACTIONS
  // -----------------------------------------
  startDrag: (type, itemId) => set({
    isDragging: true,
    dragType: type,
    dragItemId: itemId,
  }),
  
  endDrag: () => set({
    isDragging: false,
    dragType: null,
    dragItemId: null,
  }),
  
  // -----------------------------------------
  // RESIZE ACTIONS
  // -----------------------------------------
  startResize: (itemType, itemId, edge) => set({
    isResizing: true,
    resizeItemType: itemType,
    resizeItemId: itemId,
    resizeEdge: edge,
  }),
  
  endResize: () => set({
    isResizing: false,
    resizeItemType: null,
    resizeItemId: null,
    resizeEdge: null,
  }),
  
  // -----------------------------------------
  // DRAG/RESIZE INDICATOR ACTIONS
  // -----------------------------------------
  showDragIndicator: (left, top, lagDays) => set({
    dragIndicator: {
      visible: true,
      left,
      top,
      type: 'drag',
      lagDays,
    },
  }),
  
  showResizeIndicator: (left, top, date, duration, edge) => set({
    dragIndicator: {
      visible: true,
      left,
      top,
      type: 'resize',
      date,
      duration,
      edge,
    },
  }),
  
  hideIndicator: () => set({
    dragIndicator: {
      visible: false,
      left: 0,
      top: 0,
      type: 'drag',
    },
  }),
  
  // -----------------------------------------
  // DEPENDENCY LINKING ACTIONS
  // -----------------------------------------
  startLinking: (projectId, itemId, itemType, zone) => set({
    isLinkingDependency: true,
    linkingFrom: { projectId, itemId, itemType, zone },
  }),
  
  completeLinking: () => set({
    isLinkingDependency: false,
    linkingFrom: null,
  }),
  
  cancelLinking: () => set({
    isLinkingDependency: false,
    linkingFrom: null,
  }),
  
  // -----------------------------------------
  // PHANTOM SIBLING ACTIONS
  // -----------------------------------------
  startPhantomSibling: (config) => set({
    phantomSiblingMode: config,
  }),
  
  updatePhantomPosition: (phantomStart, phantomEnd) => set((state) => ({
    phantomSiblingMode: state.phantomSiblingMode 
      ? { ...state.phantomSiblingMode, phantomStart, phantomEnd }
      : null,
  })),
  
  endPhantomSibling: () => set({
    phantomSiblingMode: null,
  }),
  
  // -----------------------------------------
  // LOADING ACTIONS
  // -----------------------------------------
  setLoading: (loading, message = '') => set({
    isLoading: loading,
    loadingMessage: message,
  }),

  modalOpened: () => set((state) => ({ openModalCount: state.openModalCount + 1 })),
  modalClosed: () => set((state) => ({ openModalCount: Math.max(0, state.openModalCount - 1) })),

  showFlash: (message, tone = 'error') => set({
    flashNotice: { id: Date.now() + Math.random(), message, tone },
  }),
  dismissFlash: (id) => set((state) =>
    id === undefined || state.flashNotice?.id === id ? { flashNotice: null } : {}
  ),
  
  // -----------------------------------------
  // CONTEXT MENU ACTIONS
  // -----------------------------------------
  showContextMenu: (type, targetId, x, y, projectId, phaseId, subphaseId, assignmentData) => set({
    contextMenu: {
      visible: true,
      x,
      y,
      type,
      targetId,
      projectId,
      phaseId,
      subphaseId,
      assignmentData,
    },
  }),
  
  hideContextMenu: () => set({
    contextMenu: {
      visible: false,
      x: 0,
      y: 0,
      type: null,
      targetId: null,
      projectId: undefined,
      phaseId: undefined,
      subphaseId: undefined,
      assignmentData: undefined,
    },
  }),
  
  // -----------------------------------------
  // TIMELINE SCROLL ACTIONS
  // -----------------------------------------
  triggerScrollToToday: () => set((state) => ({
    scrollToTodayTrigger: state.scrollToTodayTrigger + 1,
  })),
  
  triggerScrollToDate: (date: string) => set({
    scrollToDateTrigger: { date, timestamp: Date.now() },
  }),
  
  clearScrollToDateTrigger: () => set({ scrollToDateTrigger: null }),
  
  triggerZoom: (direction, newCellWidth) => set({
    zoomTrigger: { direction, newCellWidth, timestamp: Date.now() },
  }),
  
  clearZoomTrigger: () => set({ zoomTrigger: null }),
  
  // -----------------------------------------
  // RESOURCE DRAG-DROP ACTIONS
  // -----------------------------------------
  startResourceDrag: (type: 'staff' | 'equipment', resourceId: number, resourceName: string) => set({
    resourceDrag: {
      active: true,
      type,
      resourceId,
      resourceName,
      targetProjectId: null,
      targetPhaseId: null,
      targetSubphaseId: null,
      previewStart: null,
      previewEnd: null,
    },
  }),
  
  updateResourceDragTarget: (
    projectId: number | null,
    phaseId: number | null,
    subphaseId: number | null,
    previewStart: string | null,
    previewEnd: string | null
  ) => set((state) => ({
    resourceDrag: {
      ...state.resourceDrag,
      targetProjectId: projectId,
      targetPhaseId: phaseId,
      targetSubphaseId: subphaseId,
      previewStart,
      previewEnd,
    },
  })),
  
  endResourceDrag: () => set({
    resourceDrag: {
      active: false,
      type: null,
      resourceId: null,
      resourceName: null,
      targetProjectId: null,
      targetPhaseId: null,
      targetSubphaseId: null,
      previewStart: null,
      previewEnd: null,
    },
  }),
}));
