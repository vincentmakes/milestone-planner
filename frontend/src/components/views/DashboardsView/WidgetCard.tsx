/**
 * WidgetCard — one widget on the dashboard grid.
 *
 * The header (`.widgetHeader`, the drag handle while editing) holds the
 * title, the resolved period under it, and the unit; the body draws the
 * widget's result by kind — `KpiTile`, `EChart` (bar, line, pie) or
 * `TableWidget`. A widget whose query failed on the server shows its error
 * in a `Notice` (the server's words, verbatim); dropped filter ids
 * (`warnings`), a multi-value `note` and a cut "all time" period show as one
 * muted line. Until the first data arrives the body says it is loading.
 */

import { useMemo } from 'react';
import type { DashboardWidget, MetricError, MetricResult } from '@/types';
import { useAppStore } from '@/stores/appStore';
import { Notice } from '@/components/common/Notice';
import { Icon, DragDotsIcon } from '@/components/common/Icon';
import { dimensionLabel, queryUnit, resolvedPeriodLabel, UNIT_LABELS } from '@/utils/metrics';
import { EChart } from './charts/EChart';
import { KpiTile } from './charts/KpiTile';
import { TableWidget } from './charts/TableWidget';
import styles from './WidgetCard.module.css';

export const TRUNCATED_TEXT = 'Period cut to five years';

export interface WidgetCardProps {
  widget: DashboardWidget;
  /** The widget's result, `{error}`, or undefined before the first load */
  result?: MetricResult | MetricError;
  /** The dashboard's data is loading */
  loading?: boolean;
  /** Edit mode: the header is the drag handle */
  editing?: boolean;
}

const isError = (value: MetricResult | MetricError | undefined): value is MetricError =>
  value !== undefined && 'error' in value;

export function WidgetCard({ widget, result, loading = false, editing = false }: WidgetCardProps) {
  const fields = useAppStore((s) => s.projectFields);
  const settings = useAppStore((s) => s.instanceSettings);
  const dimensionLabels = useMemo(
    () => (widget.query.dimensions ?? []).map((d) => dimensionLabel(d, fields, settings)),
    [widget.query.dimensions, fields, settings]
  );

  const metric = result && !isError(result) ? result : null;
  const unit = metric?.unit ?? queryUnit(widget.query);
  const unitText = UNIT_LABELS[unit] || '%';
  const notes = metric
    ? [...metric.warnings, ...(metric.note ? [metric.note] : []), ...(metric.truncated ? [TRUNCATED_TEXT] : [])]
    : [];

  let body: React.ReactNode;
  if (isError(result)) {
    body = <Notice tone="error">{result.error}</Notice>;
  } else if (!metric) {
    body = (
      <p className={styles.placeholder} role="status">
        {loading ? 'Loading…' : 'No data yet.'}
      </p>
    );
  } else if (widget.kind === 'kpi') {
    body = <KpiTile result={metric} query={widget.query} options={widget.options} />;
  } else if (widget.kind === 'table') {
    body = (
      <TableWidget result={metric} query={widget.query} options={widget.options} dimensionLabels={dimensionLabels} />
    );
  } else if (metric.rows.length === 0) {
    body = <p className={styles.placeholder}>Nothing to show for this period.</p>;
  } else {
    body = <EChart kind={widget.kind} result={metric} options={widget.options} label={widget.title} />;
  }

  return (
    <section className={styles.card} aria-label={widget.title}>
      <header className={`widgetHeader ${styles.header}${editing ? ` ${styles.draggable}` : ''}`}>
        {editing && (
          <span className={styles.handle} aria-hidden="true">
            <Icon icon={DragDotsIcon} size={14} />
          </span>
        )}
        <div className={styles.titles}>
          <h3 className={styles.title} title={widget.title}>
            {widget.title}
          </h3>
          {metric?.period && <p className={styles.period}>{resolvedPeriodLabel(metric.period)}</p>}
        </div>
        {widget.kind !== 'kpi' && <span className={styles.unit}>{unitText}</span>}
      </header>
      <div className={styles.body}>{body}</div>
      {notes.length > 0 && (
        <p className={styles.notes} title={notes.join('\n')}>
          {notes.join(' · ')}
        </p>
      )}
    </section>
  );
}
