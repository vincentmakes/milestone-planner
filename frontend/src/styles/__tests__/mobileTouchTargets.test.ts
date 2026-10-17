/**
 * The phone breakpoint in global.css (≤ 640 px) raises buttons, inputs and
 * selects to 44 × 44 px touch targets. Checkboxes, radios and ranges are
 * excluded: a checkbox is 16 px on every device and the label row around it
 * is the touch target (UI_GUIDELINES §7). Without the exclusion the dialog
 * checkboxes rendered as 44 px squares on an iPhone while staying 16 px on a
 * desktop.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', 'global.css'), 'utf8');

/** The `@media (max-width: 640px)` block, braces balanced. */
function mobileBlock(source: string): string {
  const start = source.indexOf('@media (max-width: 640px)');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced media block');
}

describe('mobile touch targets (global.css)', () => {
  const block = mobileBlock(css);
  const touchRule = block
    .split('}')
    .find((rule) => rule.includes('min-height: 44px') && rule.includes('min-width: 44px'));

  it('raises text-like inputs and selects to 44 px', () => {
    expect(touchRule).toBeDefined();
    expect(touchRule).toMatch(/\binput:not\(/);
    expect(touchRule).toMatch(/\n\s*select\s*\{/);
  });

  it.each(['checkbox', 'radio', 'range'])('leaves %s inputs at their own size', (type) => {
    const inputSelector = touchRule!.split(',').find((sel) => /\binput:not\(/.test(sel));
    expect(inputSelector).toContain(`:not([type="${type}"])`);
  });

  it('gives the label row around a checkbox or radio the touch height instead', () => {
    expect(block).toMatch(/label:has\(> input\[type="checkbox"\]\)[\s\S]*?min-height: 44px/);
    expect(block).toMatch(/label:has\(> input\[type="radio"\]\)[\s\S]*?min-height: 44px/);
  });
});
