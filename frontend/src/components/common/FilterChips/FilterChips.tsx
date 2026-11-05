/**
 * FilterChips — a segmented row of mutually exclusive filter chips (My Work's
 * Show / Outcome filters, the audit log's Category / Outcome).
 *
 * A `role="group"` named by `label`, of raw `aria-pressed` buttons (option
 * chips are not actions, so not the shared `Button`); the chosen chip is
 * raised. `onChange` fires on every click, also on the chosen chip.
 */

import styles from './FilterChips.module.css';

export interface FilterChipOption<T extends string> {
  value: T;
  label: string;
}

export interface FilterChipsProps<T extends string> {
  /** The group's accessible name */
  label: string;
  options: ReadonlyArray<FilterChipOption<T>>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

export function FilterChips<T extends string>({ label, options, value, onChange, className }: FilterChipsProps<T>) {
  return (
    <div className={[styles.group, className].filter(Boolean).join(' ')} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`${styles.chip} ${value === option.value ? styles.active : ''}`}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
