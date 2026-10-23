/**
 * Every icon is a Material icon drawn through `components/common/Icon`.
 *
 * An inline `<svg>` in a component is either an icon that belongs in
 * `common/Icon/icons.ts` or one of the few drawings listed in
 * `noInlineIconsAllowlist.json` (the Gantt dependency arrows and the
 * Microsoft logo), each with the reason it stays. A new file with an
 * `<svg>` fails here, and so does an allowlist entry that no longer draws
 * one (remove it). Tests are not scanned.
 *
 * Read through Node's fs: the files are scanned as text, not imported.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import allowlist from './noInlineIconsAllowlist.json';

const SRC = join(__dirname, '..', '..');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'test') continue;
      out.push(...filesUnder(path));
    } else if (name.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** Block and line comments: a doc comment may mention an <svg> in prose. */
const COMMENTS = /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm;

/** Whether a component source draws an inline svg element. */
export function hasInlineSvg(source: string): boolean {
  return /<svg[\s>/]/.test(source.replace(COMMENTS, ''));
}

const key = (file: string) => relative(SRC, file).split(sep).join('/');

describe('no inline icons', () => {
  const files = filesUnder(SRC);

  it('scans the sources', () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it('finds single- and multi-line svg tags and ignores comments and components', () => {
    expect(hasInlineSvg('<svg width="12" viewBox="0 0 24 24" />')).toBe(true);
    expect(hasInlineSvg('<svg\n  width="12"\n>\n</svg>')).toBe(true);
    expect(hasInlineSvg('<svg>')).toBe(true);
    expect(hasInlineSvg('/** an <svg> here */\n// <svg> there\nconst x = 1;')).toBe(false);
    expect(hasInlineSvg('<Icon icon={EditIcon} /><SvgIcon />')).toBe(false);
  });

  it('draws svg only in the allowlisted files', () => {
    const offenders = files
      .filter((file) => hasInlineSvg(readFileSync(file, 'utf8')))
      .map(key)
      .filter((file) => !(file in allowlist));
    expect(offenders).toEqual([]);
  });

  it('lists only files that still draw an svg', () => {
    const stale = Object.keys(allowlist).filter((file) => {
      const path = join(SRC, ...file.split('/'));
      try {
        return !hasInlineSvg(readFileSync(path, 'utf8'));
      } catch {
        return true;
      }
    });
    expect(stale).toEqual([]);
  });
});
