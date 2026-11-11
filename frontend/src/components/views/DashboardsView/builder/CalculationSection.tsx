/**
 * CalculationSection — the formula of a calculated widget (2.6.0), inside
 * the widget editor while *Calculation* is on: one field (`FormulaField`) in
 * which measures are pills and the rest is typed.
 *
 * On the *Formula* label's row: *Insert measure* and the *Examples* menu.
 * Under the field, one line: the problem in plain words while the formula
 * cannot be computed (a word that is not a measure offers the closest one as
 * a button that replaces it), otherwise the formula with its numbers and the
 * result (`116.3 ÷ (323.7 × 70 %) = 51.3 %`, from the preview's term totals).
 * A pill's panel holds its filters (the shared `FilterSection`) and, while a
 * dimension other than the period is set, *Use its total*; until a pill's
 * panel was opened once, a muted hint says a measure can be filtered. Then
 * *Show result as* (with the current result in each choice, when there is
 * one).
 *
 * The terms of the stored formula are never shown: the editor converts the
 * field (`utils/formulaField.ts`).
 */

import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/common/Button';
import { Select } from '@/components/common/Select';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { Icon, ChevronDownIcon, PlusIcon } from '@/components/common/Icon';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { useAppStore } from '@/stores/appStore';
import { dimensionLabel, formatMetric, isValidDimension } from '@/utils/metrics';
import { readBack } from '@/utils/formula';
import type { FieldPill, FieldProblem, FieldState, MeasureOption, TermFilters } from '@/utils/formulaField';
import type { Measure, MetricDimension, MetricFilters, MetricFormula, MetricResult, MetricUnit } from '@/types';
import type { PermissionKey } from '@/types/permissions';
import { FilterSection } from './FilterSection';
import { FormulaField } from './FormulaField';
import type { FormulaFieldHandle } from './FormulaField';
import { CAPACITY_EXAMPLES, FORMULA_EXAMPLES } from './widgetDraft';
import type { FormulaExampleKey } from './widgetDraft';
import { measureLabelOf, noResultReason } from './termSummary';
import styles from './WidgetEditor.module.css';

export const TOTAL_HINT = 'The same whole value in every row, not split by the breakdown';
export const CAPACITY_EXAMPLE_HINT = 'Needs the Staff & Calendar permission';
export const CALCULATING = 'Calculating…';
export const TYPING_HINT = 'Pick the measure from the list, or finish typing its name';
export const FILTER_HINT = 'Click a measure to filter it';
export const FIELD_DESCRIPTION = 'Click a measure, or press Enter on it, to filter it';

const RESULT_UNIT: Readonly<Record<'percent' | 'number', MetricUnit>> = { percent: 'percent', number: 'number' };

export interface CalculationSectionProps {
  formula: MetricFormula;
  field: FieldState;
  onFieldChange: (field: FieldState) => void;
  onResultChange: (result: MetricFormula['result']) => void;
  options: readonly MeasureOption[];
  /** A pill's text for a measure and its filters */
  label: (measure: Measure, filters: TermFilters | undefined) => string;
  holds: (key: PermissionKey | null) => boolean;
  /** The viewer may use the capacity measures (`views.staff`) */
  canCapacity: boolean;
  /** The widget's dimensions: beyond the period, *Use its total* is offered (forced on a measure that refuses one) */
  dimensions: readonly MetricDimension[];
  /** Why the field cannot be computed (null: it can, or the user is still typing a measure's name) */
  problem: FieldProblem | null;
  /** A measure's name is being typed (no message yet; the list helps) */
  typing?: boolean;
  /** Replace the mistyped word with the suggested measure */
  onAcceptSuggestion: (problem: FieldProblem) => void;
  /** The preview's result for this very formula (null while it is asked) */
  result: MetricResult | null;
  /** An example was chosen (the editor confirms before replacing a customised formula) */
  onExample: (key: FormulaExampleKey) => void;
}

export function CalculationSection({
  formula,
  field,
  onFieldChange,
  onResultChange,
  options,
  label,
  holds,
  canCapacity,
  dimensions,
  problem,
  typing = false,
  onAcceptSuggestion,
  result,
  onExample,
}: CalculationSectionProps) {
  const idBase = useId();
  const fieldId = `${idBase}-formula`;
  const lineId = `${idBase}-line`;
  const descriptionId = `${idBase}-description`;
  const fieldRef = useRef<FormulaFieldHandle>(null);
  // The hint goes once the user has opened a pill's panel.
  const [panelSeen, setPanelSeen] = useState(false);
  const showFilterHint =
    !panelSeen && field.pills.length > 0 && field.pills.every((p) => !p.filters || Object.keys(p.filters).length === 0);
  const fields = useAppStore((s) => s.projectFields);
  const settings = useAppStore((s) => s.instanceSettings);
  const split = dimensions.some((d) => d.kind !== 'period');

  // --- The line under the field: the problem, or the numbers and the result ---------------
  const resultUnit = RESULT_UNIT[formula.result ?? 'percent'];
  const total = result ? result.total : undefined;
  let line: ReactNode;
  if (problem) {
    const suggestion = problem.word?.suggestion;
    line = (
      <p id={lineId} className={styles.formulaError} role="alert">
        {suggestion ? (
          <>
            &quot;{problem.word?.text}&quot; is not a measure. Did you mean{' '}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.suggestion}
              onClick={() => onAcceptSuggestion(problem)}
            >
              {suggestion.label}
            </Button>
            {'?'}
          </>
        ) : (
          problem.message
        )}
      </p>
    );
  } else if (typing || !result) {
    line = (
      <p id={lineId} className={styles.readBackLine}>
        {typing ? TYPING_HINT : CALCULATING}
      </p>
    );
  } else {
    const values = Object.fromEntries((result.terms ?? []).map((t) => [t.name, formatMetric(t.value, t.unit)]));
    const termLabels = Object.fromEntries(formula.terms.map((t) => [t.name, measureLabelOf(t.measure)]));
    const shown =
      total === null || total === undefined
        ? `– (${noResultReason(result.terms ?? [], termLabels)})`
        : formatMetric(total, resultUnit);
    line = (
      <p id={lineId} className={styles.readBackLine} role="status">
        {readBack(formula.expression, values)} = <strong className={styles.calcResult}>{shown}</strong>
      </p>
    );
  }

  // The result choice shows the current result in each form — only a valid, current one.
  const ratio = !problem && !typing && typeof total === 'number' ? (resultUnit === 'percent' ? total / 100 : total) : null;
  const resultOptions = [
    { value: 'percent', label: ratio === null ? 'Percentage' : `Percentage (${formatMetric(ratio * 100, 'percent')})` },
    { value: 'number', label: ratio === null ? 'Number' : `Number (${formatMetric(ratio, 'number')})` },
  ];

  /** The first dimension beyond the period a measure refuses (its pill must use its total). */
  const refused = (measure: Measure): MetricDimension | undefined =>
    dimensions.find((d) => d.kind !== 'period' && !isValidDimension(measure, d.kind));

  const renderPanel = (pill: FieldPill, update: (patch: Partial<Pick<FieldPill, 'filters' | 'total'>>) => void) => {
    const refusedDimension = refused(pill.measure);
    return (
      <>
        <FilterSection
          disclosure={false}
          measure={pill.measure}
          filters={pill.filters ?? {}}
          onChange={(patch: Partial<MetricFilters>) =>
            update({ filters: { ...(pill.filters ?? {}), ...patch } as TermFilters })
          }
          holds={holds}
          title={`Filters of ${measureLabelOf(pill.measure)}`}
        />
        {split && (
          <div className={styles.termTotal}>
            <ToggleSwitch
              label="Use its total"
              checked={Boolean(pill.total) || refusedDimension !== undefined}
              disabled={refusedDimension !== undefined}
              onChange={(checked) => update({ total: checked })}
            />
            <p className={styles.hint}>
              {refusedDimension
                ? `${measureLabelOf(pill.measure)} has no ${dimensionLabel(refusedDimension, fields, settings)}: it uses its total`
                : TOTAL_HINT}
            </p>
          </div>
        )}
      </>
    );
  };

  return (
    <section className={styles.section} aria-label="Calculation">
      <div className={styles.formulaBlock}>
        <div className={styles.formulaHead}>
          <label htmlFor={fieldId} className={styles.label}>
            Formula
          </label>
          <div className={styles.formulaTools}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon={<Icon icon={PlusIcon} size={14} />}
              // Keep the field's caret: the measure goes where the user was.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => fieldRef.current?.openSuggestions()}
            >
              Insert measure
            </Button>
            <ExamplesMenu canCapacity={canCapacity} onPick={onExample} />
          </div>
        </div>
        <FormulaField
          ref={fieldRef}
          id={fieldId}
          state={field}
          onChange={onFieldChange}
          options={options}
          label={label}
          renderPanel={renderPanel}
          describedBy={`${lineId} ${descriptionId}`}
          invalid={problem !== null}
          onPanelOpen={() => setPanelSeen(true)}
        />
        {line}
        {showFilterHint && <p className={styles.hint}>{FILTER_HINT}</p>}
        <p id={descriptionId} className="sr-only">
          {FIELD_DESCRIPTION}
        </p>
      </div>
      <Select
        label="Show result as"
        fullWidth
        value={formula.result ?? 'percent'}
        onChange={(e) => onResultChange(e.target.value as MetricFormula['result'])}
        options={resultOptions}
      />
    </section>
  );
}

interface ExamplesMenuProps {
  canCapacity: boolean;
  onPick: (key: FormulaExampleKey) => void;
}

/** The *Examples* menu: a ready-made formula. */
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
        size="sm"
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
