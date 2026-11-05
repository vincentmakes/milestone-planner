import { describe, expect, it } from 'vitest';
import {
  actionLabel,
  categoryLabel,
  entityLabel,
  originLabel,
  outcomeLabel,
  reasonLabel,
} from '../auditLabels';

describe('actionLabel', () => {
  it('reads the sign-in keys with their exact labels', () => {
    expect(actionLabel('auth.login.succeeded')).toBe('Sign-in succeeded');
    expect(actionLabel('auth.login.failed')).toBe('Sign-in failed');
    expect(actionLabel('auth.login.locked')).toBe('Account locked after failed sign-ins');
    expect(actionLabel('auth.logout')).toBe('Signed out');
    expect(actionLabel('auth.sso.succeeded')).toBe('SSO sign-in succeeded');
    expect(actionLabel('auth.sso.failed')).toBe('SSO sign-in failed');
    expect(actionLabel('auth.password.changed')).toBe('Password changed');
  });

  it('reads the export keys', () => {
    expect(actionLabel('access.audit_log.exported')).toBe('Audit log exported');
    expect(actionLabel('access.export.site')).toBe('Site exported');
    expect(actionLabel('access.export.msproject')).toBe('MS Project exported');
    expect(actionLabel('access.export.csv')).toBe('CSV exported');
  });

  it('builds "{Entity} {verb}" for admin.<entity>.<verb> and <entity>.<verb>', () => {
    expect(actionLabel('admin.user.updated')).toBe('User updated');
    expect(actionLabel('admin.role.permissions_updated')).toBe('Role permissions updated');
    expect(actionLabel('admin.user.password_set')).toBe('User password set');
    expect(actionLabel('admin.approval_policy.updated')).toBe('Approval policy updated');
    expect(actionLabel('admin.predefined_phase.created')).toBe('Phase template created');
    expect(actionLabel('admin.sso.tested')).toBe('SSO tested');
    expect(actionLabel('project.created')).toBe('Project created');
    expect(actionLabel('staff_assignment.deleted')).toBe('Booking deleted');
    expect(actionLabel('equipment_assignment.updated')).toBe('Equipment booking updated');
    expect(actionLabel('card_comment.created')).toBe('Comment created');
    expect(actionLabel('vacation.updated')).toBe('Absence updated');
    expect(actionLabel('dashboard.deleted')).toBe('Dashboard deleted');
  });

  it('shows any other shape as recorded', () => {
    expect(actionLabel('auth.something.new')).toBe('auth.something.new');
    expect(actionLabel('access.export.pdf')).toBe('access.export.pdf');
    expect(actionLabel('admin.user')).toBe('admin.user');
    expect(actionLabel('auth.unknown')).toBe('auth.unknown');
    expect(actionLabel('project')).toBe('project');
    expect(actionLabel('a.b.c.d')).toBe('a.b.c.d');
    expect(actionLabel('Project.Created')).toBe('Project.Created');
    expect(actionLabel('')).toBe('');
  });
});

describe('entityLabel', () => {
  it('maps the known entities and capitalises the rest', () => {
    expect(entityLabel('staff_assignment')).toBe('Booking');
    expect(entityLabel('bank_holiday')).toBe('Bank holiday');
    expect(entityLabel('company_event')).toBe('Company event');
    expect(entityLabel('equipment_block')).toBe('Equipment block');
    expect(entityLabel('custom_column')).toBe('Custom column');
    expect(entityLabel('project_field')).toBe('Project field');
    expect(entityLabel('absence_type')).toBe('Absence type');
    expect(entityLabel('approval_request')).toBe('Approval request');
    expect(entityLabel('audit_log')).toBe('Audit log');
    expect(entityLabel('subphase')).toBe('Subphase');
    expect(entityLabel('equipment_type')).toBe('Equipment type');
  });
});

describe('reasonLabel', () => {
  it('reads the sign-in reasons', () => {
    expect(reasonLabel('bad_password')).toBe('Wrong password');
    expect(reasonLabel('unknown_user')).toBe('No account with this email');
    expect(reasonLabel('throttled')).toBe('Account temporarily locked');
    expect(reasonLabel('inactive')).toBe('Account disabled');
  });

  it('reads the SSO reasons', () => {
    expect(reasonLabel('config_missing')).toBe('SSO is not configured');
    expect(reasonLabel('exchange_failed')).toBe('The identity provider did not complete the sign-in');
    expect(reasonLabel('graph_failed')).toBe('The Microsoft Graph lookup failed');
    expect(reasonLabel('group_denied')).toBe('Not a member of an allowed group');
    expect(reasonLabel('no_email')).toBe('Identity provider returned no email');
    expect(reasonLabel('no_account')).toBe('No account exists and accounts are not created automatically');
    expect(reasonLabel('client_secret')).toBe('The client secret check failed');
    expect(reasonLabel('rejected')).toBe('The credentials were rejected');
  });

  it('shows an unknown code as recorded', () => {
    expect(reasonLabel('cosmic_ray')).toBe('cosmic_ray');
  });
});

describe('category, outcome and origin labels', () => {
  it('reads the known values and keeps the rest', () => {
    expect(categoryLabel('auth')).toBe('Authentication');
    expect(categoryLabel('admin')).toBe('Administration');
    expect(categoryLabel('access')).toBe('Data access');
    expect(categoryLabel('change')).toBe('Changes');
    expect(categoryLabel('other')).toBe('other');
    expect(outcomeLabel('success')).toBe('Success');
    expect(outcomeLabel('failure')).toBe('Failure');
    expect(outcomeLabel('partial')).toBe('partial');
    expect(originLabel('web')).toBe('Web');
    expect(originLabel('system')).toBe('System');
    expect(originLabel('cli')).toBe('cli');
  });
});
