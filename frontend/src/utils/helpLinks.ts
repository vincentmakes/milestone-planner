/**
 * The online manual (2.6.0): its address and the chapter of each view, for
 * the *Help* entry of the profile menu (`layout/Header/UserMenu`).
 *
 * The manual is the MkDocs site built from `docs/` (`site_url` in
 * `mkdocs.yml`); each chapter is a page under `user-guide/`. A view without
 * a chapter of its own (the archived projects) opens the home page.
 */

import type { CurrentView } from '@/types';

/** The online manual's home page. */
export const HELP_BASE_URL = 'https://docs-milestone.verdet.me/';

/** The manual's chapter of a view, relative to `HELP_BASE_URL` (pages of `docs/user-guide/`). */
export const HELP_PAGES: Readonly<Partial<Record<CurrentView, string>>> = {
  gantt: 'user-guide/gantt-charts/',
  kanban: 'user-guide/kanban-board/',
  work: 'user-guide/my-work/',
  dashboards: 'user-guide/dashboards/',
  staff: 'user-guide/staff-management/',
  equipment: 'user-guide/equipment-booking/',
  crosssite: 'user-guide/cross-site-view/',
};

/** The manual's page for `view`: its chapter, the home page otherwise. */
export function helpUrl(view: CurrentView | null | undefined): string {
  const page = view ? HELP_PAGES[view] : undefined;
  return page ? `${HELP_BASE_URL}${page}` : HELP_BASE_URL;
}
