/**
 * The client's permission rules: `can()` mirrors PermissionSet.can of
 * app/services/permissions.py (allowed key, or the project-manager bundle on
 * a project the user manages), and the per-project wrappers keep the shapes
 * their call sites use.
 */

import { describe, it, expect } from 'vitest';
import {
  can,
  canSelf,
  needsApproval,
  isSelf,
  canEditProject,
  canEditProjectById,
  canEditAssignment,
  canManageAnyProject,
  canBookEquipment,
  canBookEquipmentById,
  canBookEquipmentOnAny,
  canBookSelf,
  isBookable,
} from '../permissions';
import { makeUser } from '@/test/factories';

const admin = makeUser({ id: 1, role: 'admin' });
const superuser = makeUser({ id: 2, role: 'superuser' });
const pm = makeUser({ id: 3, role: 'user' });
const user = makeUser({ id: 4, role: 'user' });
/** A custom role without the project-manager key and without self bookings */
const viewer = makeUser({ id: 3, role: 'viewer', permissions: ['projects.view'] });

const managed = { id: 10, pm_id: 3 };
const other = { id: 11, pm_id: 9 };
const unmanaged = { id: 12, pm_id: null };

describe('can', () => {
  it('reads the allowed keys, not the role name', () => {
    expect(can(admin, 'roles.manage')).toBe(true);
    expect(can(superuser, 'projects.delete')).toBe(true);
    expect(can(superuser, 'sites.manage')).toBe(false);
    expect(can(makeUser({ role: 'admin', permissions: [] }), 'projects.delete')).toBe(false);
    expect(can(makeUser({ role: 'custom', permissions: ['sites.manage'] }), 'sites.manage')).toBe(true);
  });

  it('grants the project-manager bundle on managed projects only', () => {
    expect(can(pm, 'projects.edit_any', managed)).toBe(true);
    expect(can(pm, 'assignments.manage_others', managed)).toBe(true);
    expect(can(pm, 'projects.edit_any', other)).toBe(false);
    expect(can(pm, 'projects.edit_any', unmanaged)).toBe(false);
    expect(can(pm, 'projects.edit_any')).toBe(false);
    // Never delete, create, import or export through the bundle
    expect(can(pm, 'projects.delete', managed)).toBe(false);
    expect(can(pm, 'projects.export', managed)).toBe(false);
  });

  it('needs projects.manage_as_pm for the bundle', () => {
    expect(can(viewer, 'projects.edit_any', managed)).toBe(false);
  });

  it('is false for a missing user or a user without a permission list', () => {
    expect(can(null, 'projects.view')).toBe(false);
    expect(can(undefined, 'projects.view')).toBe(false);
    expect(can({ id: 1 }, 'projects.view')).toBe(false);
  });
});

describe('needsApproval / canSelf', () => {
  const requester = makeUser({
    id: 5,
    role: 'user',
    permissions: ['projects.view', 'assignments.self_update'],
    approval_required: ['assignments.self_create'],
  });

  it('tells approval mode apart from allow and deny', () => {
    expect(needsApproval(requester, 'assignments.self_create')).toBe(true);
    expect(needsApproval(requester, 'assignments.self_update')).toBe(false);
    expect(needsApproval(null, 'assignments.self_create')).toBe(false);
    expect(needsApproval({ id: 5 }, 'assignments.self_create')).toBe(false);
  });

  it('lets an own booking through in allow or approval mode', () => {
    expect(canSelf(requester, 'assignments.self_create')).toBe(true);
    expect(canSelf(requester, 'assignments.self_update')).toBe(true);
    expect(canSelf(requester, 'assignments.self_remove')).toBe(false);
    expect(canSelf(null, 'assignments.self_create')).toBe(false);
  });
});

describe('isSelf', () => {
  it('matches the user id and nothing else', () => {
    expect(isSelf(user, 4)).toBe(true);
    expect(isSelf(user, 3)).toBe(false);
    expect(isSelf(user, null)).toBe(false);
    expect(isSelf(user, undefined)).toBe(false);
    expect(isSelf(null, 4)).toBe(false);
  });
});

describe('canEditProject', () => {
  it('lets holders of projects.edit_any edit any project, even one without a manager', () => {
    expect(canEditProject(admin, other)).toBe(true);
    expect(canEditProject(superuser, unmanaged)).toBe(true);
    expect(canEditProject(admin, null)).toBe(true);
  });

  it('lets the project manager edit their own project only', () => {
    expect(canEditProject(pm, managed)).toBe(true);
    expect(canEditProject(pm, other)).toBe(false);
    expect(canEditProject(pm, unmanaged)).toBe(false);
  });

  it('refuses plain users, missing users and missing projects', () => {
    expect(canEditProject(user, managed)).toBe(false);
    expect(canEditProject(null, managed)).toBe(false);
    expect(canEditProject(pm, null)).toBe(false);
    expect(canEditProject(pm, undefined)).toBe(false);
  });
});

describe('canEditProjectById', () => {
  const projects = [managed, other, unmanaged];

  it('resolves the project from the id', () => {
    expect(canEditProjectById(pm, projects, 10)).toBe(true);
    expect(canEditProjectById(pm, projects, 11)).toBe(false);
    expect(canEditProjectById(pm, projects, 999)).toBe(false);
  });

  it('lets project editors through without a lookup, refuses missing ids and users', () => {
    expect(canEditProjectById(superuser, [], 999)).toBe(true);
    expect(canEditProjectById(pm, projects, null)).toBe(false);
    expect(canEditProjectById(pm, projects, undefined)).toBe(false);
    expect(canEditProjectById(null, projects, 10)).toBe(false);
  });
});

describe('canEditAssignment', () => {
  it('lets anyone who manages others\' bookings touch any assignment on the project', () => {
    expect(canEditAssignment(superuser, other, 99)).toBe(true);
    expect(canEditAssignment(pm, managed, 99)).toBe(true);
  });

  it('lets a user touch their own assignment, but not someone else\'s', () => {
    expect(canEditAssignment(user, other, 4)).toBe(true);
    expect(canEditAssignment(user, other, 5)).toBe(false);
    expect(canEditAssignment(null, other, 4)).toBe(false);
  });

  it('follows the own-booking key: allow or approval mode, never deny', () => {
    const pending = makeUser({ id: 4, role: 'user', permissions: ['projects.view'], approval_required: ['assignments.self_update'] });
    expect(canEditAssignment(pending, other, 4)).toBe(true);
    expect(canEditAssignment(pending, other, 4, 'assignments.self_create')).toBe(false);
    expect(canEditAssignment(viewer, other, 3)).toBe(false);
  });
});

describe('canManageAnyProject', () => {
  it('is true for project editors and for anyone managing at least one project', () => {
    expect(canManageAnyProject(admin, [])).toBe(true);
    expect(canManageAnyProject(superuser, null)).toBe(true);
    expect(canManageAnyProject(pm, [other, managed])).toBe(true);
  });

  it('is false for users who manage nothing', () => {
    expect(canManageAnyProject(user, [managed, other, unmanaged])).toBe(false);
    expect(canManageAnyProject(pm, [])).toBe(false);
    expect(canManageAnyProject(pm, undefined)).toBe(false);
    expect(canManageAnyProject(null, [managed])).toBe(false);
  });
});

describe('equipment bookings (equipment_bookings.manage)', () => {
  /** Books equipment anywhere but cannot edit projects */
  const booker = makeUser({ id: 20, role: 'booker', permissions: ['projects.view', 'equipment_bookings.manage'] });
  /** Edits projects but may not book equipment */
  const editor = makeUser({ id: 21, role: 'editor', permissions: ['projects.view', 'projects.edit_any'] });

  it('follows the booking key, not projects.edit_any', () => {
    expect(canBookEquipment(booker, other)).toBe(true);
    expect(canEditProject(booker, other)).toBe(false);
    expect(canBookEquipment(editor, other)).toBe(false);
    expect(canEditProject(editor, other)).toBe(true);
  });

  it('grants it to the project manager through the bundle', () => {
    expect(canBookEquipment(pm, managed)).toBe(true);
    expect(canBookEquipment(pm, other)).toBe(false);
    expect(canBookEquipment(null, managed)).toBe(false);
  });

  it('resolves a project id', () => {
    const projects = [managed, other];
    expect(canBookEquipmentById(booker, [], 999)).toBe(true);
    expect(canBookEquipmentById(editor, projects, 11)).toBe(false);
    expect(canBookEquipmentById(pm, projects, 10)).toBe(true);
    expect(canBookEquipmentById(pm, projects, 11)).toBe(false);
    expect(canBookEquipmentById(pm, projects, null)).toBe(false);
  });

  it('is true on any project for the key holder or a manager of one', () => {
    expect(canBookEquipmentOnAny(booker, [])).toBe(true);
    expect(canBookEquipmentOnAny(editor, [managed, other])).toBe(false);
    expect(canBookEquipmentOnAny(pm, [other, managed])).toBe(true);
    expect(canBookEquipmentOnAny(user, undefined)).toBe(false);
  });
});

describe('isBookable / canBookSelf', () => {
  it('reads the bookable flag, a missing flag counting as bookable', () => {
    expect(isBookable(makeUser({ id: 5, role: 'user', is_resource: true }))).toBe(true);
    expect(isBookable(makeUser({ id: 5, role: 'user', is_resource: false }))).toBe(false);
    expect(isBookable({ id: 5 })).toBe(true);
    expect(isBookable(null)).toBe(false);
    expect(isBookable(undefined)).toBe(false);
  });

  it('lets a bookable user book themself with assignments.self_create', () => {
    expect(canBookSelf(user, user.id)).toBe(true);
    expect(canBookSelf(user, admin.id)).toBe(false);
    expect(canBookSelf(viewer, viewer.id)).toBe(false);
    expect(canBookSelf(null, 4)).toBe(false);
  });

  it('refuses a user who is not bookable as a resource, even holding the key', () => {
    const notBookable = makeUser({ id: 6, role: 'user', is_resource: false });
    expect(canSelf(notBookable, 'assignments.self_create')).toBe(true);
    expect(canBookSelf(notBookable, notBookable.id)).toBe(false);
    // The administrator is not bookable by default, whatever its keys.
    expect(canBookSelf(admin, admin.id)).toBe(false);
    expect(canBookSelf(makeUser({ id: 1, role: 'admin', is_resource: true }), 1)).toBe(true);
  });
});
