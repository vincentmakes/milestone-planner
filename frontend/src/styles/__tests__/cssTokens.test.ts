/**
 * Every CSS custom property a stylesheet reads must be defined somewhere: as a
 * design token (`src/styles/variables.css`, the theme blocks in
 * `src/styles/themes/`, `src/styles/global.css`) or as a component-scoped
 * property the component itself sets (in its module CSS or an inline style).
 *
 * An undefined `var(--name)` fails silently: the declaration is dropped and the
 * element renders with the inherited or initial value. That is how context-menu
 * danger items lost their red and the absence dialog lost its gaps
 * (`--status-danger`, `--space-*`, `--radius-xs`, `--primary`, `--border-primary`,
 * `--accent-teal` were all read but never defined). A fallback value in the
 * `var()` call does not exempt a token: the fallback hides the typo instead of
 * fixing it. See UI_GUIDELINES.md, "Design tokens".
 *
 * Read through Node's fs rather than `import.meta.glob(..., '?raw')`: under
 * Vitest a `.module.css` import resolves to the CSS-module stub, not its text.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');
const STYLES = join(SRC, 'styles');

function filesUnder(dir: string, matches: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : filesUnder(full, matches);
    return matches(name) ? [full] : [];
  });
}
const isCss = (name: string) => name.endsWith('.css');
const isComponent = (name: string) => /\.tsx?$/.test(name);

const CSS_DEFINITION = /(--[a-zA-Z0-9-]+)\s*:/g;
/** `'--name': …`, `['--name' as string]: …` or `setProperty('--name', …)`. */
const TSX_DEFINITION =
  /(?:\[?\s*['"](--[a-zA-Z0-9-]+)['"](?:\s+as\s+\w+)?\s*\]?\s*:|setProperty\(\s*['"](--[a-zA-Z0-9-]+)['"])/g;

/**
 * The tokens a set of files defines: `--name: value` in a stylesheet (a global
 * token in `styles/`, or a component-scoped property set on its own class), or
 * an inline-style property a component scopes itself (`--cell-width`,
 * `--event-color`, `--absence-color`, …).
 */
function definedTokens(files: string[], pattern: RegExp): Set<string> {
  const defined = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) defined.add(match[1] ?? match[2]);
  }
  return defined;
}

/** `var(--name` reads, with the file and line they come from. */
function readTokens(files: string[]): Array<{ token: string; where: string }> {
  const reads: Array<{ token: string; where: string }> = [];
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const match of line.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
          reads.push({ token: match[1], where: `${relative(SRC, file)}:${index + 1}` });
        }
      });
  }
  return reads;
}

describe('CSS design tokens', () => {
  const stylesheets = filesUnder(SRC, isCss);
  const globalTokens = definedTokens(filesUnder(STYLES, isCss), CSS_DEFINITION);
  const tokens = new Set([
    ...definedTokens(stylesheets, CSS_DEFINITION),
    ...definedTokens(filesUnder(SRC, isComponent), TSX_DEFINITION),
  ]);

  it('scans the stylesheets and the design tokens', () => {
    expect(stylesheets.length).toBeGreaterThan(50);
    expect(globalTokens.has('--bg-primary')).toBe(true);
  });

  it('defines every custom property that a stylesheet reads', () => {
    const undefinedReads = readTokens(stylesheets).filter((read) => !tokens.has(read.token));
    expect(undefinedReads.map((r) => `${r.token} (${r.where})`)).toEqual([]);
  });

  it('keeps the tokens the fixed stylesheets rely on', () => {
    for (const token of ['--accent-teal', '--accent-green-alpha', '--accent-red', '--accent-blue', '--border-subtle', '--radius-sm']) {
      expect(globalTokens.has(token), token).toBe(true);
    }
  });
});
