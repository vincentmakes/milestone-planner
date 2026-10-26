/**
 * The instance-setting readers never throw: a malformed or stale value reads
 * as the default (an empty list, a switch that is on, no default panel).
 */
import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_FIELD_DEFAULTS,
  BUILT_IN_PROJECT_FIELDS,
  builtInFieldLabel,
  fieldLabelsValue,
  ganttDefaultPanel,
  hiddenFieldsValue,
  isBuiltInFieldHidden,
  isSettingOn,
  parseFieldLabels,
  parseHiddenFields,
  parseIdList,
  parseNameList,
} from '../instanceSettings';

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

describe('built-in project fields', () => {
  it('lists the four built-in fields in display order', () => {
    expect(BUILT_IN_PROJECT_FIELDS.map((f) => f.key)).toEqual(['customer', 'sales_pm', 'volume', 'confirmed']);
  });

  it('reads the custom labels, trimmed, known keys only', () => {
    expect(parseFieldLabels('{"customer":" Client ","confirmed":"Won","other":"x","volume":"  ","sales_pm":3}')).toEqual({
      customer: 'Client',
      confirmed: 'Won',
    });
    expect(parseFieldLabels(undefined)).toEqual({});
    expect(parseFieldLabels('not json')).toEqual({});
    expect(parseFieldLabels('["customer"]')).toEqual({});
    expect(parseFieldLabels('null')).toEqual({});
  });

  it('reads the hidden fields in display order, never confirmed', () => {
    expect(parseHiddenFields('["volume","customer","confirmed","other","volume"]')).toEqual(['customer', 'volume']);
    expect(parseHiddenFields(null)).toEqual([]);
    expect(parseHiddenFields('{"customer":true}')).toEqual([]);
  });

  it('labels a field with its custom label, else its one default name', () => {
    const settings = { project_field_labels: '{"customer":"Client"}' };
    expect(builtInFieldLabel(settings, 'customer')).toBe('Client');
    expect(builtInFieldLabel(settings, 'volume')).toBe('Volume');
    expect(builtInFieldLabel(null, 'customer')).toBe('Customer');
  });

  it.each([
    ['customer', 'Customer'],
    ['sales_pm', 'Sales PM'],
    ['volume', 'Volume'],
    ['confirmed', 'Confirmed'],
  ] as const)('defaults %s to "%s", the name Settings shows', (key, label) => {
    expect(BUILT_IN_FIELD_DEFAULTS[key]).toBe(label);
    expect(builtInFieldLabel(undefined, key)).toBe(label);
    expect(BUILT_IN_PROJECT_FIELDS.find((f) => f.key === key)?.label).toBe(label);
  });

  it('hides only the listed hideable fields; Confirmed never', () => {
    const settings = { project_fields_hidden: '["sales_pm","confirmed"]' };
    expect(isBuiltInFieldHidden(settings, 'sales_pm')).toBe(true);
    expect(isBuiltInFieldHidden(settings, 'customer')).toBe(false);
    expect(isBuiltInFieldHidden(settings, 'confirmed')).toBe(false);
    expect(isBuiltInFieldHidden(undefined, 'volume')).toBe(false);
  });

  it('writes the canonical values the backend stores', () => {
    expect(fieldLabelsValue({ confirmed: ' Won ', customer: 'Client', volume: '' })).toBe(
      '{"customer":"Client","confirmed":"Won"}'
    );
    expect(fieldLabelsValue({})).toBe('{}');
    expect(hiddenFieldsValue(['volume', 'customer', 'confirmed', 'volume'])).toBe('["customer","volume"]');
    expect(hiddenFieldsValue([])).toBe('[]');
  });
});
