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
  // Preferences. The remembered site, view mode, current view and panel
  // collapse flags live in the Zustand persist keys below.
  PREF_THEME: 'milestone_theme',

  // Project Order (per site)
  PROJECT_ORDER_PREFIX: 'milestone_project_order_site_',

  // Dismissed due-soon/overdue reminders. These are derived in the browser
  // rather than stored server-side, so their dismissals live here.
  KANBAN_DUE_DISMISSED: 'milestone_kanban_due_dismissed',

  // Zustand persist() keys (documentation of record — the stores declare
  // these inline in their persist config; keep this list in sync)
  ZUSTAND_APP_STORE: 'milestone-app-storage-v3',
  ZUSTAND_VIEW_STORE: 'milestone-view-storage-v1',
  ZUSTAND_CUSTOM_COLUMN_STORE: 'milestone-custom-columns-storage-v1',
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

type OrderableProject = { id: number; confirmed?: boolean; name: string };

/**
 * The default project order: confirmed first, then name, then id. The id makes
 * it total, so equal names never fall back to whatever order the server sent.
 */
export function compareProjectsDefault(a: OrderableProject, b: OrderableProject): number {
  if (!!a.confirmed !== !!b.confirmed) return a.confirmed ? -1 : 1;
  return a.name.localeCompare(b.name) || a.id - b.id;
}

/**
 * Site projects in the order the Gantt shows them.
 *
 * Filters to the site, drops archived projects, then applies the user's custom
 * order if one exists, falling back to confirmed-first-then-name. The Gantt and
 * the Kanban board must agree, so both call this rather than each re-deriving
 * the rule.
 */
export function orderSiteProjects<
  T extends { id: number; site_id?: number | null; archived?: boolean; confirmed?: boolean; name: string },
>(projects: T[], siteId: number | undefined): T[] {
  if (siteId === undefined) return [];

  const siteProjects = projects.filter((p) => p.site_id === siteId && !p.archived);

  if (getProjectOrder(siteId).length > 0) {
    return sortProjectsByOrder(siteProjects, siteId);
  }

  return [...siteProjects].sort(compareProjectsDefault);
}

/**
 * Sort projects by user's preferred order. Projects not in the order list go
 * at the end, in the default order -- never in the order the server returned
 * them, which changes as their dates move.
 */
export function sortProjectsByOrder<T extends OrderableProject>(projects: T[], siteId: number): T[] {
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
    // Neither has custom order
    return compareProjectsDefault(a, b);
  });
}

/**
 * Move `fromId` next to `targetId` in a list of project ids, returning a new
 * list. `ids` should be the order on screen, so projects never saved into a
 * custom order are placed exactly where the user dropped them.
 */
export function moveProjectInOrder(
  ids: number[],
  fromId: number,
  targetId: number,
  position: 'before' | 'after'
): number[] {
  if (fromId === targetId) return [...ids];
  const without = ids.filter((id) => id !== fromId);
  const targetIndex = without.indexOf(targetId);
  if (targetIndex === -1) return [...ids];
  without.splice(position === 'before' ? targetIndex : targetIndex + 1, 0, fromId);
  return without;
}

// =============================================================================
// THEME STORAGE
// =============================================================================

/**
 * Available themes:
 * - dark: Default Milestone dark theme
 * - light: Default Milestone light theme
 * - s-theme-dark: S-Theme dark variant
 * - s-theme-light: S-Theme light variant
 */
export type Theme = 'dark' | 'light' | 's-theme-dark' | 's-theme-light';
export type ThemeFamily = 'default' | 's-theme';

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
    id: 's-theme',
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
    id: 's-theme-dark',
    name: 'S-Theme Dark',
    description: 'Alternative dark theme',
    family: 's-theme',
    mode: 'dark',
  },
  {
    id: 's-theme-light',
    name: 'S-Theme Light',
    description: 'Alternative light theme',
    family: 's-theme',
    mode: 'light',
  },
];

/**
 * Get the current theme preference
 */
export function getTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEYS.PREF_THEME);
  if (stored === 'light' || stored === 'dark' || stored === 's-theme-dark' || stored === 's-theme-light') {
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
export function getThemesByFamily(family: 'default' | 's-theme'): ThemeInfo[] {
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
