import createCache from '@emotion/cache';

/**
 * Material icons carry a few base rules (`width: 1em`, `display`, a `fill`
 * transition) that MUI injects at runtime. Prepending them to `<head>` puts
 * them before every stylesheet of the app, so a CSS Module rule on the same
 * svg (`.chevron { transition: transform … }`) wins a specificity tie.
 * This is the only Emotion configuration in the app — no theme, no `sx`.
 */
export const iconStyleCache = createCache({ key: 'mui', prepend: true });
