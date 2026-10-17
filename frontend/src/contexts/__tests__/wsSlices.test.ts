/**
 * The change:<entity> → refetch-slice mapping that drives WebSocket refreshes.
 * Unknown entities refresh everything, so new backend entities need no client
 * change; entities with their own fetches refresh nothing.
 */
import { describe, it, expect } from 'vitest';
import { ALL_SLICES, WHAT_IF_SANDBOXED_SLICES, slicesForEntity } from '../wsSlices';

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
    ['settings', ['settings']],
    ['custom_column', ['customColumns']],
    ['custom_column_value', ['customColumns']],
    ['bank_holiday', ['siteCalendar']],
    ['company_event', ['siteCalendar']],
    ['absence_type', ['absenceTypes', 'vacations']],
    ['staff', ['staff', 'projects']],
    ['user', ['staff', 'currentUser', 'projects']],
    ['equipment', ['equipment', 'projects']],
    ['equipment_block', ['equipmentBlocks']],
    ['vacation', ['vacations']],
    ['site', ['sites', 'siteCalendar']],
    ['skill', ['skills', 'staff']],
    ['tag', ['tags', 'projects']],
    ['tag_group', ['tags']],
  ])('%s → %j', (entity, slices) => {
    expect(slicesForEntity(entity)).toEqual(slices);
  });

  it('refreshes every slice for an unknown entity', () => {
    expect(slicesForEntity('brand_new_thing')).toBe(ALL_SLICES);
    expect(new Set(ALL_SLICES).size).toBe(13);
  });

  it('sandboxes only the What-If plan slices', () => {
    expect([...WHAT_IF_SANDBOXED_SLICES].sort()).toEqual(['customColumns', 'projects']);
  });
});
