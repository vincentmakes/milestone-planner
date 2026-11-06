/**
 * The instance-setting readers never throw: a malformed or stale value reads
 * as the default (an empty list, a switch that is on, no default panel).
 */
import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_FIELD_DEFAULTS,
  BUILT_IN_PROJECT_FIELDS,
  DEFAULT_TOOLTIP_ROWS,
  PROJECT_TOOLTIP_ROWS,
  builtInFieldLabel,
  fieldLabelsValue,
  ganttDefaultPanel,
  hiddenFieldsValue,
  isBuiltInFieldHidden,
  isSettingOn,
  isTooltipRowShown,
  parseFieldLabels,
  parseHiddenFields,
  parseIdList,
  parseNameList,
  parseTooltipRows,
  selectShowWeekends,
  selectWeekendsWorking,
  tooltipRowGate,
  tooltipRowLabel,
  tooltipRowsValue,
  volumeDecimals,
  volumeDecimalsValue,
} from '../instanceSettings';
import type { TooltipRow } from '../instanceSettings';
import { INSTANCE_SETTING_DEFAULTS } from '@/api/endpoints/settings';

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
    expect(isSettingOn(null, 'gantt_completion_badges')).toBe(true);
    expect(isSettingOn({ gantt_completion_badges: 'false' }, 'gantt_completion_badges')).toBe(false);
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

describe('volume decimals', () => {
  it.each([
    [undefined, 1],
    ['', 1],
    ['any', null],
    ['0', 0],
    ['1', 1],
    ['2', 2],
    ['3', 3],
    // Malformed or stale rows read as the default, never throw.
    ['4', 1],
    ['ANY', 1],
    ['1.0', 1],
  ] as [string | undefined, number | null][])('reads %j as %s', (value, decimals) => {
    expect(volumeDecimals({ volume_decimals: value })).toBe(decimals);
  });

  it('reads unloaded settings as the default', () => {
    expect(volumeDecimals(null)).toBe(1);
    expect(volumeDecimals(undefined)).toBe(1);
  });

  it('writes the canonical value the backend stores', () => {
    expect(volumeDecimalsValue(null)).toBe('any');
    expect(volumeDecimalsValue(0)).toBe('0');
    expect(volumeDecimalsValue(3)).toBe('3');
  });
});

describe('Gantt details rows (project_tooltip_rows)', () => {
  it('lists the built-in rows in the backend order', () => {
    expect(PROJECT_TOOLTIP_ROWS.map((r) => r.key)).toEqual([
      'customer',
      'pm',
      'sales_pm',
      'volume',
      'confirmed',
      'tags',
      'period',
      'completion',
      'work_days',
      'total_days',
      'staff',
    ]);
  });

  it('has the default rows as its default value, already canonical', () => {
    const value = INSTANCE_SETTING_DEFAULTS.project_tooltip_rows;
    expect(parseTooltipRows(value)).toEqual(DEFAULT_TOOLTIP_ROWS);
    expect(tooltipRowsValue(DEFAULT_TOOLTIP_ROWS)).toBe(value);
  });

  it.each([undefined, null, '', 'not json', '{}', '"customer"', '3'])(
    'reads %j as the default rows',
    (value) => {
      expect(parseTooltipRows(value)).toEqual(DEFAULT_TOOLTIP_ROWS);
    }
  );

  it('reads [] as no row', () => {
    expect(parseTooltipRows('[]')).toEqual([]);
  });

  it('keeps known keys in display order, then ids ascending, each once', () => {
    expect(parseTooltipRows('[7,"staff","customer",3,7,"volume","staff"]')).toEqual([
      'customer',
      'volume',
      'staff',
      3,
      7,
    ]);
  });

  it('drops unknown keys and anything that is not a positive integer id', () => {
    expect(parseTooltipRows('["name","Customer",0,-1,1.5,true,null,"4",[2],"pm",9]')).toEqual(['pm', 9]);
  });

  it('writes the canonical value the backend stores', () => {
    expect(tooltipRowsValue(['staff', 12, 'customer', 5, 12, 'volume'])).toBe(
      '["customer","volume","staff",5,12]'
    );
    expect(tooltipRowsValue([])).toBe('[]');
  });

  it('captions the built-in fields with their renamed labels, the other rows with the defaults', () => {
    const settings = {
      project_field_labels: '{"customer":"Client","sales_pm":"Seller","volume":"Budget","confirmed":"Won"}',
    };
    expect(PROJECT_TOOLTIP_ROWS.map((r) => tooltipRowLabel(settings, r.key))).toEqual([
      'Client',
      'PM',
      'Seller',
      'Budget',
      'Won',
      'Tags',
      'Period',
      'Completion',
      'Work days',
      'Total',
      'Assigned staff',
    ]);
    expect(tooltipRowLabel(null, 'volume')).toBe('Volume');
    expect(tooltipRowLabel(undefined, 'staff')).toBe('Assigned staff');
  });

  it('shows a row only when it is listed', () => {
    const settings = { project_tooltip_rows: '["pm","volume",4]' };
    expect(isTooltipRowShown(settings, 'pm')).toBe(true);
    expect(isTooltipRowShown(settings, 'volume')).toBe(true);
    expect(isTooltipRowShown(settings, 4)).toBe(true);
    expect(isTooltipRowShown(settings, 'customer')).toBe(false);
    expect(isTooltipRowShown(settings, 5)).toBe(false);
  });

  it('never shows a listed built-in field that is hidden (Confirmed cannot be hidden)', () => {
    const settings = {
      project_tooltip_rows: '["customer","sales_pm","volume","confirmed"]',
      project_fields_hidden: '["customer","volume"]',
    };
    expect(isTooltipRowShown(settings, 'customer')).toBe(false);
    expect(isTooltipRowShown(settings, 'volume')).toBe(false);
    expect(isTooltipRowShown(settings, 'sales_pm')).toBe(true);
    expect(isTooltipRowShown(settings, 'confirmed')).toBe(true);
  });

  it('reads unloaded settings as the default rows', () => {
    expect(isTooltipRowShown(null, 'customer')).toBe(true);
    expect(isTooltipRowShown(undefined, 'staff')).toBe(true);
    expect(isTooltipRowShown(null, 'volume')).toBe(false);
  });

  it('builds one gate per settings value, the same answers as isTooltipRowShown', () => {
    const settings = { project_tooltip_rows: '["customer","pm",4]', project_fields_hidden: '["customer"]' };
    const shows = tooltipRowGate(settings);
    expect((['customer', 'pm', 'volume', 4, 5] as TooltipRow[]).map((row) => shows(row))).toEqual([false, true, false, true, false]);
    expect(tooltipRowGate(null)('staff')).toBe(true);
  });
});

describe('selectShowWeekends', () => {
  it('shows weekends unless the switch is exactly false (unloaded settings included)', () => {
    expect(selectShowWeekends({ instanceSettings: null })).toBe(true);
    expect(selectShowWeekends({ instanceSettings: {} as never })).toBe(true);
    expect(selectShowWeekends({ instanceSettings: { show_weekends: 'true' } as never })).toBe(true);
    expect(selectShowWeekends({ instanceSettings: { show_weekends: 'false' } as never })).toBe(false);
  });
});

describe('selectWeekendsWorking', () => {
  it("is on only for 'true' -- not a switch (unloaded, missing or stray values read as off)", () => {
    expect(selectWeekendsWorking({ instanceSettings: { weekend_working_days: 'true' } })).toBe(true);
    // Case-insensitive and trimmed, like the backend's weekends_working_from
    for (const value of [' TRUE ', 'True', 'tRuE\n']) {
      expect(selectWeekendsWorking({ instanceSettings: { weekend_working_days: value } })).toBe(true);
    }
    for (const value of [undefined, '', 'false', '1', 'yes', 'maybe']) {
      expect(selectWeekendsWorking({ instanceSettings: { weekend_working_days: value } })).toBe(false);
    }
    expect(selectWeekendsWorking({ instanceSettings: null })).toBe(false);
    expect(selectWeekendsWorking({ instanceSettings: {} })).toBe(false);
    // Where a switch would read on, this reads off.
    expect(isSettingOn({}, 'show_weekends')).toBe(true);
    expect(INSTANCE_SETTING_DEFAULTS.weekend_working_days).toBe('false');
  });
});
