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

export interface Team {
  id: number;
  site_id: number;
  name: string;
  description?: string | null;
  color: string | null;
  active: boolean;
  /** User ids; every member belongs to the team's site */
  member_ids: number[];
  created_at?: string;
  updated_at?: string;
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
  /** Teams of the project's site the project belongs to */
  team_ids?: number[];
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
  /** Teams the tag is restricted to (flat across sites; empty = no restriction) */
  team_ids?: number[];
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
  /** Teams of this user on this row's site */
  team_ids?: number[];
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
  /** Teams the equipment is restricted to, flat across the equipment's sites */
  team_ids?: number[];
  /** Names of team_ids, same order */
  team_names?: string[];
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
  /**
   * 'pending' = an own booking awaiting approval (a real row, excluded from
   * capacity until approved); absent on older servers = approved.
   */
  approval_status?: 'approved' | 'pending';
  /**
   * The open approval request on the row: its pending create, or a pending
   * change / removal of an approved row (the row keeps its current values
   * until the request is decided). null when nothing awaits a decision.
   */
  approval?: AssignmentApproval | null;
}

/** The booking values a request asks for, or the row held when it was filed. */
export interface BookingValues {
  allocation?: number;
  /** Project-level rows only (`YYYY-MM-DD`) */
  start_date?: string;
  end_date?: string;
}

/** The open approval request on a staff assignment (its `approval` field). */
export interface AssignmentApproval {
  request_id: number;
  /** The own-booking key: assignments.self_create | self_update | self_remove */
  action: string;
  requester_id: number;
  requested: BookingValues | null;
  previous: BookingValues | null;
  created_at: string | null;
  /** Whether the signed-in user may approve or reject it */
  can_decide: boolean;
}

export type ApprovalRequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'superseded'
  | 'expired';

/** One approval request (GET /api/approval-requests). */
export interface ApprovalRequest {
  id: number;
  action: string;
  status: ApprovalRequestStatus;
  close_reason: string | null;
  requester_id: number;
  requester_name: string | null;
  project_id: number;
  project_name: string | null;
  level: StaffAssignmentLevel;
  target_id: number;
  target_name: string | null;
  assignment_id: number | null;
  requested: BookingValues | null;
  previous: BookingValues | null;
  note: string | null;
  decided_by: number | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  superseded_by_id: number | null;
  created_at: string | null;
  updated_at: string | null;
  can_decide: boolean;
}

/** The outcome of approve / reject / cancel. */
export interface ApprovalDecisionResult {
  success: boolean;
  id: number;
  status: ApprovalRequestStatus;
}

/**
 * The 202 body of a self-booking write that needs approval: a request was
 * filed instead (`id` = the pending row for a create, the existing row
 * otherwise).
 */
export interface PendingBookingResponse {
  success: boolean;
  pending: true;
  request_id: number;
  id: number;
}

/** The route family of a staff assignment: ids are unique per level only. */
export type StaffAssignmentLevel = 'project' | 'phase' | 'subphase';

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
  /** The role's key (system roles admin/superuser/user, or a custom role) */
  role: UserRole;
  /** The role's display name */
  role_name?: string;
  max_capacity?: number;  // Max work capacity % (e.g., 80 for part-time), defaults to 100
  active: boolean;
  /**
   * Bookable as a resource: listed in the Staff panel and bookable on
   * projects. Off = new bookings of the person are refused (400); existing
   * ones stay.
   */
  is_resource: boolean;
  site_ids: number[];
  skills?: Skill[];  // User's skills
  /** Teams the user belongs to, across all their sites */
  team_ids?: number[];
  /** Names of team_ids, same order */
  team_names?: string[];
  /**
   * The signed-in user only (/auth/me), absent on user-list rows: the keys the
   * role allows outright (the admin role: every key). Gate with
   * `can()` / `useHasPermission()` from utils/permissions and hooks/useCan,
   * never with the role key.
   */
  permissions?: string[];
  /** The signed-in user only: own-booking keys the role holds in approval mode */
  approval_required?: string[];
  /** The signed-in user only: `sites.view_all` (every active site is visible) */
  can_see_all_sites?: boolean;
}

/** A role key: one of SYSTEM_ROLE_KEYS or a custom role's key */
export type UserRole = string;

/** The system roles, never deletable; `admin` always holds every permission. */
export const SYSTEM_ROLE_KEYS = ['admin', 'superuser', 'user'] as const;

/** How a role holds a permission; a key missing from a matrix is denied. */
export type PermissionMode = 'allow' | 'approval';

/** A role's matrix: permission key → mode (keys left out are denied). */
export type PermissionMatrix = Record<string, PermissionMode>;

/** A role (GET /api/roles): system (admin/superuser/user) or custom. */
export interface Role {
  id: number;
  /** Immutable key, stored on users.role */
  key: UserRole;
  name: string;
  description?: string | null;
  /** System roles cannot be deleted; the admin role cannot be edited at all */
  is_system: boolean;
  sort_order: number;
  /** Effective modes: the admin role lists every key as allow */
  permissions: PermissionMatrix;
  /** Users (active or not) holding the role */
  user_count: number;
}

export interface CreateRoleRequest {
  key: string;
  name: string;
  description?: string | null;
  permissions: PermissionMatrix;
}

export interface UpdateRoleRequest {
  name?: string;
  /** An explicit null clears the description */
  description?: string | null;
  /** Replaces the whole matrix */
  permissions?: PermissionMatrix;
}

/** One catalogue entry (GET /api/permissions), as the role matrix shows it. */
export interface PermissionInfo {
  key: string;
  label: string;
  description: string;
  /** May be held in approval mode (the own-booking keys) */
  approvable: boolean;
  /** Fixed for every role (projects.view always allow, roles.manage admin only) */
  locked: boolean;
  /** Shipped mode per editable system role (null = deny) */
  defaults: Record<string, PermissionMode | null>;
}

export interface PermissionGroup {
  name: string;
  permissions: PermissionInfo[];
}

export interface PermissionCatalogue {
  groups: PermissionGroup[];
  pm_bundle: string[];
}

/** Who approves one approvable action (admins always may). */
export interface ApprovalPolicy {
  action: string;
  label: string;
  /** The project's manager may approve */
  pm_approves: boolean;
  /** Holders of these roles may approve */
  role_ids: number[];
}

export interface UpdateApprovalPolicyRequest {
  pm_approves: boolean;
  role_ids: number[];
}

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
  /** Teams the event is restricted to (flat across sites; empty = whole sites) */
  team_ids?: number[];
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

/**
 * Instance settings (GET /api/settings, written with settings.general).
 * The admin defaults and feature switches always arrive (the backend fills a
 * missing row with its default); the readers in utils/instanceSettings.ts
 * parse them.
 */
export interface InstanceSettings {
  instance_title?: string;
  instance_name?: string;
  show_weekends?: string;
  /** `none` / `staff` / `equipment`: the overview panel the Gantt opens with */
  gantt_default_panel?: string;
  /** Compact JSON array of skill ids: the Staff panel's initial skill filter */
  staff_panel_default_skills?: string;
  /** Compact JSON array of type names: the Equipment panel's initial type filter */
  equipment_panel_default_types?: string;
  /** `false` turns the Kanban board off for everyone */
  kanban_enabled?: string;
  /** `false` turns the Nager bank-holiday import off */
  nager_enabled?: string;
  /** `false`: a new project starts with no predefined phase selected */
  new_project_preselect_phases?: string;
  [key: string]: string | undefined;
}

// =============================================================================
// VIEW & UI TYPES
// =============================================================================

export type ViewMode = 'week' | 'month' | 'quarter' | 'year';

export type CurrentView =
  | 'gantt'
  | 'kanban'
  | 'todos'
  | 'staff'
  | 'equipment'
  | 'crosssite'
  | 'archived';

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
  team_ids?: number[];
}

export interface UpdateProjectRequest extends Partial<CreateProjectRequest> {
  archived?: boolean;
}

export interface CreateTeamRequest {
  site_id: number;
  name: string;
  description?: string | null;
  color?: string | null;
  active?: boolean;
  member_ids?: number[];
}

/** A team cannot move to another site. */
export type UpdateTeamRequest = Partial<Omit<CreateTeamRequest, 'site_id'>>;

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
  /** Bookable as a resource; omitted = every role but admin */
  is_resource?: boolean;
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
  /** Bookable as a resource */
  is_resource?: boolean;
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
  /** A booking request the user may decide (entity: the approval request) */
  | 'approval_requested'
  /** The user's own request was approved, rejected or expired */
  | 'approval_decided'
  /** Someone assigned the user a task (entity: the todo) */
  | 'todo_assigned'
  /**
   * Someone else added, changed or removed the user's booking (entity: the
   * card or the project; none, and no project, when the project was deleted)
   */
  | 'assignment_changed'
  /** Someone else changed a project the user manages (same entities) */
  | 'project_changed'
  /** Derived in the browser from card end dates; never stored server-side. */
  | 'due_soon'
  | 'overdue';

export interface AppNotification {
  id: number;
  type: NotificationType;
  actor_id?: number | null;
  actor_name?: string | null;
  entity_type?: 'phase' | 'subphase' | 'project' | 'todo' | 'approval_request' | null;
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

// =============================================================================
// TODOS (My Todos)
// =============================================================================

export type TodoStatus = 'open' | 'done' | 'cancelled';

/**
 * One My Todos entry (GET /api/todos/mine): a `task` (a private todo row,
 * the caller is its assignee or creator) or an `approval` (a pending request
 * the caller may decide, id `approval:<n>`, the request in `approval_request`).
 */
export interface TodoItem {
  id: number | string;
  kind: 'task' | 'approval';
  title: string;
  notes: string | null;
  /** YYYY-MM-DD */
  due_date: string | null;
  status: TodoStatus;
  assignee_id: number | null;
  assignee_name: string | null;
  created_by: number | null;
  created_by_name: string | null;
  project_id: number | null;
  project_name: string | null;
  /** The linked card ('phase' | 'subphase'), or a request's level */
  entity_type: string | null;
  entity_id: number | null;
  completed_at: string | null;
  approval_request: ApprovalRequest | null;
  created_at: string | null;
  updated_at: string | null;
}

/** A task (`kind: 'task'`): its id is the todo row's number. */
export type TodoTask = TodoItem & { id: number; kind: 'task' };

/** POST /api/todos — the assignee defaults to the caller. */
export interface CreateTodoRequest {
  title: string;
  notes?: string | null;
  due_date?: string | null;
  assignee_id?: number;
  project_id?: number | null;
  entity_type?: 'phase' | 'subphase' | null;
  entity_id?: number | null;
}

/** PUT /api/todos/{id} — partial; an explicit null clears notes, due date and the links. */
export interface UpdateTodoRequest extends Partial<CreateTodoRequest> {
  status?: TodoStatus;
}
