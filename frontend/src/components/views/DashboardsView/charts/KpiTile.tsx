/**
 * KpiTile — a KPI widget: one big number with its unit.
 *
 * Without a percentage the number is the result's total. With `percent_of`
 * the KPI shows the share of one bucket, named by `options.kpi_bucket` — the
 * dimension value's **key** (`true` for Confirmed, an item or site id),
 * never its label; keys and the bucket are compared after `normaliseKey`, so
 * a bucket stored as `"3"` or `3` matches either. A bucket the result does
 * not hold is a share of 0 (the server never zero-fills one), with a muted
 * "none in this period".
 *
 * With *Show as % of target* and a target above 0 the number is the value as
 * a percentage of the target ("91 % of target"), the target under it in the
 * result's unit ("Target 70 %").
 */

import type { MetricQuery, MetricResult, WidgetOptions } from '@/types';
import { formatMetric, unitWord } from '@/utils/metrics';
import { BUCKET_NOT_FOUND, kpiValue, OF_TARGET, percentOfTarget, targetBase } from './kpi';
import styles from './KpiTile.module.css';

export interface KpiTileProps {
  result: MetricResult;
  query: MetricQuery;
  options?: WidgetOptions | null;
}

export function KpiTile({ result, query, options }: KpiTileProps) {
  const { value, label, missing } = kpiValue(result, query, options);
  const base = targetBase(options);
  if (base !== null) {
    const shown = percentOfTarget(value, base);
    const targetUnit = unitWord(base, result.unit, options);
    const targetText = formatMetric(base, result.unit, options);
    return (
      <div className={styles.tile}>
        <div className={styles.value}>
          <span className={styles.number}>{formatMetric(shown, 'percent', options)}</span>
          {shown !== null && <span className={styles.unit}>{OF_TARGET}</span>}
        </div>
        {label && <div className={styles.bucket}>{label}</div>}
        {missing && <div className={styles.bucket}>{BUCKET_NOT_FOUND}</div>}
        <div className={styles.bucket}>
          {`Target ${targetText}`}
          {targetUnit && options?.number_format !== 'percent' ? ` ${targetUnit}` : ''}
        </div>
      </div>
    );
  }
  // "1 phase", "3 phases".
  const unit = unitWord(value, result.unit, options);
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
