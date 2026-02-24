/**
 * Projects API endpoints
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type { 
  Project, 
  CreateProjectRequest, 
  UpdateProjectRequest,
  Phase,
  CreatePhaseRequest,
  UpdatePhaseRequest,
  Subphase,
  CreateSubphaseRequest,
  StaffAssignment,
  CreateStaffAssignmentRequest,
  EquipmentAssignment,
  CreateEquipmentAssignmentRequest,
} from '@/types';

// =============================================================================
// PROJECTS
// =============================================================================

/**
 * Get all projects
 * @param archived - Filter: 'all', 'true', 'false' (default: active only)
 */
export async function getProjects(archived: 'all' | 'true' | 'false' = 'false'): Promise<Project[]> {
  return apiGet<Project[]>(`/api/projects?archived=${archived}`);
}

/**
 * Get a single project with all nested data
 */
export async function getProject(id: number): Promise<Project> {
  return apiGet<Project>(`/api/projects/${id}`);
}

/**
 * Create a new project
 */
export async function createProject(data: CreateProjectRequest): Promise<Project> {
  return apiPost<Project>('/api/projects', data);
}

/**
 * Update a project
 */
export async function updateProject(id: number, data: UpdateProjectRequest): Promise<Project> {
  return apiPut<Project>(`/api/projects/${id}`, data);
}

/**
 * Delete a project
 */
export async function deleteProject(id: number): Promise<void> {
  await apiDelete(`/api/projects/${id}`);
}

/**
 * Archive a project
 */
export async function archiveProject(id: number): Promise<Project> {
  return apiPut<Project>(`/api/projects/${id}`, { archived: true });
}

/**
 * Restore an archived project
 */
export async function restoreProject(id: number): Promise<Project> {
  return apiPut<Project>(`/api/projects/${id}`, { archived: false });
}

// =============================================================================
// PHASES
// =============================================================================

/**
 * Create a new phase for a project
 * Backend expects: { type, start_date, end_date, is_milestone }
 */
export async function createPhase(projectId: number, data: CreatePhaseRequest): Promise<Phase> {
  // Map frontend 'name' to backend 'type'
  const backendData: Record<string, unknown> = {
    type: data.name,
    start_date: data.start_date,
    end_date: data.end_date,
    is_milestone: data.is_milestone ?? false,
  };
  
  // Include optional fields if provided
  if (data.order_index !== undefined) {
    backendData.order_index = data.order_index;
  }
  if (data.dependencies !== undefined) {
    backendData.dependencies = data.dependencies;
  }
  
  return apiPost<Phase>(`/api/projects/${projectId}/phases`, backendData);
}

/**
 * Update a phase
 * Backend expects 'type' instead of 'name' for the phase name
 */
export async function updatePhase(phaseId: number, data: UpdatePhaseRequest): Promise<Phase> {
  // Map frontend 'name' to backend 'type'
  const backendData: Record<string, unknown> = {};
  
  if (data.name !== undefined) {
    backendData.type = data.name;
  }
  if (data.start_date !== undefined) {
    backendData.start_date = data.start_date;
  }
  if (data.end_date !== undefined) {
    backendData.end_date = data.end_date;
  }
  if (data.is_milestone !== undefined) {
    backendData.is_milestone = data.is_milestone;
  }
  if (data.dependencies !== undefined) {
    backendData.dependencies = data.dependencies;
  }
  if (data.completion !== undefined) {
    backendData.completion = data.completion;
  }
  
  return apiPut<Phase>(`/api/phases/${phaseId}`, backendData);
}

/**
 * Delete a phase
 */
export async function deletePhase(phaseId: number): Promise<void> {
  await apiDelete(`/api/phases/${phaseId}`);
}

// =============================================================================
// SUBPHASES
// =============================================================================

/**
 * Create a new subphase under a phase
 * Backend endpoint: POST /phases/{phase_id}/subphases
 */
export async function createSubphase(
  phaseId: number, 
  projectId: number, 
  data: CreateSubphaseRequest
): Promise<Subphase> {
  const backendData: Record<string, unknown> = {
    name: data.name,
    start_date: data.start_date,
    end_date: data.end_date,
    project_id: projectId,
    is_milestone: data.is_milestone ?? false,
  };
  
  // Include optional fields if provided
  if (data.order_index !== undefined) {
    backendData.order_index = data.order_index;
  }
  if (data.dependencies !== undefined) {
    backendData.dependencies = data.dependencies;
  }
  
  return apiPost<Subphase>(`/api/phases/${phaseId}/subphases`, backendData);
}

/**
 * Create a nested subphase under another subphase
 * Backend endpoint: POST /subphases/{subphase_id}/children
 */
export async function createChildSubphase(
  parentSubphaseId: number,
  projectId: number,
  data: CreateSubphaseRequest
): Promise<Subphase> {
  const backendData: Record<string, unknown> = {
    name: data.name,
    start_date: data.start_date,
    end_date: data.end_date,
    project_id: projectId,
    is_milestone: data.is_milestone ?? false,
  };
  
  // Include optional fields if provided
  if (data.order_index !== undefined) {
    backendData.order_index = data.order_index;
  }
  if (data.dependencies !== undefined) {
    backendData.dependencies = data.dependencies;
  }
  
  return apiPost<Subphase>(`/api/subphases/${parentSubphaseId}/children`, backendData);
}

/**
 * Update a subphase
 */
export async function updateSubphase(subphaseId: number, data: Partial<CreateSubphaseRequest>): Promise<Subphase> {
  return apiPut<Subphase>(`/api/subphases/${subphaseId}`, data);
}

/**
 * Delete a subphase
 */
export async function deleteSubphase(subphaseId: number): Promise<void> {
  await apiDelete(`/api/subphases/${subphaseId}`);
}

// =============================================================================
// STAFF ASSIGNMENTS
// =============================================================================

/**
 * Create a staff assignment
 * Can be assigned to project, phase, or subphase
 */
export async function createStaffAssignment(
  data: CreateStaffAssignmentRequest & { 
    project_id?: number; 
    phase_id?: number; 
    subphase_id?: number; 
  }
): Promise<StaffAssignment> {
  // Determine endpoint based on what we're assigning to
  if (data.subphase_id) {
    return apiPost<StaffAssignment>(`/api/subphases/${data.subphase_id}/staff`, data);
  } else if (data.phase_id) {
    return apiPost<StaffAssignment>(`/api/phases/${data.phase_id}/staff`, data);
  } else if (data.project_id) {
    return apiPost<StaffAssignment>(`/api/projects/${data.project_id}/staff`, data);
  }
  throw new Error('Must specify project_id, phase_id, or subphase_id');
}

/**
 * Update a staff assignment
 * Routes to correct endpoint based on assignment level
 */
export async function updateStaffAssignment(
  assignmentId: number, 
  data: Partial<CreateStaffAssignmentRequest>,
  level: 'project' | 'phase' | 'subphase' = 'project'
): Promise<StaffAssignment> {
  const endpoint = level === 'subphase' 
    ? `/api/subphase-staff/${assignmentId}`
    : level === 'phase'
    ? `/api/phase-staff/${assignmentId}`
    : `/api/assignments/${assignmentId}`;
  return apiPut<StaffAssignment>(endpoint, data);
}

/**
 * Delete a staff assignment
 * Routes to correct endpoint based on assignment level
 */
export async function deleteStaffAssignment(
  assignmentId: number,
  level: 'project' | 'phase' | 'subphase' = 'project'
): Promise<void> {
  const endpoint = level === 'subphase' 
    ? `/api/subphase-staff/${assignmentId}`
    : level === 'phase'
    ? `/api/phase-staff/${assignmentId}`
    : `/api/assignments/${assignmentId}`;
  await apiDelete(endpoint);
}

// =============================================================================
// EQUIPMENT ASSIGNMENTS
// =============================================================================

/**
 * Create an equipment assignment
 * Can be assigned to project, phase, or subphase
 */
export async function createEquipmentAssignment(
  data: CreateEquipmentAssignmentRequest & { 
    project_id?: number; 
    phase_id?: number; 
    subphase_id?: number; 
  }
): Promise<EquipmentAssignment> {
  // Determine endpoint based on what we're assigning to
  if (data.subphase_id) {
    return apiPost<EquipmentAssignment>(`/api/subphases/${data.subphase_id}/equipment`, data);
  } else if (data.phase_id) {
    return apiPost<EquipmentAssignment>(`/api/phases/${data.phase_id}/equipment`, data);
  } else if (data.project_id) {
    return apiPost<EquipmentAssignment>(`/api/projects/${data.project_id}/equipment`, data);
  }
  throw new Error('Must specify project_id, phase_id, or subphase_id');
}

/**
 * Update an equipment assignment
 */
export async function updateEquipmentAssignment(
  assignmentId: number, 
  data: Partial<CreateEquipmentAssignmentRequest>
): Promise<EquipmentAssignment> {
  return apiPut<EquipmentAssignment>(`/api/equipment-assignments/${assignmentId}`, data);
}

/**
 * Delete an equipment assignment
 */
export async function deleteEquipmentAssignment(assignmentId: number): Promise<void> {
  await apiDelete(`/api/equipment-assignments/${assignmentId}`);
}

// =============================================================================
// BULK OPERATIONS
// =============================================================================

/**
 * Transform API response from snake_case to camelCase
 */
function transformProject(project: any): Project {
  return {
    ...project,
    // Ensure arrays exist and transform nested data
    phases: (project.phases ?? []).map(transformPhase),
    staffAssignments: (project.staff_assignments ?? project.staffAssignments ?? []).map(transformStaffAssignment),
    equipmentAssignments: (project.equipment_assignments ?? project.equipmentAssignments ?? []).map(transformEquipmentAssignment),
  };
}

// Phase color - use theme-aware function
import { getPhaseColor, getDepthColor } from '@/utils/themeColors';

// Legacy constants for fallback (kept for reference)
const PHASE_COLOR_FALLBACK = '#ec4899';

// Subphase depth colors fallback
const DEPTH_COLORS_FALLBACK: Record<number, string> = {
  1: '#06b6d4',  // Cyan
  2: '#8b5cf6',  // Purple
  3: '#3b82f6',  // Blue
  4: '#f97316',  // Orange
  5: '#10b981',  // Green
  6: '#ec4899',  // Pink
  7: '#eab308',  // Yellow
  8: '#14b8a6',  // Teal
  9: '#a855f7',  // Light Purple
};

function getDepthColorWithFallback(depth: number): string {
  // Try to get from CSS variables first, fall back to hardcoded
  try {
    return getDepthColor(depth);
  } catch {
    return DEPTH_COLORS_FALLBACK[depth] || DEPTH_COLORS_FALLBACK[1];
  }
}

function getPhaseColorWithFallback(): string {
  try {
    return getPhaseColor();
  } catch {
    return PHASE_COLOR_FALLBACK;
  }
}

function transformPhase(phase: any): Phase {
  return {
    id: phase.id,
    project_id: phase.project_id,
    name: phase.type || phase.name || 'Phase',  // API returns 'type' for phases
    start_date: phase.start_date,
    end_date: phase.end_date,
    color: getPhaseColorWithFallback(),
    order_index: phase.sort_order ?? 0,
    completion: phase.completion ?? null,
    // Handle SQLite integer (0/1) and boolean
    is_milestone: Boolean(phase.is_milestone),
    dependencies: phase.dependencies ?? [],
    children: (phase.children ?? phase.subphases ?? []).map((s: any) => transformSubphase(s, 1)),
    staffAssignments: (phase.staff_assignments ?? phase.staffAssignments ?? []).map(transformStaffAssignment),
    equipmentAssignments: (phase.equipment_assignments ?? phase.equipmentAssignments ?? []).map(transformEquipmentAssignment),
  };
}

function transformSubphase(subphase: any, depth: number = 1): Subphase {
  const actualDepth = subphase.depth ?? depth;
  return {
    id: subphase.id,
    project_id: subphase.project_id,
    parent_phase_id: subphase.parent_type === 'phase' ? subphase.parent_id : null,
    parent_subphase_id: subphase.parent_type === 'subphase' ? subphase.parent_id : null,
    name: subphase.name,
    start_date: subphase.start_date,
    end_date: subphase.end_date,
    color: getDepthColorWithFallback(actualDepth),
    order_index: subphase.sort_order ?? 0,
    completion: subphase.completion ?? null,
    // Handle SQLite integer (0/1) and boolean
    is_milestone: Boolean(subphase.is_milestone),
    dependencies: subphase.dependencies ?? [],
    children: (subphase.children ?? []).map((s: any) => transformSubphase(s, actualDepth + 1)),
    staffAssignments: (subphase.staff_assignments ?? subphase.staffAssignments ?? []).map(transformStaffAssignment),
    equipmentAssignments: (subphase.equipment_assignments ?? subphase.equipmentAssignments ?? []).map(transformEquipmentAssignment),
  };
}

function transformStaffAssignment(assignment: any): StaffAssignment {
  return {
    id: assignment.id,
    staff_id: assignment.staff_id,
    staff_name: assignment.staff_name,
    project_id: assignment.project_id,
    phase_id: assignment.phase_id,
    subphase_id: assignment.subphase_id,
    allocation: assignment.allocation ?? assignment.allocation_percent ?? 100,
    start_date: assignment.start_date,
    end_date: assignment.end_date,
  };
}

function transformEquipmentAssignment(assignment: any): EquipmentAssignment {
  return {
    id: assignment.id,
    equipment_id: assignment.equipment_id,
    equipment_name: assignment.equipment_name,
    project_id: assignment.project_id,
    phase_id: assignment.phase_id,
    subphase_id: assignment.subphase_id,
    start_date: assignment.start_date,
    end_date: assignment.end_date,
  };
}

/**
 * Load all projects with full nested data
 * This is the main data loading function used at app startup
 */
export async function loadAllProjects(): Promise<Project[]> {
  const projects = await getProjects('all');
  
  if (!projects || projects.length === 0) {
    return [];
  }
  
  // Load full details for each project in parallel
  const fullProjects = await Promise.all(
    projects.map(p => getProject(p.id))
  );
  
  // Transform to ensure correct property names
  return fullProjects.map(transformProject);
}
