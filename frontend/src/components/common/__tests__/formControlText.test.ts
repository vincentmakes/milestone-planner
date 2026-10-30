/**
 * The shared form controls read the body size (UI_GUIDELINES.md §2.10).
 *
 * The text of every boxed control — Input (text and number fields, the
 * read-only DateRangeField fields), Select, and the trigger and option rows
 * of SearchableSelect / MultiSelectDropdown — is `--font-size-base`; their
 * labels are `--font-size-sm`. A number field keeps that size and shows its
 * figures in a medium weight with aligned digits. Changing the token a
 * control reads is the one lever: never a per-dialog size.
 *
 * Read through Node's fs: under Vitest a `.module.css` import is a stub.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', '..');
const css = (path: string) => readFileSync(join(SRC, path), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const match = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(sheet);
  expect(match, `${selector} not found`).not.toBeNull();
  return match![2];
}

const declared = (block: string, property: string) =>
  block.match(new RegExp(`(^|[\\s;])${property}:\\s*([^;]+);`))?.[2].trim();

describe('shared form controls', () => {
  const input = css('components/common/Input/Input.module.css');
  const select = css('components/common/Select/Select.module.css');
  const shell = css('components/common/dropdownShell.module.css');

  it.each([
    ['Input .input', input, '.input'],
    ['Select .select', select, '.select'],
    ['dropdown trigger', shell, '.trigger'],
    ['dropdown option rows', shell, '.option'],
  ])('%s reads the body size', (_name, sheet, selector) => {
    expect(declared(rule(sheet, selector), 'font-size')).toBe('var(--font-size-base)');
  });

  it.each([
    ['Input', input],
    ['Select', select],
    ['dropdown shell', shell],
  ])('the %s label reads the small size, medium weight', (_name, sheet) => {
    const label = rule(sheet, '.label');
    expect(declared(label, 'font-size')).toBe('var(--font-size-sm)');
    expect(declared(label, 'font-weight')).toBe('var(--font-weight-medium)');
  });
});

describe('the project dialog', () => {
  const modal = css('components/modals/ProjectModal.module.css');

  it('labels its groups at the controls’ label size', () => {
    expect(declared(rule(modal, '.label'), 'font-size')).toBe('var(--font-size-sm)');
  });

  it('shows number figures in a medium weight with aligned digits, at the field size', () => {
    const numbers = rule(modal, '.numberField input');
    expect(declared(numbers, 'font-weight')).toBe('var(--font-weight-medium)');
    expect(declared(numbers, 'font-variant-numeric')).toBe('tabular-nums');
    expect(declared(numbers, 'font-size')).toBeUndefined();
  });
});
