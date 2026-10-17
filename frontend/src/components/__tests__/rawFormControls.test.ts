/**
 * Raw form controls are a ratchet.
 *
 * Every text-like `<input>` (text, email, password, number, date, search, url,
 * tel, or untyped) and every `<select>` in a component is meant to be the
 * shared `Input` / `Select` (components/common): same height, focus ring,
 * label wiring and error announcement everywhere. A handful of controls are
 * documented exceptions (UI_GUIDELINES.md §3.4): inline row-rename editors,
 * ARIA comboboxes with their own listbox, the Gantt cell editor, the header
 * site selector, the phone-only Settings section picker and the read-only
 * copy fields of the credentials dialog. `rawFormControlsAllowlist.json`
 * holds their counts per file; a count may only go down (lower it when you
 * convert one), a new file starts at 0, and a count that rises fails here.
 *
 * Read through Node's fs: the files are scanned as text, not imported.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import allowlist from './rawFormControlsAllowlist.json';

const COMPONENTS = join(__dirname, '..');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...filesUnder(path));
    } else if (name.endsWith('.tsx') && !name.endsWith('.test.tsx')) {
      out.push(path);
    }
  }
  return out;
}

/** The shared controls themselves render the one allowed raw element each. */
const SHARED = ['common/Input/Input.tsx', 'common/Select/Select.tsx'];

const TAG = /<(input|select)\b([^>]*?)>/gs;
const TEXT_LIKE = /\btype=\{?["']?(text|email|password|number|date|search|url|tel)\b/;
const OTHER_TYPE = /\btype=/;

/** Block and line comments: a doc comment may mention a <select> in prose. */
const COMMENTS = /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm;

/** Text-like inputs (typed or untyped) plus selects in one component file. */
export function rawControlCount(source: string): number {
  let count = 0;
  for (const match of source.replace(COMMENTS, '').matchAll(TAG)) {
    const [, tag, attrs] = match;
    if (tag === 'select') count += 1;
    else if (TEXT_LIKE.test(attrs) || !OTHER_TYPE.test(attrs)) count += 1;
  }
  return count;
}

describe('raw form controls (ratchet)', () => {
  const files = filesUnder(COMPONENTS).filter((f) => !SHARED.includes(relative(COMPONENTS, f)));

  it('scans the components', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('counts typed, untyped and multi-line tags, and ignores native-only inputs', () => {
    expect(rawControlCount('<input\n  type="date"\n  value={d}\n/>')).toBe(1);
    expect(rawControlCount('<input value={x} />')).toBe(1);
    expect(rawControlCount('<select value={v}><option /></select>')).toBe(1);
    expect(rawControlCount('<input type="checkbox" /><input type="range" /><input type="file" />')).toBe(0);
    expect(rawControlCount('<Input label="x" /><Select options={[]} />')).toBe(0);
    expect(rawControlCount('/** a <select> value is a string */\n// <input> here too\nconst x = 1;')).toBe(0);
  });

  it('never adds a raw text input or select to a component (ratchet)', () => {
    const allowed: Record<string, number> = allowlist;
    const over: string[] = [];
    for (const file of files) {
      const key = relative(COMPONENTS, file);
      const count = rawControlCount(readFileSync(file, 'utf8'));
      const max = allowed[key] ?? 0;
      if (count > max) over.push(`${key}: ${count} raw control(s), allowlist says ${max} — use <Input> / <Select>`);
    }
    expect(over).toEqual([]);
  });

  it('lists only files that still hold a raw control (keep the allowlist honest)', () => {
    const allowed: Record<string, number> = allowlist;
    const stale: string[] = [];
    for (const [key, max] of Object.entries(allowed)) {
      const file = join(COMPONENTS, key);
      let count = 0;
      try {
        count = rawControlCount(readFileSync(file, 'utf8'));
      } catch {
        stale.push(`${key}: file no longer exists`);
        continue;
      }
      if (count < max) stale.push(`${key}: allowlist says ${max}, file has ${count} — lower it`);
    }
    expect(stale).toEqual([]);
  });
});
