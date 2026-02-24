/**
 * Storage Utilities
 * Helpers for localStorage/sessionStorage with type safety
 */

// =============================================================================
// LOCAL STORAGE
// =============================================================================

/**
 * Get a value from localStorage with type safety
 */
export function getLocalStorage<T>(key: string, defaultValue: T): T {
  try {
    const item = localStorage.getItem(key);
    if (item === null) {
      return defaultValue;
    }
    return JSON.parse(item) as T;
  } catch {
    console.warn(`Failed to parse localStorage key "${key}"`);
    return defaultValue;
  }
}

/**
 * Set a value in localStorage
 */
export function setLocalStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn(`Failed to set localStorage key "${key}"`, err);
  }
}

/**
 * Remove a value from localStorage
 */
export function removeLocalStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (err) {
    console.warn(`Failed to remove localStorage key "${key}"`, err);
  }
}

// =============================================================================
// SESSION STORAGE
// =============================================================================

/**
 * Get a value from sessionStorage with type safety
 */
export function getSessionStorage<T>(key: string, defaultValue: T): T {
  try {
    const item = sessionStorage.getItem(key);
    if (item === null) {
      return defaultValue;
    }
    return JSON.parse(item) as T;
  } catch {
    console.warn(`Failed to parse sessionStorage key "${key}"`);
    return defaultValue;
  }
}

/**
 * Set a value in sessionStorage
 */
export function setSessionStorage<T>(key: string, value: T): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn(`Failed to set sessionStorage key "${key}"`, err);
  }
}

/**
 * Remove a value from sessionStorage
 */
export function removeSessionStorage(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch (err) {
    console.warn(`Failed to remove sessionStorage key "${key}"`, err);
  }
}

// =============================================================================
// STORAGE KEYS
// =============================================================================

/**
 * Centralized storage keys to avoid typos and enable easy refactoring
 */
export const STORAGE_KEYS = {
  // Preferences
  PREF_SITE_ID: 'milestone_pref_site_id',
  PREF_VIEW: 'milestone_pref_view',
  PREF_VIEW_MODE: 'milestone_pref_view_mode',
  PREF_THEME: 'milestone_theme',
  
  // UI State
  SIDEBAR_COLLAPSED: 'milestone_sidebar_collapsed',
  RESOURCE_PANEL_COLLAPSED: 'milestone_resource_panel_collapsed',
  
  // Project Order (per site)
  PROJECT_ORDER_PREFIX: 'milestone_project_order_site_',
  
  // View State (persisted by Zustand)
  VIEW_STATE: 'milestone-app-storage',
  
  // Legacy keys (for migration from old vanilla JS app)
  LEGACY_SITE_ID: 'rd_pref_site_id',
  LEGACY_VIEW: 'rd_pref_view',
  LEGACY_VIEW_MODE: 'rd_pref_view_mode',
  LEGACY_VIEW_STATE: 'milestone_view_state',
} as const;

// =============================================================================
// PROJECT ORDER STORAGE
// =============================================================================

/**
 * Get the project order for a specific site
 * Returns an array of project IDs in the user's preferred order
 */
export function getProjectOrder(siteId: number): number[] {
  const key = `${STORAGE_KEYS.PROJECT_ORDER_PREFIX}${siteId}`;
  return getLocalStorage<number[]>(key, []);
}

/**
 * Set the project order for a specific site
 */
export function setProjectOrder(siteId: number, projectIds: number[]): void {
  const key = `${STORAGE_KEYS.PROJECT_ORDER_PREFIX}${siteId}`;
  setLocalStorage(key, projectIds);
}

/**
 * Sort projects by user's preferred order (projects not in order list go at the end)
 */
export function sortProjectsByOrder<T extends { id: number }>(projects: T[], siteId: number): T[] {
  const order = getProjectOrder(siteId);
  if (order.length === 0) {
    return projects; // No custom order, return as-is
  }
  
  // Create a map of project ID to its position in the order array
  const orderMap = new Map<number, number>();
  order.forEach((id, index) => orderMap.set(id, index));
  
  // Sort projects: those in order list first (by their position), then the rest
  return [...projects].sort((a, b) => {
    const orderA = orderMap.get(a.id);
    const orderB = orderMap.get(b.id);
    
    // Both have custom order
    if (orderA !== undefined && orderB !== undefined) {
      return orderA - orderB;
    }
    // Only A has custom order - A comes first
    if (orderA !== undefined) return -1;
    // Only B has custom order - B comes first
    if (orderB !== undefined) return 1;
    // Neither has custom order - maintain original order
    return 0;
  });
}

// =============================================================================
// MIGRATION HELPERS
// =============================================================================

/**
 * Migrate data from legacy storage keys to new keys
 * Call this once during app initialization
 */
export function migrateLegacyStorage(): void {
  const migrations: [string, string][] = [
    [STORAGE_KEYS.LEGACY_SITE_ID, STORAGE_KEYS.PREF_SITE_ID],
    [STORAGE_KEYS.LEGACY_VIEW, STORAGE_KEYS.PREF_VIEW],
    [STORAGE_KEYS.LEGACY_VIEW_MODE, STORAGE_KEYS.PREF_VIEW_MODE],
  ];
  
  migrations.forEach(([oldKey, newKey]) => {
    const oldValue = localStorage.getItem(oldKey);
    if (oldValue !== null && localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, oldValue);
      console.log(`Migrated storage: ${oldKey} -> ${newKey}`);
    }
  });
}

// =============================================================================
// THEME STORAGE
// =============================================================================

/**
 * Available themes:
 * - dark: Default Milestone dark theme
 * - light: Default Milestone light theme
 * - sulzer-dark: S-Theme dark variant
 * - sulzer-light: S-Theme light variant
 */
export type Theme = 'dark' | 'light' | 'sulzer-dark' | 'sulzer-light';
export type ThemeFamily = 'default' | 'sulzer';

export interface ThemeInfo {
  id: Theme;
  name: string;
  description: string;
  family: ThemeFamily;
  mode: 'dark' | 'light';
}

export interface ThemeFamilyInfo {
  id: ThemeFamily;
  name: string;
  description: string;
}

export const THEME_FAMILIES: ThemeFamilyInfo[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'Original Milestone theme',
  },
  {
    id: 'sulzer',
    name: 'S-Theme',
    description: 'Alternative color scheme',
  },
];

export const THEMES: ThemeInfo[] = [
  {
    id: 'dark',
    name: 'Default Dark',
    description: 'Original Milestone dark theme',
    family: 'default',
    mode: 'dark',
  },
  {
    id: 'light',
    name: 'Default Light',
    description: 'Original Milestone light theme',
    family: 'default',
    mode: 'light',
  },
  {
    id: 'sulzer-dark',
    name: 'S-Theme Dark',
    description: 'Alternative dark theme',
    family: 'sulzer',
    mode: 'dark',
  },
  {
    id: 'sulzer-light',
    name: 'S-Theme Light',
    description: 'Alternative light theme',
    family: 'sulzer',
    mode: 'light',
  },
];

/**
 * Get the current theme preference
 */
export function getTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEYS.PREF_THEME);
  if (stored === 'light' || stored === 'dark' || stored === 'sulzer-dark' || stored === 'sulzer-light') {
    return stored;
  }
  // Default to dark theme
  return 'dark';
}

/**
 * Get theme info by ID
 */
export function getThemeInfo(theme: Theme): ThemeInfo {
  return THEMES.find(t => t.id === theme) || THEMES[0];
}

/**
 * Get all themes in a specific family
 */
export function getThemesByFamily(family: 'default' | 'sulzer'): ThemeInfo[] {
  return THEMES.filter(t => t.family === family);
}

/**
 * Check if theme is a dark mode theme
 */
export function isDarkTheme(theme: Theme): boolean {
  const info = getThemeInfo(theme);
  return info.mode === 'dark';
}

/**
 * Set the theme preference
 */
export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEYS.PREF_THEME, theme);
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Toggle between light and dark mode within the same theme family
 */
export function toggleThemeMode(): Theme {
  const current = getTheme();
  const currentInfo = getThemeInfo(current);
  
  // Find the opposite mode theme in the same family
  const newTheme = THEMES.find(
    t => t.family === currentInfo.family && t.mode !== currentInfo.mode
  );
  
  if (newTheme) {
    setTheme(newTheme.id);
    return newTheme.id;
  }
  
  // Fallback to simple toggle
  const fallback = current === 'dark' ? 'light' : 'dark';
  setTheme(fallback);
  return fallback;
}

/**
 * Legacy toggle function for backward compatibility
 * @deprecated Use toggleThemeMode() instead
 */
export function toggleTheme(): Theme {
  return toggleThemeMode();
}

/**
 * Get current theme family
 */
export function getThemeFamily(): ThemeFamily {
  const theme = getTheme();
  const info = getThemeInfo(theme);
  return info.family;
}

/**
 * Set theme family (switches to the same mode in the new family)
 */
export function setThemeFamily(family: ThemeFamily): Theme {
  const current = getTheme();
  const currentInfo = getThemeInfo(current);
  
  // Find the theme in the new family with the same mode
  const newTheme = THEMES.find(
    t => t.family === family && t.mode === currentInfo.mode
  );
  
  if (newTheme) {
    setTheme(newTheme.id);
    return newTheme.id;
  }
  
  // Fallback to dark theme in the family
  const fallback = THEMES.find(t => t.family === family && t.mode === 'dark');
  if (fallback) {
    setTheme(fallback.id);
    return fallback.id;
  }
  
  return current;
}

/**
 * Initialize theme from storage
 * Call this on app startup
 */
export function initTheme(): void {
  const theme = getTheme();
  document.documentElement.setAttribute('data-theme', theme);
}
