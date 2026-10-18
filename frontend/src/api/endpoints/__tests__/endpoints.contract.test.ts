/**
 * Wire contract of the thin endpoint modules: each function hits the right
 * HTTP method + URL with the right body. The client itself is mocked, so these
 * pin the routes the backend exposes (see the API reference in CLAUDE.md).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as client from '@/api/client';
import * as admin from '../admin';
import * as customColumns from '../customColumns';
import * as equipment from '../equipment';
import * as kanban from '../kanban';
import * as notifications from '../notifications';
import * as settings from '../settings';
import * as sites from '../sites';
import * as staff from '../staff';
import * as users from '../users';
import * as vacations from '../vacations';
import { tagsApi, tagGroupsApi } from '../tags';
import { skillsApi } from '../skills';
import { absenceTypesApi } from '../absenceTypes';
import { getAppVersion } from '../health';

vi.mock('@/api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  apiRequest: vi.fn(),
  downloadFile: vi.fn(),
  isWhatIfActive: vi.fn(() => false),
}));

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'REQUEST';
const fns: Record<Method, ReturnType<typeof vi.fn>> = {
  GET: vi.mocked(client.apiGet),
  POST: vi.mocked(client.apiPost),
  PUT: vi.mocked(client.apiPut),
  PATCH: vi.mocked(client.apiPatch),
  DELETE: vi.mocked(client.apiDelete),
  REQUEST: vi.mocked(client.apiRequest),
};

beforeEach(() => {
  for (const fn of Object.values(fns)) fn.mockReset().mockResolvedValue({});
});

/** [description, call, method, url, body?]. `undefined` body = not passed. */
type Case = [string, () => Promise<unknown>, Method, string, unknown?];

function runCases(cases: Case[]) {
  it.each(cases)('%s', async (_name, call, method, url, ...rest) => {
    await call();
    const fn = fns[method];
    expect(fn).toHaveBeenCalledTimes(1);
    const args = fn.mock.calls[0];
    expect(args[0]).toBe(url);
    if (rest.length > 0) expect(args[1]).toEqual(rest[0]);
  });
}

describe('admin portal endpoints', () => {
  runCases([
    ['adminLogin', () => admin.adminLogin('a@x', 'pw'), 'POST', '/api/admin/auth/login', { email: 'a@x', password: 'pw' }],
    ['adminLogout', () => admin.adminLogout(), 'POST', '/api/admin/auth/logout', {}],
    ['changeAdminPassword', () => admin.changeAdminPassword('old', 'new'), 'POST', '/api/admin/auth/change-password', { current_password: 'old', new_password: 'new' }],
    ['getAdminMe', () => admin.getAdminMe(), 'GET', '/api/admin/auth/me'],
    ['getTenants', () => admin.getTenants(), 'GET', '/api/admin/tenants'],
    ['getTenant', () => admin.getTenant('t1'), 'GET', '/api/admin/tenants/t1'],
    ['createTenant', () => admin.createTenant({ name: 'A', slug: 'a', admin_email: 'x@a' }), 'POST', '/api/admin/tenants', { name: 'A', slug: 'a', admin_email: 'x@a' }],
    ['updateTenant', () => admin.updateTenant('t1', { name: 'B' }), 'PUT', '/api/admin/tenants/t1', { name: 'B' }],
    ['updateTenantStatus', () => admin.updateTenantStatus('t1', 'suspended'), 'PUT', '/api/admin/tenants/t1/status', { status: 'suspended' }],
    ['deleteTenant keeps the DB by default', () => admin.deleteTenant('t1'), 'DELETE', '/api/admin/tenants/t1?delete_database=false'],
    ['deleteTenant with DB', () => admin.deleteTenant('t1', true), 'DELETE', '/api/admin/tenants/t1?delete_database=true'],
    ['provisionTenant', () => admin.provisionTenant('t1'), 'POST', '/api/admin/tenants/t1/provision', { seedDemoData: false }],
    ['provisionTenant with demo data', () => admin.provisionTenant('t1', { seedDemoData: true }), 'POST', '/api/admin/tenants/t1/provision', { seedDemoData: true }],
    ['deprovisionTenant', () => admin.deprovisionTenant('t1'), 'POST', '/api/admin/tenants/t1/deprovision', {}],
    ['resetTenantAdminPassword', () => admin.resetTenantAdminPassword('t1'), 'POST', '/api/admin/tenants/t1/reset-admin-password', {}],
    ['getTenantAuditLog default limit', () => admin.getTenantAuditLog('t1'), 'GET', '/api/admin/tenants/t1/audit?limit=50'],
    ['getTenantAuditLog custom limit', () => admin.getTenantAuditLog('t1', 5), 'GET', '/api/admin/tenants/t1/audit?limit=5'],
    ['getSystemStats', () => admin.getSystemStats(), 'GET', '/api/admin/stats'],
    ['getAdminUsers', () => admin.getAdminUsers(), 'GET', '/api/admin/users'],
    ['createAdminUser', () => admin.createAdminUser({ email: 'e', password: 'p', name: 'n', role: 'admin' }), 'POST', '/api/admin/users', { email: 'e', password: 'p', name: 'n', role: 'admin' }],
    ['updateAdminUser', () => admin.updateAdminUser(3, { active: false }), 'PUT', '/api/admin/users/3', { active: false }],
    ['deleteAdminUser', () => admin.deleteAdminUser(3), 'DELETE', '/api/admin/users/3'],
    ['getOrganizations', () => admin.getOrganizations(), 'GET', '/api/admin/organizations'],
    ['getOrganization', () => admin.getOrganization('o1'), 'GET', '/api/admin/organizations/o1'],
    ['createOrganization', () => admin.createOrganization({ name: 'O', slug: 'o' }), 'POST', '/api/admin/organizations', { name: 'O', slug: 'o' }],
    ['updateOrganization', () => admin.updateOrganization('o1', { description: 'd' }), 'PUT', '/api/admin/organizations/o1', { description: 'd' }],
    ['deleteOrganization', () => admin.deleteOrganization('o1'), 'DELETE', '/api/admin/organizations/o1'],
    ['getOrganizationSSOConfig', () => admin.getOrganizationSSOConfig('o1'), 'GET', '/api/admin/organizations/o1/sso'],
    ['updateOrganizationSSOConfig', () => admin.updateOrganizationSSOConfig('o1', { enabled: true }), 'PUT', '/api/admin/organizations/o1/sso', { enabled: true }],
    ['deleteOrganizationSSOConfig', () => admin.deleteOrganizationSSOConfig('o1'), 'DELETE', '/api/admin/organizations/o1/sso'],
    ['testOrganizationSSOConfig', () => admin.testOrganizationSSOConfig('o1'), 'POST', '/api/admin/organizations/o1/sso/test', {}],
    ['addTenantToOrganization without body', () => admin.addTenantToOrganization('o1', 't1'), 'PUT', '/api/admin/organizations/o1/tenants/t1', {}],
    ['addTenantToOrganization with groups', () => admin.addTenantToOrganization('o1', 't1', { requiredGroupIds: ['g'] }), 'PUT', '/api/admin/organizations/o1/tenants/t1', { requiredGroupIds: ['g'] }],
    ['removeTenantFromOrganization', () => admin.removeTenantFromOrganization('o1', 't1'), 'DELETE', '/api/admin/organizations/o1/tenants/t1'],
    ['updateTenantGroupAccess', () => admin.updateTenantGroupAccess('t1', { groupMembershipMode: 'all' }), 'PATCH', '/api/admin/organizations/tenants/t1/groups', { groupMembershipMode: 'all' }],
  ]);
});

describe('custom column endpoints', () => {
  const value = { custom_column_id: 1, entity_type: 'project' as const, entity_id: 2, value: 'x' };
  runCases([
    ['getCustomColumns (all)', () => customColumns.getCustomColumns(), 'GET', '/api/custom-columns'],
    ['getCustomColumns (site)', () => customColumns.getCustomColumns(4), 'GET', '/api/custom-columns?site_id=4'],
    ['getCustomColumnsWithValues', () => customColumns.getCustomColumnsWithValues(4), 'GET', '/api/custom-columns/with-values?site_id=4'],
    ['createCustomColumn', () => customColumns.createCustomColumn({ name: 'P', column_type: 'text' }), 'POST', '/api/custom-columns', { name: 'P', column_type: 'text' }],
    ['updateCustomColumn is a PATCH', () => customColumns.updateCustomColumn(9, { width: 200 }), 'REQUEST', '/api/custom-columns/9', { method: 'PATCH', body: { width: 200 } }],
    ['deleteCustomColumn', () => customColumns.deleteCustomColumn(9), 'DELETE', '/api/custom-columns/9'],
    ['reorderCustomColumns', () => customColumns.reorderCustomColumns([3, 1]), 'REQUEST', '/api/custom-columns/reorder', { method: 'PATCH', body: { column_order: [3, 1] } }],
    ['setCustomColumnValue', () => customColumns.setCustomColumnValue(value), 'PUT', '/api/custom-columns/values', value],
    ['setCustomColumnValuesBatch', () => customColumns.setCustomColumnValuesBatch([value]), 'PUT', '/api/custom-columns/values/batch', { updates: [value] }],
    ['deleteCustomColumnValue', () => customColumns.deleteCustomColumnValue(1, 'phase', 5), 'DELETE', '/api/custom-columns/values/1/phase/5'],
  ]);

  it('builds value keys and converts booleans', () => {
    expect(customColumns.getValueKey(1, 'phase', 5)).toBe('1-phase-5');
    expect(customColumns.parseBooleanValue('TRUE')).toBe(true);
    expect(customColumns.parseBooleanValue('no')).toBe(false);
    expect(customColumns.parseBooleanValue(null)).toBe(false);
    expect(customColumns.booleanToString(true)).toBe('true');
    expect(customColumns.booleanToString(false)).toBe('false');
  });
});

describe('equipment and staff endpoints', () => {
  const blockBody = { equipment_id: 1, start_date: '2026-01-01', end_date: '2026-01-02', reason: 'maintenance' };
  runCases([
    ['getEquipment (site)', () => equipment.getEquipment(), 'GET', '/api/equipment'],
    ['getEquipment (all sites)', () => equipment.getEquipment(true), 'GET', '/api/equipment?includeAllSites=true'],
    ['getEquipmentItem', () => equipment.getEquipmentItem(2), 'GET', '/api/equipment/2'],
    ['createEquipment', () => equipment.createEquipment({ name: 'E', type: 'T', site_id: 1 } as never), 'POST', '/api/equipment', { name: 'E', type: 'T', site_id: 1 }],
    ['updateEquipment', () => equipment.updateEquipment(2, { name: 'F' }), 'PUT', '/api/equipment/2', { name: 'F' }],
    ['deleteEquipment', () => equipment.deleteEquipment(2), 'DELETE', '/api/equipment/2'],
    ['getEquipmentBlocks (all)', () => equipment.getEquipmentBlocks(), 'GET', '/api/equipment-blocks'],
    ['getEquipmentBlocks (filtered)', () => equipment.getEquipmentBlocks({ siteId: 1, equipmentId: 0 }), 'GET', '/api/equipment-blocks?siteId=1&equipmentId=0'],
    ['createEquipmentBlock', () => equipment.createEquipmentBlock(blockBody as never), 'POST', '/api/equipment-blocks', blockBody],
    ['updateEquipmentBlock', () => equipment.updateEquipmentBlock(5, { reason: 'defect' } as never), 'PUT', '/api/equipment-blocks/5', { reason: 'defect' }],
    ['deleteEquipmentBlock', () => equipment.deleteEquipmentBlock(5), 'DELETE', '/api/equipment-blocks/5'],
    ['getStaff (site)', () => staff.getStaff(), 'GET', '/api/staff'],
    ['getStaff (all sites)', () => staff.getStaff(true), 'GET', '/api/staff?includeAllSites=true'],
    ['getStaffMember', () => staff.getStaffMember(4), 'GET', '/api/staff/4'],
  ]);
});

describe('kanban endpoints', () => {
  runCases([
    ['getMentionableUsers', () => kanban.getMentionableUsers(1), 'GET', '/api/kanban/sites/1/mentionable-users'],
    ['moveCard', () => kanban.moveCard('phase', 12, 'done'), 'PUT', '/api/kanban/cards/phase/12/status', { status: 'done' }],
    ['assignCard leaves allocation to the server', () => kanban.assignCard('subphase', 3, 4), 'POST', '/api/kanban/cards/subphase/3/assignees', { staff_id: 4, allocation: null }],
    ['assignCard with allocation', () => kanban.assignCard('phase', 3, 4, 60), 'POST', '/api/kanban/cards/phase/3/assignees', { staff_id: 4, allocation: 60 }],
    ['unassignCard', () => kanban.unassignCard('phase', 3, 4), 'DELETE', '/api/kanban/cards/phase/3/assignees/4'],
    ['getComments', () => kanban.getComments('subphase', 8), 'GET', '/api/kanban/cards/subphase/8/comments'],
    ['createComment without mentions', () => kanban.createComment('phase', 8, 'hi'), 'POST', '/api/kanban/cards/phase/8/comments', { body: 'hi', mentioned_user_ids: [] }],
    ['createComment with mentions', () => kanban.createComment('phase', 8, '@bob', [4]), 'POST', '/api/kanban/cards/phase/8/comments', { body: '@bob', mentioned_user_ids: [4] }],
    ['updateComment', () => kanban.updateComment(7, 'edit'), 'PUT', '/api/kanban/comments/7', { body: 'edit' }],
    ['deleteComment', () => kanban.deleteComment(7), 'DELETE', '/api/kanban/comments/7'],
  ]);

  it('flattens project comment counts to card keys', async () => {
    fns.GET.mockResolvedValue({ phase: { '12': 3 }, subphase: { '45': 1 } });
    const counts = await kanban.getCommentCounts(9);
    expect(fns.GET).toHaveBeenCalledWith('/api/kanban/projects/9/comment-counts');
    expect(Object.fromEntries(counts)).toEqual({ 'phase-12': 3, 'subphase-45': 1 });
  });

  it('flattens site comment counts and tolerates missing groups', async () => {
    fns.GET.mockResolvedValue({ subphase: { '2': 5 } });
    const counts = await kanban.getSiteCommentCounts(1);
    expect(fns.GET).toHaveBeenCalledWith('/api/kanban/sites/1/comment-counts');
    expect(Object.fromEntries(counts)).toEqual({ 'subphase-2': 5 });
  });
});

describe('notification endpoints', () => {
  runCases([
    ['markNotificationRead', () => notifications.markNotificationRead(3), 'PUT', '/api/notifications/3/read', {}],
    ['markAllNotificationsRead', () => notifications.markAllNotificationsRead(), 'PUT', '/api/notifications/read-all', {}],
  ]);

  it('tags fetched notifications as server-sourced', async () => {
    fns.GET.mockResolvedValue([{ id: 1, title: 'Hi' }]);
    const items = await notifications.getNotifications();
    expect(fns.GET).toHaveBeenCalledWith('/api/notifications?unread_only=false&limit=50');
    expect(items).toEqual([{ id: 1, title: 'Hi', source: 'server' }]);
    await notifications.getNotifications(true, 10);
    expect(fns.GET).toHaveBeenLastCalledWith('/api/notifications?unread_only=true&limit=10');
  });

  it('returns the unread count', async () => {
    fns.GET.mockResolvedValue({ count: 4 });
    await expect(notifications.getUnreadCount()).resolves.toBe(4);
    expect(fns.GET).toHaveBeenCalledWith('/api/notifications/unread-count');
  });
});

describe('settings endpoints', () => {
  runCases([
    ['getSetting', () => settings.getSetting('show_weekends'), 'GET', '/api/settings/show_weekends'],
    ['updateSetting', () => settings.updateSetting('k', 'v'), 'PUT', '/api/settings/k', { value: 'v' }],
    ['updateInstanceTitle', () => settings.updateInstanceTitle('Lab'), 'PUT', '/api/settings/instance_title', { value: 'Lab' }],
    ['getPredefinedPhases', () => settings.getPredefinedPhases(), 'GET', '/api/predefined-phases'],
    ['createPredefinedPhase', () => settings.createPredefinedPhase({ name: 'QA' } as never), 'POST', '/api/predefined-phases', { name: 'QA' }],
    ['updatePredefinedPhase', () => settings.updatePredefinedPhase(2, { name: 'QC' } as never), 'PUT', '/api/predefined-phases/2', { name: 'QC' }],
    ['deletePredefinedPhase', () => settings.deletePredefinedPhase(2), 'DELETE', '/api/predefined-phases/2'],
    ['getSSOConfig', () => settings.getSSOConfig(), 'GET', '/api/settings/sso'],
    ['updateSSOConfig', () => settings.updateSSOConfig({ enabled: true } as never), 'PUT', '/api/settings/sso', { enabled: true }],
  ]);

  it('getInstanceTitle falls back to the default title', async () => {
    fns.GET.mockResolvedValueOnce({ value: 'My Lab' });
    await expect(settings.getInstanceTitle()).resolves.toBe('My Lab');
    fns.GET.mockResolvedValueOnce({ value: null });
    await expect(settings.getInstanceTitle()).resolves.toBe('R&D Planning');
    fns.GET.mockRejectedValueOnce(new Error('down'));
    await expect(settings.getInstanceTitle()).resolves.toBe('R&D Planning');
  });

  it('getInstanceSettings maps empty values to undefined', async () => {
    fns.GET.mockResolvedValue({ instance_title: 'T', instance_name: '', show_weekends: 'true', other: 'x' });
    await expect(settings.getInstanceSettings()).resolves.toEqual({
      instance_title: 'T',
      instance_name: undefined,
      show_weekends: 'true',
    });
    expect(fns.GET).toHaveBeenCalledWith('/api/settings');
  });
});

describe('site, holiday and event endpoints', () => {
  const event = { date: '2026-01-01', name: 'Audit', site_ids: [1] };
  runCases([
    ['getSites', () => sites.getSites(), 'GET', '/api/sites'],
    ['getSite', () => sites.getSite(2), 'GET', '/api/sites/2'],
    ['createSite', () => sites.createSite({ name: 'Bern' } as never), 'POST', '/api/sites', { name: 'Bern' }],
    ['updateSite', () => sites.updateSite(2, { name: 'Zug' }), 'PUT', '/api/sites/2', { name: 'Zug' }],
    ['deleteSite', () => sites.deleteSite(2), 'DELETE', '/api/sites/2'],
    ['getBankHolidays', () => sites.getBankHolidays(2), 'GET', '/api/sites/2/holidays'],
    ['getBankHolidays (year)', () => sites.getBankHolidays(2, 2026), 'GET', '/api/sites/2/holidays?year=2026'],
    ['addCustomHoliday', () => sites.addCustomHoliday(2, { date: '2026-08-01', name: 'NDay' }), 'POST', '/api/sites/2/holidays', { date: '2026-08-01', name: 'NDay' }],
    ['createBankHoliday alias', () => sites.createBankHoliday(2, { date: '2026-08-01', name: 'NDay' }), 'POST', '/api/sites/2/holidays'],
    ['deleteCustomHoliday', () => sites.deleteCustomHoliday(2, 9), 'DELETE', '/api/sites/2/holidays/9'],
    ['deleteBankHoliday alias', () => sites.deleteBankHoliday(2, 9), 'DELETE', '/api/sites/2/holidays/9'],
    ['updateBankHoliday', () => sites.updateBankHoliday(2, 9, { name: 'X' }), 'PUT', '/api/sites/2/holidays/9', { name: 'X' }],
    ['importBankHolidays', () => sites.importBankHolidays(2, [{ date: '2026-01-01', name: 'NY' }]), 'POST', '/api/sites/2/holidays/import', { items: [{ date: '2026-01-01', name: 'NY' }] }],
    ['refreshBankHolidays', () => sites.refreshBankHolidays(2), 'POST', '/api/sites/2/holidays/refresh'],
    ['getCompanyEvents', () => sites.getCompanyEvents(2), 'GET', '/api/sites/2/events'],
    ['createCompanyEvent', () => sites.createCompanyEvent(2, { date: '2026-01-01', name: 'Audit' }), 'POST', '/api/sites/2/events', { date: '2026-01-01', name: 'Audit' }],
    ['deleteCompanyEvent', () => sites.deleteCompanyEvent(2, 4), 'DELETE', '/api/sites/2/events/4'],
    ['createCompanyEventMultiSite', () => sites.createCompanyEventMultiSite(event), 'POST', '/api/events', event],
    ['updateCompanyEvent', () => sites.updateCompanyEvent(4, { site_ids: [1, 2] }), 'PUT', '/api/events/4', { site_ids: [1, 2] }],
    ['deleteCompanyEventById', () => sites.deleteCompanyEventById(4), 'DELETE', '/api/events/4'],
    ['importCompanyEvents', () => sites.importCompanyEvents({ site_ids: [1], items: [] }), 'POST', '/api/events/import', { site_ids: [1], items: [] }],
  ]);

  it('exportSiteToExcel downloads with a slugified fallback name', async () => {
    await sites.exportSiteToExcel(3, 'Basel Lab #2');
    expect(client.downloadFile).toHaveBeenCalledWith('/api/export/site/3/excel', 'basel-lab-2-export.xlsx');
    await sites.exportSiteToExcel(4);
    expect(client.downloadFile).toHaveBeenLastCalledWith('/api/export/site/4/excel', 'site-4-export.xlsx');
  });
});

describe('user and vacation endpoints', () => {
  runCases([
    ['getUser', () => users.getUser(3), 'GET', '/api/users/3'],
    ['createUser', () => users.createUser({ email: 'e' } as never), 'POST', '/api/users', { email: 'e' }],
    ['updateUser', () => users.updateUser(3, { role: 'user' } as never), 'PUT', '/api/users/3', { role: 'user' }],
    ['deleteUser', () => users.deleteUser(3), 'DELETE', '/api/users/3'],
    ['getVacations', () => vacations.getVacations(), 'GET', '/api/vacations'],
    ['getStaffVacations', () => vacations.getStaffVacations(4), 'GET', '/api/vacations?staff_id=4'],
    ['createVacation', () => vacations.createVacation({ staff_id: 4 } as never), 'POST', '/api/vacations', { staff_id: 4 }],
    ['updateVacation', () => vacations.updateVacation(1, { description: 'x' }), 'PUT', '/api/vacations/1', { description: 'x' }],
    ['deleteVacation', () => vacations.deleteVacation(1), 'DELETE', '/api/vacations/1'],
    ['importVacations', () => vacations.importVacations(4, []), 'POST', '/api/vacations/import', { staff_id: 4, items: [] }],
  ]);

  it('getUsers unwraps the paginated items', async () => {
    fns.GET.mockResolvedValue({ items: [{ id: 1 }], total: 1, offset: 0, limit: 50 });
    await expect(users.getUsers()).resolves.toEqual([{ id: 1 }]);
    expect(fns.GET).toHaveBeenCalledWith('/api/users');
    await users.getUsers(true);
    expect(fns.GET).toHaveBeenLastCalledWith('/api/users?includeDisabled=true');
  });
});

describe('tags, skills and absence-type endpoints', () => {
  runCases([
    ['tags getAll', () => tagsApi.getAll(), 'GET', '/api/tags'],
    ['tags create', () => tagsApi.create({ name: 'A' }), 'POST', '/api/tags', { name: 'A' }],
    ['tags update', () => tagsApi.update(1, { color: '#fff' }), 'PUT', '/api/tags/1', { color: '#fff' }],
    ['tags delete', () => tagsApi.delete(1), 'DELETE', '/api/tags/1'],
    ['tags reorder', () => tagsApi.reorder([2, 1]), 'PUT', '/api/tags/reorder', { tag_order: [2, 1] }],
    ['tag groups getAll', () => tagGroupsApi.getAll(), 'GET', '/api/tag-groups'],
    ['tag groups create', () => tagGroupsApi.create({ name: 'G' }), 'POST', '/api/tag-groups', { name: 'G' }],
    ['tag groups update', () => tagGroupsApi.update(1, { single_select: true }), 'PUT', '/api/tag-groups/1', { single_select: true }],
    ['tag groups delete', () => tagGroupsApi.delete(1), 'DELETE', '/api/tag-groups/1'],
    ['tag groups reorder', () => tagGroupsApi.reorder([1]), 'PUT', '/api/tag-groups/reorder', { group_order: [1] }],
    ['skills getAll', () => skillsApi.getAll(), 'GET', '/api/skills'],
    ['skills get', () => skillsApi.get(2), 'GET', '/api/skills/2'],
    ['skills create', () => skillsApi.create({ name: 'HPLC' }), 'POST', '/api/skills', { name: 'HPLC' }],
    ['skills update', () => skillsApi.update(2, { color: '#000' }), 'PUT', '/api/skills/2', { color: '#000' }],
    ['skills delete', () => skillsApi.delete(2), 'DELETE', '/api/skills/2'],
    ['skills getUserSkills', () => skillsApi.getUserSkills(4), 'GET', '/api/skills/user/4'],
    ['skills updateUserSkills', () => skillsApi.updateUserSkills(4, [1, 2]), 'PUT', '/api/skills/user/4', { skill_ids: [1, 2] }],
    ['skills addUserSkill', () => skillsApi.addUserSkill(4, 2), 'POST', '/api/skills/user/4/2'],
    ['skills removeUserSkill', () => skillsApi.removeUserSkill(4, 2), 'DELETE', '/api/skills/user/4/2'],
    ['absence types getAll', () => absenceTypesApi.getAll(), 'GET', '/api/absence-types'],
    ['absence types create', () => absenceTypesApi.create({ name: 'Sick', color: '#f00' }), 'POST', '/api/absence-types', { name: 'Sick', color: '#f00' }],
    ['absence types update', () => absenceTypesApi.update(1, { is_active: false }), 'PUT', '/api/absence-types/1', { is_active: false }],
    ['absence types remove', () => absenceTypesApi.remove(1), 'DELETE', '/api/absence-types/1'],
    ['absence types reorder', () => absenceTypesApi.reorder([1]), 'PUT', '/api/absence-types/reorder', { type_order: [1] }],
  ]);
});

describe('health', () => {
  it('returns the backend version, or null when unknown or unreachable', async () => {
    fns.GET.mockResolvedValueOnce({ version: '1.6.0' });
    await expect(getAppVersion()).resolves.toBe('1.6.0');
    expect(fns.GET).toHaveBeenCalledWith('/api/health');
    fns.GET.mockResolvedValueOnce({ version: '' });
    await expect(getAppVersion()).resolves.toBeNull();
    fns.GET.mockRejectedValueOnce(new Error('down'));
    await expect(getAppVersion()).resolves.toBeNull();
  });
});
