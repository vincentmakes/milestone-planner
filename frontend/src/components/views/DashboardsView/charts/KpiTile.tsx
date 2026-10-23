/**
 * KpiTile — a KPI widget: one big number with its unit.
 *
 * Without a percentage the number is the result's total. With `percent_of`
 * the KPI shows the share of one bucket, named by `options.kpi_bucket` — the
 * dimension value's **key** (`true` for Confirmed, an item or site id),
 * never its label; keys and the bucket are compared after `normaliseKey`, so
 * a bucket stored as `"3"` or `3` matches either. A bucket the result does
 * not hold falls back to the total, with a muted "bucket not found".
 */

import type { MetricQuery, MetricResult, WidgetOptions } from '@/types';
import { formatMetric, UNIT_LABELS } from '@/utils/metrics';
import { BUCKET_NOT_FOUND, kpiValue } from './kpi';
import styles from './KpiTile.module.css';

export interface KpiTileProps {
  result: MetricResult;
  query: MetricQuery;
  options?: WidgetOptions | null;
}

export function KpiTile({ result, query, options }: KpiTileProps) {
  const { value, label, missing } = kpiValue(result, query, options);
  const unit = UNIT_LABELS[result.unit];
  return (
    <div className={styles.tile}>
      <div className={styles.value}>
        <span className={styles.number}>{formatMetric(value, result.unit, options)}</span>
        {unit && options?.number_format !== 'percent' && <span className={styles.unit}>{unit}</span>}
      </div>
      {label && <div className={styles.bucket}>{label}</div>}
      {missing && <div className={styles.bucket}>{BUCKET_NOT_FOUND}</div>}
    </div>
  );
}
