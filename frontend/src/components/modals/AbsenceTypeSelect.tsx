/**
 * AbsenceTypeSelect - pick an absence type (Holidays, Home Office, ...)
 *
 * Lists the active types in sort order with a colour chip for the selected
 * one. A value pointing at an inactive type stays selectable (labelled
 * "(inactive)") so editing an old absence never silently changes its type.
 */

import { useMemo } from 'react';
import { activeAbsenceTypes, absenceColorStyle } from '@/utils/recurringVacation';
import type { AbsenceType } from '@/types';
import styles from './AbsenceTypeSelect.module.css';

interface AbsenceTypeSelectProps {
  /** Selected type id; null = untyped */
  value: number | null;
  onChange: (value: number | null) => void;
  /** All absence types (active and inactive) */
  types: AbsenceType[];
  id?: string;
  'aria-label'?: string;
  compact?: boolean;
  disabled?: boolean;
}

export function AbsenceTypeSelect({
  value,
  onChange,
  types,
  id,
  'aria-label': ariaLabel,
  compact = false,
  disabled = false,
}: AbsenceTypeSelectProps) {
  const options = useMemo(() => {
    const active = activeAbsenceTypes(types);
    const selected = value != null ? types.find((t) => t.id === value) : undefined;
    return selected && !selected.is_active ? [...active, selected] : active;
  }, [types, value]);

  const selectedType = value != null ? types.find((t) => t.id === value) ?? null : null;
  // "No type" is offered only when it is the current value or nothing else exists
  const showNone = value == null || options.length === 0;

  return (
    <span className={`${styles.wrapper} ${compact ? styles.compact : ''}`}>
      <span
        className={`${styles.chip} ${selectedType ? '' : styles.chipNone}`}
        style={absenceColorStyle(selectedType)}
        aria-hidden="true"
      />
      <select
        id={id}
        className={styles.select}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        {showNone && <option value="">No type</option>}
        {options.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
            {t.is_active ? '' : ' (inactive)'}
            {t.counts_as_unavailable ? '' : ' (available)'}
          </option>
        ))}
      </select>
    </span>
  );
}
