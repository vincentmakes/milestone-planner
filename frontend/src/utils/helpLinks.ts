/**
 * The online manual (2.6.0): its public address and the chapter of each view,
 * for the *Help* entry of the profile menu (`layout/Header/UserMenu`).
 *
 * The manual is the MkDocs site built from `docs/` (`site_url` in
 * `mkdocs.yml`); each chapter is a page under `user-guide/`. The chapter
 * paths are relative, so a copy of the manual hosted elsewhere -- the
 * instance setting `help_url` (Settings → Features & defaults, read with
 * `helpBaseUrl` in `instanceSettings.ts`) -- opens the same chapters. A view
 * without a chapter of its own (the archived projects) opens the home page.
 */

import type { CurrentView } from '@/types';

/** The public manual's home page: the default of `help_url` (`DEFAULT_HELP_URL` on the server too). */
export const DEFAULT_HELP_URL = 'https://docs-milestone.verdet.me/';

/** The former name of `DEFAULT_HELP_URL`. */
export const HELP_BASE_URL = DEFAULT_HELP_URL;

/** The manual's chapter of a view, relative to the manual's home page (pages of `docs/user-guide/`). */
export const HELP_PAGES: Readonly<Partial<Record<CurrentView, string>>> = {
  gantt: 'user-guide/gantt-charts/',
  kanban: 'user-guide/kanban-board/',
  work: 'user-guide/my-work/',
  dashboards: 'user-guide/dashboards/',
  staff: 'user-guide/staff-management/',
  equipment: 'user-guide/equipment-booking/',
  crosssite: 'user-guide/cross-site-view/',
};

/**
 * The manual's page for `view` under `baseUrl` (a home page ending in `/`,
 * `helpBaseUrl`'s answer): its chapter, the home page otherwise.
 */
export function helpUrl(view: CurrentView | null | undefined, baseUrl: string = DEFAULT_HELP_URL): string {
  const page = view ? HELP_PAGES[view] : undefined;
  return page ? `${baseUrl}${page}` : baseUrl;
}
