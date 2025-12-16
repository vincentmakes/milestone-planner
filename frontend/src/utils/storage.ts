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
  
  // View State (persisted by Zustand)
  VIEW_STATE: 'milestone-app-storage',
  
  // Legacy keys (for migration from old vanilla JS app)
  LEGACY_SITE_ID: 'rd_pref_site_id',
  LEGACY_VIEW: 'rd_pref_view',
  LEGACY_VIEW_MODE: 'rd_pref_view_mode',
  LEGACY_VIEW_STATE: 'milestone_view_state',
} as const;

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

export type Theme = 'dark' | 'light';

/**
 * Get the current theme preference
 */
export function getTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEYS.PREF_THEME);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }
  // Default to dark theme
  return 'dark';
}

/**
 * Set the theme preference
 */
export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEYS.PREF_THEME, theme);
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Toggle between light and dark theme
 */
export function toggleTheme(): Theme {
  const current = getTheme();
  const newTheme = current === 'dark' ? 'light' : 'dark';
  setTheme(newTheme);
  return newTheme;
}

/**
 * Initialize theme from storage
 * Call this on app startup
 */
export function initTheme(): void {
  const theme = getTheme();
  document.documentElement.setAttribute('data-theme', theme);
}
