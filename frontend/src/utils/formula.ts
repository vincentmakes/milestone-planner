/**
 * The formula language of calculated widgets (2.6.0), on the client: the
 * mirror of `app/services/formula.py`.
 *
 *     sum      := product (("+" | "-") product)*
 *     product  := unary (("*" | "×" | "/" | "÷") unary)*
 *     unary    := "-" unary | primary
 *     primary  := number ["%"] | name | "(" sum ")"
 *     number   := digits ["." digits] | "." digits
 *     name     := [A-Za-z][A-Za-z0-9_]*   (case-insensitive: read in lower case)
 *
 * **Mirror contract**: the same language, the same messages and the same
 * canonical form as the server; `FORMULA_CASES` in
 * `src/utils/__tests__/formula.test.ts` and `tests/test_formula.py` is the
 * shared table — change one, change both. The editor validates as the user
 * types; the server stays the judge and evaluates (never this module).
 *
 * Beside the parser: `readBack` (the formula said in words), `renameTerm`
 * (a rename that updates the references, and nothing else in the text) and
 * `nextTermName` (`a`, `b`, … for a new term).
 */

import { MAX_FORMULA_LENGTH } from './metrics';

export { MAX_FORMULA_LENGTH };
export const MAX_DEPTH = 20;

export const EMPTY_DETAIL = 'Enter a formula';
export const TOO_LONG_DETAIL = `A formula has at most ${MAX_FORMULA_LENGTH} characters`;
export const DECIMAL_COMMA_DETAIL = 'Use a point for decimals: 0.7';
export const TOO_DEEP_DETAIL = 'The formula is nested too deeply';
export const ENDS_EARLY_DETAIL = 'The formula ends too early: something is missing at the end';
export const UNCLOSED_DETAIL = 'Missing closing bracket )';

/** The typed (and inserted) multiplication and division signs. */
const OPERATOR_ALIASES: Readonly<Record<string, string>> = { '×': '*', '÷': '/' };

export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}

export type FormulaNode =
  | { kind: 'num'; value: number; text: string }
  | { kind: 'name'; text: string }
  | { kind: 'neg'; left: FormulaNode }
  | { kind: '+' | '-' | '*' | '/'; left: FormulaNode; right: FormulaNode };

export interface ParsedFormula {
  tree: FormulaNode;
  /** Every term name the formula uses, in order of first appearance (lower case) */
  names: string[];
  canonical: string;
}

interface Token {
  kind: 'num' | 'name' | 'op' | 'end';
  /** As read (names in lower case, `×` / `÷` as `*` / `/`) */
  text: string;
  /** 1-based position of its first character */
  pos: number;
  /** Its characters in the source */
  length: number;
}

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';
const isLetter = (ch: string | undefined): boolean =>
  ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'));

const unexpected = (text: string, pos: number): FormulaError =>
  new FormulaError(`Unexpected "${text}" at position ${pos}`);

function tokens(source: string): Token[] {
  const out: Token[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1]))) {
      const start = i;
      while (isDigit(source[i])) i += 1;
      if (source[i] === '.') {
        i += 1;
        if (!isDigit(source[i])) throw unexpected('.', i);
        while (isDigit(source[i])) i += 1;
      }
      if (source[i] === ',' && isDigit(source[i + 1])) throw new FormulaError(DECIMAL_COMMA_DETAIL);
      out.push({ kind: 'num', text: source.slice(start, i), pos: start + 1, length: i - start });
      continue;
    }
    if (isLetter(ch)) {
      const start = i;
      while (isLetter(source[i]) || isDigit(source[i]) || source[i] === '_') i += 1;
      out.push({ kind: 'name', text: source.slice(start, i).toLowerCase(), pos: start + 1, length: i - start });
      continue;
    }
    if ('+-*/()%×÷'.includes(ch)) {
      out.push({ kind: 'op', text: OPERATOR_ALIASES[ch] ?? ch, pos: i + 1, length: 1 });
      i += 1;
      continue;
    }
    throw unexpected(ch, i + 1);
  }
  out.push({ kind: 'end', text: '', pos: n + 1, length: 0 });
  return out;
}

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly toks: Token[]) {}

  peek(): Token {
    return this.toks[this.index];
  }

  private take(): Token {
    const token = this.toks[this.index];
    this.index += 1;
    return token;
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new FormulaError(TOO_DEEP_DETAIL);
  }

  sum(): FormulaNode {
    let node = this.product();
    while (this.peek().kind === 'op' && (this.peek().text === '+' || this.peek().text === '-')) {
      const op = this.take().text as '+' | '-';
      node = { kind: op, left: node, right: this.product() };
    }
    return node;
  }

  private product(): FormulaNode {
    let node = this.unary();
    while (this.peek().kind === 'op' && (this.peek().text === '*' || this.peek().text === '/')) {
      const op = this.take().text as '*' | '/';
      node = { kind: op, left: node, right: this.unary() };
    }
    return node;
  }

  private unary(): FormulaNode {
    const token = this.peek();
    if (token.kind === 'op' && token.text === '-') {
      this.take();
      this.enter();
      const node: FormulaNode = { kind: 'neg', left: this.unary() };
      this.depth -= 1;
      return node;
    }
    return this.primary();
  }

  private primary(): FormulaNode {
    const token = this.take();
    if (token.kind === 'num') {
      let value = Number(token.text);
      let text = token.text;
      if (this.peek().kind === 'op' && this.peek().text === '%') {
        this.take();
        value /= 100;
        text += '%';
      }
      return { kind: 'num', value, text };
    }
    if (token.kind === 'name') return { kind: 'name', text: token.text };
    if (token.kind === 'op' && token.text === '(') {
      this.enter();
      const node = this.sum();
      this.depth -= 1;
      const closing = this.take();
      if (closing.kind === 'end') throw new FormulaError(UNCLOSED_DETAIL);
      if (closing.text !== ')') throw unexpected(closing.text, closing.pos);
      return node;
    }
    if (token.kind === 'end') throw new FormulaError(ENDS_EARLY_DETAIL);
    throw unexpected(token.text, token.pos);
  }
}

/** Every operation bracketed, numbers as written: `(a / (b * 70%))`. */
export function canonical(node: FormulaNode): string {
  switch (node.kind) {
    case 'num':
    case 'name':
      return node.text;
    case 'neg':
      return `(-${canonical(node.left)})`;
    default:
      return `(${canonical(node.left)} ${node.kind} ${canonical(node.right)})`;
  }
}

function collectNames(node: FormulaNode, out: string[]): void {
  if (node.kind === 'name') {
    if (!out.includes(node.text)) out.push(node.text);
    return;
  }
  if (node.kind === 'num') return;
  collectNames(node.left, out);
  if (node.kind !== 'neg') collectNames(node.right, out);
}

/** The formula `source` as a tree, or a `FormulaError` in plain words. */
export function parseFormula(source: string): ParsedFormula {
  if (source.length > MAX_FORMULA_LENGTH) throw new FormulaError(TOO_LONG_DETAIL);
  if (!source.trim()) throw new FormulaError(EMPTY_DETAIL);
  const parser = new Parser(tokens(source));
  const tree = parser.sum();
  const token = parser.peek();
  if (token.kind !== 'end') throw unexpected(token.text, token.pos);
  const names: string[] = [];
  collectNames(tree, names);
  return { tree, names, canonical: canonical(tree) };
}

/** A name the formula uses that no term has (the server's `unknown_name_detail`). */
export const unknownNameDetail = (name: string, terms: readonly string[]): string =>
  `"${name}" is not one of your terms: ${terms.join(', ')}`;

/** A term the formula does not use (the server's `unused_term_detail`). */
export const unusedTermDetail = (name: string): string =>
  `Term ${name} is not used in the formula: use it or remove it`;

export const TERM_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const TERM_NAME_DETAIL =
  'A term name is a lowercase word of letters, digits and _, starting with a letter (customer_weeks)';

/**
 * Why a formula over `termNames` cannot be computed, or null: a parse error,
 * a bad or repeated term name, a name that is no term, a term not used — the
 * server's refusals, in the same words.
 */
export function formulaProblem(expression: string, termNames: readonly string[]): string | null {
  const names = termNames.map((name) => name.trim().toLowerCase());
  for (const name of names) {
    if (!TERM_NAME_PATTERN.test(name)) return TERM_NAME_DETAIL;
  }
  let parsed: ParsedFormula;
  try {
    parsed = parseFormula(expression);
  } catch (err) {
    return err instanceof FormulaError ? err.message : String(err);
  }
  for (const name of names) {
    if (names.indexOf(name) !== names.lastIndexOf(name)) return `Two terms are named "${name}"`;
  }
  for (const name of parsed.names) {
    if (!names.includes(name)) return unknownNameDetail(name, names);
  }
  for (const name of names) {
    if (!parsed.names.includes(name)) return unusedTermDetail(name);
  }
  return null;
}

const PRECEDENCE: Readonly<Record<FormulaNode['kind'], number>> = {
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
  neg: 3,
  num: 4,
  name: 4,
};

/** The operators as a reader writes them. */
export const OPERATOR_SIGNS: Readonly<Record<'+' | '-' | '*' | '/', string>> = {
  '+': '+',
  '-': '−',
  '*': '×',
  '/': '÷',
};

function words(node: FormulaNode, labels: Readonly<Record<string, string>>): string {
  switch (node.kind) {
    case 'num':
      return node.text.endsWith('%') ? `${node.text.slice(0, -1)} %` : node.text;
    case 'name':
      return labels[node.text] ?? node.text;
    case 'neg': {
      const inner = words(node.left, labels);
      return PRECEDENCE[node.left.kind] < PRECEDENCE.neg ? `−(${inner})` : `−${inner}`;
    }
    default: {
      const own = PRECEDENCE[node.kind];
      let left = words(node.left, labels);
      let right = words(node.right, labels);
      if (PRECEDENCE[node.left.kind] < own) left = `(${left})`;
      const rightPrecedence = PRECEDENCE[node.right.kind];
      // a − (b − c) and a ÷ (b ÷ c) keep their brackets; a − (b + c) too.
      if (rightPrecedence < own || (rightPrecedence === own && (node.kind === '-' || node.kind === '/'))) {
        right = `(${right})`;
      }
      return `${left} ${OPERATOR_SIGNS[node.kind]} ${right}`;
    }
  }
}

/**
 * The formula said in words: each name replaced by its label (a measure and
 * its filters), real operator signs, only the brackets the reading needs —
 * "Booked weeks (has a customer) ÷ (Capacity (weeks) × 70 %)". Null when
 * the formula does not parse.
 */
export function readBack(expression: string, labels: Readonly<Record<string, string>>): string | null {
  try {
    return words(parseFormula(expression).tree, labels);
  } catch {
    return null;
  }
}

/**
 * `expression` with the term `from` renamed `to`: only whole name tokens
 * (any case) change, the rest of the text stays as typed. Unreadable text
 * is returned unchanged.
 */
export function renameTerm(expression: string, from: string, to: string): string {
  let toks: Token[];
  try {
    toks = tokens(expression);
  } catch {
    return expression;
  }
  const wanted = from.toLowerCase();
  let out = expression;
  // From the end, so earlier positions stay valid.
  for (const token of [...toks].reverse()) {
    if (token.kind === 'name' && token.text === wanted) {
      const start = token.pos - 1;
      out = out.slice(0, start) + to + out.slice(start + token.length);
    }
  }
  return out;
}

/** The first of `a`, `b`, … `z`, `a2`, … no term is named yet. */
export function nextTermName(existing: readonly string[]): string {
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  for (let round = 1; ; round += 1) {
    for (let code = 97; code <= 122; code += 1) {
      const name = String.fromCharCode(code) + (round > 1 ? String(round) : '');
      if (!taken.has(name)) return name;
    }
  }
}
