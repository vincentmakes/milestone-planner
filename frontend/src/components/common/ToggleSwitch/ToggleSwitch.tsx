/**
 * ToggleSwitch - an on/off switch for settings.
 *
 * One implementation for every toggle in the app, so they all look and behave
 * the same. The real control is a checkbox for accessibility (keyboard, screen
 * readers, label association); it is visually hidden and a styled track is
 * drawn next to it. Hiding it also keeps the global `input[type="checkbox"]`
 * sizing rule in global.css away from the visible switch.
 */

import type { ReactNode } from 'react';
import styles from './ToggleSwitch.module.css';

export interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Text shown to the right of the switch; use aria-label when there is none */
  label?: ReactNode;
  disabled?: boolean;
  title?: string;
  'aria-label'?: string;
  /** Extra class on the wrapping label, for layout by the caller */
  className?: string;
  id?: string;
}

export function ToggleSwitch({
  checked,
  onChange,
  label,
  disabled = false,
  title,
  'aria-label': ariaLabel,
  className,
  id,
}: ToggleSwitchProps) {
  const rootClass = [styles.root, disabled ? styles.disabled : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <label className={rootClass} title={title}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className={styles.input}
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={styles.track} aria-hidden="true" />
      {label != null && <span className={styles.label}>{label}</span>}
    </label>
  );
}
