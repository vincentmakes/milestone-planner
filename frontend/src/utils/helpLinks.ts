/**
 * Where Help goes (2.6.0). The *Help* entry of the profile menu
 * (`layout/Header/UserMenu`) opens one address as it is, nothing appended:
 * the instance setting `help_url` (Settings → Features & defaults, read with
 * `helpAddress` in `instanceSettings.ts`) -- the manual's home page, a copy
 * hosted elsewhere, or the manual's PDF on a file share such as SharePoint,
 * whose link carries a query string -- or the public manual when none is set.
 *
 * Only the widget editor's *How calculations work* points into a chapter, and
 * only of the public manual (`calculationsHelpUrl`).
 */

/** The public manual's home page: the default of `help_url` (`DEFAULT_HELP_URL` on the server too). */
export const DEFAULT_HELP_URL = 'https://docs-milestone.verdet.me/';

/** The public manual's chapter on calculated widgets, relative to its home page. */
export const CALCULATIONS_HELP_PAGE = 'user-guide/dashboards/#calculated-widgets';

/**
 * The address *How calculations work* opens: the custom address Help opens
 * when one is set (`customHelpUrl`), as it is; otherwise the public manual's
 * chapter on calculated widgets.
 */
export function calculationsHelpUrl(customAddress: string | null): string {
  return customAddress ?? `${DEFAULT_HELP_URL}${CALCULATIONS_HELP_PAGE}`;
}
