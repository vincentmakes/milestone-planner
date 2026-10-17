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
import rawColorAllowlist from './rawColorAllowlist.json';

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

/**
 * `var(--name, fallback)` reads of a *global* token. A fallback on a defined
 * token is dead weight that hides a typo (the test above would catch the typo;
 * the fallback would silently paint the wrong colour instead).
 */
function fallbackReads(files: string[], globalTokens: Set<string>): string[] {
  const hits: string[] = [];
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const match of line.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*,/g)) {
          if (globalTokens.has(match[1])) hits.push(`${match[1]} (${relative(SRC, file)}:${index + 1})`);
        }
      });
  }
  return hits;
}

/** Hex and rgb()/rgba() literals in a stylesheet — colours that bypass the tokens. */
const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
function rawColorCount(file: string): number {
  return (readFileSync(file, 'utf8').match(RAW_COLOR) ?? []).length;
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

  it('reads a defined token without a fallback value', () => {
    expect(fallbackReads(stylesheets, globalTokens)).toEqual([]);
  });

  it('never adds raw colour literals to a component stylesheet (ratchet)', () => {
    // rawColorAllowlist.json holds the count per *.module.css at the time the
    // ratchet was set. A file may only go down (lower its number when it
    // does); a new file starts at 0; a count that rises fails here. Shadows
    // are counted too — use the --shadow-* tokens.
    const allowlist: Record<string, number> = rawColorAllowlist;
    const over: string[] = [];
    for (const file of stylesheets.filter((f) => f.endsWith('.module.css'))) {
      const key = relative(SRC, file);
      const count = rawColorCount(file);
      const allowed = allowlist[key] ?? 0;
      if (count > allowed) over.push(`${key}: ${count} raw colours, allowlist says ${allowed}`);
    }
    expect(over).toEqual([]);
  });

  it('lets grid tracks and date inputs shrink (no bare 1fr track, min-width 0 on date inputs)', () => {
    // A `1fr` track has an implicit `min-width: auto`: it cannot shrink below
    // its content, and iOS Safari gives a date input a wide intrinsic width —
    // so two date fields in a `1fr 1fr` row overflowed and overlapped on iPad.
    // `minmax(0, 1fr)` is the track that shrinks.
    const bare: string[] = [];
    for (const file of stylesheets.filter((f) => f.endsWith('.module.css'))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const m = line.match(/grid-template-columns:\s*([^;]+)/);
          if (!m) return;
          const tracks = m[1].replace(/minmax\([^)]*\)/g, '');
          if (/(?<![\w(,])1fr\b/.test(tracks) || /repeat\(\d+,\s*1fr\)/.test(tracks)) {
            bare.push(`${relative(SRC, file)}:${index + 1}: ${m[0].trim()}`);
          }
        });
    }
    expect(bare).toEqual([]);

    const global = readFileSync(join(STYLES, 'global.css'), 'utf8');
    expect(global).toMatch(/input\[type="date"\]\s*\{[^}]*min-width:\s*0;/);
  });

  it('keeps the tokens the fixed stylesheets rely on', () => {
    for (const token of ['--accent-teal', '--accent-green-alpha', '--accent-red', '--accent-blue', '--border-subtle', '--radius-sm']) {
      expect(globalTokens.has(token), token).toBe(true);
    }
  });
});
