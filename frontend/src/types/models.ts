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
  city?: string;
  country_code?: string;
  region_code?: string;
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
}

export interface Phase {
  id: number;
  project_id: number;
  name: string;
  start_date: string;
  end_date: string;
  color: string;
  order_index: number;
  completion?: number | null;
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
  max_allocation?: number;
  skills?: Skill[];  // Staff skills
}

export interface Equipment {
  id: number;
  name: string;
  type: string;
  site_id: number;
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

export type CurrentView = 'gantt' | 'staff' | 'equipment' | 'crosssite' | 'archived';

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
  bankHolidayName?: string | null;
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

export interface CreateVacationRequest {
  staff_id: number;
  start_date: string;
  end_date: string;
  description?: string;
}

export interface CreateUserRequest {
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  job_title?: string;
  role: UserRole;
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
