/**
 * Theme Colors Utility
 * 
 * Provides access to theme-aware colors, particularly for phase/subphase levels.
 * Colors are read from CSS variables which change based on the active theme.
 */

// Default fallback colors (Default theme)
const DEFAULT_LEVEL_COLORS: Record<number, string> = {
  0: '#FF50A8',  // Phase level (Pink)
  1: '#05B6D4',  // Cyan
  2: '#8B5CF6',  // Purple
  3: '#3B82F6',  // Blue
  4: '#FA7315',  // Orange
  5: '#11B981',  // Emerald
  6: '#EC4899',  // Fuchsia
  7: '#EAB30A',  // Amber
  8: '#14B8A6',  // Teal
  9: '#A755F7',  // Violet
  10: '#F43F5E', // Rose
};

/**
 * Get the computed value of a CSS variable
 */
function getCSSVariable(name: string): string | null {
  if (typeof window === 'undefined') return null;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || null;
}

/**
 * Get the color for a phase (top-level)
 */
export function getPhaseColor(): string {
  return getCSSVariable('--level-phase') || DEFAULT_LEVEL_COLORS[0];
}

/**
 * Get the color for a subphase at a specific depth
 * @param depth - The depth level (1-10)
 */
export function getDepthColor(depth: number): string {
  // Clamp depth to 1-10 range
  const clampedDepth = Math.max(1, Math.min(10, depth));
  const cssVar = getCSSVariable(`--level-${clampedDepth}`);
  return cssVar || DEFAULT_LEVEL_COLORS[clampedDepth] || DEFAULT_LEVEL_COLORS[1];
}

/**
 * Get the text color for bars (should be white for contrast)
 */
export function getLevelBarTextColor(): string {
  return getCSSVariable('--level-bar-text') || '#ffffff';
}

/**
 * Get all level colors as a map
 */
export function getAllLevelColors(): Record<number, string> {
  const colors: Record<number, string> = {};
  
  // Phase level
  colors[0] = getPhaseColor();
  
  // Subphase levels 1-10
  for (let i = 1; i <= 10; i++) {
    colors[i] = getDepthColor(i);
  }
  
  return colors;
}
