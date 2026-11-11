/**
 * utils/formula.ts — the mirror of app/services/formula.py. `FORMULA_CASES`
 * is the same table, case for case, as `tests/test_formula.py` (the length
 * pin keeps them the same size): `[expression, canonical, names]` or
 * `[expression, null, error]`.
 */
import { describe, it, expect } from 'vitest';
import { FormulaError, formulaTokens, MAX_DEPTH, MAX_FORMULA_LENGTH, nextTermName, parseFormula, readBack } from '../formula';

type Case = [string, string | null, readonly string[] | string];

const FORMULA_CASES: Case[] = [
  ['customer_weeks / (capacity_weeks * 70%)', '(customer_weeks / (capacity_weeks * 70%))', ['customer_weeks', 'capacity_weeks']],
  ['a+b*c', '(a + (b * c))', ['a', 'b', 'c']],
  ['(a+b)*c', '((a + b) * c)', ['a', 'b', 'c']],
  ['a - b - c', '((a - b) - c)', ['a', 'b', 'c']],
  ['a / b / c', '((a / b) / c)', ['a', 'b', 'c']],
  ['-a - -b', '((-a) - (-b))', ['a', 'b']],
  ['(a)', 'a', ['a']],
  ['a * a + b', '((a * a) + b)', ['a', 'b']],
  ['1 - a / b', '(1 - (a / b))', ['a', 'b']],
  ['.5*a', '(.5 * a)', ['a']],
  ['2.25 * x_1', '(2.25 * x_1)', ['x_1']],
  ['100%', '100%', []],
  ['  a\t+ b ', '(a + b)', ['a', 'b']],
  ['', null, 'Enter a formula'],
  ['   ', null, 'Enter a formula'],
  ['x'.repeat(MAX_FORMULA_LENGTH + 1), null, 'A formula has at most 200 characters'],
  ['a * 0,7', null, 'Use a point for decimals: 0.7'],
  ['a , b', null, 'Unexpected "," at position 3'],
  ['a +', null, 'The formula ends too early: something is missing at the end'],
  ['(a', null, 'Missing closing bracket )'],
  ['a)', null, 'Unexpected ")" at position 2'],
  ['a b', null, 'Unexpected "b" at position 3'],
  ['1.', null, 'Unexpected "." at position 2'],
  ['1..2', null, 'Unexpected "." at position 2'],
  ['a $ b', null, 'Unexpected "$" at position 3'],
  ['% a', null, 'Unexpected "%" at position 1'],
  ['A / B', '(a / b)', ['a', 'b']],
  ['Customer_Weeks ÷ (Capacity × 70%)', '(customer_weeks / (capacity * 70%))', ['customer_weeks', 'capacity']],
  ['('.repeat(MAX_DEPTH + 1) + 'a' + ')'.repeat(MAX_DEPTH + 1), null, 'The formula is nested too deeply'],
  ['-'.repeat(MAX_DEPTH + 1) + 'a', null, 'The formula is nested too deeply'],
];

describe('formula mirror table', () => {
  it('has the pinned length of tests/test_formula.py', () => {
    expect(FORMULA_CASES).toHaveLength(30);
  });

  it.each(FORMULA_CASES)('%s', (source, canonicalForm, expected) => {
    if (canonicalForm === null) {
      expect(() => parseFormula(source)).toThrow(FormulaError);
      expect(() => parseFormula(source)).toThrow(expected as string);
      try {
        parseFormula(source);
      } catch (err) {
        expect((err as Error).message).toBe(expected);
      }
    } else {
      const parsed = parseFormula(source);
      expect(parsed.canonical).toBe(canonicalForm);
      expect(parsed.names).toEqual(expected);
    }
  });
});

describe('readBack', () => {
  const labels = {
    customer_weeks: 'Booked weeks (has a customer)',
    capacity_weeks: 'Capacity (weeks)',
    a: 'Booked days',
    b: 'Capacity (days)',
  };

  it('says the formula in words with real operators and only the needed brackets', () => {
    expect(readBack('customer_weeks / (capacity_weeks * 70%)', labels)).toBe(
      'Booked weeks (has a customer) ÷ (Capacity (weeks) × 70 %)'
    );
    expect(readBack('a / b', labels)).toBe('Booked days ÷ Capacity (days)');
    expect(readBack('a - b + 1', labels)).toBe('Booked days − Capacity (days) + 1');
    expect(readBack('a - (b + 1)', labels)).toBe('Booked days − (Capacity (days) + 1)');
    expect(readBack('(a + b) * 2', labels)).toBe('(Booked days + Capacity (days)) × 2');
    expect(readBack('-a', labels)).toBe('−Booked days');
    expect(readBack('-(a + b)', labels)).toBe('−(Booked days + Capacity (days))');
    expect(readBack('A ÷ unknown', labels)).toBe('Booked days ÷ unknown');
    expect(readBack('a /', labels)).toBeNull();
  });
});

describe('nextTermName', () => {
  it('gives the first free letter', () => {
    expect(nextTermName([])).toBe('a');
    expect(nextTermName(['a', 'B'])).toBe('c');
    const all = Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i));
    expect(nextTermName(all)).toBe('a2');
  });
});

describe('formulaTokens', () => {
  it('gives each token with its position, or null when the text cannot be read', () => {
    expect(formulaTokens('a / 70%')?.map((t) => [t.kind, t.text, t.pos, t.length])).toEqual([
      ['name', 'a', 1, 1],
      ['op', '/', 3, 1],
      ['num', '70', 5, 2],
      ['op', '%', 7, 1],
      ['end', '', 8, 0],
    ]);
    expect(formulaTokens('a $ b')).toBeNull();
  });
});
