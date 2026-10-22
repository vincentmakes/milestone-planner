/**
 * The instance-setting readers never throw: a malformed or stale value reads
 * as the default (an empty list, a switch that is on, no default panel).
 */
import { describe, it, expect } from 'vitest';
import { ganttDefaultPanel, isSettingOn, parseIdList, parseNameList } from '../instanceSettings';

describe('parseIdList', () => {
  it('keeps the unique positive integers in order', () => {
    expect(parseIdList('[3,1,3,2]')).toEqual([3, 1, 2]);
  });

  it('drops anything that is not a positive integer', () => {
    expect(parseIdList('[0,-1,1.5,"2",null,true,4]')).toEqual([4]);
  });

  it('reads a missing, malformed or non-array value as empty', () => {
    expect(parseIdList(undefined)).toEqual([]);
    expect(parseIdList(null)).toEqual([]);
    expect(parseIdList('')).toEqual([]);
    expect(parseIdList('[1,')).toEqual([]);
    expect(parseIdList('{"a":1}')).toEqual([]);
    expect(parseIdList('7')).toEqual([]);
  });
});

describe('parseNameList', () => {
  it('keeps the unique trimmed non-empty strings in order', () => {
    expect(parseNameList('["HPLC"," GC ","HPLC","",3,null,"GC"]')).toEqual(['HPLC', 'GC']);
  });

  it('reads a missing or malformed value as empty', () => {
    expect(parseNameList(undefined)).toEqual([]);
    expect(parseNameList('not json')).toEqual([]);
    expect(parseNameList('"HPLC"')).toEqual([]);
  });
});

describe('isSettingOn', () => {
  it('is off only for exactly "false"', () => {
    expect(isSettingOn({ kanban_enabled: 'false' }, 'kanban_enabled')).toBe(false);
    expect(isSettingOn({ kanban_enabled: 'true' }, 'kanban_enabled')).toBe(true);
    expect(isSettingOn({ kanban_enabled: 'FALSE' }, 'kanban_enabled')).toBe(true);
    expect(isSettingOn({}, 'nager_enabled')).toBe(true);
  });

  it('is on before the settings are loaded', () => {
    expect(isSettingOn(null, 'new_project_preselect_phases')).toBe(true);
    expect(isSettingOn(undefined, 'show_weekends')).toBe(true);
  });
});

describe('ganttDefaultPanel', () => {
  it('reads staff and equipment, and anything else as none', () => {
    expect(ganttDefaultPanel({ gantt_default_panel: 'staff' })).toBe('staff');
    expect(ganttDefaultPanel({ gantt_default_panel: 'equipment' })).toBe('equipment');
    expect(ganttDefaultPanel({ gantt_default_panel: 'none' })).toBe('none');
    expect(ganttDefaultPanel({ gantt_default_panel: 'Staff' })).toBe('none');
    expect(ganttDefaultPanel(null)).toBe('none');
  });
});
