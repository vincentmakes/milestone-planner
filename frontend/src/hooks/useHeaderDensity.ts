/**
 * How much room the header has, as four tiers.
 *
 * The header needs its breakpoints in both CSS (hiding labels, tightening
 * gaps) and JS (deciding which controls move into the overflow menu, and two
 * things CSS cannot reach at all: how many avatars `OnlineUsers` maps over,
 * and whether the date reads "August 2026" or "Aug 2026"). CSS custom
 * properties do not work inside `@media`, so a pure-CSS approach would repeat
 * these numbers across five stylesheets and drift from whatever JS believed.
 *
 * This hook is the one definition. The header applies the tier as a
 * `data-density` attribute, so every rule selects on that rather than on a
 * width. **CSS in the header must contain no pixel breakpoints.**
 *
 * The tiers come from the width each one needs before a label truncates,
 * measured at the 2.2 type scale (text one step up, icons x1.125) on the
 * demo — admin, Gantt view, instance title "Demo Instance", site
 * "Winterthur", team filter "Whole site", one person online (each extra
 * avatar adds ~22px):
 *
 *   full      >= 1650   1613px needed: everything at full size
 *   compact   >= 1280   1399px: labels become icons, dividers go, dates shorten;
 *                                the instance title and site name ellipsize below
 *   condensed >= 1024   1031px: zoom and undo/redo move into the overflow menu;
 *                                the site selector drops to its icon below
 *   minimal    < 1024    641px: view modes, theme and What If follow them,
 *                                and the logo drops its wordmark
 *
 * Before 2.2 the same measure gave 1580 / 1374 / 1012 / 641, so only `full`
 * moved (from 1600): the other tiers' gaps grew by 20-25px, not enough to
 * give up a tier at those widths.
 *
 * Zoom and undo/redo are demoted first because both already have keyboard
 * equivalents in useKeyboardShortcuts (`+`/`-`, Ctrl+Z / Ctrl+Y). View modes
 * have none, so they stay in the bar one tier longer.
 */

import { useEffect, useState } from 'react';

export type HeaderDensity = 'full' | 'compact' | 'condensed' | 'minimal';

/** Ordered widest-first; the first match wins, anything narrower is 'minimal'. */
const TIERS: readonly (readonly [HeaderDensity, string])[] = [
  ['full', '(min-width: 1650px)'],
  ['compact', '(min-width: 1280px)'],
  ['condensed', '(min-width: 1024px)'],
] as const;

function readDensity(): HeaderDensity {
  // jsdom has no matchMedia. Falling back to the roomy layout keeps the
  // rendered DOM identical to a wide browser rather than hiding controls
  // nobody asked to hide.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'full';
  for (const [tier, query] of TIERS) {
    if (window.matchMedia(query).matches) return tier;
  }
  return 'minimal';
}

export function useHeaderDensity(): HeaderDensity {
  const [density, setDensity] = useState<HeaderDensity>(readDensity);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const lists = TIERS.map(([, query]) => window.matchMedia(query));
    // Re-reads all queries rather than trusting the one that fired, so
    // crossing two boundaries at once still lands on the right tier. Writing
    // the same string is a no-op for React.
    const onChange = () => setDensity(readDensity());

    onChange();
    lists.forEach((list) => list.addEventListener('change', onChange));
    return () => lists.forEach((list) => list.removeEventListener('change', onChange));
  }, []);

  return density;
}
