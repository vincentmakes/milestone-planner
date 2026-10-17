/**
 * ColorSwatchPicker - pick one of the theme swatches, or (optionally) any color
 */

import { EVENT_COLOR_SWATCHES } from '@/utils/colorSwatches';
import type { ColorSwatch } from '@/utils/colorSwatches';
import styles from './ColorSwatchPicker.module.css';

interface ColorSwatchPickerProps {
  value: string;
  onChange: (color: string) => void;
  /** Accessible name of the group */
  label: string;
  swatches?: ColorSwatch[];
  /** Offer a native color input for colors outside the swatches */
  allowCustom?: boolean;
}

export function ColorSwatchPicker({
  value,
  onChange,
  label,
  swatches = EVENT_COLOR_SWATCHES,
  allowCustom = false,
}: ColorSwatchPickerProps) {
  const normalized = value.toLowerCase();
  const isCustom = !swatches.some((s) => s.value.toLowerCase() === normalized);

  return (
    <div className={styles.swatches} role="radiogroup" aria-label={label}>
      {swatches.map((swatch) => {
        const selected = swatch.value.toLowerCase() === normalized;
        return (
          <button
            key={swatch.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={swatch.label}
            title={swatch.label}
            className={`${styles.swatch} ${selected ? styles.selected : ''}`}
            style={{ background: swatch.value }}
            onClick={() => onChange(swatch.value)}
          />
        );
      })}
      {allowCustom && (
        <label
          className={`${styles.custom} ${isCustom ? styles.selected : ''}`}
          title="Custom color"
          style={isCustom ? { background: value } : undefined}
        >
          <input
            type="color"
            className={styles.colorInput}
            value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#3b82f6'}
            onChange={(e) => onChange(e.target.value)}
            aria-label="Custom color"
          />
          {!isCustom && <span aria-hidden="true">+</span>}
        </label>
      )}
    </div>
  );
}
