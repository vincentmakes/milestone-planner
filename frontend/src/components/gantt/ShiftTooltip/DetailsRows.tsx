/**
 * DetailsRows - the content of the Gantt's Shift-hover details: the title
 * and the rows of a project, phase or subphase (`TooltipData`). Presentational
 * only: `ShiftTooltip` wraps it in the floating tooltip, Settings → Project
 * fields in its preview card.
 *
 * `shows` gates the rows: a project passes the `project_tooltip_rows` gate
 * (`tooltipRowGate`), a phase or subphase `() => true`.
 */

import type { InstanceSettings } from '@/types';
import { parseLocalDate } from '@/utils/date';
import { barTextColor } from '@/utils/tags';
import { builtInFieldLabel, volumeDecimals, type TooltipRow } from '@/utils/instanceSettings';
import { formatFieldNumber } from '@/utils/projectFields';
import type { TooltipData, TooltipTag } from './tooltipData';
import styles from './ShiftTooltip.module.css';

interface DetailsRowsProps {
  data: TooltipData;
  /** For the built-in fields' labels and Volume's decimals */
  settings: InstanceSettings | null | undefined;
  shows: (row: TooltipRow) => boolean;
}

// Format date range nicely using browser locale
function formatDateRange(startDate: string, endDate: string): string {
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);

  const formatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return `${formatter.format(start)} - ${formatter.format(end)}`;
}

function Pills({ items }: { items: readonly TooltipTag[] }) {
  return (
    <>
      {items.map((item) => (
        <span
          key={item.id}
          className={styles.tagPill}
          style={{ backgroundColor: item.color, color: barTextColor(item.color) }}
        >
          {item.label}
        </span>
      ))}
    </>
  );
}

export function DetailsRows({ data, settings, shows }: DetailsRowsProps) {
  const completionText =
    data.completion !== null ? `${data.completion}%${data.isCalculatedCompletion ? ' (calc)' : ''}` : '—';

  const isProject = data.type === 'project';
  const fieldRows = isProject ? (data.fieldRows ?? []).filter((r) => shows(r.id)) : [];

  return (
    <>
      <div className={styles.title}>{data.title}</div>

      {/* Project-specific: the built-in fields, PM and tags */}
      {isProject && (
        <>
          {data.customer && shows('customer') && (
            <div className={styles.row}>
              <span className={styles.label}>{builtInFieldLabel(settings, 'customer')}:</span>
              <span>{data.customer}</span>
            </div>
          )}
          {data.pmName && shows('pm') && (
            <div className={styles.row}>
              <span className={styles.label}>PM:</span>
              <span>{data.pmName}</span>
            </div>
          )}
          {data.salesPm && shows('sales_pm') && (
            <div className={styles.row}>
              <span className={styles.label}>{builtInFieldLabel(settings, 'sales_pm')}:</span>
              <span>{data.salesPm}</span>
            </div>
          )}
          {data.volume != null && shows('volume') && (
            <div className={styles.row}>
              <span className={styles.label}>{builtInFieldLabel(settings, 'volume')}:</span>
              <span>{formatFieldNumber(data.volume, volumeDecimals(settings))}</span>
            </div>
          )}
          {shows('confirmed') && (
            <div className={styles.row}>
              <span className={styles.label}>{builtInFieldLabel(settings, 'confirmed')}:</span>
              <span className={data.confirmed ? styles.confirmed : styles.unconfirmed}>
                {data.confirmed ? 'Yes' : 'No'}
              </span>
            </div>
          )}
          {data.tags && data.tags.length > 0 && shows('tags') && (
            <div className={styles.tagSection}>
              <div className={styles.tagHeader}>Tags:</div>
              <div className={styles.tagRow}>
                <Pills items={data.tags} />
              </div>
            </div>
          )}
        </>
      )}

      {/* Phase/Subphase: show project name */}
      {!isProject && data.projectName && (
        <div className={styles.row}>
          <span className={styles.label}>Project:</span>
          <span>{data.projectName}</span>
        </div>
      )}

      {data.parentName && (
        <div className={styles.row}>
          <span className={styles.label}>Parent:</span>
          <span>{data.parentName}</span>
        </div>
      )}

      {shows('period') && (
        <div className={styles.row}>
          <span className={styles.label}>Period:</span>
          <span>{formatDateRange(data.startDate, data.endDate)}</span>
        </div>
      )}
      {shows('completion') && (
        <div className={styles.row}>
          <span className={styles.label}>Completion:</span>
          <span>{completionText}</span>
        </div>
      )}
      {shows('work_days') && (
        <div className={styles.row}>
          <span className={styles.label}>Work days:</span>
          <span>
            {data.workDays} days
            {data.holidays > 0 && ` (excl. ${data.holidays} hol.)`}
          </span>
        </div>
      )}
      {shows('total_days') && (
        <div className={styles.row}>
          <span className={styles.label}>Total:</span>
          <span>{data.totalDays} days</span>
        </div>
      )}

      {/* Staff assignments */}
      {data.staff.length > 0 && shows('staff') && (
        <div className={styles.staffSection}>
          <div className={styles.staffHeader}>Assigned Staff:</div>
          {data.staff.map((s, i) => (
            <div key={i} className={styles.staffRow}>
              <span className={styles.staffName}>{s.name}</span>
              <span className={styles.staffAllocation}>{s.allocation}%</span>
            </div>
          ))}
        </div>
      )}

      {/* Project: the custom fields project_tooltip_rows lists, in field order */}
      {fieldRows.length > 0 && (
        <div className={styles.fieldSection}>
          {fieldRows.map((row) => (
            <div key={row.id} className={styles.row}>
              <span className={styles.label}>{row.label}:</span>
              {row.items ? (
                <div className={styles.fieldPills}>
                  <Pills items={row.items} />
                </div>
              ) : (
                <span>{row.text}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
