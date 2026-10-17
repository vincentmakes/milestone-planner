/**
 * The per-project permission rules, as the frontend applies them. They mirror
 * app/services/project_access.py: a project manager edits their own project
 * (but may not delete it), anyone edits assignments that book their own time,
 * and admins/superusers are unchanged.
 */

import { describe, it, expect } from 'vitest';
import {
  isPrivileged,
  isSelf,
  canEditProject,
  canEditProjectById,
  canEditAssignment,
  canManageAnyProject,
} from '../permissions';

const admin = { id: 1, role: 'admin' as const };
const superuser = { id: 2, role: 'superuser' as const };
const pm = { id: 3, role: 'user' as const };
const user = { id: 4, role: 'user' as const };

const managed = { id: 10, pm_id: 3 };
const other = { id: 11, pm_id: 9 };
const unmanaged = { id: 12, pm_id: null };

describe('isPrivileged', () => {
  it('is true for admins and superusers only', () => {
    expect(isPrivileged(admin)).toBe(true);
    expect(isPrivileged(superuser)).toBe(true);
    expect(isPrivileged(pm)).toBe(false);
    expect(isPrivileged(null)).toBe(false);
    expect(isPrivileged(undefined)).toBe(false);
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
  it('lets privileged users edit any project, even one without a manager', () => {
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

  it('never treats a null pm_id as a match', () => {
    // A user object with no id would otherwise compare null === null.
    expect(canEditProject({ id: null as unknown as number, role: 'user' }, unmanaged)).toBe(false);
  });
});

describe('canEditProjectById', () => {
  const projects = [managed, other, unmanaged];

  it('finds the project by id', () => {
    expect(canEditProjectById(pm, projects, 10)).toBe(true);
    expect(canEditProjectById(pm, projects, 11)).toBe(false);
  });

  it('refuses unknown or missing ids for plain users but not for privileged ones', () => {
    expect(canEditProjectById(pm, projects, 99)).toBe(false);
    expect(canEditProjectById(pm, projects, undefined)).toBe(false);
    expect(canEditProjectById(admin, [], 99)).toBe(true);
    expect(canEditProjectById(null, projects, 10)).toBe(false);
  });
});

describe('canEditAssignment', () => {
  it('lets project editors touch anyone and everyone touch themselves', () => {
    expect(canEditAssignment(pm, managed, 4)).toBe(true);
    expect(canEditAssignment(user, managed, 4)).toBe(true);
    expect(canEditAssignment(user, managed, 3)).toBe(false);
    expect(canEditAssignment(admin, other, 4)).toBe(true);
  });

  it('still allows the own row when the project is unknown', () => {
    expect(canEditAssignment(user, null, 4)).toBe(true);
    expect(canEditAssignment(user, null, 5)).toBe(false);
    expect(canEditAssignment(null, managed, 4)).toBe(false);
  });
});

describe('canManageAnyProject', () => {
  it('is true for privileged users regardless of the list', () => {
    expect(canManageAnyProject(admin, [])).toBe(true);
    expect(canManageAnyProject(superuser, null)).toBe(true);
  });

  it('is true for a user who manages at least one listed project', () => {
    expect(canManageAnyProject(pm, [other, managed])).toBe(true);
    expect(canManageAnyProject(pm, [other, unmanaged])).toBe(false);
    expect(canManageAnyProject(user, [managed])).toBe(false);
    expect(canManageAnyProject(pm, [])).toBe(false);
    expect(canManageAnyProject(null, [managed])).toBe(false);
  });
});
