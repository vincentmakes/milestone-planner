/**
 * helpLinks: the manual's chapter per view, the home page otherwise, and
 * every chapter a page that exists under docs/user-guide/.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_HELP_URL, HELP_BASE_URL, HELP_PAGES, helpUrl } from '../helpLinks';
import type { CurrentView } from '@/types';

describe('helpUrl', () => {
  it('opens the chapter of each view', () => {
    expect(helpUrl('gantt')).toBe('https://docs-milestone.verdet.me/user-guide/gantt-charts/');
    expect(helpUrl('kanban')).toBe('https://docs-milestone.verdet.me/user-guide/kanban-board/');
    expect(helpUrl('work')).toBe('https://docs-milestone.verdet.me/user-guide/my-work/');
    expect(helpUrl('dashboards')).toBe('https://docs-milestone.verdet.me/user-guide/dashboards/');
    expect(helpUrl('staff')).toBe('https://docs-milestone.verdet.me/user-guide/staff-management/');
    expect(helpUrl('equipment')).toBe('https://docs-milestone.verdet.me/user-guide/equipment-booking/');
    expect(helpUrl('crosssite')).toBe('https://docs-milestone.verdet.me/user-guide/cross-site-view/');
  });

  it('opens the home page for a view without a chapter, or none', () => {
    expect(helpUrl('archived')).toBe(HELP_BASE_URL);
    expect(helpUrl(null)).toBe(HELP_BASE_URL);
    expect(helpUrl(undefined)).toBe(HELP_BASE_URL);
    expect(helpUrl('unknown' as CurrentView)).toBe(HELP_BASE_URL);
  });

  it('points only at pages the manual has', () => {
    const docs = resolve(__dirname, '../../../../docs');
    for (const page of Object.values(HELP_PAGES)) {
      expect(page).toMatch(/^user-guide\/[a-z-]+\/$/);
      expect(existsSync(resolve(docs, `${page.slice(0, -1)}.md`)), page).toBe(true);
    }
  });
});


describe('helpUrl with a self-hosted manual', () => {
  it('opens the same chapters under another home page', () => {
    const base = 'https://intranet.example/milestone-docs/';
    expect(helpUrl('kanban', base)).toBe('https://intranet.example/milestone-docs/user-guide/kanban-board/');
    expect(helpUrl('archived', base)).toBe(base);
    expect(HELP_BASE_URL).toBe(DEFAULT_HELP_URL);
  });
});
