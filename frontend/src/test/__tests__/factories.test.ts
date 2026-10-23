/**
 * The shared factories return complete objects and let overrides win.
 */
import { describe, it, expect } from 'vitest';
import {
  makeApprovalRequest,
  makeCustomColumn,
  makeEquipment,
  makePhase,
  makeProject,
  makeSite,
  makeStaff,
  makeSubphase,
  makeTag,
  makeUser,
  makeVacation,
} from '../factories';

describe('test factories', () => {
  it.each([
    ['makeSite', makeSite],
    ['makeUser', makeUser],
    ['makeStaff', makeStaff],
    ['makeEquipment', makeEquipment],
    ['makeProject', makeProject],
    ['makePhase', makePhase],
    ['makeSubphase', makeSubphase],
    ['makeVacation', makeVacation],
    ['makeTag', makeTag],
    ['makeCustomColumn', makeCustomColumn],
    ['makeApprovalRequest', makeApprovalRequest],
  ] as const)('%s applies an override and keeps the other defaults', (_name, factory) => {
    const base = factory();
    const made = factory({ id: 42 });
    expect(made.id).toBe(42);
    expect({ ...made, id: base.id }).toEqual(base);
  });

  it('returns a fresh object (and fresh arrays) on every call', () => {
    const a = makeProject();
    const b = makeProject();
    expect(a).not.toBe(b);
    a.phases.push(makePhase());
    expect(b.phases).toEqual([]);
  });

  it('builds a project tree from nested overrides', () => {
    const sub = makeSubphase({ id: 7, parent_phase_id: 3, status: 'done', completion: 100 });
    const phase = makePhase({ id: 3, children: [sub] });
    const project = makeProject({ id: 9, name: 'Catalyst Optimization', phases: [phase] });

    expect(project.name).toBe('Catalyst Optimization');
    expect(project.phases[0].children[0]).toMatchObject({ id: 7, parent_phase_id: 3, status: 'done' });
  });

  it('accepts overrides that set nullable fields', () => {
    expect(makeUser({ role: 'user', site_ids: [] })).toMatchObject({ role: 'user', site_ids: [] });
    expect(makeCustomColumn({ column_type: 'text', list_options: null }).list_options).toBeNull();
    expect(makeTag({ all_sites: false, site_ids: [2] })).toMatchObject({ all_sites: false, site_ids: [2] });
    expect(makeVacation({ absence_type_id: 3 }).absence_type_id).toBe(3);
    expect(makeSite({ name: 'Zurich' }).name).toBe('Zurich');
    expect(makeEquipment({ type: 'HPLC' }).type).toBe('HPLC');
    expect(makeStaff({ max_capacity: 80 }).max_capacity).toBe(80);
  });

  it('makeUser derives the role\'s default permissions unless given', () => {
    const admin = makeUser();
    expect(admin.permissions).toContain('roles.manage');
    expect(admin).toMatchObject({ role_name: 'Admin', can_see_all_sites: true, approval_required: [] });

    const superuser = makeUser({ role: 'superuser' });
    expect(superuser.permissions).toEqual(expect.arrayContaining(['projects.delete', 'whatif.use']));
    expect(superuser.permissions).not.toContain('sites.manage');
    expect(superuser).toMatchObject({ role_name: 'Superuser', can_see_all_sites: false });

    const user = makeUser({ role: 'user' });
    expect(user.permissions).toEqual(expect.arrayContaining(['projects.manage_as_pm', 'views.kanban']));
    expect(user.permissions).not.toContain('projects.edit_any');

    expect(makeUser({ role: 'team_lead' })).toMatchObject({ role_name: 'team_lead', permissions: [] });
    expect(makeUser({ role: 'user', permissions: ['sites.view_all'] })).toMatchObject({
      permissions: ['sites.view_all'],
      can_see_all_sites: true,
    });
  });
});
