/**
 * The value of a KPI widget (see KpiTile): the total, or with `percent_of`
 * the bucket named by `options.kpi_bucket`, matched on the row key. A total
 * (or bucket) of `null` — a ratio over nothing — shows as "–".
 *
 * *Show as % of target* (`options.percent_of_target`, 2.6.0) turns the value
 * of a KPI or a gauge into value / target × 100, in the client: only with a
 * target above 0 (`targetBase`), a `null` value staying `null`.
 */

import type { MetricQuery, MetricResult, WidgetOptions } from '@/types';
import { normaliseKey } from '@/utils/metrics';

/** The largest gauge or KPI target, the server's (`MAX_GAUGE_TARGET` in `app/schemas/dashboard.py`). */
export const MAX_GAUGE_TARGET = 1_000_000_000;

/** A stored target, when it is one (finite, from 0 to `MAX_GAUGE_TARGET`). */
export const gaugeTarget = (target: number | null | undefined): number | null =>
  typeof target === 'number' && Number.isFinite(target) && target >= 0 && target <= MAX_GAUGE_TARGET ? target : null;

/** What follows a value shown as a percentage of its target ("91 % of target"). */
export const OF_TARGET = 'of target';

/** The target a value is shown against as a percentage, or null (no flag, or no target above 0). */
export function targetBase(options?: WidgetOptions | null): number | null {
  if (!options?.percent_of_target) return null;
  const target = gaugeTarget(options.target);
  return target !== null && target > 0 ? target : null;
}

/** `value` as a percentage of `target` (> 0); `null` stays `null`. */
export function percentOfTarget(value: number | null, target: number): number | null {
  return value === null ? null : (value / target) * 100;
}

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

