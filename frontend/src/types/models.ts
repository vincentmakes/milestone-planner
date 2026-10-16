/**
 * Domain Models for Milestone
 * These types mirror the backend Pydantic schemas and existing JS state
 */

// =============================================================================
// CORE ENTITIES
// =============================================================================

export interface Site {
  id: number;
  name: string;
  location?: string;
  city?: string | null;
  country_code?: string | null;
  region_code?: string | null;
  active?: boolean | number;
  last_holiday_fetch?: string;
  created_at?: string;
}

export interface Project {
  id: number;
  name: string;
  site_id: number;
  customer?: string | null;
  pm_id?: number | null;
  pm_name?: string | null;
  sales_pm?: string | null;
  volume?: number | null;
  confirmed: boolean;
  archived: boolean;
  start_date?: string | null;
  end_date?: string | null;
  created_at?: string;
  // Nested relations
  phases: Phase[];
  staffAssignments: StaffAssignment[];
  equipmentAssignments: EquipmentAssignment[];
  /**
   * Inline tag refs as the project endpoints return them. Can be stale (What-If,
   * a teammate renaming/recolouring a tag): resolve name/colour/group through
   * appStore.tags by id (utils/tags.ts), never from these fields.
   */
  tags?: ProjectTagRef[];
}

/** Shape of `project.tags[]` in project responses. */
export type ProjectTagRef = Pick<Tag, 'id' | 'name' | 'color' | 'group_id'>;

/**
 * Project tag. Tags are tenant-wide but may be limited to some sites
 * (`all_sites: false` + `site_ids`); an optional group makes them a category
 * (see TagGroup). Snake_case straight from the API, like Equipment.
 */
export interface Tag {
  id: number;
  name: string;
  color: string;
  group_id: number | null;
  all_sites: boolean;
  site_ids: number[];
  sort_order: number;
}

/**
 * A category of tags (e.g. "Project type": Internal / Customer). A
 * single-select group allows one of its tags per project. Any group can
 * colour the Gantt project bars — a per-user choice ("Colour by",
 * viewStore.ganttColorBy), not a property of the group.
 */
export interface TagGroup {
  id: number;
  name: string;
  single_select: boolean;
  sort_order: number;
}

/**
 * Kanban column. Kept in sync with `completion` by utils/kanbanCards.ts,
 * which mirrors app/services/card_status.py on the backend.
 */
export type CardStatus = 'todo' | 'in_progress' | 'blocked' | 'done';

export interface Phase {
  id: number;
  project_id: number;
  name: string;
  start_date: string;
  end_date: string;
  color: string;
  order_index: number;
  completion?: number | null;
  status: CardStatus;
  is_milestone?: boolean;
  dependencies: Dependency[];
  // Nested relations
  children: Subphase[];
  staffAssignments: StaffAssignment[];
  equipmentAssignments: EquipmentAssignment[];
}

export interface Subphase {
  id: number;
  project_id: number;
  parent_phase_id: number | null;
  parent_subphase_id: number | null;
  name: string;
  start_date: string;
  end_date: string;
  color: string;
  order_index: number;
  completion?: number | null;
  status: CardStatus;
  is_milestone?: boolean;
  dependencies: Dependency[];
  // Recursive children
  children: Subphase[];
  staffAssignments: StaffAssignment[];
  equipmentAssignments: EquipmentAssignment[];
}

export interface Dependency {
  id: number;        // Predecessor phase/subphase ID
  type: DependencyType;
  lag?: number;      // Lag in days (positive = lag, negative = lead)
  /**
   * Kind of the predecessor. Phase and subphase ids come from separate
   * sequences, so `id` alone is ambiguous. Written on every new link;
   * legacy entries without it resolve phase-first.
   */
  entity?: 'phase' | 'subphase';
}

export type DependencyType = 'FS' | 'FF' | 'SS' | 'SF';

// Helper type for rendering dependencies
export interface DependencyLink {
  id: string;                    // Unique key for React
  fromId: number;                // Predecessor ID
  fromType: 'phase' | 'subphase';
  toId: number;                  // Successor ID
  toType: 'phase' | 'subphase';
  type: DependencyType;
  lag: number;
  projectId: number;
}

// =============================================================================
// RESOURCES
// =============================================================================

export interface Skill {
  id: number;
  name: string;
  color: string;
  description?: string;
}

export interface Staff {
  id: number;
  name: string;
  email?: string;
  role?: string;  // job_title
  site_id: number;
  active: boolean;
  max_capacity?: number;  // Max work capacity % (e.g., 80 for part-time), defaults to 100
  skills?: Skill[];  // Staff skills
}

export interface Equipment {
  id: number;
  name: string;
  type: string;
  /** Site of this row (GET /equipment returns one row per equipment-site pair) */
  site_id: number;
  /** All sites the equipment is available on */
  site_ids?: number[];
  /** Names of site_ids, same order (sent by /equipment/all) */
  site_names?: string[];
  active: boolean;
}

// =============================================================================
// ASSIGNMENTS
// =============================================================================

export interface StaffAssignment {
  id: number;
  staff_id: number;
  staff_name?: string;
  project_id?: number | null;
  phase_id?: number | null;
  subphase_id?: number | null;
  allocation: number;
  start_date: string;
  end_date: string;
}

export interface EquipmentAssignment {
  id: number;
  equipment_id: number;
  equipment_name?: string;
  project_id?: number | null;
  phase_id?: number | null;
  subphase_id?: number | null;
  start_date: string;
  end_date: string;
}

// =============================================================================
// USER & AUTH
// =============================================================================

export interface User {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  name: string; // Computed: first_name + last_name
  job_title?: string;  // Job role/title
  role: UserRole;  // System role (admin/superuser/user)
  max_capacity?: number;  // Max work capacity % (e.g., 80 for part-time), defaults to 100
  active: boolean;
  site_ids: number[];
  skills?: Skill[];  // User's skills
}

export type UserRole = 'admin' | 'superuser' | 'user';

export interface AuthResponse {
  user: User;
  message?: string;
}

// =============================================================================
// TIME OFF & HOLIDAYS
// =============================================================================

export interface Vacation {
  id: number;
  staff_id: number;
  staff_name?: string;
  start_date: string;
  end_date: string;
  description?: string;
  /** Absence type; null/undefined is treated as an unavailable absence */
  absence_type_id?: number | null;
  /** Whether the current user may edit/delete this entry (server-computed) */
  canEdit?: boolean;
  created_at?: string;
}

/**
 * Tenant-wide absence category (Holidays, Home Office, Illness, ...).
 * Only types with counts_as_unavailable reduce a person's capacity.
 */
export interface AbsenceType {
  id: number;
  name: string;
  color: string;
  counts_as_unavailable: boolean;
  sort_order: number;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface BankHoliday {
  id: number;
  site_id: number;
  date: string;
  end_date?: string | null;
  name: string;
  is_custom: boolean;
  year?: number;
}

export interface CompanyEvent {
  id: number;
  /** First linked site (legacy single-site field, kept for compatibility) */
  site_id: number;
  /** All sites the event applies to */
  site_ids?: number[];
  date: string;
  end_date?: string | null;
  name: string;
  color?: string | null;
  /** Site closure: staff on the event's sites are unavailable for its dates */
  counts_as_unavailable?: boolean;
}

export interface EquipmentBlock {
  id: number;
  equipment_id: number;
  equipment_name?: string;
  start_date: string;
  end_date: string;
  reason: string;
  description: string;
}

// =============================================================================
// SETTINGS & CONFIGURATION
// =============================================================================

export interface PredefinedPhase {
  id: number;
  name: string;
  sort_order: number;
  is_active: boolean;
  created_at?: string;
}

export interface SSOConfig {
  enabled: boolean;
  client_id?: string;
  tenant_id?: string;
  redirect_uri?: string;
}

export interface InstanceSettings {
  instance_title?: string;
  [key: string]: string | undefined;
}

// =============================================================================
// VIEW & UI TYPES
// =============================================================================

export type ViewMode = 'week' | 'month' | 'quarter' | 'year';

export type CurrentView = 'gantt' | 'kanban' | 'staff' | 'equipment' | 'crosssite' | 'archived';

export type ResourceTab = 'staff' | 'equipment';

// =============================================================================
// GANTT SPECIFIC TYPES
// =============================================================================

export interface TimelineCell {
  date: Date;
  label: string;
  isToday: boolean;
  isWeekend: boolean;
  isBankHoliday: boolean;
  isCustomHoliday: boolean;  // Keep for backwards compat, but both will be orange
  bankHolidayName?: string | null;
  isCompanyEvent: boolean;
  companyEventName?: string | null;
  dayOfWeek: number;
  periodOffset: number;
  isFirstOfWeek?: boolean;
  isFirstOfMonth?: boolean;
  weekLabel?: string | null;
  monthLabel?: string | null;
  weekNumber?: number;
}

export interface BarPosition {
  left: number;
  width: number;
}

export interface DragState {
  isDragging: boolean;
  dragType: 'phase' | 'subphase' | null;
  dragItemId: number | null;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  daysDelta: number;
}

export interface ResizeState {
  isResizing: boolean;
  edge: 'left' | 'right' | null;
  itemId: number | null;
  itemType: 'phase' | 'subphase' | null;
  startX: number;
  daysDelta: number;
}

export interface LinkingState {
  isLinking: boolean;
  linkType: 'phase' | 'subphase';
  fromId: number | null;
  fromProjectId: number | null;
}

// =============================================================================
// API REQUEST/RESPONSE TYPES
// =============================================================================

export interface ApiError {
  error: string;
  detail?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
}

export interface CreateProjectRequest {
  name: string;
  site_id: number;
  customer?: string | null;
  pm_id?: number | null;
  sales_pm?: string | null;
  volume?: number | null;
  confirmed?: boolean;
  start_date?: string | null;
  end_date?: string | null;
  tag_ids?: number[];
}

export interface UpdateProjectRequest extends Partial<CreateProjectRequest> {
  archived?: boolean;
}

export interface CreatePhaseRequest {
  name: string;
  start_date: string;
  end_date: string;
  color: string;
  order_index?: number;
  dependencies?: Dependency[];
  completion?: number | null;
  is_milestone?: boolean;
}

export interface UpdatePhaseRequest extends Partial<CreatePhaseRequest> {
  dependencies?: Dependency[];
  completion?: number | null;
  is_milestone?: boolean;
}

export interface CreateSubphaseRequest {
  name: string;
  parent_phase_id?: number | null;
  parent_subphase_id?: number | null;
  start_date: string;
  end_date: string;
  color: string;
  order_index?: number;
  dependencies?: Dependency[];
  completion?: number | null;
  is_milestone?: boolean;
}

export interface CreateStaffAssignmentRequest {
  staff_id: number;
  phase_id?: number | null;
  subphase_id?: number | null;
  allocation: number;
  start_date: string;
  end_date: string;
}

export interface CreateEquipmentAssignmentRequest {
  equipment_id: number;
  phase_id?: number | null;
  subphase_id?: number | null;
  start_date: string;
  end_date: string;
}

/** Result of a bulk calendar import (vacations, holidays, company events) */
export interface CalendarImportResult {
  created: number;
  skipped: number;
  /** Company events only: existing events that gained a site link */
  linked?: number;
}

export interface CreateVacationRequest {
  staff_id: number;
  start_date: string;
  end_date: string;
  description?: string;
  absence_type_id?: number | null;
}

export interface CreateEquipmentBlockRequest {
  equipment_id: number;
  start_date: string;
  end_date: string;
  reason?: string;
  description?: string;
}

export interface CreateUserRequest {
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  job_title?: string;
  role: UserRole;
  max_capacity?: number;  // Max work capacity % (default 100)
  site_ids: number[];
  skill_ids?: number[];
}

export interface UpdateUserRequest {
  email?: string;
  password?: string;
  first_name?: string;
  last_name?: string;
  job_title?: string;
  role?: UserRole;
  max_capacity?: number;  // Max work capacity %
  active?: boolean;
  site_ids?: number[];
  skill_ids?: number[];
}

// =============================================================================
// CUSTOM COLUMNS
// =============================================================================

export type CustomColumnType = 'text' | 'boolean' | 'list';
export type CustomColumnEntityType = 'project' | 'phase' | 'subphase';

export interface CustomColumn {
  id: number;
  name: string;
  column_type: CustomColumnType;
  list_options: string[] | null;
  site_id: number | null;  // null = global (all sites)
  display_order: number;
  width: number;
  created_at: string;
  updated_at: string;
}

export interface CustomColumnValue {
  columnId: number;
  entityType: CustomColumnEntityType;
  entityId: number;
  value: string | null;
}

// Key format for values map: "{columnId}-{entityType}-{entityId}"
export type CustomColumnValuesMap = Record<string, string | null>;

// =============================================================================
// NOTIFICATIONS
// =============================================================================

export type NotificationType =
  | 'assigned'
  | 'comment'
  | 'mention'
  | 'status_change'
  /** Derived in the browser from card end dates; never stored server-side. */
  | 'due_soon'
  | 'overdue';

export interface AppNotification {
  id: number;
  type: NotificationType;
  actor_id?: number | null;
  actor_name?: string | null;
  entity_type?: 'phase' | 'subphase' | null;
  entity_id?: number | null;
  project_id?: number | null;
  title: string;
  body?: string | null;
  read_at?: string | null;
  created_at: string;
  /**
   * 'derived' notifications are computed client-side from loaded project data
   * and are dismissed into localStorage rather than marked read on the server.
   */
  source?: 'server' | 'derived';
}
