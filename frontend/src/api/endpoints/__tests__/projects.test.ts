/**
 * Projects endpoint module: request shapes (phase name -> backend `type`,
 * per-level assignment routes, pagination) and the response transform layer
 * (snake_case -> frontend model, `type` -> `name`, `sort_order` ->
 * `order_index`, recursive subphases with depth colours).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as client from '@/api/client';
import {
  archiveProject,
  createChildSubphase,
  createEquipmentAssignment,
  createPhase,
  createProject,
  createStaffAssignment,
  createSubphase,
  deleteEquipmentAssignment,
  deletePhase,
  deleteProject,
  deleteStaffAssignment,
  deleteSubphase,
  fetchAllProjects,
  getProject,
  transformFieldValues,
  getProjects,
  restoreProject,
  updateEquipmentAssignment,
  updatePhase,
  updateProject,
  updateStaffAssignment,
  updateSubphase,
} from '../projects';

vi.mock('@/api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  isWhatIfActive: vi.fn(() => false),
}));

const get = vi.mocked(client.apiGet);
const post = vi.mocked(client.apiPost);
const put = vi.mocked(client.apiPut);
const del = vi.mocked(client.apiDelete);

beforeEach(() => {
  for (const fn of [get, post, put, del]) fn.mockReset().mockResolvedValue({});
  document.documentElement.style.cssText = '';
});

describe('project CRUD', () => {
  it('reads every page of the paginated list', async () => {
    const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: from + i }));
    get
      .mockResolvedValueOnce({ items: page(200, 1), total: 250, offset: 0, limit: 200 })
      .mockResolvedValueOnce({ items: page(50, 201), total: 250, offset: 200, limit: 200 });
    const projects = await getProjects('true');
    expect(projects).toHaveLength(250);
    expect(get.mock.calls.map((c) => c[0])).toEqual([
      '/api/projects?archived=true&limit=200&offset=0',
      '/api/projects?archived=true&limit=200&offset=200',
    ]);
  });

  it('stops when the total is reached even on a full page', async () => {
    get.mockResolvedValueOnce({ items: Array.from({ length: 200 }, (_, i) => ({ id: i })), total: 200 });
    await getProjects();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toContain('archived=false');
  });

  it('routes single-project calls', async () => {
    await getProject(5);
    await createProject({ name: 'P', site_id: 1 } as never);
    await updateProject(5, { name: 'Q' } as never);
    await archiveProject(5);
    await restoreProject(5);
    await deleteProject(5);
    expect(get).toHaveBeenCalledWith('/api/projects/5');
    expect(post).toHaveBeenCalledWith('/api/projects', { name: 'P', site_id: 1 });
    expect(put.mock.calls).toEqual([
      ['/api/projects/5', { name: 'Q' }],
      ['/api/projects/5', { archived: true }],
      ['/api/projects/5', { archived: false }],
    ]);
    expect(del).toHaveBeenCalledWith('/api/projects/5');
  });
});

describe('phases and subphases', () => {
  it('createPhase sends the name as `type` and defaults is_milestone', async () => {
    await createPhase(1, { name: 'Design', start_date: '2026-01-01', end_date: '2026-01-31' } as never);
    expect(post).toHaveBeenCalledWith('/api/projects/1/phases', {
      type: 'Design',
      start_date: '2026-01-01',
      end_date: '2026-01-31',
      is_milestone: false,
    });
  });

  it('createPhase forwards optional order and dependencies', async () => {
    const dependencies = [{ id: 2, type: 'FS' }];
    await createPhase(1, {
      name: 'M',
      start_date: 'a',
      end_date: 'b',
      is_milestone: true,
      order_index: 3,
      dependencies,
    } as never);
    expect(post.mock.calls[0][1]).toEqual({
      type: 'M',
      start_date: 'a',
      end_date: 'b',
      is_milestone: true,
      order_index: 3,
      dependencies,
    });
  });

  it('updatePhase only sends the fields given, renaming name -> type', async () => {
    await updatePhase(7, {});
    expect(put).toHaveBeenLastCalledWith('/api/phases/7', {});
    await updatePhase(7, {
      name: 'N',
      start_date: 's',
      end_date: 'e',
      is_milestone: false,
      dependencies: [],
      completion: 30,
    } as never);
    expect(put).toHaveBeenLastCalledWith('/api/phases/7', {
      type: 'N',
      start_date: 's',
      end_date: 'e',
      is_milestone: false,
      dependencies: [],
      completion: 30,
    });
    await deletePhase(7);
    expect(del).toHaveBeenCalledWith('/api/phases/7');
  });

  it('creates subphases under a phase or another subphase with the project id', async () => {
    await createSubphase(3, 1, { name: 'S', start_date: 'a', end_date: 'b' } as never);
    expect(post).toHaveBeenLastCalledWith('/api/phases/3/subphases', {
      name: 'S',
      start_date: 'a',
      end_date: 'b',
      project_id: 1,
      is_milestone: false,
    });
    await createChildSubphase(9, 1, {
      name: 'C',
      start_date: 'a',
      end_date: 'b',
      is_milestone: true,
      order_index: 0,
      dependencies: [],
    } as never);
    expect(post).toHaveBeenLastCalledWith('/api/subphases/9/children', {
      name: 'C',
      start_date: 'a',
      end_date: 'b',
      project_id: 1,
      is_milestone: true,
      order_index: 0,
      dependencies: [],
    });
    await createSubphase(3, 1, { name: 'S2', start_date: 'a', end_date: 'b', order_index: 2, dependencies: [] } as never);
    expect(post.mock.calls[2][1]).toMatchObject({ order_index: 2, dependencies: [] });
    await createChildSubphase(9, 1, { name: 'C2', start_date: 'a', end_date: 'b' } as never);
    expect(post.mock.calls[3][1]).not.toHaveProperty('order_index');
  });

  it('updates and deletes subphases', async () => {
    await updateSubphase(4, { name: 'X' });
    await deleteSubphase(4);
    expect(put).toHaveBeenCalledWith('/api/subphases/4', { name: 'X' });
    expect(del).toHaveBeenCalledWith('/api/subphases/4');
  });
});

describe('assignments route by level', () => {
  it('creates staff assignments on the most specific level given', async () => {
    const base = { staff_id: 4, allocation: 50 } as never;
    await createStaffAssignment({ ...(base as object), subphase_id: 3, phase_id: 2 } as never);
    await createStaffAssignment({ ...(base as object), phase_id: 2, project_id: 1 } as never);
    await createStaffAssignment({ ...(base as object), project_id: 1 } as never);
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      '/api/subphases/3/staff',
      '/api/phases/2/staff',
      '/api/projects/1/staff',
    ]);
    await expect(createStaffAssignment(base)).rejects.toThrow('Must specify');
  });

  it('updates and deletes staff assignments on the per-level route', async () => {
    await updateStaffAssignment(5, { allocation: 20 });
    await updateStaffAssignment(5, { allocation: 20 }, 'phase');
    await updateStaffAssignment(5, { allocation: 20 }, 'subphase');
    expect(put.mock.calls.map((c) => c[0])).toEqual([
      '/api/assignments/5',
      '/api/phase-staff/5',
      '/api/subphase-staff/5',
    ]);
    await deleteStaffAssignment(5);
    await deleteStaffAssignment(5, 'phase');
    await deleteStaffAssignment(5, 'subphase');
    expect(del.mock.calls.map((c) => c[0])).toEqual([
      '/api/assignments/5',
      '/api/phase-staff/5',
      '/api/subphase-staff/5',
    ]);
  });

  it('books equipment on the project only, whatever row it comes from', async () => {
    // Regression: phase / subphase rows used to post to /api/phases/{id}/equipment
    // and /api/subphases/{id}/equipment, which do not exist (404).
    const base = { equipment_id: 1, start_date: 'a', end_date: 'b' };
    await createEquipmentAssignment({ ...base, project_id: 1 });
    await createEquipmentAssignment({ ...base, project_id: 4, note: 'Bring the column' });
    // Ids a caller still passes along are never sent, nor do they pick the route.
    await createEquipmentAssignment({ ...base, project_id: 5, phase_id: 2, subphase_id: 3 } as never);
    expect(post.mock.calls).toEqual([
      ['/api/projects/1/equipment', base],
      ['/api/projects/4/equipment', { ...base, note: 'Bring the column' }],
      ['/api/projects/5/equipment', base],
    ]);
  });

  it('updates and deletes equipment assignments', async () => {
    await updateEquipmentAssignment(8, { end_date: 'c' } as never);
    await deleteEquipmentAssignment(8);
    expect(put).toHaveBeenCalledWith('/api/equipment-assignments/8', { end_date: 'c' });
    expect(del).toHaveBeenCalledWith('/api/equipment-assignments/8');
  });
});

describe('transformFieldValues', () => {
  it('turns the JSON string keys into field ids and keeps every value shape', () => {
    expect(transformFieldValues({ '1': 'Pilot plant', '2': 1250, '3': false, '4': 42, '5': [51, 52] })).toEqual({
      1: 'Pilot plant',
      2: 1250,
      3: false,
      4: 42,
      5: [51, 52],
    });
  });

  it('drops keys that are not field ids and reads anything else as no values', () => {
    expect(transformFieldValues({ x: 1, '0': 2, '-3': 3, '1.5': 4, '7': 'ok' })).toEqual({ 7: 'ok' });
    expect(transformFieldValues(undefined)).toEqual({});
    expect(transformFieldValues(null)).toEqual({});
    expect(transformFieldValues([1, 2])).toEqual({});
    expect(transformFieldValues('nope')).toEqual({});
  });

  it('is applied by fetchAllProjects (absent = {})', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/projects?')) return { items: [{ id: 1 }, { id: 2 }], total: 2 };
      return url.endsWith('/1')
        ? { id: 1, name: 'A', site_id: 1, field_values: { '3': [7] } }
        : { id: 2, name: 'B', site_id: 1 };
    });
    const projects = await fetchAllProjects();
    expect(projects.map((p) => p.field_values)).toEqual([{ 3: [7] }, {}]);
  });
});

describe('fetchAllProjects transform layer', () => {
  it('returns [] without fetching details when there are no projects', async () => {
    get.mockResolvedValueOnce({ items: [], total: 0 });
    await expect(fetchAllProjects()).resolves.toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('maps the backend tree to the frontend model', async () => {
    document.documentElement.style.setProperty('--level-phase', '#aa0000');
    document.documentElement.style.setProperty('--level-2', '#00bb00');
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/projects?')) return { items: [{ id: 1 }], total: 1 };
      return {
        id: 1,
        name: 'P',
        site_id: 1,
        staff_assignments: [
          { id: 1, staff_id: 4, allocation_percent: 40, start_date: 'a', end_date: 'b' },
          {
            id: 2,
            staff_id: 8,
            allocation: 60,
            start_date: 'a',
            end_date: 'b',
            approval_status: 'pending',
            approval: {
              request_id: 31,
              action: 'assignments.self_create',
              requester_id: 8,
              requested: { allocation: 60, start_date: 'a', end_date: 'b' },
              previous: null,
              created_at: '2026-10-20T08:00:00.000Z',
              can_decide: true,
            },
          },
        ],
        equipment_assignments: [{ id: 2, equipment_id: 9, equipment_name: 'Reactor', start_date: 'a', end_date: 'b' }],
        phases: [
          {
            id: 10,
            project_id: 1,
            type: 'Design',
            start_date: '2026-01-01',
            end_date: '2026-02-01',
            sort_order: 2,
            is_milestone: 1,
            completion: 50,
            status: 'in_progress',
            dependencies: [{ id: 9, type: 'FS' }],
            staffAssignments: [{ id: 3, staff_id: 5 }],
            subphases: [
              {
                id: 20,
                project_id: 1,
                parent_type: 'phase',
                parent_id: 10,
                name: 'Child',
                start_date: '2026-01-01',
                end_date: '2026-01-10',
                is_milestone: 0,
                equipmentAssignments: [{ id: 4, equipment_id: 9, note: 'Bring the column' }],
                children: [
                  {
                    id: 21,
                    project_id: 1,
                    parent_type: 'subphase',
                    parent_id: 20,
                    name: 'Grandchild',
                    start_date: '2026-01-02',
                    end_date: '2026-01-03',
                    sort_order: 1,
                    staff_assignments: [{ id: 5, staff_id: 6, allocation: 10 }],
                  },
                ],
              },
            ],
          },
          { id: 11, project_id: 1, name: 'Fallback name', start_date: 'a', end_date: 'b' },
          { id: 12, project_id: 1, start_date: 'a', end_date: 'b' },
        ],
      };
    });

    const [project] = await fetchAllProjects();
    expect(get).toHaveBeenCalledWith('/api/projects/1');

    expect(project.staffAssignments).toEqual([
      expect.objectContaining({ id: 1, staff_id: 4, allocation: 40, approval_status: 'approved', approval: null }),
      expect.objectContaining({
        id: 2,
        approval_status: 'pending',
        approval: {
          request_id: 31,
          action: 'assignments.self_create',
          requester_id: 8,
          requested: { allocation: 60, start_date: 'a', end_date: 'b' },
          previous: null,
          created_at: '2026-10-20T08:00:00.000Z',
          can_decide: true,
        },
      }),
    ]);
    expect(project.equipmentAssignments[0]).toMatchObject({ equipment_id: 9, equipment_name: 'Reactor' });
    // No note sent (an older server): null, never undefined.
    expect(project.equipmentAssignments[0].note).toBeNull();

    const [design, fallback, unnamed] = project.phases;
    expect(design).toMatchObject({
      name: 'Design',
      order_index: 2,
      is_milestone: true,
      completion: 50,
      status: 'in_progress',
      color: '#aa0000',
      dependencies: [{ id: 9, type: 'FS' }],
    });
    // Missing allocation defaults to 100 %.
    expect(design.staffAssignments[0].allocation).toBe(100);
    expect(fallback).toMatchObject({ name: 'Fallback name', order_index: 0, completion: null, status: 'todo' });
    expect(unnamed.name).toBe('Phase');
    expect(unnamed.children).toEqual([]);

    const child = design.children[0];
    expect(child).toMatchObject({
      name: 'Child',
      parent_phase_id: 10,
      parent_subphase_id: null,
      is_milestone: false,
      status: 'todo',
      color: '#05B6D4',
    });
    expect(child.equipmentAssignments[0].equipment_id).toBe(9);
    expect(child.equipmentAssignments[0].note).toBe('Bring the column');

    const grandchild = child.children[0];
    expect(grandchild).toMatchObject({
      name: 'Grandchild',
      parent_phase_id: null,
      parent_subphase_id: 20,
      order_index: 1,
      color: '#00bb00',
    });
    expect(grandchild.staffAssignments[0].allocation).toBe(10);
  });

  it('maps the booking dates and linked flag of card rows (older servers: linked, the card dates)', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/projects?')) return { items: [{ id: 1 }], total: 1 };
      return {
        id: 1,
        staff_assignments: [{ id: 1, staff_id: 4, allocation: 40, start_date: '2026-03-01', end_date: '2026-03-31', linked: false }],
        phases: [
          {
            id: 10,
            start_date: '2026-03-02T00:00:00.000Z',
            end_date: '2026-03-13T00:00:00.000Z',
            staff_assignments: [
              { id: 3, staff_id: 5, allocation: 50, start_date: '2026-03-03T00:00:00.000Z', end_date: '2026-03-05T00:00:00.000Z', linked: false },
              { id: 4, staff_id: 6, allocation: 50, start_date: '2026-03-02T00:00:00.000Z', end_date: '2026-03-13T00:00:00.000Z', linked: true },
              // A server before 1.17.0: no dates, no flag
              { id: 5, staff_id: 7, allocation: 50 },
            ],
            subphases: [
              {
                id: 20,
                parent_type: 'phase',
                parent_id: 10,
                name: 'S',
                start_date: '2026-03-02',
                end_date: '2026-03-06',
                staff_assignments: [{ id: 6, staff_id: 5, allocation: 20, start_date: '2026-03-04', end_date: '2026-03-04', linked: false }],
              },
            ],
          },
        ],
      };
    });
    const [project] = await fetchAllProjects();
    expect(project.staffAssignments[0].linked).toBe(false);
    const [segment, linked, legacy] = project.phases[0].staffAssignments;
    expect(segment).toMatchObject({ linked: false, start_date: '2026-03-03T00:00:00.000Z', end_date: '2026-03-05T00:00:00.000Z' });
    expect(linked.linked).toBe(true);
    expect(legacy).toMatchObject({ linked: true, start_date: '2026-03-02T00:00:00.000Z', end_date: '2026-03-13T00:00:00.000Z' });
    expect(project.phases[0].children[0].staffAssignments[0]).toMatchObject({ linked: false, start_date: '2026-03-04' });
  });

  it('uses an explicit subphase depth for its colour', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/projects?')) return { items: [{ id: 1 }], total: 1 };
      return {
        id: 1,
        phases: [
          {
            id: 1,
            children: [{ id: 2, parent_type: 'phase', parent_id: 1, name: 'D', depth: 3 }],
          },
        ],
      };
    });
    const [project] = await fetchAllProjects();
    expect(project.phases[0].children[0].color).toBe('#3B82F6');
    expect(project.staffAssignments).toEqual([]);
  });
});
