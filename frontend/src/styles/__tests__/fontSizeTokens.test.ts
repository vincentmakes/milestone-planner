/**
 * Font sizes outside the timeline views come from the type scale.
 *
 * The app reads one step larger than the five timeline views (Gantt, Staff
 * Overview, Equipment, Cross-site, Archived), which keep the compact scale
 * through the `.compact-ui` class on their root (`styles/global.css`). That
 * only works when a stylesheet reads `var(--font-size-*)`: a raw `0.75rem` or
 * `12px` stays put when the tokens move, and the screen drifts back to the
 * old size one panel at a time. So, in every `*.module.css` outside the
 * timeline directories, a `font-size` is a token (or `inherit`), or it is one
 * of the documented exceptions below:
 *
 * - counters and initials inside a fixed circle, under 11 px — 12 px text does
 *   not fit a 16 px badge, so they keep their raw size;
 * - display sizes above the scale's `xl` (the instance title, stat numerals,
 *   the admin sign-in title), which the bump leaves alone on purpose.
 *
 * A new exception goes in ALLOWED with its reason; remove an entry when its
 * line goes. See UI_GUIDELINES.md §2.10.
 *
 * Read through Node's fs: under Vitest a `.module.css` import is a stub.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');

/** The timeline views keep their compact sizes in their own stylesheets. */
const TIMELINE_DIRS = [
  'components/gantt/',
  'components/views/StaffView/',
  'components/views/EquipmentView/',
  'components/views/CrossSiteView/',
  'components/views/ArchivedView/',
];

/** `file: [raw values]` — each listed value may appear once per entry. */
const ALLOWED: Record<string, string[]> = {
  // Counters and initials in a fixed circle, under 11 px
  'components/common/NotificationBell/NotificationBell.module.css': ['9px'], // unread count, 15 px badge
  'components/views/KanbanView/KanbanCard.module.css': ['9px'], // assignee initials, 20 px avatar
  'components/common/OnlineUsers/OnlineUsers.module.css': ['10px', '10px'], // small avatar initials, "+N" chip
  'components/common/ProjectFilterDropdown/ProjectFilterDropdown.module.css': ['10px'], // active-filter count, 16 px badge
  'components/layout/Header/Header.module.css': ['10px'], // open-panels count, 16 px badge
  // Display sizes above the scale
  'components/layout/Header/InstanceTitle.module.css': ['1.25rem', '1.2rem'], // instance title
  'components/admin/SystemStatsPanel.module.css': ['1.25rem', '1.5rem'], // stat numerals
  'components/admin/TenantList.module.css': ['2rem'], // tenant count numeral
  'components/admin/AdminLogin.module.css': ['1.5rem'], // admin sign-in title
};

function moduleStylesheets(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : moduleStylesheets(full);
    return name.endsWith('.module.css') ? [full] : [];
  });
}

const COMMENTS = /\/\*[\s\S]*?\*\//g;
const FONT_SIZE = /font-size\s*:\s*([^;}]+)/g;

/** The raw (non-token) font-size values of one stylesheet, comments ignored. */
export function rawFontSizes(css: string): string[] {
  const raw: string[] = [];
  for (const match of css.replace(COMMENTS, '').matchAll(FONT_SIZE)) {
    const value = match[1].trim();
    if (value === 'inherit' || /^var\(--font-size-[a-z0-9]+\)$/.test(value)) continue;
    raw.push(value);
  }
  return raw;
}

const posix = (path: string) => path.split(sep).join('/');

describe('font sizes read the type scale outside the timelines (ratchet)', () => {
  const files = moduleStylesheets(SRC)
    .map((file) => ({ file, key: posix(relative(SRC, file)) }))
    .filter(({ key }) => !TIMELINE_DIRS.some((dir) => key.startsWith(dir)));

  it('scans the non-timeline stylesheets', () => {
    expect(files.length).toBeGreaterThan(90);
    expect(files.some(({ key }) => key.startsWith('components/gantt/'))).toBe(false);
  });

  it('accepts tokens and inherit, and reports rem and px values', () => {
    expect(
      rawFontSizes(`
        /* font-size: 14px in a comment is prose */
        .a { font-size: var(--font-size-sm); }
        .b { font-size: inherit; }
        .c { font-size: 0.75rem; }
        .d { font-size: 13px }
      `)
    ).toEqual(['0.75rem', '13px']);
  });

  it('uses a font-size token everywhere but the documented exceptions', () => {
    const unexpected: string[] = [];
    for (const { file, key } of files) {
      const allowed = [...(ALLOWED[key] ?? [])];
      for (const value of rawFontSizes(readFileSync(file, 'utf8'))) {
        const at = allowed.indexOf(value);
        if (at >= 0) allowed.splice(at, 1);
        else unexpected.push(`${key}: font-size ${value}`);
      }
    }
    expect(unexpected).toEqual([]);
  });

  it('lists no exception that is gone', () => {
    const stale: string[] = [];
    for (const [key, values] of Object.entries(ALLOWED)) {
      const found = rawFontSizes(readFileSync(join(SRC, key), 'utf8'));
      for (const value of values) {
        const at = found.indexOf(value);
        if (at >= 0) found.splice(at, 1);
        else stale.push(`${key}: ${value}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('keeps every badge exception under 11 px', () => {
    const px = Object.values(ALLOWED)
      .flat()
      .filter((value) => value.endsWith('px'))
      .map((value) => parseFloat(value));
    expect(px.every((size) => size < 11)).toBe(true);
  });
});

describe('the compact scale of the timeline views', () => {
  const globalCss = readFileSync(join(SRC, 'styles', 'global.css'), 'utf8');
  const variablesCss = readFileSync(join(SRC, 'styles', 'variables.css'), 'utf8');
  const block = (css: string, selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf('}', start));
  };
  const declared = (css: string, token: string) => css.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1];

  it('re-declares the small size tokens and the icon scale in .compact-ui', () => {
    // Custom properties resolve where they are declared: a factor on the root
    // tokens could not be undone by a child, so the scope must re-declare them.
    const compact = block(globalCss, '.compact-ui');
    expect(declared(compact, '--font-size-xs')).toBe('11px');
    expect(declared(compact, '--font-size-sm')).toBe('12px');
    expect(declared(compact, '--font-size-md')).toBe('13px');
    expect(declared(compact, '--font-size-base')).toBe('14px');
    expect(declared(compact, '--icon-scale')).toBe('1');
  });

  it('sits one step above it everywhere else', () => {
    const root = block(variablesCss, ':root');
    expect(declared(root, '--font-size-xs')).toBe('12px');
    expect(declared(root, '--font-size-sm')).toBe('13px');
    expect(declared(root, '--font-size-md')).toBe('14px');
    expect(declared(root, '--font-size-base')).toBe('15px');
    expect(declared(root, '--icon-scale')).toBe('1.125');
  });
});
