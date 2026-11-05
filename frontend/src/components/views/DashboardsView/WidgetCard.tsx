/**
 * WidgetCard — one widget on the dashboard grid.
 *
 * The header (`.widgetHeader`, the drag handle while editing) holds the
 * title, the resolved period under it, and the unit; the body draws the
 * widget's result by kind — `KpiTile`, `EChart` (bar, line, pie, gauge,
 * heatmap, treemap, sankey) or `TableWidget`; a chart with nothing to draw
 * (`hasDrawableData`: no row, a gauge without a total, a treemap or sankey
 * without a positive value) says so instead. A widget whose query failed on the server shows its error
 * in a `Notice` (the server's words, verbatim); dropped filter ids
 * (`warnings`), a multi-value `note` and a cut "all time" period show as one
 * muted line. Until the first data arrives the body says it is loading.
 * In the builder's edit mode the header also holds compact 28 px Edit and
 * Remove buttons (the Gantt-header exception of UI_GUIDELINES §3.14: the
 * header is small and doubles as the drag handle).
 */

import { useMemo } from 'react';
import type { DashboardWidget, MetricError, MetricResult } from '@/types';
import { useAppStore } from '@/stores/appStore';
import { Notice } from '@/components/common/Notice';
import { Icon, CloseIcon, DragDotsIcon, EditIcon } from '@/components/common/Icon';
import { dimensionLabel, MEASURES, queryUnit, resolvedPeriodLabel, UNIT_LABELS } from '@/utils/metrics';
import { EChart } from './charts/EChart';
import { hasDrawableData } from './charts/toOption';
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
  /** Edit mode: open the widget editor on this widget */
  onEdit?: () => void;
  /** Edit mode: take the widget off the draft */
  onRemove?: () => void;
}

const isError = (value: MetricResult | MetricError | undefined): value is MetricError =>
  value !== undefined && 'error' in value;

export function WidgetCard({ widget, result, loading = false, editing = false, onEdit, onRemove }: WidgetCardProps) {
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
  } else if (!hasDrawableData(widget.kind, metric)) {
    body = <p className={styles.placeholder}>Nothing to show for this period.</p>;
  } else {
    const measureLabel = MEASURES.find((m) => m.key === widget.query.measure)?.label;
    body = (
      <EChart
        kind={widget.kind}
        result={metric}
        options={widget.options}
        label={widget.title}
        measureLabel={measureLabel}
      />
    );
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
        {editing && onEdit && (
          // `widgetAction` keeps a press on the button from starting a drag.
          <button
            type="button"
            className={`widgetAction ${styles.action}`}
            onClick={onEdit}
            aria-label={`Edit ${widget.title}`}
            title="Edit widget"
          >
            <Icon icon={EditIcon} size={14} />
          </button>
        )}
        {editing && onRemove && (
          <button
            type="button"
            className={`widgetAction ${styles.action}`}
            onClick={onRemove}
            aria-label={`Remove ${widget.title}`}
            title="Remove widget"
          >
            <Icon icon={CloseIcon} size={14} />
          </button>
        )}
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
