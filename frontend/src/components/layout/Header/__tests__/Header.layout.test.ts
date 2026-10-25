/**
 * The header's layout rules (2.1.0 fix: on a phone the date controls drew
 * over the icons on the right, and from 1024 to 1280px "Today" hid behind
 * the view-mode buttons). jsdom does no layout, so these pin the CSS rules
 * that make the bar fit — checked in a browser at 400 / 480 / 640 / 1024 /
 * 1280 / 1440 / 1600px when they were written:
 *
 * - the centre takes its content as basis and never goes below it, so the
 *   left (site name, instance title) yields instead of the date controls
 *   overflowing onto their neighbours;
 * - the date navigator can shrink (its label is a 120px *basis*, down to its
 *   own text), its arrow buttons and Today cannot;
 * - the team trigger without its label and the instance title do not push
 *   past their box;
 * - phones (the global 640px breakpoint, the only width the header CSS may
 *   name) get a two-row grid: logo and actions, then the site and team
 *   selectors and the date controls.
 *
 * Read through Node's fs: under Vitest a `.module.css` import is a stub.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..');
const css = (file: string) => readFileSync(join(DIR, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector is exactly `selector` (outside any @media). */
function rule(text: string, selector: string): string {
  const flat = text.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const match = flat.match(new RegExp(`(^|\\n|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`No rule for ${selector}`);
  return match[2];
}

/** The body of the one `@media (max-width: 640px)` block. */
function mobileBlock(text: string): string {
  const start = text.indexOf('@media (max-width: 640px)');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error('Unclosed @media block');
}

describe('Header layout rules', () => {
  const header = css('Header.module.css');

  it('names no width but the global mobile breakpoint', () => {
    const media = header.match(/@media[^{]*/g) ?? [];
    expect(media.map((m) => m.trim())).toEqual(['@media (max-width: 640px)']);
  });

  it('lets the centre share a shortfall without going below its content', () => {
    const center = rule(header, '.center');
    expect(center).toMatch(/flex:\s*1 1 auto;/);
    expect(center).not.toMatch(/min-width/);
  });

  it('lets the date navigator yield, but never its buttons or Today', () => {
    const nav = css('DateNavigation.module.css');
    expect(rule(nav, '.navigation')).toMatch(/min-width:\s*0;/);
    const label = rule(nav, '.periodLabel');
    expect(label).toMatch(/flex:\s*0 1 120px;/);
    // A `width` would count as the label's min-content and make it rigid
    expect(label).not.toMatch(/(^|[^-])width:/);
    expect(label).not.toMatch(/min-width/);
    expect(rule(nav, '.navButton')).toMatch(/flex-shrink:\s*0;/);
    expect(rule(nav, '.todayButton')).toMatch(/flex-shrink:\s*0;/);
  });

  it('keeps each Panels toggle label on one line', () => {
    // "Staff & Calendar" wrapped onto two lines in the 220px dropdown: the
    // labels never wrap, so their width sizes the (shrink-to-fit) dropdown.
    expect(rule(header, '.panelToggleBtn')).toMatch(/white-space:\s*nowrap;/);
    expect(rule(header, '.panelsDropdown')).toMatch(/min-width:\s*220px;/);
    expect(rule(header, '.panelsDropdown')).not.toMatch(/(^|[^-])width:/);
  });

  it('keeps the label-less team trigger whole and lets the instance title truncate', () => {
    expect(css('TeamSelector.module.css')).toMatch(
      /\[data-density\]:not\(\[data-density='full'\]\) \.wrapper \{\s*flex-shrink:\s*0;\s*\}/
    );
    expect(rule(css('InstanceTitle.module.css'), '.container')).toMatch(/min-width:\s*0;/);
  });

  it('lays a phone header out on two rows: logo and actions, then selectors and dates', () => {
    const mobile = mobileBlock(header);
    expect(mobile).toMatch(/\.header \{[^}]*display:\s*grid;[^}]*height:\s*auto;/);
    expect(mobile).toMatch(/grid-template-columns:\s*minmax\(0, max-content\) auto minmax\(min-content, 1fr\);/);
    expect(mobile).toMatch(/\.left \{\s*display:\s*contents;\s*\}/);
    expect(mobile).toMatch(/\.logo \{\s*grid-area:\s*1 \/ 1;\s*\}/);
    expect(mobile).toMatch(/\.right \{\s*grid-area:\s*1 \/ 2 \/ 2 \/ 4;/);
    expect(mobile).toMatch(/\.left > :not\(\.logo\) \{\s*grid-row:\s*2;\s*min-width:\s*0;\s*\}/);
    expect(mobile).toMatch(/\.center \{\s*grid-area:\s*2 \/ 3;/);
  });
});
