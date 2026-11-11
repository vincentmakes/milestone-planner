/**
 * The formula field of a calculated widget (2.6.0): one text field in which a
 * measure is a *pill* — text plus an anchor carrying the measure, its filters
 * and its *total* flag — and everything else (numbers, `+ - * /`, `×`, `÷`,
 * brackets, `%`) is typed.
 *
 * The technique is the @-mention field's (`utils/mentions.ts`): a pill is an
 * anchor at a character offset, carried across edits by the same
 * prefix/suffix diff (`diffEdit`) and dropped when an edit touches it, so a
 * pill never re-attaches to other text. Nothing here touches the DOM.
 *
 * The field is converted to the stored `formula` (`formulaFromField`) and
 * back (`fieldFromFormula`): pills become terms named `a`, `b`, … in order of
 * first appearance (two pills of the same measure, filters and total flag
 * share one term); the names are internal — a stored formula with longer
 * names (`customer_weeks`) loads the same way. Problems are told in the
 * field's own words (`fieldProblem`): a word that is not a measure with a
 * suggestion, a missing bracket, something missing after an operator.
 */

import type { Measure, MetricFormula, MetricTerm } from '@/types';
import { diffEdit } from './mentions';
import {
  DECIMAL_COMMA_DETAIL,
  ENDS_EARLY_DETAIL,
  FormulaError,
  formulaTokens,
  MAX_FORMULA_LENGTH,
  nextTermName,
  OPERATOR_SIGNS,
  parseFormula,
  TOO_DEEP_DETAIL,
  TOO_LONG_DETAIL,
  UNCLOSED_DETAIL,
} from './formula';
import { FAMILY_LABELS, MAX_FORMULA_TERMS, MEASURES, measureFamily, TERM_MEASURES } from './metrics';

export type TermFilters = MetricTerm['filters'];

/** A picked measure in the field: its text from `start`, and what it stands for. */
export interface FieldPill {
  /** Stable identity across edits (React key, the open filter panel) */
  key: number;
  start: number;
  /** The text the pill covers ("Booked weeks · Has a customer") */
  text: string;
  measure: Measure;
  filters?: TermFilters;
  total?: boolean;
}

export interface FieldState {
  text: string;
  pills: FieldPill[];
}

export type FieldSegment =
  | { kind: 'text'; text: string; start: number }
  | { kind: 'pill'; text: string; start: number; pill: FieldPill };

let lastKey = 0;
/** A key for a new pill. */
export const newPillKey = (): number => {
  lastKey += 1;
  return lastKey;
};

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);
const isLetter = (c: string | undefined): boolean => c !== undefined && /[A-Za-z]/.test(c);

// =============================================================================
// PILL LIFECYCLE (the mention field's rules)
// =============================================================================

/** Whether the pill's text is still there, standing alone (no letter glued to either side). */
export function isPillIntact(text: string, pill: Pick<FieldPill, 'start' | 'text'>): boolean {
  const end = pill.start + pill.text.length;
  if (pill.start < 0 || end > text.length || pill.text.length === 0) return false;
  if (text.slice(pill.start, end) !== pill.text) return false;
  return !isWordChar(text[pill.start - 1]) && !isWordChar(text[end]);
}

/** Carry pills across an edit: before it untouched, after it shifted, overlapping it dropped. */
export function reconcilePills(prev: string, next: string, pills: FieldPill[]): FieldPill[] {
  if (prev === next) return pills.filter((p) => isPillIntact(next, p));
  const edit = diffEdit(prev, next);
  const editEnd = edit.start + edit.removed;
  const delta = edit.inserted - edit.removed;
  const moved: FieldPill[] = [];
  for (const pill of pills) {
    const end = pill.start + pill.text.length;
    if (end <= edit.start) moved.push(pill);
    else if (pill.start >= editEnd) moved.push({ ...pill, start: pill.start + delta });
  }
  return moved.filter((p) => isPillIntact(next, p)).sort((a, b) => a.start - b.start);
}

/** The field as text and pill runs (the mirror paints the pills; the conversions read them). */
export function segmentField(state: FieldState): FieldSegment[] {
  const live = state.pills.filter((p) => isPillIntact(state.text, p)).sort((a, b) => a.start - b.start);
  const out: FieldSegment[] = [];
  let cursor = 0;
  for (const pill of live) {
    if (pill.start < cursor) continue;
    if (pill.start > cursor) out.push({ kind: 'text', text: state.text.slice(cursor, pill.start), start: cursor });
    out.push({ kind: 'pill', text: pill.text, start: pill.start, pill });
    cursor = pill.start + pill.text.length;
  }
  if (cursor < state.text.length) out.push({ kind: 'text', text: state.text.slice(cursor), start: cursor });
  return out;
}

/** The pill the caret sits inside (`edges`: or at either end of it). */
export function pillAt(state: FieldState, caret: number, edges = false): FieldPill | null {
  return (
    segmentField(state)
      .filter((s): s is Extract<FieldSegment, { kind: 'pill' }> => s.kind === 'pill')
      .map((s) => s.pill)
      .find((p) =>
        edges ? caret >= p.start && caret <= p.start + p.text.length : caret > p.start && caret < p.start + p.text.length
      ) ?? null
  );
}

/**
 * `text.slice(start, end)` replaced by a pill reading `label`, with a space
 * before it after a word and one after it; returns the new state and the
 * caret after the pill.
 */
export function insertPill(
  state: FieldState,
  range: { start: number; end: number },
  pill: Omit<FieldPill, 'key' | 'start' | 'text'>,
  label: string
): { state: FieldState; caret: number } {
  const before = state.text.slice(0, range.start);
  const after = state.text.slice(range.end);
  const lead = before !== '' && !/[\s(]$/.test(before) ? ' ' : '';
  const trail = after.startsWith(' ') ? '' : ' ';
  const text = before + lead + label + trail + after;
  const start = range.start + lead.length;
  const shifted = reconcilePills(state.text, text, state.pills);
  const created: FieldPill = { ...pill, key: newPillKey(), start, text: label };
  return {
    state: { text, pills: [...shifted, created].sort((a, b) => a.start - b.start) },
    caret: start + label.length + 1,
  };
}

/** The pill `key` with its text changed to `label` (its filters changed) and `patch` applied. */
export function relabelPill(state: FieldState, key: number, label: string, patch: Partial<FieldPill>): FieldState {
  const pill = state.pills.find((p) => p.key === key);
  if (!pill) return state;
  const end = pill.start + pill.text.length;
  const text = state.text.slice(0, pill.start) + label + state.text.slice(end);
  const delta = label.length - pill.text.length;
  const pills = state.pills.map((p) => {
    if (p.key === key) return { ...p, ...patch, text: label };
    return p.start >= end ? { ...p, start: p.start + delta } : p;
  });
  return { text, pills };
}

// =============================================================================
// SUGGESTIONS
// =============================================================================

/** How a pill under the pointer is named. */
export const clickToFilter = (pill: string): string => `${pill}: click to filter`;

/** A measure the field offers. */
export interface MeasureOption {
  measure: Measure;
  label: string;
  /** Its family's name, the list's group heading */
  group: string;
}

/** The term measures, in the server's order, with their family names. */
export function measureOptions(include: (measure: Measure) => boolean = () => true): MeasureOption[] {
  return MEASURES.filter((m) => TERM_MEASURES.has(m.key) && include(m.key)).map((m) => ({
    measure: m.key,
    label: m.label,
    group: FAMILY_LABELS[measureFamily(m.key)],
  }));
}

/** The words the caret is typing: letters and spaces back to an operator, a number or a pill. */
export interface ActiveWord {
  start: number;
  end: number;
  query: string;
}

/** The word the caret is typing (it opens the suggestions), or null. */
export function activeWord(state: FieldState, caret: number): ActiveWord | null {
  if (pillAt(state, caret)) return null;
  const pills = segmentField(state).filter((s) => s.kind === 'pill');
  const floor = pills.reduce((max, s) => (s.start + s.text.length <= caret ? Math.max(max, s.start + s.text.length) : max), 0);
  let i = caret;
  while (i > floor && /[A-Za-z ]/.test(state.text[i - 1])) i -= 1;
  while (i < caret && state.text[i] === ' ') i += 1;
  if (i >= caret || !isLetter(state.text[i]) || isWordChar(state.text[i - 1])) return null;
  return { start: i, end: caret, query: state.text.slice(i, caret) };
}

/**
 * The measures matching `query` (any case): those whose name starts with it,
 * then those containing it, kept in their families' order.
 */
export function matchMeasures(options: readonly MeasureOption[], query: string): MeasureOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  const groups = [...new Set(options.map((o) => o.group))];
  return groups.flatMap((group) => {
    const own = options.filter((o) => o.group === group);
    const prefix = own.filter((o) => o.label.toLowerCase().startsWith(q));
    const contains = own.filter((o) => !prefix.includes(o) && o.label.toLowerCase().includes(q));
    return [...prefix, ...contains];
  });
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A measure's full name typed by hand (any case) turned into a pill once the
 * user moves on: not while the caret still touches its end (`caret` null:
 * the field lost focus). The typed text stays as typed.
 */
export function recogniseMeasures(
  state: FieldState,
  options: readonly MeasureOption[],
  caret: number | null
): FieldState {
  const byLength = [...options].sort((a, b) => b.label.length - a.label.length);
  for (const segment of segmentField(state)) {
    if (segment.kind !== 'text') continue;
    for (const option of byLength) {
      const re = new RegExp(escapeRegExp(option.label), 'gi');
      let match: RegExpExecArray | null;
      while ((match = re.exec(segment.text)) !== null) {
        const start = segment.start + match.index;
        const end = start + match[0].length;
        const glued = isWordChar(state.text[start - 1]) || isWordChar(state.text[end]);
        const typing = caret !== null && caret >= start && caret <= end;
        if (glued || typing) continue;
        const pill: FieldPill = { key: newPillKey(), start, text: match[0], measure: option.measure };
        // One at a time: the segments move once a pill is in.
        return recogniseMeasures(
          { text: state.text, pills: [...state.pills, pill].sort((a, b) => a.start - b.start) },
          options,
          caret
        );
      }
    }
  }
  return state;
}

/** How far apart two texts are (insertions, deletions, substitutions). */
export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/**
 * The measure a mistyped word most likely means: one whose name starts with
 * it, or contains it, or is a few letters away (its name or one of its
 * words); ties go to `preferUnit`'s measures (the unit of the field's first
 * pill), then to the server's order. Null when nothing is close.
 */
export function closestMeasure(
  word: string,
  options: readonly MeasureOption[],
  preferUnit?: string
): MeasureOption | null {
  const w = word.trim().toLowerCase();
  if (!w) return null;
  const unitOf = (o: MeasureOption) => MEASURES.find((m) => m.key === o.measure)?.unit;
  const score = (o: MeasureOption): number => {
    const label = o.label.toLowerCase();
    if (label.startsWith(w)) return 0;
    if (label.includes(w)) return 1;
    const words = label.replace(/[()]/g, '').split(/\s+/);
    const best = Math.min(editDistance(w, label), ...words.map((x) => editDistance(w, x)));
    return best <= Math.max(2, Math.floor(w.length / 3)) ? 2 + best : Infinity;
  };
  let best: MeasureOption | null = null;
  let bestScore = Infinity;
  for (const option of options) {
    const s = score(option) - (preferUnit && unitOf(option) === preferUnit ? 0.5 : 0);
    if (s < bestScore) {
      best = option;
      bestScore = s;
    }
  }
  return Number.isFinite(bestScore) ? best : null;
}

// =============================================================================
// FIELD -> FORMULA
// =============================================================================

type FieldToken =
  | { kind: 'num'; text: string; display: string }
  | { kind: 'op'; text: string; display: string }
  | { kind: 'pill'; pill: FieldPill; display: string };

/** A problem of the field, in its own words; `word` set for a word that is not a measure. */
export interface FieldProblem {
  message: string;
  word?: { start: number; end: number; text: string; suggestion: MeasureOption | null };
}

export const EMPTY_FIELD = 'Type a measure, or pick one with Insert measure';
export const MISSING_CLOSE = 'Missing closing bracket';
export const DECIMALS = 'Use a point for decimals: 0.7';
export const PERCENT_AFTER_NUMBER = '% goes right after a number, as in 70%';
export const EMPTY_BRACKETS = 'Put something between ( and )';
export const STRAY_CLOSE = 'A closing bracket has no opening one';
export const TOO_LONG_FIELD = 'The formula is too long';
export const TOO_MANY_MEASURES = `A formula uses at most ${MAX_FORMULA_TERMS} different measures (a measure with other filters counts apart)`;
export const notAMeasure = (word: string, suggestion: string | null): string =>
  suggestion
    ? `"${word}" is not a measure. Did you mean ${suggestion}?`
    : `"${word}" is not a measure: type a measure's name or pick one with Insert measure`;

const OP_DISPLAY: Readonly<Record<string, string>> = {
  '+': OPERATOR_SIGNS['+'],
  '-': OPERATOR_SIGNS['-'],
  '*': OPERATOR_SIGNS['*'],
  '/': OPERATOR_SIGNS['/'],
  '×': OPERATOR_SIGNS['*'],
  '÷': OPERATOR_SIGNS['/'],
  '(': '(',
  ')': ')',
  '%': '%',
};

/** The field's tokens, or the first problem of its typed text. */
function fieldTokens(
  state: FieldState,
  options: readonly MeasureOption[]
): { tokens: FieldToken[] } | { problem: FieldProblem } {
  const out: FieldToken[] = [];
  const firstUnit = (() => {
    const first = segmentField(state).find((s) => s.kind === 'pill');
    return first && first.kind === 'pill' ? MEASURES.find((m) => m.key === first.pill.measure)?.unit : undefined;
  })();
  for (const segment of segmentField(state)) {
    if (segment.kind === 'pill') {
      out.push({ kind: 'pill', pill: segment.pill, display: segment.text });
      continue;
    }
    const s = segment.text;
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (/\s/.test(ch)) {
        i += 1;
      } else if (/[0-9.]/.test(ch)) {
        const m = /^(\d+(\.\d+)?|\.\d+)/.exec(s.slice(i));
        if (!m) return { problem: { message: DECIMALS } };
        const after = s[i + m[0].length];
        if (after === ',' && /\d/.test(s[i + m[0].length + 1] ?? '')) return { problem: { message: DECIMALS } };
        if (after === '.') return { problem: { message: DECIMALS } };
        out.push({ kind: 'num', text: m[0], display: m[0] });
        i += m[0].length;
      } else if (ch in OP_DISPLAY) {
        out.push({ kind: 'op', text: ch === '×' ? '*' : ch === '÷' ? '/' : ch, display: OP_DISPLAY[ch] });
        i += 1;
      } else if (isLetter(ch)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9_ ]/.test(s[j])) j += 1;
        const word = s.slice(i, j).trim();
        const start = segment.start + i;
        return {
          problem: {
            message: notAMeasure(word, closestMeasure(word, options, firstUnit)?.label ?? null),
            word: { start, end: start + word.length, text: word, suggestion: closestMeasure(word, options, firstUnit) },
          },
        };
      } else {
        return { problem: { message: `"${ch}" cannot be used in a formula` } };
      }
    }
  }
  return { tokens: out };
}

/** JSON with sorted keys (filters picked in another order are the same filters). */
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );

const termKey = (pill: FieldPill): string =>
  stableJson({ measure: pill.measure, filters: pill.filters ?? {}, total: Boolean(pill.total) });

/** The expression of `tokens` over term names: no space before `%` or `)`, none after `(`. */
function expressionOf(tokens: FieldToken[], nameOf: (pill: FieldPill) => string): string {
  let out = '';
  tokens.forEach((token, i) => {
    const text = token.kind === 'pill' ? nameOf(token.pill) : token.text;
    const prev = tokens[i - 1];
    const tight = i === 0 || text === '%' || text === ')' || (prev?.kind === 'op' && prev.text === '(');
    out += (tight ? '' : ' ') + text;
  });
  return out;
}

/** The parser's refusal in the field's words. */
function translate(err: FormulaError, tokens: FieldToken[], expression: string): string {
  const message = err.message;
  if (message === UNCLOSED_DETAIL) return MISSING_CLOSE;
  if (message === DECIMAL_COMMA_DETAIL) return DECIMALS;
  if (message === TOO_DEEP_DETAIL) return message;
  if (message === TOO_LONG_DETAIL) return TOO_LONG_FIELD;
  if (message === ENDS_EARLY_DETAIL) {
    const last = tokens[tokens.length - 1];
    return last?.kind === 'op' ? `Something is missing after ${last.display}` : 'Something is missing at the end';
  }
  const m = /at position (\d+)$/.exec(message);
  if (!m) return message;
  // Which token sits at that position of the expression.
  const position = Number(m[1]) - 1;
  const toks = formulaTokens(expression) ?? [];
  const index = toks.findIndex((t) => t.pos - 1 === position);
  const token = tokens[index];
  const prev = tokens[index - 1];
  if (!token) return message;
  if (token.kind === 'op' && token.text === ')') {
    if (prev?.kind === 'op' && prev.text === '(') return EMPTY_BRACKETS;
    if (prev?.kind === 'op') return `Something is missing after ${prev.display}`;
    return STRAY_CLOSE;
  }
  if (token.kind === 'op' && token.text === '%') return PERCENT_AFTER_NUMBER;
  if (token.kind === 'op' && token.text !== '(') return `Something is missing before ${token.display}`;
  return `An operator is missing between ${prev?.display ?? 'the start'} and ${token.display}`;
}

/**
 * The stored formula a field stands for (`terms` named `a`, `b`, … in order
 * of first appearance, a repeated pill sharing its term), or its first
 * problem in plain words.
 */
export function formulaFromField(
  state: FieldState,
  options: readonly MeasureOption[]
): { formula: Pick<MetricFormula, 'expression' | 'terms'> } | { problem: FieldProblem } {
  if (!state.text.trim()) return { problem: { message: EMPTY_FIELD } };
  const read = fieldTokens(state, options);
  if ('problem' in read) return read;
  const names = new Map<string, string>();
  const terms: MetricTerm[] = [];
  const nameOf = (pill: FieldPill): string => {
    const key = termKey(pill);
    let name = names.get(key);
    if (!name) {
      name = nextTermName([...names.values()]);
      names.set(key, name);
      const term: MetricTerm = { name, measure: pill.measure, filters: { ...(pill.filters ?? {}) } };
      if (pill.total) term.total = true;
      terms.push(term);
    }
    return name;
  };
  const expression = expressionOf(read.tokens, nameOf);
  if (expression.length > MAX_FORMULA_LENGTH) return { problem: { message: TOO_LONG_FIELD } };
  try {
    parseFormula(expression);
  } catch (err) {
    return { problem: { message: translate(err as FormulaError, read.tokens, expression) } };
  }
  if (terms.length === 0) return { problem: { message: EMPTY_FIELD } };
  if (terms.length > MAX_FORMULA_TERMS) return { problem: { message: TOO_MANY_MEASURES } };
  return { formula: { expression, terms } };
}

/** The field's first problem, or null. */
export function fieldProblem(state: FieldState, options: readonly MeasureOption[]): FieldProblem | null {
  const read = formulaFromField(state, options);
  return 'problem' in read ? read.problem : null;
}

// =============================================================================
// FORMULA -> FIELD
// =============================================================================

/**
 * The field showing a stored formula: each term name a pill reading
 * `label(term)`, the rest as stored. A name no term has stays text.
 */
export function fieldFromFormula(
  formula: Pick<MetricFormula, 'expression' | 'terms'>,
  label: (term: MetricTerm) => string
): FieldState {
  const toks = formulaTokens(formula.expression);
  if (!toks) return { text: formula.expression, pills: [] };
  let text = '';
  const pills: FieldPill[] = [];
  let cursor = 0;
  for (const token of toks) {
    if (token.kind === 'end') break;
    const start = token.pos - 1;
    text += formula.expression.slice(cursor, start);
    const term = token.kind === 'name' ? formula.terms.find((t) => t.name.toLowerCase() === token.text) : undefined;
    if (term) {
      const pillText = label(term);
      const pill: FieldPill = { key: newPillKey(), start: text.length, text: pillText, measure: term.measure };
      if (term.filters && Object.keys(term.filters).length > 0) pill.filters = { ...term.filters };
      if (term.total) pill.total = true;
      pills.push(pill);
      text += pillText;
    } else {
      text += formula.expression.slice(start, start + token.length);
    }
    cursor = start + token.length;
  }
  text += formula.expression.slice(cursor);
  return { text, pills };
}
