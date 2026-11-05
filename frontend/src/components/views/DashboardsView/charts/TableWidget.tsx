/**
 * TableWidget — a table widget: the first dimension's values as rows, the
 * second dimension's as columns, and a totals row.
 *
 * Cells are formatted with `formatMetric`; a missing (row × column) point is
 * empty, a `null` value (a ratio over nothing) "–". Row and column sums are
 * shown only for additive measures (booked, project and phase weeks / days,
 * capacity, available and equipment booked days) in their own unit — summing distinct
 * counts or percentages would double count — and only when no fact counted
 * in several values (the result's `note`: a booking on a project tagged A and
 * B sits in both cells), while the grand total is always the server's
 * (recomputed over distinct facts).
 */

import type { MetricKey, MetricQuery, MetricResult, WidgetOptions } from '@/types';
import { formatMetric, normaliseKey, OTHER_KEY, UNIT_LABELS } from '@/utils/metrics';
import styles from './TableWidget.module.css';

export interface TableWidgetProps {
  result: MetricResult;
  query: MetricQuery;
  options?: WidgetOptions | null;
  /** Column headers of the dimensions (instance labels); defaults to the result's */
  dimensionLabels?: string[];
}

/** Measures whose values add up over the dimension values. */
const ADDITIVE = new Set([
  'booked_days',
  'booked_weeks',
  'project_weeks',
  'phase_weeks',
  'capacity_days',
  'available_days',
  'equipment_booked_days',
]);

const keyId = (key: MetricKey | undefined): string => JSON.stringify(normaliseKey(key?.key ?? null));

function distinct(result: MetricResult, index: number): MetricKey[] {
  const seen = new Map<string, MetricKey>();
  for (const row of result.rows) {
    const key = row.keys[index];
    if (key && !seen.has(keyId(key))) seen.set(keyId(key), key);
  }
  const rank = (key: MetricKey) => (key.key === OTHER_KEY ? 2 : key.key === null ? 1 : 0);
  return [...seen.values()]
    .map((key, order) => ({ key, order }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.order - b.order)
    .map(({ key }) => key);
}

/** A one-dimension row's value: 0 when absent, null (shown "–") kept. */
const valueOrZero = (value: number | null | undefined): number | null => (value === undefined ? 0 : value);

export function TableWidget({ result, query, options, dimensionLabels }: TableWidgetProps) {
  const fmt = (value: number | null) => formatMetric(value, result.unit, options);
  const labels = dimensionLabels ?? result.dimensions.map((d) => d.label);
  const sums = ADDITIVE.has(query.measure) && result.unit !== 'percent' && !result.note;
  const valueHeader = UNIT_LABELS[result.unit] || '%';

  if (result.dimensions.length === 0) {
    return (
      <div className={styles.wrapper}>
        <table className={styles.table}>
          <tbody>
            <tr className={styles.totalRow}>
              <th scope="row">Total</th>
              <td>{fmt(result.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  const rows = distinct(result, 0);
  const columns = result.dimensions.length >= 2 ? distinct(result, 1) : [];
  // A cell is null only while every one of its rows is (a ratio over nothing).
  const cell = new Map<string, number | null>();
  for (const row of result.rows) {
    const id = `${keyId(row.keys[0])}|${columns.length > 0 ? keyId(row.keys[1]) : ''}`;
    const sum = cell.get(id);
    cell.set(id, row.value === null ? sum ?? null : (sum ?? 0) + row.value);
  }
  const valueAt = (r: MetricKey, c: MetricKey | null) => cell.get(`${keyId(r)}|${c ? keyId(c) : ''}`);
  const sumOf = (values: (number | null | undefined)[]) => values.reduce<number>((acc, v) => acc + (v ?? 0), 0);

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{labels[0]}</th>
            {columns.length > 0 ? (
              <>
                {columns.map((c) => (
                  <th key={keyId(c)} scope="col">
                    {c.label}
                  </th>
                ))}
                {sums && <th scope="col">Total</th>}
              </>
            ) : (
              <th scope="col">{valueHeader}</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={keyId(r)}>
              <th scope="row">{r.label}</th>
              {columns.length > 0 ? (
                <>
                  {columns.map((c) => {
                    const value = valueAt(r, c);
                    return <td key={keyId(c)}>{value === undefined ? '' : fmt(value)}</td>;
                  })}
                  {sums && <td>{fmt(sumOf(columns.map((c) => valueAt(r, c))))}</td>}
                </>
              ) : (
                <td>{fmt(valueOrZero(valueAt(r, null)))}</td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className={styles.totalRow}>
            <th scope="row">Total</th>
            {columns.length > 0 && sums ? (
              <>
                {columns.map((c) => (
                  <td key={keyId(c)}>{fmt(sumOf(rows.map((r) => valueAt(r, c))))}</td>
                ))}
                <td>{fmt(result.total)}</td>
              </>
            ) : columns.length > 0 ? (
              // Distinct counts and percentages do not add up per column:
              // only the server's total, across the columns.
              <td colSpan={columns.length}>{fmt(result.total)}</td>
            ) : (
              <td>{fmt(result.total)}</td>
            )}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
