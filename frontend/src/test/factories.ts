/**
 * Shared test-data factories.
 *
 * Each factory returns a complete, valid object of a frontend model type
 * (src/types/models.ts) with deterministic defaults drawn from the demo tenant,
 * and takes a `Partial<T>` whose fields replace the defaults. Nested arrays
 * (phases, children, assignments, ...) default to empty — pass them in when a
 * test needs a tree. Use these instead of redeclaring object literals per test
 * file; add a field here when the model gains a required one.
 */
import type {
  CustomColumn,
  Equipment,
  Phase,
  Project,
  Site,
  Staff,
  Subphase,
  Tag,
  Team,
  User,
  Vacation,
} from '@/types';
import { permissionsForRole, roleNameFor } from './permissionFixtures';

export function makeSite(overrides: Partial<Site> = {}): Site {
  return {
    id: 1,
    name: 'Basel',
    location: 'Basel, Switzerland',
    country_code: 'CH',
    region_code: null,
    active: true,
    ...overrides,
  };
}

/**
 * A signed-in user. `permissions` (and `role_name`, `can_see_all_sites`) are
 * derived from `role` unless given: a system role gets its shipped defaults
 * (test/permissionFixtures.ts), so `makeUser({ role: 'user' })` is a plain
 * user of a fresh tenant.
 */
export function makeUser(overrides: Partial<User> = {}): User {
  const role = overrides.role ?? 'admin';
  const permissions = overrides.permissions ?? permissionsForRole(role);
  return {
    id: 1,
    email: 'ada.admin@demo.local',
    first_name: 'Ada',
    last_name: 'Admin',
    name: 'Ada Admin',
    job_title: 'Lab Manager',
    role,
    role_name: roleNameFor(role),
    max_capacity: 100,
    active: true,
    site_ids: [1],
    skills: [],
    team_ids: [],
    approval_required: [],
    can_see_all_sites: permissions.includes('sites.view_all'),
    ...overrides,
    permissions,
  };
}

export function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 1,
    site_id: 1,
    name: 'Analytics',
    description: null,
    color: '#3b82f6',
    active: true,
    member_ids: [],
    ...overrides,
  };
}

export function makeStaff(overrides: Partial<Staff> = {}): Staff {
  return {
    id: 4,
    name: 'Bob Brown',
    email: 'bob.brown@demo.local',
    role: 'Scientist',
    site_id: 1,
    active: true,
    max_capacity: 100,
    skills: [],
    team_ids: [],
    ...overrides,
  };
}

export function makeEquipment(overrides: Partial<Equipment> = {}): Equipment {
  return {
    id: 1,
    name: 'Bioreactor 50L',
    type: 'Bioreactor',
    site_id: 1,
    site_ids: [1],
    active: true,
    team_ids: [],
    ...overrides,
  };
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: 'Bioprocess Scale-Up',
    site_id: 1,
    customer: null,
    pm_id: null,
    pm_name: null,
    sales_pm: null,
    volume: null,
    confirmed: true,
    archived: false,
    start_date: '2026-01-05',
    end_date: '2026-06-30',
    phases: [],
    staffAssignments: [],
    equipmentAssignments: [],
    tags: [],
    team_ids: [],
    ...overrides,
  };
}

export function makePhase(overrides: Partial<Phase> = {}): Phase {
  return {
    id: 1,
    project_id: 1,
    name: 'Feasibility',
    start_date: '2026-01-05',
    end_date: '2026-02-27',
    color: '#3b82f6',
    order_index: 0,
    completion: null,
    status: 'todo',
    is_milestone: false,
    dependencies: [],
    children: [],
    staffAssignments: [],
    equipmentAssignments: [],
    ...overrides,
  };
}

export function makeSubphase(overrides: Partial<Subphase> = {}): Subphase {
  return {
    id: 1,
    project_id: 1,
    parent_phase_id: 1,
    parent_subphase_id: null,
    name: 'Literature review',
    start_date: '2026-01-05',
    end_date: '2026-01-30',
    color: '#60a5fa',
    order_index: 0,
    completion: null,
    status: 'todo',
    is_milestone: false,
    dependencies: [],
    children: [],
    staffAssignments: [],
    equipmentAssignments: [],
    ...overrides,
  };
}

export function makeVacation(overrides: Partial<Vacation> = {}): Vacation {
  return {
    id: 1,
    staff_id: 4,
    staff_name: 'Bob Brown',
    start_date: '2026-03-09',
    end_date: '2026-03-13',
    description: 'Holidays',
    absence_type_id: null,
    ...overrides,
  };
}

export function makeTag(overrides: Partial<Tag> = {}): Tag {
  return {
    id: 1,
    name: 'Customer',
    color: '#10b981',
    group_id: null,
    all_sites: true,
    site_ids: [],
    sort_order: 0,
    team_ids: [],
    ...overrides,
  };
}

export function makeCustomColumn(overrides: Partial<CustomColumn> = {}): CustomColumn {
  return {
    id: 1,
    name: 'Priority',
    column_type: 'list',
    list_options: ['High', 'Medium', 'Low'],
    site_id: null,
    display_order: 0,
    width: 120,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
