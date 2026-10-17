import { forwardRef, SelectHTMLAttributes, ReactNode, useId } from 'react';
import styles from './Select.module.css';

export interface SelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

/** A labelled <optgroup> of options, rendered after the flat `options` */
export interface SelectOptionGroup {
  label: string;
  options: SelectOption[];
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  label?: string;
  error?: string;
  hint?: string;
  options: SelectOption[];
  groups?: SelectOptionGroup[];
  placeholder?: string;
  fullWidth?: boolean;
  icon?: ReactNode;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      label,
      error,
      hint,
      options,
      groups,
      placeholder,
      fullWidth = false,
      icon,
      className,
      id,
      ...props
    },
    ref
  ) => {
    const generatedId = useId();
    const selectId = id || `select-${generatedId}`;

    const wrapperClasses = [
      styles.wrapper,
      fullWidth && styles.fullWidth,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    const selectClasses = [
      styles.select,
      error && styles.error,
      icon && styles.hasIcon,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div className={wrapperClasses}>
        {label && (
          <label htmlFor={selectId} className={styles.label}>
            {label}
          </label>
        )}
        <div className={styles.selectWrapper}>
          {icon && <span className={styles.icon}>{icon}</span>}
          <select
            ref={ref}
            id={selectId}
            className={selectClasses}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined}
            {...props}
          >
            {placeholder && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}
            {options.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={option.disabled}
              >
                {option.label}
              </option>
            ))}
            {groups?.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((option) => (
                  <option key={option.value} value={option.value} disabled={option.disabled}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className={styles.chevron} aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </span>
        </div>
        {error && (
          <span id={`${selectId}-error`} className={styles.errorText} role="alert">
            {error}
          </span>
        )}
        {hint && !error && (
          <span id={`${selectId}-hint`} className={styles.hint}>
            {hint}
          </span>
        )}
      </div>
    );
  }
);

Select.displayName = 'Select';
