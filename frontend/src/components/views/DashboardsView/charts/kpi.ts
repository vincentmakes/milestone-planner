/**
 * The value of a KPI widget (see KpiTile): the total, or with `percent_of`
 * the bucket named by `options.kpi_bucket`, matched on the row key. A total
 * (or bucket) of `null` — a ratio over nothing — shows as "–".
 */

import type { MetricQuery, MetricResult, WidgetOptions } from '@/types';
import { normaliseKey } from '@/utils/metrics';

// The server never zero-fills a bucket: an absent one is a share of 0.
export const BUCKET_NOT_FOUND = 'none in this period';

/** The value a KPI shows, and whether its bucket was missing. */
export function kpiValue(
  result: MetricResult,
  query: MetricQuery,
  options?: WidgetOptions | null
): { value: number | null; label: string | null; missing: boolean } {
  const bucket = options?.kpi_bucket;
  if (!query.percent_of || bucket === undefined || bucket === null) {
    return { value: result.total, label: null, missing: false };
  }
  const wanted = normaliseKey(bucket);
  const rows = result.rows.filter((row) => normaliseKey(row.keys[0]?.key) === wanted);
  if (rows.length === 0) return { value: 0, label: null, missing: true };
  // A ratio over nothing is null: the bucket is null only when every row is.
  const numbers = rows.map((row) => row.value).filter((v): v is number => v !== null);
  const value = numbers.length > 0 ? numbers.reduce((sum, v) => sum + v, 0) : null;
  return { value, label: rows[0].keys[0]?.label ?? null, missing: false };
}

