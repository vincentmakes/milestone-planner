/**
 * The timeline header (period row, day labels, events row) is
 * `--timeline-header-total` high, and the header of every left pane beside a
 * timeline reads the same token: both panes shift by the same amount, so the
 * project / staff / equipment / site rows stay level with their bars. The
 * token is declared in every theme block, like every token.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), 'utf8');

/** The body of the first `selector { … }` block of a stylesheet */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('--timeline-header-total', () => {
  const variables = read('styles', 'variables.css');
  const themes = read('styles', 'themes', 'themes.css');

  it.each([
    [':root', variables],
    ['[data-theme="light"]', variables],
    ['[data-theme="s-theme-dark"]', themes],
    ['[data-theme="s-theme-light"]', themes],
  ])('is 66 px in %s', (selector, css) => {
    expect(block(css, selector)).toMatch(/--timeline-header-total: 66px;/);
  });

  it.each([
    ['components/gantt/ProjectPanel/ProjectPanel.module.css', '.header'],
    ['components/views/StaffView/StaffView.module.css', '.panelHeader'],
    ['components/views/EquipmentView/EquipmentView.module.css', '.panelHeader'],
    ['components/views/CrossSiteView/CrossSiteView.module.css', '.panelHeader'],
    ['components/views/ArchivedView/ArchivedView.module.css', '.panelHeader'],
  ])('sizes the left-pane header of %s', (file, selector) => {
    const rule = block(read(...file.split('/')), selector);
    expect(rule).toMatch(/\bheight: var\(--timeline-header-total\);/);
    expect(rule).not.toMatch(/52px/);
  });
});
