/**
 * CalculationSection — the terms and the formula of a calculated widget
 * (2.6.0), inside the widget editor while *Calculation* is on.
 *
 * Top to bottom (the tab order too): the *Examples* menu; one compact row per
 * term — its name badge and live value ("a = 412 weeks", from the preview's
 * `terms`), a short *Name* field (a rename updates the formula's references,
 * never anything else in it), its *Measure* (summed and counted ones only,
 * grouped), a filter summary that opens the shared `FilterSection` in place,
 * *Use its total* while a dimension other than the period is set, and a
 * remove button —; *Add term* (at most `MAX_FORMULA_TERMS`); the *Formula*
 * field with its error (`formulaProblem`, the server's words) and the insert
 * bar (a chip per term, `+ − × ÷ ( ) %`: a click inserts at the cursor and
 * keeps the focus in the field); the read-back line (`readBack`) and the
 * live result ("= 75.5 %", or "–" with the reason); the *Result* choice with
 * an example of each.
 *
 * The typed text is never rewritten (only a rename touches it). The section
 * holds no query of its own: every change goes to `onChange` as the next
 * query, which the editor normalises.
 */

import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { Icon, ChevronDownIcon, ChevronRightIcon, PlusIcon, TrashIcon } from '@/components/common/Icon';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { useAppStore } from '@/stores/appStore';
import { uniqueById } from '@/utils/uniqueById';
import { dimensionLabel, formatMetric, isTermMeasure, isValidDimension, MAX_FORMULA_TERMS, measureNeeds, measuresByFamily, unitWord } from '@/utils/metrics';
import { nextTermName, readBack, renameTerm, TERM_NAME_DETAIL, TERM_NAME_PATTERN } from '@/utils/formula';
import type { Measure, MetricDimension, MetricFilters, MetricFormula, MetricQuery, MetricResult, MetricTerm, MetricUnit } from '@/types';
import type { PermissionKey } from '@/types/permissions';
import { FilterSection } from './FilterSection';
import { addTerm, CAPACITY_EXAMPLES, FORMULA_EXAMPLES } from './widgetDraft';
import type { FormulaExampleKey } from './widgetDraft';
import { filterSummary, measureLabelOf, noResultReason, termLabel } from './termSummary';
import type { NameLookups } from './termSummary';
import styles from './WidgetEditor.module.css';

export const FORMULA_HINT = 'Term names, numbers (70% is 0.7), + − × ÷ and brackets';
export const TOTAL_HINT = 'The same whole value in every row, not split by the breakdown';
export const MAX_TERMS_HINT = `A calculation has at most ${MAX_FORMULA_TERMS} terms`;
export const CAPACITY_EXAMPLE_HINT = 'Needs the Staff & Calendar permission';

/** The insert bar's operators: the sign shown, the text inserted, the button's name. */
const OPERATORS: readonly { sign: string; text: string; name: string }[] = [
  { sign: '+', text: ' + ', name: 'plus' },
  { sign: '−', text: ' - ', name: 'minus' },
  { sign: '×', text: ' × ', name: 'times' },
  { sign: '÷', text: ' ÷ ', name: 'divided by' },
  { sign: '(', text: '(', name: 'opening bracket' },
  { sign: ')', text: ')', name: 'closing bracket' },
  { sign: '%', text: '%', name: 'percent' },
];

const RESULT_UNIT: Readonly<Record<'percent' | 'number', MetricUnit>> = { percent: 'percent', number: 'number' };

/** A value with its unit word ("412.0 weeks", "75.5 %"). */
function withUnit(value: number | null, unit: MetricUnit): string {
  const text = formatMetric(value, unit);
  const word = value === null ? '' : unitWord(value, unit);
  return word ? `${text} ${word}` : text;
}

export interface CalculationSectionProps {
  query: MetricQuery & { formula: MetricFormula };
  /** The next query (the editor normalises it) */
  onChange: (next: MetricQuery) => void;
  holds: (key: PermissionKey | null) => boolean;
  /** The viewer may use the capacity measures (`views.staff`) */
  canCapacity: boolean;
  /** The widget's dimensions: beyond the period, *Use its total* is offered (and forced on a term that refuses one) */
  dimensions: readonly MetricDimension[];
  /** Why the formula cannot be computed (the server's words), or null */
  formulaError: string | null;
  /** The preview's result (the last valid one while the formula is invalid) */
  result: MetricResult | null;
  /** The result is the last valid one (shown dimmed) */
  stale: boolean;
  /** An example was chosen (the editor confirms before replacing a customised calculation) */
  onExample: (key: FormulaExampleKey) => void;
}

export function CalculationSection({
  query,
  onChange,
  holds,
  canCapacity,
  dimensions,
  formulaError,
  result,
  stale,
  onExample,
}: CalculationSectionProps) {
  const formula = query.formula;
  const terms = formula.terms;
  const names = terms.map((t) => t.name);
  const formulaRef = useRef<HTMLInputElement>(null);
  // The cursor to restore after an insert (the field is controlled: it moves on re-render).
  const caretRef = useRef<number | null>(null);
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  const [renaming, setRenaming] = useState<{ index: number; text: string; error: string | null } | null>(null);
  const [openFilters, setOpenFilters] = useState<ReadonlySet<number>>(() => new Set());
  const idBase = useId();

  // --- Names of the filter values (the summaries and the read-back) -----------------------
  const teams = useAppStore((s) => s.teams);
  const staff = useAppStore((s) => s.staff);
  const projects = useAppStore((s) => s.projects);
  const tags = useAppStore((s) => s.tags);
  const equipment = useAppStore((s) => s.equipment);
  const sites = useAppStore((s) => s.sites);
  const fields = useAppStore((s) => s.projectFields);
  const lookups = useMemo<NameLookups>(
    () => ({
      sites: new Map(sites.map((s) => [s.id, s.name])),
      teams: new Map(teams.map((t) => [t.id, t.name])),
      people: new Map(uniqueById(staff).map((s) => [s.id, s.name])),
      projects: new Map(projects.map((p) => [p.id, p.name])),
      tags: new Map(tags.map((t) => [t.id, t.name])),
      equipment: new Map(uniqueById(equipment).map((e) => [e.id, e.name])),
      fields,
    }),
    [sites, teams, staff, projects, tags, equipment, fields]
  );
  const labels = useMemo(
    () => Object.fromEntries(terms.map((t) => [t.name, termLabel(t, lookups)])),
    [terms, lookups]
  );

  // --- Changes ------------------------------------------------------------------------------
  const setFormula = (patch: Partial<MetricFormula>) => onChange({ ...query, formula: { ...formula, ...patch } });
  const setTerm = (index: number, patch: Partial<MetricTerm>) =>
    setFormula({ terms: terms.map((t, i) => (i === index ? { ...t, ...patch } : t)) });
  const setTermFilters = (index: number, patch: Partial<MetricFilters>) =>
    setTerm(index, { filters: { ...(terms[index].filters ?? {}), ...patch } as MetricTerm['filters'] });

  const rename = (index: number, text: string) => {
    const wanted = text.trim().toLowerCase();
    let error: string | null = null;
    if (!TERM_NAME_PATTERN.test(wanted)) error = TERM_NAME_DETAIL;
    else if (names.some((name, i) => i !== index && name === wanted)) error = `Two terms are named "${wanted}"`;
    setRenaming({ index, text, error });
    if (error || wanted === names[index]) return;
    setFormula({
      expression: renameTerm(formula.expression, names[index], wanted),
      terms: terms.map((t, i) => (i === index ? { ...t, name: wanted } : t)),
    });
  };

  const removeTerm = (index: number) => {
    setRenaming(null);
    setOpenFilters(new Set());
    setFormula({ terms: terms.filter((_, i) => i !== index) });
  };

  const toggleFilters = (index: number) =>
    setOpenFilters((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  // --- The formula field and its insert bar -------------------------------------------------
  const rememberSelection = () => {
    const input = formulaRef.current;
    if (input) selectionRef.current = { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 };
  };

  const insert = (text: string) => {
    const value = formula.expression;
    const sel = selectionRef.current ?? { start: value.length, end: value.length };
    const before = value.slice(0, sel.start);
    const after = value.slice(sel.end);
    // A name gets a space before it (none after an opening bracket); no space is doubled.
    const glue = /^[A-Za-z]/.test(text) && before !== '' && !/[\s(]$/.test(before) ? ' ' : '';
    let piece = text;
    if (before.endsWith(' ') || before === '') piece = piece.replace(/^ /, '');
    if (after.startsWith(' ')) piece = piece.replace(/ $/, '');
    const next = before + glue + piece + after;
    const caret = sel.start + glue.length + piece.length;
    caretRef.current = caret;
    selectionRef.current = { start: caret, end: caret };
    setFormula({ expression: next });
  };

  // Put the focus and the cursor back in the field after an insert.
  useLayoutEffect(() => {
    const caret = caretRef.current;
    const input = formulaRef.current;
    if (caret === null || !input) return;
    caretRef.current = null;
    input.focus();
    input.setSelectionRange(caret, caret);
  });

  // --- Live values ---------------------------------------------------------------------------
  const termValues = new Map((result?.terms ?? []).map((t) => [t.name, t]));
  const resultUnit = RESULT_UNIT[formula.result ?? 'percent'];
  const total = result ? result.total : undefined;
  let resultText: string | null = null;
  if (total !== undefined) {
    resultText =
      total === null ? `= – (${noResultReason(result?.terms ?? [], labels)})` : `= ${formatMetric(total, resultUnit)}`;
  }
  const spoken = readBack(formula.expression, labels);

  // The result choice with an example of each, from the live value when there is one.
  const ratio = typeof total === 'number' ? (resultUnit === 'percent' ? total / 100 : total) : 0.755;
  const resultOptions = [
    { value: 'percent', label: `Percentage (${formatMetric(ratio * 100, 'percent')})` },
    { value: 'number', label: `Number (${formatMetric(ratio, 'number')})` },
  ];

  const termGroups = (current: Measure) =>
    measuresByFamily((m) => isTermMeasure(m) && (m === current || holds(measureNeeds(m))));

  const formulaId = `${idBase}-formula`;
  const split = dimensions.some((d) => d.kind !== 'period');
  const fieldsList = useAppStore((s) => s.projectFields);
  const settings = useAppStore((s) => s.instanceSettings);
  /** The first dimension beyond the period a term's measure refuses (the term must use its total). */
  const refused = (measure: Measure): MetricDimension | undefined =>
    dimensions.find((d) => d.kind !== 'period' && !isValidDimension(measure, d.kind));
  const valueClass = `${styles.termValue}${stale ? ` ${styles.stale}` : ''}`;

  return (
    <section className={styles.section} aria-label="Calculation">
      <div className={styles.calcHeader}>
        <p className={styles.label}>Terms</p>
        <ExamplesMenu canCapacity={canCapacity} onPick={onExample} />
      </div>

      {terms.map((term, index) => {
        const value = termValues.get(term.name);
        const nameText = renaming?.index === index ? renaming.text : term.name;
        const filtersOpen = openFilters.has(index);
        const panelId = `${idBase}-filters-${index}`;
        const refusedDimension = refused(term.measure);
        return (
          <div key={index} className={styles.termRow} role="group" aria-label={`Term ${term.name}`}>
            <div className={styles.termHead}>
              <span className={styles.termBadge} aria-hidden="true">
                {term.name}
              </span>
              <span className={valueClass} aria-live="polite">
                {value ? `${term.name} = ${withUnit(value.value, value.unit)}` : ''}
              </span>
              <Button
                type="button"
                variant="icon"
                size="sm"
                aria-label={`Remove term ${term.name}`}
                title={terms.length === 1 ? 'A calculation needs one term' : `Remove term ${term.name}`}
                icon={<Icon icon={TrashIcon} size={15} />}
                disabled={terms.length === 1}
                onClick={() => removeTerm(index)}
              />
            </div>
            <div className={styles.termFields}>
              <Input
                label="Name"
                aria-label={`Name of term ${term.name}`}
                className={styles.termName}
                value={nameText}
                maxLength={40}
                onChange={(e) => rename(index, e.target.value)}
                onBlur={() => setRenaming(null)}
                error={renaming?.index === index ? renaming.error ?? undefined : undefined}
              />
              <Select
                label="Measure"
                aria-label={`Measure of term ${term.name}`}
                className={styles.grow}
                fullWidth
                value={term.measure}
                onChange={(e) => setTerm(index, { measure: e.target.value as Measure })}
                options={[]}
                groups={termGroups(term.measure)}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              className={styles.disclosure}
              aria-expanded={filtersOpen}
              aria-controls={panelId}
              aria-label={`Filters of term ${term.name}: ${filterSummary(term.filters, lookups)}`}
              icon={<Icon icon={filtersOpen ? ChevronDownIcon : ChevronRightIcon} />}
              onClick={() => toggleFilters(index)}
            >
              {filterSummary(term.filters, lookups)}
            </Button>
            {filtersOpen && (
              <FilterSection
                id={panelId}
                disclosure={false}
                measure={term.measure}
                filters={term.filters ?? {}}
                onChange={(patch) => setTermFilters(index, patch)}
                holds={holds}
                title={`Filters of term ${term.name}`}
              />
            )}
            {split && (
              <div className={styles.termTotal}>
                <ToggleSwitch
                  label="Use its total"
                  aria-label={`Use the total of term ${term.name}`}
                  checked={Boolean(term.total) || refusedDimension !== undefined}
                  disabled={refusedDimension !== undefined}
                  onChange={(checked) => setTerm(index, { total: checked })}
                />
                <p className={styles.hint}>
                  {refusedDimension
                    ? `${measureLabelOf(term.measure)} has no ${dimensionLabel(refusedDimension, fieldsList, settings)}: it uses its total`
                    : TOTAL_HINT}
                </p>
              </div>
            )}
          </div>
        );
      })}

      <div className={styles.addTerm}>
        <Button
          type="button"
          variant="secondary"
          icon={<Icon icon={PlusIcon} />}
          disabled={terms.length >= MAX_FORMULA_TERMS}
          onClick={() => setFormula(addTerm(formula, nextTermName(names)))}
        >
          Add term
        </Button>
        {terms.length >= MAX_FORMULA_TERMS && <p className={styles.hint}>{MAX_TERMS_HINT}</p>}
      </div>

      <Input
        ref={formulaRef}
        id={formulaId}
        label="Formula"
        fullWidth
        spellCheck={false}
        autoComplete="off"
        value={formula.expression}
        maxLength={200}
        onChange={(e) => {
          setFormula({ expression: e.target.value });
          selectionRef.current = { start: e.target.selectionStart ?? 0, end: e.target.selectionEnd ?? 0 };
        }}
        onSelect={rememberSelection}
        onKeyUp={rememberSelection}
        onClick={rememberSelection}
        error={formulaError ?? undefined}
        hint={formulaError ? undefined : FORMULA_HINT}
      />
      <div className={styles.insertBar} role="toolbar" aria-label="Insert into the formula">
        {terms.map((term) => (
          <Button
            key={`term-${term.name}`}
            type="button"
            variant="secondary"
            size="sm"
            className={styles.chip}
            aria-label={`Insert term ${term.name} (${measureLabelOf(term.measure)})`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(term.name)}
          >
            <span className={styles.chipName}>{term.name}</span> {measureLabelOf(term.measure)}
          </Button>
        ))}
        {OPERATORS.map((op) => (
          <Button
            key={op.name}
            type="button"
            variant="secondary"
            size="sm"
            className={styles.operator}
            aria-label={`Insert ${op.name}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(op.text)}
          >
            {op.sign}
          </Button>
        ))}
      </div>

      {spoken !== null && (
        <p className={styles.readBack}>
          <span className={styles.label}>Reads </span>
          {spoken}
        </p>
      )}
      {resultText !== null && (
        <p className={`${styles.calcResult}${stale ? ` ${styles.stale}` : ''}`} role="status">
          {resultText}
        </p>
      )}

      <Select
        label="Result"
        fullWidth
        value={formula.result ?? 'percent'}
        onChange={(e) => setFormula({ result: e.target.value as MetricFormula['result'] })}
        options={resultOptions}
      />
    </section>
  );
}

interface ExamplesMenuProps {
  canCapacity: boolean;
  onPick: (key: FormulaExampleKey) => void;
}

/** The *Examples* menu: a ready-made formula over the current terms. */
function ExamplesMenu({ canCapacity, onPick }: ExamplesMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const { onBlur } = useDismissableOverlay({ open, onClose: () => setOpen(false), wrapperRef, triggerRef });
  return (
    <div ref={wrapperRef} className={styles.examples} onBlur={onBlur}>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        icon={<Icon icon={ChevronDownIcon} />}
        iconPosition="right"
        onClick={() => setOpen((value) => !value)}
      >
        Examples
      </Button>
      {open && (
        <div id={menuId} className={styles.examplesMenu} role="menu" aria-label="Formula examples">
          {FORMULA_EXAMPLES.map((example) => {
            const blocked = CAPACITY_EXAMPLES.has(example.key) && !canCapacity;
            return (
              <Button
                key={example.key}
                type="button"
                variant="ghost"
                role="menuitem"
                className={styles.examplesItem}
                disabled={blocked}
                title={blocked ? CAPACITY_EXAMPLE_HINT : undefined}
                onClick={() => {
                  setOpen(false);
                  onPick(example.key);
                }}
              >
                <span>{example.label}</span>
                <code className={styles.examplesCode}>{example.expression}</code>
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
