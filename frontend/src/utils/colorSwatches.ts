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

/**
 * Default colours offered for a skill (Settings → Skills). Data colours like
 * the event swatches: fixed hex values, the same in both themes.
 */
export const SKILL_COLOR_SWATCHES: ColorSwatch[] = [
  { value: '#3b82f6', label: 'Blue' },
  { value: '#8b5cf6', label: 'Purple' },
  { value: '#10b981', label: 'Green' },
  { value: '#f59e0b', label: 'Amber' },
  { value: '#ef4444', label: 'Red' },
  { value: '#06b6d4', label: 'Cyan' },
  { value: '#ec4899', label: 'Pink' },
  { value: '#84cc16', label: 'Lime' },
  { value: '#f97316', label: 'Orange' },
  { value: '#6366f1', label: 'Indigo' },
];
export const DEFAULT_SKILL_COLOR = SKILL_COLOR_SWATCHES[0].value;

/** Colours offered for a team (Settings → Teams): the skill palette. */
export const TEAM_COLOR_SWATCHES = SKILL_COLOR_SWATCHES;
export const DEFAULT_TEAM_COLOR = TEAM_COLOR_SWATCHES[0].value;
