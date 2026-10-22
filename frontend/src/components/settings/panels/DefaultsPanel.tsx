/**
 * DefaultsPanel (Settings hub > Features & defaults)
 *
 * The instance-wide defaults and feature switches (settings.general):
 * - the overview panel the Gantt opens with, and the initial skill / type
 *   filter of the Staff and Equipment panels. Users may close the panel or
 *   change the filter for their session; every new opening applies the
 *   default again;
 * - the Kanban board, the Nager bank-holiday import and the pre-selection of
 *   the predefined phases in a new project.
 *
 * Only the keys that changed are saved, in the canonical form the backend
 * stores (compact JSON lists, `true` / `false`). Stored skills and types that
 * no longer exist are listed so they can be unticked. Turning the Kanban
 * board on or off changes everyone's permissions, the saver's too, and the
 * broadcast skips the saver, so the panel re-reads /auth/me itself.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/common/Button';
import { Notice } from '@/components/common/Notice';
import { Select } from '@/components/common/Select';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useAppStore } from '@/stores/appStore';
import { getInstanceSettings, updateSetting } from '@/api/endpoints/settings';
import type { DefaultedSettingKey } from '@/api/endpoints/settings';
import { getEquipmentTypes } from '@/api/endpoints/equipment';
import { checkAuth } from '@/api/endpoints/auth';
import {
  ganttDefaultPanel,
  isSettingOn,
  parseIdList,
  parseNameList,
} from '@/utils/instanceSettings';
import type { InstanceSettings } from '@/types';
import type { SettingsPanelProps } from '../types';
import { useReportDirty } from '../useReportDirty';
import styles from './DefaultsPanel.module.css';

/** The six settings as the backend stores them */
type Values = Record<DefaultedSettingKey, string>;

const SAVE_ORDER: DefaultedSettingKey[] = [
  'gantt_default_panel',
  'staff_panel_default_skills',
  'equipment_panel_default_types',
  'kanban_enabled',
  'nager_enabled',
  'new_project_preselect_phases',
];

const PANEL_OPTIONS = [
  { value: 'none', label: 'Nothing' },
  { value: 'staff', label: 'Staff panel' },
  { value: 'equipment', label: 'Equipment panel' },
];

/** Sorted, so the same set always compares equal whatever the ticking order */
function idsValue(ids: readonly number[]): string {
  return JSON.stringify([...ids].sort((a, b) => a - b));
}

function namesValue(names: readonly string[]): string {
  return JSON.stringify([...names].sort((a, b) => a.localeCompare(b)));
}

function switchValue(on: boolean): string {
  return on ? 'true' : 'false';
}

function valuesFrom(settings: InstanceSettings): Values {
  return {
    gantt_default_panel: ganttDefaultPanel(settings),
    staff_panel_default_skills: idsValue(parseIdList(settings.staff_panel_default_skills)),
    equipment_panel_default_types: namesValue(parseNameList(settings.equipment_panel_default_types)),
    kanban_enabled: switchValue(isSettingOn(settings, 'kanban_enabled')),
    nager_enabled: switchValue(isSettingOn(settings, 'nager_enabled')),
    new_project_preselect_phases: switchValue(isSettingOn(settings, 'new_project_preselect_phases')),
  };
}

interface Loaded {
  values: Values;
  equipmentTypes: string[];
}

export function DefaultsPanel({ onDirtyChange }: SettingsPanelProps) {
  const skills = useAppStore((s) => s.skills);
  const setInstanceSettings = useAppStore((s) => s.setInstanceSettings);
  const setCurrentUser = useAppStore((s) => s.setCurrentUser);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [original, setOriginal] = useState<Values | null>(null);
  const [values, setValues] = useState<Values | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const { isSubmitting, begin, end } = useSubmitGuard();

  useEffect(() => {
    let cancelled = false;
    Promise.all([getInstanceSettings(), getEquipmentTypes()])
      .then(([settings, equipmentTypes]) => {
        if (cancelled) return;
        const initial = valuesFrom(settings);
        setLoaded({ values: initial, equipmentTypes });
        setOriginal(initial);
        setValues(initial);
      })
      .catch((err) => {
        console.error('Load defaults error:', err);
        if (!cancelled) setLoadError('Failed to load settings');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const changedKeys = useMemo(
    () => (values && original ? SAVE_ORDER.filter((key) => values[key] !== original[key]) : []),
    [values, original]
  );
  const dirty = changedKeys.length > 0;
  useReportDirty(onDirtyChange, dirty);

  // Checklist rows: what exists today, then the stored entries that no
  // longer do (deleted skill, renamed type), so they can be unticked.
  const skillItems = useMemo(() => {
    const known = skills.map((skill) => ({ value: skill.id, label: skill.name, stale: false }));
    const knownIds = new Set(skills.map((skill) => skill.id));
    const stale = loaded
      ? parseIdList(loaded.values.staff_panel_default_skills)
          .filter((id) => !knownIds.has(id))
          .map((id) => ({ value: id, label: `Skill #${id}`, stale: true }))
      : [];
    return [...known, ...stale];
  }, [skills, loaded]);

  const typeItems = useMemo(() => {
    if (!loaded) return [];
    const known = loaded.equipmentTypes.map((type) => ({ value: type, label: type, stale: false }));
    const knownTypes = new Set(loaded.equipmentTypes);
    const stale = parseNameList(loaded.values.equipment_panel_default_types)
      .filter((type) => !knownTypes.has(type))
      .map((type) => ({ value: type, label: type, stale: true }));
    return [...known, ...stale];
  }, [loaded]);

  if (loadError) {
    return (
      <div className={styles.container}>
        <Notice tone="error">{loadError}</Notice>
      </div>
    );
  }

  if (!values || !original) {
    return <div className={styles.loading}>Loading settings...</div>;
  }

  const selectedSkills = parseIdList(values.staff_panel_default_skills);
  const selectedTypes = parseNameList(values.equipment_panel_default_types);

  const change = (key: DefaultedSettingKey, value: string) => {
    setValues((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSuccess(null);
  };

  const handleReset = () => {
    setValues(original);
    setError(null);
    setSuccess(null);
  };

  const handleSave = async () => {
    if (!begin()) return; // a save is already running
    setError(null);
    setSuccess(null);
    const saved: Partial<Values> = {};
    try {
      for (const key of changedKeys) {
        await updateSetting(key, values[key]);
        saved[key] = values[key];
      }
      setSuccess('Settings saved');
    } catch (err) {
      console.error('Save defaults error:', err);
      setError(err instanceof Error && err.message ? err.message : 'Failed to save settings');
    } finally {
      // Keep what reached the server, even when a later key failed: those
      // keys are no longer unsaved, the failed one and the rest still are.
      if (Object.keys(saved).length > 0) {
        setOriginal((prev) => (prev ? { ...prev, ...saved } : prev));
        setInstanceSettings({ ...(useAppStore.getState().instanceSettings ?? {}), ...saved });
      }
      if ('kanban_enabled' in saved) {
        const { user } = await checkAuth();
        if (user) setCurrentUser(user);
      }
      end();
    }
  };

  return (
    <div className={styles.container}>
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Gantt</h3>
        <Select
          label="Open the Gantt with"
          hint="Shown to everyone who manages a project, each time they open the Gantt. They can close it."
          options={PANEL_OPTIONS}
          value={values.gantt_default_panel}
          onChange={(e) => change('gantt_default_panel', e.target.value)}
          disabled={isSubmitting}
        />
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Default filters</h3>
        <OptionChecklist
          label="Staff panel skills"
          hint="The Staff panel opens showing only people with one of these skills. None ticked shows everyone."
          items={skillItems}
          selected={selectedSkills}
          onChange={(ids) => change('staff_panel_default_skills', idsValue(ids))}
          emptyText="No skills yet. Add them in Skills."
          disabled={isSubmitting}
        />
        <OptionChecklist
          label="Equipment panel types"
          hint="The Equipment panel opens showing only these types. None ticked shows all equipment."
          items={typeItems}
          selected={selectedTypes}
          onChange={(names) => change('equipment_panel_default_types', namesValue(names))}
          emptyText="No equipment types yet."
          disabled={isSubmitting}
        />
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Features</h3>
        <SwitchField
          label="Kanban board"
          hint="When off, nobody sees the board, whatever their role."
          checked={values.kanban_enabled === 'true'}
          onChange={(on) => change('kanban_enabled', switchValue(on))}
          disabled={isSubmitting}
        />
        <SwitchField
          label="Bank-holiday import (Nager)"
          hint="Holidays already imported stay; refresh and automatic fetching stop."
          checked={values.nager_enabled === 'true'}
          onChange={(on) => change('nager_enabled', switchValue(on))}
          disabled={isSubmitting}
        />
        <SwitchField
          label="Pre-select predefined phases in new projects"
          hint="When off, a new project starts with no phase selected and its creator picks them."
          checked={values.new_project_preselect_phases === 'true'}
          onChange={(on) => change('new_project_preselect_phases', switchValue(on))}
          disabled={isSubmitting}
        />
      </section>

      {error && <Notice tone="error">{error}</Notice>}
      {success && <Notice tone="success">{success}</Notice>}

      <div className={styles.actions}>
        <span className={styles.hint}>{dirty ? 'You have unsaved changes' : ''}</span>
        <div className={styles.rightActions}>
          {dirty && (
            <Button variant="ghost" onClick={handleReset} disabled={isSubmitting}>
              Reset
            </Button>
          )}
          <Button onClick={handleSave} disabled={!dirty} loading={isSubmitting}>
            Save Changes
          </Button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// FIELDS
// =============================================================================

interface SwitchFieldProps {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled: boolean;
}

function SwitchField({ label, hint, checked, onChange, disabled }: SwitchFieldProps) {
  return (
    <div className={styles.toggleField}>
      <div className={styles.toggleInfo}>
        <span className={styles.label}>{label}</span>
        <span className={styles.hint}>{hint}</span>
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} aria-label={label} disabled={disabled} />
    </div>
  );
}

interface ChecklistItem<T> {
  value: T;
  label: string;
  /** Stored but no longer existing: listed so it can be unticked */
  stale: boolean;
}

interface OptionChecklistProps<T extends string | number> {
  label: string;
  hint: string;
  items: ChecklistItem<T>[];
  selected: T[];
  onChange: (selected: T[]) => void;
  emptyText: string;
  disabled: boolean;
}

/**
 * Pick several items from a list: label-wrapped raw checkboxes in a named
 * group, the RoleChecklist layout (UI_GUIDELINES §3.4).
 */
function OptionChecklist<T extends string | number>({
  label,
  hint,
  items,
  selected,
  onChange,
  emptyText,
  disabled,
}: OptionChecklistProps<T>) {
  const labelId = useId();
  const hintId = useId();
  const toggle = (value: T, checked: boolean) => {
    onChange(checked ? [...selected, value] : selected.filter((v) => v !== value));
  };

  return (
    <div className={styles.field}>
      <span className={styles.label} id={labelId}>
        {label}
      </span>
      <div
        className={styles.checklist}
        role="group"
        aria-labelledby={labelId}
        aria-describedby={hintId}
      >
        {items.length === 0 && <span className={styles.empty}>{emptyText}</span>}
        {items.map((item) => (
          <label
            key={String(item.value)}
            className={`${styles.check} ${disabled ? styles.disabled : ''}`}
          >
            <input
              type="checkbox"
              checked={selected.includes(item.value)}
              disabled={disabled}
              onChange={(e) => toggle(item.value, e.target.checked)}
            />
            <span>{item.label}</span>
            {item.stale && <span className={styles.stale}> (no longer exists)</span>}
          </label>
        ))}
      </div>
      <span className={styles.hint} id={hintId}>
        {hint}
      </span>
    </div>
  );
}
