import { forwardRef, InputHTMLAttributes } from 'react';
import styles from './Checkbox.module.css';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
  error?: string;
  indeterminate?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, error, indeterminate, className, id, ...props }, ref) => {
    const checkboxId = id || `checkbox-${Math.random().toString(36).substr(2, 9)}`;

    const wrapperClasses = [styles.wrapper, className].filter(Boolean).join(' ');

    return (
      <div className={wrapperClasses}>
        <label htmlFor={checkboxId} className={styles.label}>
          <input
            ref={(el) => {
              if (el) {
                el.indeterminate = indeterminate || false;
              }
              if (typeof ref === 'function') {
                ref(el);
              } else if (ref) {
                ref.current = el;
              }
            }}
            type="checkbox"
            id={checkboxId}
            className={styles.input}
            {...props}
          />
          <span className={styles.checkbox}>
            <svg
              className={styles.checkIcon}
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <svg
              className={styles.indeterminateIcon}
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </span>
          {label && <span className={styles.labelText}>{label}</span>}
        </label>
        {error && <span className={styles.error}>{error}</span>}
      </div>
    );
  }
);

Checkbox.displayName = 'Checkbox';
