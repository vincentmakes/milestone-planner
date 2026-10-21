/**
 * Role helpers: the client mirror of the escalation guard
 * (app/services/user_access.py `role_within`), the key derived from a new
 * role's name, and matrix equality for dirty checks.
 */
import { describe, it, expect } from 'vitest';
import { confirmRoleDelete, matrixEquals, roleKeyFromName, roleWithin } from '../roles';
import { stubConfirm } from '@/test/confirmDialog';
import { makeRole, makeSystemRoles, makeUser } from '@/test/factories';

const [admin, superuser, user] = makeSystemRoles();

describe('roleWithin', () => {
  it('lets an administrator assign every role', () => {
    const me = makeUser({ role: 'admin' });
    for (const role of [admin, superuser, user]) expect(roleWithin(role, me)).toBe(true);
  });

  it('never offers the admin role to anyone else', () => {
    expect(roleWithin(admin, makeUser({ role: 'superuser' }))).toBe(false);
  });

  it('needs every allowed key of the role held outright', () => {
    const me = makeUser({ role: 'superuser' });
    expect(roleWithin(user, me)).toBe(true);
    expect(roleWithin(superuser, me)).toBe(true);
    const sso = makeRole({ permissions: { 'projects.view': 'allow', 'settings.sso': 'allow' } });
    expect(roleWithin(sso, me)).toBe(false);
    expect(roleWithin(superuser, makeUser({ role: 'user' }))).toBe(false);
  });

  it('accepts an approval-mode key held in either mode', () => {
    const approvalRole = makeRole({ permissions: { 'assignments.self_create': 'approval' } });
    const allowRole = makeRole({ permissions: { 'assignments.self_create': 'allow' } });
    const viaApproval = makeUser({
      role: 'x',
      permissions: ['users.change_role'],
      approval_required: ['assignments.self_create'],
    });
    expect(roleWithin(approvalRole, viaApproval)).toBe(true);
    // An allow needs an allow
    expect(roleWithin(allowRole, viaApproval)).toBe(false);
  });

  it('is false without a user', () => {
    expect(roleWithin(user, null)).toBe(false);
  });
});

describe('roleKeyFromName', () => {
  it('slugs the name into the server key pattern', () => {
    expect(roleKeyFromName('Team lead', [])).toBe('team_lead');
    expect(roleKeyFromName('  QA / Reviewer! ', [])).toBe('qa_reviewer');
    expect(roleKeyFromName('Über-Planer', [])).toBe('uber_planer');
  });

  it('starts with a letter and has at least two characters', () => {
    expect(roleKeyFromName('2nd line', [])).toBe('role_2nd_line');
    expect(roleKeyFromName('X', [])).toBe('x_role');
    expect(roleKeyFromName('!!!', [])).toBe('role');
  });

  it('keeps to 20 characters', () => {
    const key = roleKeyFromName('Senior laboratory operations planner', []);
    expect(key).toBe('senior_laboratory_op');
    expect(key).toMatch(/^[a-z][a-z0-9_]{1,19}$/);
  });

  it('adds a number while the key is taken', () => {
    expect(roleKeyFromName('User', ['admin', 'superuser', 'user'])).toBe('user_2');
    expect(roleKeyFromName('User', ['user', 'user_2'])).toBe('user_3');
    const long = roleKeyFromName('Senior laboratory operations planner', ['senior_laboratory_op']);
    expect(long).toBe('senior_laboratory_2');
    expect(long).toMatch(/^[a-z][a-z0-9_]{1,19}$/);
  });
});

describe('matrixEquals', () => {
  it('compares modes key by key, ignoring order', () => {
    expect(matrixEquals({ a: 'allow', b: 'approval' }, { b: 'approval', a: 'allow' })).toBe(true);
    expect(matrixEquals({ a: 'allow' }, { a: 'approval' })).toBe(false);
    expect(matrixEquals({ a: 'allow' }, { a: 'allow', b: 'allow' })).toBe(false);
    expect(matrixEquals({}, {})).toBe(true);
  });
});

describe('confirmRoleDelete', () => {
  it('asks a destructive confirmation naming the role', async () => {
    const confirm = stubConfirm(false);
    await expect(confirmRoleDelete(makeRole({ name: 'QA' }))).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledWith({
      title: 'Delete role',
      message: 'Delete role "QA"? Users holding it must be moved to another role first. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
  });
});
