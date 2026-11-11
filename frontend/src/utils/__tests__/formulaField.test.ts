/**
 * utils/formulaField.ts — the formula field's pills (carried through edits
 * like the mention field's anchors), its suggestions, the recognition of a
 * measure typed by hand, the did-you-mean, the problems in plain words, and
 * the conversions between the field and the stored formula, both ways.
 */
import { describe, it, expect } from 'vitest';
import {
  activeWord,
  clickToFilter,
  closestMeasure,
  DECIMALS,
  editDistance,
  EMPTY_BRACKETS,
  EMPTY_FIELD,
  fieldFromFormula,
  fieldProblem,
  formulaFromField,
  insertPill,
  isPillIntact,
  matchMeasures,
  measureOptions,
  MISSING_CLOSE,
  notAMeasure,
  PERCENT_AFTER_NUMBER,
  pillAt,
  recogniseMeasures,
  reconcilePills,
  relabelPill,
  segmentField,
  readField,
  STRAY_CLOSE,
  TOO_LONG_FIELD,
  TOO_MANY_MEASURES,
} from '../formulaField';
import type { FieldPill, FieldState } from '../formulaField';
import type { Measure, MetricTerm } from '@/types';

const OPTIONS = measureOptions();
const pill = (start: number, text: string, measure: Measure, extra: Partial<FieldPill> = {}): FieldPill => ({
  key: start + 1000,
  start,
  text,
  measure,
  ...extra,
});

/** "Booked weeks / Capacity (weeks)" with both pills. */
const ratio = (): FieldState => ({
  text: 'Booked weeks / Capacity (weeks)',
  pills: [pill(0, 'Booked weeks', 'booked_weeks'), pill(15, 'Capacity (weeks)', 'capacity_weeks')],
});

describe('pills through edits', () => {
  it('keeps a pill before an edit, shifts one after it, drops one the edit touches', () => {
    const state = ratio();
    // Before both: shifted.
    const before = '(Booked weeks / Capacity (weeks)';
    expect(reconcilePills(state.text, before, state.pills).map((p) => p.start)).toEqual([1, 16]);
    // Between them: the first stays, the second moves.
    const between = 'Booked weeks // Capacity (weeks)';
    expect(reconcilePills(state.text, between, state.pills).map((p) => p.start)).toEqual([0, 16]);
    // Inside the first: dropped, the second kept.
    const inside = 'Booked xweeks / Capacity (weeks)';
    expect(reconcilePills(state.text, inside, state.pills).map((p) => p.measure)).toEqual(['capacity_weeks']);
    // A letter glued to the end demotes it.
    const glued = 'Booked weeksx / Capacity (weeks)';
    expect(reconcilePills(state.text, glued, state.pills).map((p) => p.measure)).toEqual(['capacity_weeks']);
    // No change: intact pills only.
    expect(reconcilePills(state.text, state.text, state.pills)).toHaveLength(2);
    expect(isPillIntact('a', { start: 0, text: '' })).toBe(false);
    expect(isPillIntact('ab', { start: 1, text: 'bc' })).toBe(false);
  });

  it('splits the field into text and pill runs, and finds the pill at the caret', () => {
    const state = { ...ratio(), text: ratio().text + ' * 2' };
    expect(segmentField(state).map((s) => [s.kind, s.text])).toEqual([
      ['pill', 'Booked weeks'],
      ['text', ' / '],
      ['pill', 'Capacity (weeks)'],
      ['text', ' * 2'],
    ]);
    // Overlapping pills: the first wins.
    expect(segmentField({ text: 'Booked weeks', pills: [pill(0, 'Booked weeks', 'booked_weeks'), pill(0, 'Booked weeks', 'booked_days')] })).toHaveLength(1);
    expect(pillAt(state, 3)?.measure).toBe('booked_weeks');
    expect(pillAt(state, 0)).toBeNull();
    expect(pillAt(state, 0, true)?.measure).toBe('booked_weeks');
    expect(pillAt(state, 13)).toBeNull();
  });

  it('reads the field with real operator signs, the pills as they show', () => {
    const goal = { text: 'Booked weeks / (Capacity (weeks) * 70%) - 2', pills: [pill(0, 'Booked weeks', 'booked_weeks'), pill(16, 'Capacity (weeks)', 'capacity_weeks')] };
    expect(readField(goal)).toBe('Booked weeks ÷ (Capacity (weeks) × 70 %) − 2');
    // A pill's own text is never rewritten: a hyphen in a name stays one.
    expect(readField({ text: 'Booked weeks · R-and-D + 1', pills: [pill(0, 'Booked weeks · R-and-D', 'booked_weeks')] })).toBe(
      'Booked weeks · R-and-D + 1'
    );
  });

  it('inserts a pill with the spaces it needs and puts the caret after it', () => {
    const { state, caret } = insertPill({ text: '2*', pills: [] }, { start: 2, end: 2 }, { measure: 'booked_days' }, 'Booked days');
    expect(state.text).toBe('2* Booked days ');
    expect(state.pills[0]).toMatchObject({ start: 3, text: 'Booked days', measure: 'booked_days' });
    expect(caret).toBe(15);
    // After a bracket no space; before an existing space none added.
    const inBrackets = insertPill({ text: '( / 2', pills: [] }, { start: 1, end: 1 }, { measure: 'booked_days' }, 'Booked days');
    expect(inBrackets.state.text).toBe('(Booked days / 2');
    // Replacing a typed word.
    const replaced = insertPill({ text: 'a / capcity', pills: [] }, { start: 4, end: 11 }, { measure: 'capacity_weeks' }, 'Capacity (weeks)');
    expect(replaced.state.text).toBe('a / Capacity (weeks) ');
  });

  it('relabels a pill when its filters change, shifting the pills after it', () => {
    const state = ratio();
    const next = relabelPill(state, 1000, 'Booked weeks · Has a customer', { filters: { has_customer: true } });
    expect(next.text).toBe('Booked weeks · Has a customer / Capacity (weeks)');
    expect(next.pills[0]).toMatchObject({ text: 'Booked weeks · Has a customer', filters: { has_customer: true } });
    expect(next.pills[1].start).toBe(32);
    expect(relabelPill(state, 1, 'x', {})).toBe(state);
  });
});

describe('suggestions', () => {
  it('finds the word being typed, back to an operator or a pill', () => {
    const state: FieldState = { text: 'Booked weeks / cap', pills: [pill(0, 'Booked weeks', 'booked_weeks')] };
    expect(activeWord(state, 18)).toEqual({ start: 15, end: 18, query: 'cap' });
    expect(activeWord({ text: 'booked we', pills: [] }, 9)?.query).toBe('booked we');
    expect(activeWord(state, 5)).toBeNull(); // inside a pill
    expect(activeWord(state, 14)).toBeNull(); // after an operator and a space
    expect(activeWord({ text: '2a', pills: [] }, 2)).toBeNull(); // glued to a number
  });

  it('matches names starting with the text first, then containing it, family by family', () => {
    expect(matchMeasures(OPTIONS, 'cap').map((o) => o.label)).toEqual(['Capacity (days)', 'Capacity (weeks)']);
    const weeks = matchMeasures(OPTIONS, 'WEEKS').map((o) => o.label);
    expect(weeks).toContain('Booked weeks');
    expect(weeks).toContain('Capacity (weeks)');
    const projects = matchMeasures(OPTIONS, 'pro').map((o) => o.label);
    expect(projects.indexOf('Projects')).toBeLessThan(projects.indexOf('Project weeks') + 1);
    expect(matchMeasures(OPTIONS, '  ')).toHaveLength(OPTIONS.length);
    expect(OPTIONS.find((o) => o.measure === 'capacity_weeks')?.group).toBe('Capacity');
    expect(measureOptions((m) => m !== 'capacity_weeks').some((o) => o.measure === 'capacity_weeks')).toBe(false);
    expect(OPTIONS.some((o) => o.measure === 'utilisation')).toBe(false);
  });

  it('turns a full name typed by hand into a pill once the user moves on', () => {
    const typed: FieldState = { text: 'booked weeks / 2', pills: [] };
    // The caret still on its end: not yet.
    expect(recogniseMeasures({ text: 'booked weeks', pills: [] }, OPTIONS, 12).pills).toEqual([]);
    const done = recogniseMeasures(typed, OPTIONS, 16);
    expect(done.text).toBe('booked weeks / 2');
    expect(done.pills).toEqual([expect.objectContaining({ start: 0, text: 'booked weeks', measure: 'booked_weeks' })]);
    // The longest name wins; on blur (null caret) even at the end.
    const capacity = recogniseMeasures({ text: '(Capacity (Weeks)', pills: [] }, OPTIONS, null);
    expect(capacity.pills[0]).toMatchObject({ text: 'Capacity (Weeks)', measure: 'capacity_weeks' });
    // Glued to a word: left alone.
    expect(recogniseMeasures({ text: 'xbooked weeks ', pills: [] }, OPTIONS, null).pills).toEqual([]);
  });

  it('suggests the closest measure for a mistyped word', () => {
    expect(editDistance('capcity', 'capacity')).toBe(1);
    expect(editDistance('', 'ab')).toBe(2);
    expect(closestMeasure('capcity', OPTIONS, 'weeks')?.label).toBe('Capacity (weeks)');
    expect(closestMeasure('capcity', OPTIONS)?.label).toBe('Capacity (days)');
    expect(closestMeasure('booked wekks', OPTIONS)?.label).toBe('Booked weeks');
    expect(closestMeasure('book', OPTIONS)?.label).toBe('Booked days');
    expect(closestMeasure('volume', OPTIONS)?.label).toBe('Project volume');
    expect(closestMeasure('zzzzzz', OPTIONS)).toBeNull();
    expect(closestMeasure('  ', OPTIONS)).toBeNull();
    expect(clickToFilter('Booked weeks')).toBe('Booked weeks: click to filter');
  });
});

describe('field problems', () => {
  const booked = (text: string, at = 0): FieldState => ({ text, pills: [pill(at, 'Booked weeks', 'booked_weeks')] });

  it.each([
    [{ text: '  ', pills: [] }, EMPTY_FIELD],
    [{ text: '2 * 3', pills: [] }, EMPTY_FIELD],
    [booked('Booked weeks * 0,7'), DECIMALS],
    [booked('Booked weeks * 1.'), DECIMALS],
    [booked('Booked weeks * 1.2.3'), DECIMALS],
    [booked('(Booked weeks', 1), MISSING_CLOSE],
    [booked('Booked weeks /'), 'Something is missing after ÷'],
    [booked('Booked weeks * -'), 'Something is missing after −'],
    [booked('Booked weeks * ()'), EMPTY_BRACKETS],
    [booked('Booked weeks ()'), 'An operator is missing between Booked weeks and ('],
    [booked('(Booked weeks + )', 1), 'Something is missing after +'],
    [booked('Booked weeks )'), STRAY_CLOSE],
    [booked('Booked weeks %'), PERCENT_AFTER_NUMBER],
    [booked('Booked weeks * / 2'), 'Something is missing before ÷'],
    [booked('Booked weeks 2'), 'An operator is missing between Booked weeks and 2'],
    [booked('Booked weeks $ 2'), '"$" cannot be used in a formula'],
    [booked('Booked weeks / capcity'), notAMeasure('capcity', 'Capacity (weeks)')],
    [booked('Booked weeks / zzzzzz'), notAMeasure('zzzzzz', null)],
    [booked('Booked weeks * 2 ×'), 'Something is missing after ×'],
    [booked('Booked weeks' + ' + 1'.repeat(60)), TOO_LONG_FIELD],
  ])('%#: %o', (state, message) => {
    expect(fieldProblem(state as FieldState, OPTIONS)?.message).toBe(message);
  });

  it('says the nesting is too deep, and that a formula has at most six measures', () => {
    expect(fieldProblem(booked('-'.repeat(21) + 'Booked weeks', 21), OPTIONS)?.message).toBe('The formula is nested too deeply');
    const measures: Measure[] = ['booked_days', 'booked_weeks', 'project_count', 'phase_count', 'capacity_days', 'capacity_weeks', 'project_weeks'];
    let text = '';
    const pills: FieldPill[] = [];
    measures.forEach((m, i) => {
      if (i) text += ' + ';
      pills.push(pill(text.length, m, m));
      text += m;
    });
    expect(fieldProblem({ text, pills }, OPTIONS)?.message).toBe(TOO_MANY_MEASURES);
  });

  it('points at the mistyped word and its suggestion', () => {
    const problem = fieldProblem(booked('Booked weeks / capcity'), OPTIONS);
    expect(problem?.word).toEqual({
      start: 15,
      end: 22,
      text: 'capcity',
      suggestion: expect.objectContaining({ measure: 'capacity_weeks' }),
    });
    expect(fieldProblem(booked('Booked weeks'), OPTIONS)).toBeNull();
  });
});

describe('field <-> formula', () => {
  const label = (t: MetricTerm) =>
    t.measure === 'booked_weeks' && t.filters?.has_customer ? 'Booked weeks · Has a customer' : t.measure === 'booked_weeks' ? 'Booked weeks' : 'Capacity (weeks)';

  it('names the terms in order of first appearance, sharing one between equal pills', () => {
    const text = 'Booked weeks · Has a customer / (Capacity (weeks) × 70%) + Booked weeks · Has a customer - Booked weeks';
    const a = text.indexOf('Booked weeks · Has a customer');
    const c = text.indexOf('Capacity');
    const a2 = text.lastIndexOf('Booked weeks · Has a customer');
    const b = text.lastIndexOf('Booked weeks');
    const state: FieldState = {
      text,
      pills: [
        pill(a, 'Booked weeks · Has a customer', 'booked_weeks', { filters: { has_customer: true } }),
        pill(c, 'Capacity (weeks)', 'capacity_weeks', { total: true }),
        pill(a2, 'Booked weeks · Has a customer', 'booked_weeks', { filters: { has_customer: true }, key: 77 }),
        pill(b, 'Booked weeks', 'booked_weeks'),
      ],
    };
    const read = formulaFromField(state, OPTIONS);
    expect(read).toEqual({
      formula: {
        expression: 'a / (b * 70%) + a - c',
        terms: [
          { name: 'a', measure: 'booked_weeks', filters: { has_customer: true } },
          { name: 'b', measure: 'capacity_weeks', filters: {}, total: true },
          { name: 'c', measure: 'booked_weeks', filters: {} },
        ],
      },
    });
  });

  it('round-trips: field -> formula -> field -> formula', () => {
    const formula = {
      expression: 'customer_weeks / (capacity_weeks * 70%)',
      terms: [
        { name: 'customer_weeks', measure: 'booked_weeks' as const, filters: { has_customer: true } },
        { name: 'capacity_weeks', measure: 'capacity_weeks' as const, total: true },
      ],
    };
    const field = fieldFromFormula(formula, label);
    expect(field.text).toBe('Booked weeks · Has a customer / (Capacity (weeks) * 70%)');
    expect(field.pills.map((p) => [p.start, p.measure, p.filters, p.total])).toEqual([
      [0, 'booked_weeks', { has_customer: true }, undefined],
      [33, 'capacity_weeks', undefined, true],
    ]);
    const back = formulaFromField(field, OPTIONS);
    expect(back).toEqual({
      formula: {
        expression: 'a / (b * 70%)',
        terms: [
          { name: 'a', measure: 'booked_weeks', filters: { has_customer: true } },
          { name: 'b', measure: 'capacity_weeks', filters: {}, total: true },
        ],
      },
    });
    const again = fieldFromFormula((back as { formula: typeof formula }).formula, label);
    expect(again.text).toBe(field.text);
  });

  it('keeps a name no term has, and an unreadable expression, as text', () => {
    expect(fieldFromFormula({ expression: 'a + x', terms: [{ name: 'a', measure: 'booked_weeks' }] }, label).text).toBe(
      'Booked weeks + x'
    );
    expect(fieldFromFormula({ expression: 'a $', terms: [] }, label)).toEqual({ text: 'a $', pills: [] });
    expect(fieldFromFormula({ expression: 'A ÷ 2', terms: [{ name: 'a', measure: 'booked_weeks' }] }, label).text).toBe(
      'Booked weeks ÷ 2'
    );
  });
});
