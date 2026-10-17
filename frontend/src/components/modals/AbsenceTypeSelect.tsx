/**
 * AbsenceTypeSelect - pick an absence type (Holidays, Home Office, ...)
 *
 * Lists the active types in sort order (a shared Select) with a colour chip
 * for the selected one in the Select's icon slot. A value pointing at an inactive type stays selectable (labelled
 * "(inactive)") so editing an old absence never silently changes its type.
 */

import { useMemo } from 'react';
import { Select } from '@/components/common/Select';
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

  const selectOptions = useMemo(
    () => [
      ...(showNone ? [{ value: '', label: 'No type' }] : []),
      ...options.map((t) => ({
        value: t.id,
        label: `${t.name}${t.is_active ? '' : ' (inactive)'}${t.counts_as_unavailable ? '' : ' (available)'}`,
      })),
    ],
    [options, showNone]
  );

  return (
    <Select
      id={id}
      className={compact ? styles.compact : undefined}
      fullWidth
      icon={
        <span
          className={`${styles.chip} ${selectedType ? '' : styles.chipNone}`}
          style={absenceColorStyle(selectedType)}
          aria-hidden="true"
        />
      }
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      aria-label={ariaLabel}
      disabled={disabled}
      options={selectOptions}
    />
  );
}
