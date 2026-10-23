/**
 * The value of a KPI widget (see KpiTile): the total, or with `percent_of`
 * the bucket named by `options.kpi_bucket`, matched on the row key.
 */

import type { MetricQuery, MetricResult, WidgetOptions } from '@/types';
import { normaliseKey } from '@/utils/metrics';

export const BUCKET_NOT_FOUND = 'bucket not found';

/** The value a KPI shows, and whether its bucket was missing. */
export function kpiValue(
  result: MetricResult,
  query: MetricQuery,
  options?: WidgetOptions | null
): { value: number; label: string | null; missing: boolean } {
  const bucket = options?.kpi_bucket;
  if (!query.percent_of || bucket === undefined || bucket === null) {
    return { value: result.total, label: null, missing: false };
  }
  const wanted = normaliseKey(bucket);
  const rows = result.rows.filter((row) => normaliseKey(row.keys[0]?.key) === wanted);
  if (rows.length === 0) return { value: result.total, label: null, missing: true };
  const value = rows.reduce((sum, row) => sum + row.value, 0);
  return { value, label: rows[0].keys[0]?.label ?? null, missing: false };
}

