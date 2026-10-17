/**
 * Typed storage wrappers, project ordering and the theme system in
 * utils/storage.ts (STORAGE_KEYS itself is covered by storageKeys.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  STORAGE_KEYS,
  compareProjectsDefault,
  getLocalStorage,
  getProjectOrder,
  getSessionStorage,
  getTheme,
  getThemeFamily,
  getThemeInfo,
  getThemesByFamily,
  initTheme,
  isDarkTheme,
  moveProjectInOrder,
  orderSiteProjects,
  removeLocalStorage,
  removeSessionStorage,
  setLocalStorage,
  setProjectOrder,
  setSessionStorage,
  setTheme,
  setThemeFamily,
  sortProjectsByOrder,
  toggleTheme,
  toggleThemeMode,
} from '../storage';

describe('local/session storage wrappers', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips JSON values through localStorage', () => {
    expect(getLocalStorage('k', { a: 0 })).toEqual({ a: 0 });
    setLocalStorage('k', { a: 1, list: [1, 2] });
    expect(localStorage.getItem('k')).toBe('{"a":1,"list":[1,2]}');
    expect(getLocalStorage('k', null)).toEqual({ a: 1, list: [1, 2] });
    removeLocalStorage('k');
    expect(localStorage.getItem('k')).toBeNull();
  });

  it('round-trips JSON values through sessionStorage', () => {
    expect(getSessionStorage('s', 'fallback')).toBe('fallback');
    setSessionStorage('s', [3, 4]);
    expect(getSessionStorage('s', [])).toEqual([3, 4]);
    removeSessionStorage('s');
    expect(sessionStorage.getItem('s')).toBeNull();
  });

  it('returns the default and warns on unparsable JSON', () => {
    localStorage.setItem('bad', '{not json');
    sessionStorage.setItem('bad', '{not json');
    expect(getLocalStorage('bad', 42)).toBe(42);
    expect(getSessionStorage('bad', 43)).toBe(43);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('swallows quota/access errors on write and remove', () => {
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    vi.spyOn(proto, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    vi.spyOn(proto, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => setLocalStorage('x', 1)).not.toThrow();
    expect(() => removeLocalStorage('x')).not.toThrow();
    expect(() => setSessionStorage('x', 1)).not.toThrow();
    expect(() => removeSessionStorage('x')).not.toThrow();
    expect(console.warn).toHaveBeenCalledTimes(4);
  });
});

describe('project order', () => {
  const projects = [
    { id: 1, name: 'Zeta', confirmed: true, site_id: 1 },
    { id: 2, name: 'Alpha', confirmed: false, site_id: 1 },
    { id: 3, name: 'Beta', confirmed: true, site_id: 1 },
    { id: 4, name: 'Beta', confirmed: true, site_id: 1 },
    { id: 5, name: 'Archived', confirmed: true, site_id: 1, archived: true },
    { id: 6, name: 'Other site', confirmed: true, site_id: 2 },
  ];

  beforeEach(() => localStorage.clear());

  it('stores the order per site', () => {
    setProjectOrder(1, [3, 1]);
    expect(localStorage.getItem(`${STORAGE_KEYS.PROJECT_ORDER_PREFIX}1`)).toBe('[3,1]');
    expect(getProjectOrder(1)).toEqual([3, 1]);
    expect(getProjectOrder(2)).toEqual([]);
  });

  it('defaults to confirmed first, then name, then id', () => {
    expect([...projects.slice(0, 4)].sort(compareProjectsDefault).map((p) => p.id)).toEqual([
      3, 4, 1, 2,
    ]);
  });

  it('orderSiteProjects filters to the site and drops archived projects', () => {
    expect(orderSiteProjects(projects, undefined)).toEqual([]);
    expect(orderSiteProjects(projects, 1).map((p) => p.id)).toEqual([3, 4, 1, 2]);
  });

  it('applies a saved custom order, placing unknown projects after it in default order', () => {
    setProjectOrder(1, [2, 1]);
    expect(orderSiteProjects(projects, 1).map((p) => p.id)).toEqual([2, 1, 3, 4]);
  });

  it('sortProjectsByOrder returns the input untouched without a saved order', () => {
    const input = projects.slice(0, 2);
    expect(sortProjectsByOrder(input, 1)).toBe(input);
  });

  it('moveProjectInOrder places the dragged id before or after the target', () => {
    expect(moveProjectInOrder([1, 2, 3, 4], 4, 2, 'before')).toEqual([1, 4, 2, 3]);
    expect(moveProjectInOrder([1, 2, 3, 4], 1, 3, 'after')).toEqual([2, 3, 1, 4]);
    expect(moveProjectInOrder([1, 2, 3], 2, 2, 'after')).toEqual([1, 2, 3]);
    expect(moveProjectInOrder([1, 2, 3], 2, 99, 'after')).toEqual([1, 2, 3]);
  });
});

describe('themes', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to dark and ignores unknown stored values', () => {
    expect(getTheme()).toBe('dark');
    localStorage.setItem(STORAGE_KEYS.PREF_THEME, 'neon');
    expect(getTheme()).toBe('dark');
  });

  it('setTheme persists and applies data-theme; initTheme re-applies it', () => {
    setTheme('s-theme-light');
    expect(localStorage.getItem(STORAGE_KEYS.PREF_THEME)).toBe('s-theme-light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('s-theme-light');
    document.documentElement.removeAttribute('data-theme');
    initTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('s-theme-light');
  });

  it('describes themes and families', () => {
    expect(getThemeInfo('light').name).toBe('Default Light');
    expect(getThemeInfo('bogus' as never).id).toBe('dark');
    expect(getThemesByFamily('s-theme').map((t) => t.id)).toEqual(['s-theme-dark', 's-theme-light']);
    expect(isDarkTheme('s-theme-dark')).toBe(true);
    expect(isDarkTheme('light')).toBe(false);
  });

  it('toggles the mode within the current family', () => {
    expect(toggleThemeMode()).toBe('light');
    expect(getTheme()).toBe('light');
    expect(toggleTheme()).toBe('dark');
    setTheme('s-theme-dark');
    expect(toggleThemeMode()).toBe('s-theme-light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('s-theme-light');
  });

  it('switches family while keeping the mode', () => {
    setTheme('light');
    expect(getThemeFamily()).toBe('default');
    expect(setThemeFamily('s-theme')).toBe('s-theme-light');
    expect(getThemeFamily()).toBe('s-theme');
    expect(setThemeFamily('default')).toBe('light');
  });

  it('keeps the current theme for an unknown family', () => {
    setTheme('s-theme-dark');
    expect(setThemeFamily('missing' as never)).toBe('s-theme-dark');
  });
});
