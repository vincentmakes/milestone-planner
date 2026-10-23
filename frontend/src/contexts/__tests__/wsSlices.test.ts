/**
 * The change:<entity> → refetch-slice mapping that drives WebSocket refreshes.
 * Unknown entities refresh everything, so new backend entities need no client
 * change; entities with their own fetches refresh nothing.
 */
import { describe, it, expect } from 'vitest';
import { ALL_SLICES, DASHBOARD_DATA_SLICES, WHAT_IF_SANDBOXED_SLICES, slicesForEntity } from '../wsSlices';

describe('slicesForEntity', () => {
  it.each([
    ['project', ['projects']],
    ['phase', ['projects']],
    ['subphase', ['projects']],
    ['assignment', ['projects']],
    ['staff_assignment', ['projects']],
    ['equipment_assignment', ['projects']],
    ['predefined_phase', ['projects']],
    ['note', []],
    ['card_comment', []],
    ['settings', ['settings', 'currentUser']],
    ['custom_column', ['customColumns']],
    ['custom_column_value', ['customColumns']],
    ['bank_holiday', ['siteCalendar']],
    ['company_event', ['siteCalendar']],
    ['absence_type', ['absenceTypes', 'vacations']],
    ['staff', ['staff', 'projects']],
    // A role change also changes which dashboards the user may see
    ['user', ['staff', 'currentUser', 'projects', 'teams', 'roles', 'dashboards']],
    ['equipment', ['equipment', 'projects']],
    ['equipment_block', ['equipmentBlocks']],
    ['vacation', ['vacations']],
    // A delete can take away a user's only site: their record and the staff rows reload.
    ['site', ['sites', 'siteCalendar', 'projects', 'tags', 'projectFields', 'equipment', 'teams', 'currentUser', 'staff']],
    ['skill', ['skills', 'staff']],
    ['tag', ['tags', 'projects']],
    // Fields and items: a delete removes project values, so the tree reloads
    ['project_field', ['projectFields', 'projects']],
    ['team', ['teams', 'staff', 'projects', 'tags', 'projectFields', 'equipment', 'siteCalendar']],
    // RBAC: a role edit changes the signed-in user's permissions (/auth/me)
    // and the role list of Settings → Roles and the role pickers
    ['role', ['currentUser', 'roles']],
    // A policy edit changes the approver names on pending badges and who may
    // decide; a decision (approval_request) does not touch the policies.
    // approval_required comes from the role's modes (change:role), not the
    // policy, so /auth/me is not reloaded.
    ['approval_policy', ['approvalPolicies', 'approvals']],
    ['approval_request', ['projects', 'approvals']],
    // Every /api/dashboards write; /query and /data never broadcast
    ['dashboard', ['dashboards']],
  ])('%s → %j', (entity, slices) => {
    expect(slicesForEntity(entity)).toEqual(slices);
  });

  it('refreshes every slice for an unknown entity', () => {
    expect(slicesForEntity('brand_new_thing')).toBe(ALL_SLICES);
    expect(new Set(ALL_SLICES).size).toBe(19);
    expect(ALL_SLICES).toEqual(
      expect.arrayContaining(['approvals', 'approvalPolicies', 'roles', 'projectFields', 'dashboards'])
    );
    expect(ALL_SLICES).not.toContain('todos');
  });

  it('reloads the open dashboard data for the plan slices only', () => {
    expect([...DASHBOARD_DATA_SLICES].sort()).toEqual(['projectFields', 'projects', 'staff', 'teams']);
  });

  it('sandboxes only the What-If plan slices', () => {
    expect([...WHAT_IF_SANDBOXED_SLICES].sort()).toEqual(['customColumns', 'projects']);
  });
});
