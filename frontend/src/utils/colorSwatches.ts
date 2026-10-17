/**
 * Color swatches for user-picked marker colors (company events, absence types).
 * Values match the accent colors in styles/variables.css.
 */

export interface ColorSwatch {
  label: string;
  value: string;
}

// The first option (red) preserves the original company-event marker color.
export const EVENT_COLOR_SWATCHES: ColorSwatch[] = [
  { label: 'Red', value: '#ef4444' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Yellow', value: '#f59e0b' },
  { label: 'Green', value: '#10b981' },
  { label: 'Cyan', value: '#06b6d4' },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Purple', value: '#8b5cf6' },
];

export const DEFAULT_EVENT_COLOR = EVENT_COLOR_SWATCHES[0].value;
